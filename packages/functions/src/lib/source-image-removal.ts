import { IMAGE_VARIANT_SIZES, imageVariantStorageUrl } from "./image-variants";

// ── Remove a source's catalog images (POST /api/images-admin/source-images/remove) ──
//
// When a store asks us to stop using its pictures, an admin disables its `data_source` and runs
// this job: every `image_asset` row the source owns (`owner_type = 'source'`, `owner_id` = the
// `data_source_id`) loses its swatches (`source_product` and `source_gallery`), then the row, then
// its blob and thumbnail variant blobs. A shade left without a `source_product` swatch falls back
// to its remaining gallery (the polish queries order product swatches first) or to no image (the
// display shows the hex). Kept: an image with a hex label (`color_training_sample`) or whose
// swatch has `color_features` (row, swatches and blob untouched); and the blob of an image whose
// storage URL or checksum another `image_asset` row shares (that row is removed, the blob stays).

type Queryable = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
};

export interface SourceImageRemovalDeps {
  query: Queryable["query"];
  transaction: <T>(callback: (client: Queryable) => Promise<T>) => Promise<T>;
  /** Delete one catalog blob; false when it did not exist. Throws on any other failure. */
  deleteBlob: (storageUrl: string) => Promise<boolean>;
  /**
   * Whether `storageUrl` is a blob of ours (the handler passes `isCatalogStorageUrl`). An image
   * kept at its vendor URL has none: its row is removed, no blob delete is issued or counted, in
   * the dry run and the real run alike.
   */
  ownsBlob: (storageUrl: string) => boolean;
}

/** A batch stops starting new images after this long (like the variants backfill). */
export const SOURCE_IMAGE_REMOVAL_TIME_BUDGET_MS = 45_000;

export interface SourceImageRemovalRunOptions {
  timeBudgetMs?: number;
  now?: () => number;
}

/** Thrown inside an image's transaction when the source was re-enabled mid-batch. */
class SourceReEnabledError extends Error {}

export interface SourceImageRemovalOptions {
  sourceName: string;
  afterImageId: number;
  /** Images per batch. */
  limit: number;
  /** Report only; false deletes. */
  dryRun: boolean;
}

export type SourceImageKeptReason = "labeled" | "color_features" | "shared_blob";

export interface SourceImageRemovalResult {
  dryRun: boolean;
  /** Images of the source read in this batch. */
  scanned: number;
  /** Swatch rows (dry run: that would be) deleted. */
  swatchesUnlinked: number;
  /** `image_asset` rows (dry run: that would be) deleted. */
  imagesDeleted: number;
  /** Original blobs deleted (dry run: to delete); variants are not counted. */
  blobsDeleted: number;
  kept: { imageId: number; reason: SourceImageKeptReason }[];
  failures: { imageId: number; error: string }[];
  /** Pass as `afterImageId` for the next batch; null when the scan is finished. */
  nextAfterImageId: number | null;
}

export type SourceImageRemovalOutcome =
  | { status: "ok"; result: SourceImageRemovalResult }
  | { status: "not_found" }
  | { status: "source_enabled" };

interface ImageFlags {
  imageId: number;
  storageUrl: string;
  labeled: boolean;
  colorFeatures: boolean;
  swatchCount: number;
  sharedBlob: boolean;
}

/** Per-image facts the decision needs; `ia` is the `image_asset` alias. */
const IMAGE_FLAGS_SQL = `
       ia.image_id::bigint AS "imageId",
       ia.storage_url      AS "storageUrl",
       EXISTS (SELECT 1 FROM color_training_sample cts WHERE cts.image_id = ia.image_id) AS "labeled",
       EXISTS (
         SELECT 1 FROM swatch sw JOIN color_features cf ON cf.swatch_id = sw.swatch_id
         WHERE sw.image_id_original = ia.image_id OR sw.image_id_normalized = ia.image_id
       ) AS "colorFeatures",
       (SELECT count(*) FROM swatch sw
         WHERE sw.image_id_original = ia.image_id OR sw.image_id_normalized = ia.image_id)::int AS "swatchCount",
       EXISTS (
         SELECT 1 FROM image_asset other
         WHERE other.image_id <> ia.image_id
           AND (other.storage_url = ia.storage_url
                OR (ia.checksum_sha256 IS NOT NULL AND other.checksum_sha256 = ia.checksum_sha256))
       ) AS "sharedBlob"`;

function toFlags(row: any): ImageFlags {
  return {
    imageId: Number(row.imageId),
    storageUrl: String(row.storageUrl ?? ""),
    labeled: row.labeled === true,
    colorFeatures: row.colorFeatures === true,
    swatchCount: Number(row.swatchCount ?? 0),
    sharedBlob: row.sharedBlob === true,
  };
}

