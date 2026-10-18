import sharp from "sharp";

/**
 * Catalog gallery hygiene: the same vendor image can end up linked to a shade twice under
 * different `image_asset` rows, because `image_asset` dedupes on the stored bytes' checksum and
 * older ingests stored different bytes for the same picture (before the metadata strip /
 * re-encode pipeline, or with an older sharp). Ingestion now reconciles a shade's gallery with
 * the product's current images (`pruneStaleGallerySwatches`); `planShadeGalleryDedupe` cleans up
 * existing data by comparing the stored images perceptually (`POST /api/images-admin/gallery-dedupe`).
 */

/**
 * Swatches that must never be removed by gallery cleanup, as a SQL predicate over `alias`
 * (a `swatch` row): its image is a hex ground-truth label (`color_training_sample.image_id`,
 * admin Hex Labeling / detail-page sip) or it has derived `color_features`.
 */
export function protectedSwatchSql(alias: string): string {
  return `(EXISTS (SELECT 1 FROM color_training_sample cts WHERE cts.image_id = ${alias}.image_id_original)
        OR EXISTS (SELECT 1 FROM color_features cf WHERE cf.swatch_id = ${alias}.swatch_id))`;
}

/**
 * Another product of the same data source also maps to the shade (`shade_source_product`), so
 * this product's images are not the shade's whole gallery from that source: ingestion then never
 * unlinks gallery swatches for it (stale prune, near-duplicate / over-cap unlink).
 */
export async function shadeSharedWithOtherProduct(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> },
  params: { shadeId: number; dataSourceId: number; externalId: string }
): Promise<boolean> {
  const shared = await client.query(
    `SELECT 1
     FROM shade_source_product ssp
     JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
     WHERE ssp.shade_id = $1
       AND ep.data_source_id = $2
       AND ep.external_id IS DISTINCT FROM $3
     LIMIT 1`,
    [params.shadeId, params.dataSourceId, params.externalId]
  );
  return shared.rows.length > 0;
}

/**
 * Ingestion: make the shade's `source_gallery` swatches from this data source exactly the
 * product's current images. Deletes gallery swatches whose image belongs to `dataSourceId` but is
 * not in `keepImageIds` (this run's primary + additional image ids). Never touches
 * `source_product` swatches, other data sources' or user images, or protected swatches; the
 * `image_asset` rows and blobs are kept. Skipped (returns 0) when another product of the same
 * data source also maps to this shade, since that product's images are not in `keepImageIds`.
 *
 * Only call it when every current image of the product was stored and linked this run: a
 * failed download must not unlink the image it would have replaced.
 */
export async function pruneStaleGallerySwatches(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> },
  params: { shadeId: number; dataSourceId: number; externalId: string; keepImageIds: number[] }
): Promise<{ deleted: number; skippedSharedShade: boolean }> {
  if (await shadeSharedWithOtherProduct(client, params)) {
    return { deleted: 0, skippedSharedShade: true };
  }

  const deleted = await client.query(
    `DELETE FROM swatch sw
     USING image_asset ia
     WHERE sw.shade_id = $1
       AND sw.swatch_type = 'source_gallery'
       AND ia.image_id = sw.image_id_original
       AND ia.owner_type = 'source'
       AND ia.owner_id = $2
       AND sw.image_id_original <> ALL($3::bigint[])
       AND NOT ${protectedSwatchSql("sw")}
     RETURNING sw.swatch_id AS "swatchId"`,
    [params.shadeId, params.dataSourceId, params.keepImageIds]
  );
  return { deleted: deleted.rows.length, skippedSharedShade: false };
}

// ── Perceptual fingerprint ───────────────────────────────────────────────────

/** Gradient hash grid (bits = DHASH_SIZE²) and color thumbnail edge (pixels = THUMB_SIZE²). */
export const DHASH_SIZE = 16;
export const THUMB_SIZE = 16;

/**
 * Two stored images are the same picture when both distances are within these limits and their
 * aspect ratios match. Measured on Holo Taco "Wicked Potion" (13 vendor images incl. 2 GIFs and
 * 9 similar nail shots), each re-encoded 4 ways (JPEG q78, 700px WebP q70, 1600px PNG, 400px
 * JPEG q60): same-picture maxima were dHash 32/256 and thumbnail MAD 5.3; the closest different
 * pictures were dHash 83 and MAD 30. Thresholds sit between, nearer the same-picture side.
 */
export const DEFAULT_DEDUPE_THRESHOLDS = {
  /** Max differing bits of the 256-bit dHash. */
  maxHashDistance: 56,
  /** Max mean absolute RGB difference (0–255) of the 16×16 thumbnails. */
  maxThumbDistance: 12,
  /** Max relative aspect-ratio difference (a re-crop to another shape is not a duplicate). */
  maxAspectDelta: 0.03,
} as const;

export type DedupeThresholds = { -readonly [K in keyof typeof DEFAULT_DEDUPE_THRESHOLDS]: number };

export interface ImageFingerprint {
  /** DHASH_SIZE² gradient bits as a hex string. */
  dhash: string;
  /** THUMB_SIZE² RGB bytes, base64. */
  thumb: string;
  width: number;
  height: number;
}

/** Fingerprint of an image's first frame, flattened on white (transparent PNGs, GIFs). */
export async function computeImageFingerprint(bytes: Buffer): Promise<ImageFingerprint> {
  const base = () => sharp(bytes, { animated: false, failOn: "none" }).rotate().flatten({ background: "#ffffff" });
  const meta = await sharp(bytes, { animated: false, failOn: "none" }).metadata();
  const [gray, color] = await Promise.all([
    base().grayscale().resize(DHASH_SIZE + 1, DHASH_SIZE, { fit: "fill" }).raw().toBuffer(),
    base().removeAlpha().resize(THUMB_SIZE, THUMB_SIZE, { fit: "fill" }).raw().toBuffer(),
  ]);

  let hex = "";
  let nibble = 0;
  let bit = 0;
  for (let y = 0; y < DHASH_SIZE; y += 1) {
    for (let x = 0; x < DHASH_SIZE; x += 1) {
      const left = gray[y * (DHASH_SIZE + 1) + x];
      const right = gray[y * (DHASH_SIZE + 1) + x + 1];
      nibble = (nibble << 1) | (left < right ? 1 : 0);
      bit += 1;
      if (bit % 4 === 0) {
        hex += nibble.toString(16);
        nibble = 0;
      }
    }
  }

  // EXIF orientations 5–8 swap the displayed width and height (`.rotate()` applies them).
  const swap = (meta.orientation ?? 1) >= 5;
  const width = (swap ? meta.height : meta.width) ?? 0;
  const height = (swap ? meta.width : meta.height) ?? 0;
  return { dhash: hex, thumb: color.toString("base64"), width, height };
}

export function hashDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

export function thumbDistance(a: string, b: string): number {
  const left = Buffer.from(a, "base64");
  const right = Buffer.from(b, "base64");
  if (left.length === 0 || left.length !== right.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) sum += Math.abs(left[i] - right[i]);
  return sum / left.length;
}

function aspectDelta(a: ImageFingerprint, b: ImageFingerprint): number {
  if (!a.width || !a.height || !b.width || !b.height) return Number.POSITIVE_INFINITY;
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  return Math.abs(ra - rb) / Math.max(ra, rb);
}

export interface FingerprintComparison {
  hashDistance: number;
  thumbDistance: number;
  aspectDelta: number;
  duplicate: boolean;
}