function protectionReason(flags: ImageFlags): SourceImageKeptReason | null {
  if (flags.labeled) return "labeled";
  if (flags.colorFeatures) return "color_features";
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One keyset batch (`image_id > afterImageId`, `limit` images) of the source image removal. Runs
 * only on a disabled source (`source_enabled` otherwise, `not_found` for an unknown name), both
 * checked before any scan. Each image is removed in its own transaction that re-checks that the
 * source is still disabled (`source_enabled` aborts the batch otherwise) and re-reads the image's
 * flags (scoped to the source) under `FOR UPDATE`; a transaction that throws is recorded in
 * `failures` and the batch goes on. The batch stops starting images after
 * `SOURCE_IMAGE_REMOVAL_TIME_BUDGET_MS` and returns the last finished image as the cursor. Blob
 * deletes (only for `ownsBlob` URLs) run after the transaction commits, and a blob failure is recorded in
 * `failures` without undoing the row delete (the orphaned blob is harmless; the run is idempotent).
 */
export async function runSourceImageRemovalBatch(
  deps: SourceImageRemovalDeps,
  options: SourceImageRemovalOptions,
  run: SourceImageRemovalRunOptions = {}
): Promise<SourceImageRemovalOutcome> {
  const now = run.now ?? Date.now;
  const timeBudgetMs = run.timeBudgetMs ?? SOURCE_IMAGE_REMOVAL_TIME_BUDGET_MS;
  const startedAt = now();
  const source = await deps.query(
    `SELECT data_source_id::bigint AS "dataSourceId", enabled
     FROM data_source
     WHERE name = $1`,
    [options.sourceName]
  );
  if (source.rows.length === 0) return { status: "not_found" };
  if (source.rows[0].enabled === true) return { status: "source_enabled" };
  const dataSourceId = Number(source.rows[0].dataSourceId);

  const scan = await deps.query(
    `SELECT ${IMAGE_FLAGS_SQL}
     FROM image_asset ia
     WHERE ia.owner_type = 'source'
       AND ia.owner_id = $1
       AND ia.image_id > $2
     ORDER BY ia.image_id
     LIMIT $3`,
    [dataSourceId, options.afterImageId, options.limit]
  );
  const images = scan.rows.map(toFlags);

  const result: SourceImageRemovalResult = {
    dryRun: options.dryRun,
    scanned: images.length,
    swatchesUnlinked: 0,
    imagesDeleted: 0,
    blobsDeleted: 0,
    kept: [],
    failures: [],
    nextAfterImageId: null,
  };

  // The first image always runs; once the budget is spent the rest wait for the next batch.
  let processed = 0;
  for (const scanned of images) {
    if (processed > 0 && now() - startedAt >= timeBudgetMs) break;
    processed += 1;
    if (options.dryRun) {
      const reason = protectionReason(scanned);
      if (reason) {
        result.kept.push({ imageId: scanned.imageId, reason });
        continue;
      }
      result.swatchesUnlinked += scanned.swatchCount;
      result.imagesDeleted += 1;
      if (scanned.sharedBlob) result.kept.push({ imageId: scanned.imageId, reason: "shared_blob" });
      else if (deps.ownsBlob(scanned.storageUrl)) result.blobsDeleted += 1;
      continue;
    }

    let removed: { flags: ImageFlags; swatches: number } | { kept: SourceImageKeptReason } | null;
    try {
      removed = await deps.transaction(async (client) => {
        // The source may have been re-enabled since the batch started: stop before deleting.
        const state = await client.query(
          `SELECT enabled FROM data_source WHERE data_source_id = $1 FOR SHARE`,
          [dataSourceId]
        );
        if (state.rows[0]?.enabled !== false) throw new SourceReEnabledError();
        const current = await client.query(
          `SELECT ${IMAGE_FLAGS_SQL}
           FROM image_asset ia
           WHERE ia.image_id = $1
             AND ia.owner_type = 'source'
             AND ia.owner_id = $2
           FOR UPDATE`,
          [scanned.imageId, dataSourceId]
        );
        if (current.rows.length === 0) return null; // already gone
        const flags = toFlags(current.rows[0]);
        const reason = protectionReason(flags);
        if (reason) return { kept: reason };
        const swatches = await client.query(
          `DELETE FROM swatch
           WHERE image_id_original = $1 OR image_id_normalized = $1
           RETURNING swatch_id AS "swatchId"`,
          [flags.imageId]
        );
        await client.query(`DELETE FROM image_asset WHERE image_id = $1 RETURNING image_id AS "imageId"`, [
          flags.imageId,
        ]);
        return { flags, swatches: swatches.rows.length };
      });
    } catch (error) {
      if (error instanceof SourceReEnabledError) return { status: "source_enabled" };
      result.failures.push({ imageId: scanned.imageId, error: errorMessage(error) });
      continue;
    }
    if (removed === null) continue;
    if ("kept" in removed) {
      result.kept.push({ imageId: scanned.imageId, reason: removed.kept });
      continue;
    }

    result.swatchesUnlinked += removed.swatches;
    result.imagesDeleted += 1;
    if (removed.flags.sharedBlob) {
      result.kept.push({ imageId: scanned.imageId, reason: "shared_blob" });
      continue;
    }
    if (!deps.ownsBlob(removed.flags.storageUrl)) continue; // vendor URL: no blob of ours
    try {
      const storageUrl = removed.flags.storageUrl;
      for (const size of IMAGE_VARIANT_SIZES) {
        const variantUrl = imageVariantStorageUrl(storageUrl, size);
        if (variantUrl) await deps.deleteBlob(variantUrl);
      }
      if (await deps.deleteBlob(storageUrl)) result.blobsDeleted += 1;
    } catch (error) {
      result.failures.push({ imageId: scanned.imageId, error: errorMessage(error) });
    }
  }

  result.scanned = processed;
  if (processed < images.length || images.length === options.limit) {
    result.nextAfterImageId = images[processed - 1].imageId;
  }
  return { status: "ok", result };
}