export function compareFingerprints(
  a: ImageFingerprint,
  b: ImageFingerprint,
  thresholds: DedupeThresholds = DEFAULT_DEDUPE_THRESHOLDS
): FingerprintComparison {
  const comparison = {
    hashDistance: hashDistance(a.dhash, b.dhash),
    thumbDistance: thumbDistance(a.thumb, b.thumb),
    aspectDelta: aspectDelta(a, b),
  };
  return {
    ...comparison,
    duplicate:
      comparison.hashDistance <= thresholds.maxHashDistance &&
      comparison.thumbDistance <= thresholds.maxThumbDistance &&
      comparison.aspectDelta <= thresholds.maxAspectDelta,
  };
}

// ── Stored fingerprint (image_asset.perceptual_hash / thumb_fingerprint / image_width / image_height) ──

/** `image_asset` fingerprint columns, all null or all set (CHECK image_asset_fingerprint_complete). */
export interface FingerprintColumns {
  perceptualHash: string | null;
  thumbFingerprint: Buffer | null;
  imageWidth: number | null;
  imageHeight: number | null;
}

const EMPTY_FINGERPRINT_COLUMNS: FingerprintColumns = {
  perceptualHash: null,
  thumbFingerprint: null,
  imageWidth: null,
  imageHeight: null,
};

/** Columns for a fingerprint; all null when it is missing or would violate the CHECK. */
export function fingerprintToColumns(fingerprint: ImageFingerprint | null | undefined): FingerprintColumns {
  if (!fingerprint) return EMPTY_FINGERPRINT_COLUMNS;
  const thumb = Buffer.from(fingerprint.thumb, "base64");
  const valid =
    /^[0-9a-f]{64}$/.test(fingerprint.dhash) &&
    thumb.length === THUMB_SIZE * THUMB_SIZE * 3 &&
    Number.isInteger(fingerprint.width) &&
    fingerprint.width > 0 &&
    Number.isInteger(fingerprint.height) &&
    fingerprint.height > 0;
  if (!valid) return EMPTY_FINGERPRINT_COLUMNS;
  return {
    perceptualHash: fingerprint.dhash,
    thumbFingerprint: thumb,
    imageWidth: fingerprint.width,
    imageHeight: fingerprint.height,
  };
}

/** Fingerprint read back from the columns (`thumbFingerprint` as a node-postgres bytea Buffer). */
export function fingerprintFromColumns(row: Partial<FingerprintColumns> | null | undefined): ImageFingerprint | null {
  if (!row?.perceptualHash || !row.thumbFingerprint || !row.imageWidth || !row.imageHeight) return null;
  return {
    dhash: row.perceptualHash,
    thumb: Buffer.from(row.thumbFingerprint).toString("base64"),
    width: Number(row.imageWidth),
    height: Number(row.imageHeight),
  };
}

/** SQL select list for the fingerprint columns of `alias` (an `image_asset` row). */
export function fingerprintColumnsSql(alias: string): string {
  return `${alias}.perceptual_hash AS "perceptualHash",
       ${alias}.thumb_fingerprint AS "thumbFingerprint",
       ${alias}.image_width AS "imageWidth",
       ${alias}.image_height AS "imageHeight"`;
}

/** Fingerprint of stored bytes, or null when they cannot be decoded (never throws). */
export async function computeImageFingerprintSafely(bytes: Buffer): Promise<ImageFingerprint | null> {
  try {
    const fingerprint = await computeImageFingerprint(bytes);
    return fingerprintToColumns(fingerprint).perceptualHash ? fingerprint : null;
  } catch {
    return null;
  }
}

/**
 * Fill an image's fingerprint columns when they are still empty (never overwrites, so concurrent
 * writers and re-ingests are harmless). No-op for a missing or invalid fingerprint. Returns
 * whether the row was written.
 */
export async function storeImageFingerprint(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  imageId: number,
  fingerprint: ImageFingerprint | null | undefined
): Promise<boolean> {
  const columns = fingerprintToColumns(fingerprint);
  if (!columns.perceptualHash) return false;
  const updated = await client.query(
    `UPDATE image_asset
     SET perceptual_hash = $2, thumb_fingerprint = $3, image_width = $4, image_height = $5
     WHERE image_id = $1
       AND perceptual_hash IS NULL
     RETURNING image_id`,
    [imageId, columns.perceptualHash, columns.thumbFingerprint, columns.imageWidth, columns.imageHeight]
  );
  return (updated?.rows?.length ?? 0) > 0;
}

// ── Ingest: which of a product's images to link as gallery swatches ─────────

/**
 * Near-duplicate limits for gallery linking at ingest: looser than DEFAULT_DEDUPE_THRESHOLDS so a
 * slightly re-cropped or re-shot copy of a photo already in the gallery is not linked again.
 * Measured on Cracked Polish (2026-10-18; 5 products, 184 vendor images, 3,316 pairs; fixture
 * tests/fixtures/gallery-near-duplicates.json):
 * - same-aspect trims of every image, re-encoded as WebP: 3% trims caught 95–100%, a 6% centered
 *   trim 99% (a 6% corner trim 19%); 10%+ trims are as far apart as different pictures (dHash p50
 *   ≥ 66, MAD ≥ 16) and are not caught. Re-crops to another aspect never match (aspect gate); a
 *   brute-force crop search found none in the sample.
 * - real pairs inside 64/20: only two same-pose re-shoots (dHash 54 / MAD 14.8, 58 / 16.4); the
 *   same 2 up to 72/24. The closest different pictures are dHash 70–80 with MAD 23–30 (other poses
 *   from the same session) and the closest by thumbnail MAD 25.8 (dHash 101).
 */
export const INGEST_NEAR_DUPLICATE_THRESHOLDS: DedupeThresholds = {
  maxHashDistance: 64,
  maxThumbDistance: 20,
  maxAspectDelta: DEFAULT_DEDUPE_THRESHOLDS.maxAspectDelta,
};

/**
 * Max `source_gallery` images one product links to its shade per ingest
 * (`GALLERY_MAX_IMAGES_PER_SHADE`, a positive integer; unset, empty, 0 or invalid = unlimited).
 */
export function getGalleryMaxImagesPerShade(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.GALLERY_MAX_IMAGES_PER_SHADE?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return value >= 1 ? value : null;
}

/** One of the product's images, in vendor order. `key` identifies the stored image (its checksum). */
export interface GalleryLinkCandidate {
  key: string;
  fingerprint: ImageFingerprint | null;
  /** Always linked, before the others and regardless of duplicates or the cap (the AI detection image). */
  pinned?: boolean;
}

export type GalleryLinkReason = "linked" | "pinned" | "same_image" | "near_duplicate" | "over_cap";

export interface GalleryLinkDecision {
  key: string;
  link: boolean;
  reason: GalleryLinkReason;
  /** `same_image` / `near_duplicate`: the linked image it repeats. */
  duplicateOfKey?: string;
}

/**
 * Decide which additional images of a product become `source_gallery` swatches. The primary is
 * always linked (as the product swatch); pinned images next; then each other image in vendor
 * order is linked unless it is the same stored image as, or a near-duplicate of
 * (`compareFingerprints` with `thresholds`), an image already linked, or the product already
 * links `maxGalleryImages` gallery images. Pure and order-deterministic, so the same vendor
 * gallery gives the same decisions on every run. An image without a fingerprint is never a
 * near-duplicate (it is linked unless capped). Returns one decision per `additional`, same order.
 */
export function planProductGalleryLinks(params: {
  primary: { key: string; fingerprint: ImageFingerprint | null } | null;
  additional: GalleryLinkCandidate[];
  thresholds?: DedupeThresholds;
  maxGalleryImages?: number | null;
}): GalleryLinkDecision[] {
  const thresholds = params.thresholds ?? INGEST_NEAR_DUPLICATE_THRESHOLDS;
  const cap = params.maxGalleryImages ?? null;
  const linked: Array<{ key: string; fingerprint: ImageFingerprint | null }> = params.primary ? [params.primary] : [];
  let galleryCount = 0;
  const decisions = new Map<number, GalleryLinkDecision>();

  const order = params.additional
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => Number(Boolean(b.candidate.pinned)) - Number(Boolean(a.candidate.pinned)) || a.index - b.index);

  for (const { candidate, index } of order) {
    const same = linked.find((image) => image.key === candidate.key);
    if (same) {
      decisions.set(index, { key: candidate.key, link: false, reason: "same_image", duplicateOfKey: same.key });
      continue;
    }
    if (!candidate.pinned) {
      const fingerprint = candidate.fingerprint;
      const duplicateOf = fingerprint
        ? linked.find((image) => image.fingerprint && compareFingerprints(fingerprint, image.fingerprint, thresholds).duplicate)
        : undefined;
      if (duplicateOf) {
        decisions.set(index, {
          key: candidate.key,
          link: false,
          reason: "near_duplicate",
          duplicateOfKey: duplicateOf.key,
        });
        continue;
      }
      if (cap !== null && galleryCount >= cap) {
        decisions.set(index, { key: candidate.key, link: false, reason: "over_cap" });
        continue;
      }
    }
    linked.push(candidate);
    galleryCount += 1;
    decisions.set(index, { key: candidate.key, link: true, reason: candidate.pinned ? "pinned" : "linked" });
  }

  return params.additional.map((_, index) => decisions.get(index)!);
}

// ── Per-shade plan ───────────────────────────────────────────────────────────

/** One catalog image linked to a shade (only `image_asset.owner_type = 'source'` rows). */
export interface ShadeGalleryImage {
  swatchId: number;
  imageId: number;
  swatchType: string | null;
  /** The image has a `source_image_url` row, i.e. it was stored by the current pipeline. */
  hasSourceUrl: boolean;
  /** `protectedSwatchSql`: a hex label or color_features points at it. */
  protected: boolean;
  /** Null when the blob could not be read or decoded: such an image is never removed or matched. */
  fingerprint: ImageFingerprint | null;
}

export interface GalleryDuplicateGroup {
  keepSwatchId: number;
  keepImageId: number;
  removeSwatchIds: number[];
  removeImageIds: number[];
  /** Duplicates left in place: a product swatch, protected, or stored by the current pipeline. */
  keptSwatchIds: number[];
  /** Largest distances inside the group, for the dry-run report. */
  maxHashDistance: number;
  maxThumbDistance: number;
}

/**
 * Keeper rank inside a duplicate group: the product swatch, then an image with a vendor URL
 * (current pipeline), then a protected swatch, then the newest image.
 */
function keeperOrder(a: ShadeGalleryImage, b: ShadeGalleryImage): number {
  const rank = (img: ShadeGalleryImage) => [
    img.swatchType === "source_product" ? 1 : 0,
    img.hasSourceUrl ? 1 : 0,
    img.protected ? 1 : 0,
    img.imageId,
  ];
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return rb[i] - ra[i];
  }
  return a.swatchId - b.swatchId;
}

/**
 * Group a shade's catalog images into near-duplicate clusters (single-linkage over
 * `compareFingerprints`; identical image ids always group) and choose one keeper per cluster.
 * Only unprotected `source_gallery` swatches without a `source_image_url` row are ever listed
 * for removal: an image the current pipeline stored is either still in the vendor's gallery
 * (ingestion would re-link it) or stale, which ingestion's `pruneStaleGallerySwatches` handles.
 */
export function planShadeGalleryDedupe(
  images: ShadeGalleryImage[],
  thresholds: DedupeThresholds = DEFAULT_DEDUPE_THRESHOLDS
): GalleryDuplicateGroup[] {
  const parent = images.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const stats = new Map<string, { hash: number; thumb: number }>();

  for (let i = 0; i < images.length; i += 1) {
    for (let j = i + 1; j < images.length; j += 1) {
      const a = images[i];
      const b = images[j];
      let same = a.imageId === b.imageId;
      let hash = 0;
      let thumb = 0;
      if (!same && a.fingerprint && b.fingerprint) {
        const comparison = compareFingerprints(a.fingerprint, b.fingerprint, thresholds);
        same = comparison.duplicate;
        hash = comparison.hashDistance;
        thumb = comparison.thumbDistance;
      }
      if (same) {
        parent[find(i)] = find(j);
        stats.set(`${i}:${j}`, { hash, thumb });
      }
    }
  }

  const clusters = new Map<number, number[]>();
  images.forEach((_, i) => {
    const root = find(i);
    clusters.set(root, [...(clusters.get(root) ?? []), i]);
  });

  const groups: GalleryDuplicateGroup[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const sorted = members.map((i) => images[i]).sort(keeperOrder);
    const [keeper, ...rest] = sorted;
    const removable = rest.filter((img) => img.swatchType === "source_gallery" && !img.protected && !img.hasSourceUrl);
    const kept = rest.filter((img) => !removable.includes(img));
    let maxHash = 0;
    let maxThumb = 0;
    for (const [key, value] of stats) {
      const [i, j] = key.split(":").map(Number);
      if (members.includes(i) && members.includes(j)) {
        maxHash = Math.max(maxHash, value.hash);
        maxThumb = Math.max(maxThumb, value.thumb);
      }
    }
    groups.push({
      keepSwatchId: keeper.swatchId,
      keepImageId: keeper.imageId,
      removeSwatchIds: removable.map((img) => img.swatchId),
      removeImageIds: removable.map((img) => img.imageId),
      keptSwatchIds: kept.map((img) => img.swatchId),
      maxHashDistance: maxHash,
      maxThumbDistance: Math.round(maxThumb * 10) / 10,
    });
  }
  return groups.sort((a, b) => a.keepSwatchId - b.keepSwatchId);
}

// ── Cleanup batch (POST /api/images-admin/gallery-dedupe) ───────────────────

type Queryable = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
};

export interface GalleryDedupeDeps {
  query: Queryable["query"];
  transaction: <T>(callback: (client: Queryable) => Promise<T>) => Promise<T>;
  /** Bytes of a catalog image; throw when it cannot be read. */
  readImage: (storageUrl: string) => Promise<Buffer>;
  /** Parallel blob reads (default 4). */
  concurrency?: number;
}

export interface GalleryDedupeOptions {
  afterShadeId: number;
  /** Shades per batch. */
  limit: number;
  /** Report only (the default for callers); false deletes the duplicate swatches. */
  dryRun: boolean;
  /**
   * Save fingerprints computed from blobs into `image_asset` (only where still empty), also in a
   * dry run: they are derived data with no visible effect, and they back ingestion's near-duplicate
   * check for images reused without a download. Default true; false makes the run read-only.
   */
  storeFingerprints?: boolean;
  /** Only these shades (still keyset-paged by `afterShadeId`). */
  shadeIds?: number[];
  thresholds?: DedupeThresholds;
}

export interface GalleryDedupeShadeReport extends GalleryDuplicateGroup {
  shadeId: number;
}

export interface GalleryDedupeBatchResult {
  dryRun: boolean;
  /** Shades with at least one gallery swatch read in this batch. */
  scannedShades: number;
  shadesWithDuplicates: number;
  /** Images whose fingerprint was already stored in `image_asset` (no blob read). */
  storedFingerprintsUsed: number;
  /** Distinct blobs read and fingerprinted (shades with a single image are not read). */
  imagesFingerprinted: number;
  /** `image_asset` rows whose fingerprint columns this batch filled in. */
  fingerprintsStored: number;
  /** Images whose blob could not be read or decoded; never removed or matched. */
  unreadableImages: number;
  duplicateGroups: number;
  /** Gallery swatches that are (dry run: would be) unlinked. */
  swatchesRemoved: number;
  /** Duplicates left linked: product swatch, protected, or stored by the current pipeline. */
  duplicatesKept: number;
  /** First 50 groups with something to remove, for review. */
  groups: GalleryDedupeShadeReport[];
  failures: { imageId: number; error: string }[];
  /** Pass as `afterShadeId` for the next batch; null when the scan is finished. */
  nextAfterShadeId: number | null;
}

const MAX_REPORTED_GROUPS = 50;
const MAX_REPORTED_FAILURES = 20;

/**
 * One keyset batch of the gallery duplicate cleanup: for each shade (`shade_id > afterShadeId`
 * with a `source_gallery` swatch, `limit` shades), fingerprint its catalog images and unlink the
 * gallery swatches that duplicate another of its images (`planShadeGalleryDedupe`). Stored
 * fingerprints (`image_asset.perceptual_hash` …) are used as is; only images without one are read
 * from blob storage, and those fingerprints are saved (`storeFingerprints`), so the scan doubles as
 * the fingerprint backfill. Idempotent; the `image_asset` rows and blobs are kept. Deletes re-check
 * the safety rules in SQL.
 */
export async function runGalleryDedupeBatch(
  deps: GalleryDedupeDeps,
  options: GalleryDedupeOptions
): Promise<GalleryDedupeBatchResult> {
  const thresholds = options.thresholds ?? DEFAULT_DEDUPE_THRESHOLDS;
  const shadeRows = await deps.query(
    `SELECT DISTINCT sw.shade_id::bigint AS "shadeId"
     FROM swatch sw
     WHERE sw.swatch_type = 'source_gallery'
       AND sw.shade_id > $1
       AND ($3::bigint[] IS NULL OR sw.shade_id = ANY($3::bigint[]))
     ORDER BY sw.shade_id
     LIMIT $2`,
    [options.afterShadeId, options.limit, options.shadeIds ?? null]
  );
  const shadeIds = shadeRows.rows.map((row) => Number(row.shadeId));

  const result: GalleryDedupeBatchResult = {
    dryRun: options.dryRun,
    scannedShades: shadeIds.length,
    shadesWithDuplicates: 0,
    storedFingerprintsUsed: 0,
    imagesFingerprinted: 0,
    fingerprintsStored: 0,
    unreadableImages: 0,
    duplicateGroups: 0,
    swatchesRemoved: 0,
    duplicatesKept: 0,
    groups: [],
    failures: [],
    nextAfterShadeId: shadeIds.length === options.limit ? shadeIds[shadeIds.length - 1] : null,
  };
  if (shadeIds.length === 0) return result;

  const imageRows = await deps.query(
    `SELECT
       sw.shade_id::bigint          AS "shadeId",
       sw.swatch_id::bigint         AS "swatchId",
       sw.image_id_original::bigint AS "imageId",
       sw.swatch_type               AS "swatchType",
       ia.storage_url               AS "storageUrl",
       ${fingerprintColumnsSql("ia")},
       EXISTS (SELECT 1 FROM source_image_url u WHERE u.image_id = ia.image_id) AS "hasSourceUrl",
       ${protectedSwatchSql("sw")} AS "protected"
     FROM swatch sw
     JOIN image_asset ia ON ia.image_id = sw.image_id_original
     WHERE sw.shade_id = ANY($1::bigint[])
       AND ia.owner_type = 'source'
     ORDER BY sw.shade_id, sw.swatch_id`,
    [shadeIds]
  );

  const byShade = new Map<number, Array<ShadeGalleryImage & { storageUrl: string }>>();
  for (const row of imageRows.rows) {
    const shadeId = Number(row.shadeId);
    const list = byShade.get(shadeId) ?? [];
    list.push({
      swatchId: Number(row.swatchId),
      imageId: Number(row.imageId),
      swatchType: row.swatchType ?? null,
      hasSourceUrl: row.hasSourceUrl === true,
      protected: row.protected === true,
      fingerprint: fingerprintFromColumns(row),
      storageUrl: String(row.storageUrl ?? ""),
    });
    byShade.set(shadeId, list);
  }

  // Read each distinct blob without a stored fingerprint once (an image can be linked to several
  // shades, and rows can share a storage URL).
  const toRead = new Map<string, number[]>();
  const storedUsed = new Set<number>();
  for (const images of byShade.values()) {
    if (images.length < 2) continue;
    for (const image of images) {
      if (image.fingerprint) {
        storedUsed.add(image.imageId);
        continue;
      }
      const ids = toRead.get(image.storageUrl) ?? [];
      if (!ids.includes(image.imageId)) ids.push(image.imageId);
      toRead.set(image.storageUrl, ids);
    }
  }
  result.storedFingerprintsUsed = storedUsed.size;
  const fingerprints = new Map<string, ImageFingerprint | null>();
  const queue = [...toRead];
  const workers = Array.from({ length: Math.max(1, deps.concurrency ?? 4) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [storageUrl, imageIds] = next;
      try {
        fingerprints.set(storageUrl, await computeImageFingerprint(await deps.readImage(storageUrl)));
        result.imagesFingerprinted += 1;
      } catch (error) {
        fingerprints.set(storageUrl, null);
        result.unreadableImages += 1;
        result.failures.push({ imageId: imageIds[0], error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  await Promise.all(workers);

  if (options.storeFingerprints !== false) {
    for (const [storageUrl, imageIds] of toRead) {
      for (const imageId of imageIds) {
        if (await storeImageFingerprint(deps, imageId, fingerprints.get(storageUrl))) {
          result.fingerprintsStored += 1;
        }
      }
    }
  }

  const plans: GalleryDedupeShadeReport[] = [];
  for (const [shadeId, images] of byShade) {
    if (images.length < 2) continue;
    const groups = planShadeGalleryDedupe(
      images.map((image) => ({ ...image, fingerprint: image.fingerprint ?? fingerprints.get(image.storageUrl) ?? null })),
      thresholds
    );
    if (groups.length === 0) continue;
    result.shadesWithDuplicates += 1;
    result.duplicateGroups += groups.length;
    for (const group of groups) {
      result.duplicatesKept += group.keptSwatchIds.length;
      if (group.removeSwatchIds.length > 0) plans.push({ shadeId, ...group });
    }
  }

  if (options.dryRun) {
    result.swatchesRemoved = plans.reduce((sum, plan) => sum + plan.removeSwatchIds.length, 0);
  } else if (plans.length > 0) {
    result.swatchesRemoved = await deps.transaction(async (client) => {
      let removed = 0;
      for (const plan of plans) {
        // Re-check at delete time: still an unprotected gallery swatch of a source image without
        // a vendor URL row, and the keeper is still linked to the shade.
        const deleted = await client.query(
          `DELETE FROM swatch sw
           USING image_asset ia
           WHERE sw.swatch_id = ANY($1::bigint[])
             AND sw.shade_id = $2
             AND sw.swatch_type = 'source_gallery'
             AND ia.image_id = sw.image_id_original
             AND ia.owner_type = 'source'
             AND NOT EXISTS (SELECT 1 FROM source_image_url u WHERE u.image_id = ia.image_id)
             AND NOT ${protectedSwatchSql("sw")}
             AND EXISTS (SELECT 1 FROM swatch keep WHERE keep.swatch_id = $3 AND keep.shade_id = $2)
           RETURNING sw.swatch_id`,
          [plan.removeSwatchIds, plan.shadeId, plan.keepSwatchId]
        );
        removed += deleted.rows.length;
      }
      return removed;
    });
  }

  result.groups = plans.slice(0, MAX_REPORTED_GROUPS);
  result.failures = result.failures.sort((a, b) => a.imageId - b.imageId).slice(0, MAX_REPORTED_FAILURES);
  return result;
}
