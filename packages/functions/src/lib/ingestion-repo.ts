import { query, transaction } from "./db";
import { ConnectorProductRecord } from "./connectors/types";
import { SUPPORTED_SOURCES } from "./connectors/types";
import { isShopifyProductsSource } from "./connectors/registry";
import { defaultShopifyBaseUrl, isShopifyRetailerSource, isShopifySourceEnabledByDefault } from "./connectors/shopify-generic";
import { detectHexWithAzureOpenAI, type HexDetectionOptions } from "./ai-color-detection";
import {
  chooseUploadedImageForDetection,
  parseProductImageCandidates,
  type ProductImageCandidate,
  type UploadedImageChoice,
  type UploadedImageRef,
} from "./image-selection";
import {
  detectedHexProvenanceSetSql,
  provenanceFromDetection,
  provenanceParams,
  EMPTY_DETECTED_HEX_PROVENANCE,
  type DetectedHexProvenance,
} from "./hex-provenance";
import { submitVisionHexBatch } from "./azure-openai-batch";
import { uploadSourceImageToBlob, ensureContainer } from "./blob-storage";
import { describeImageStoreFailure } from "./image-store-error";
import { toImageProxyUrlFromOrigin } from "./image-proxy";
import { snapDetectionToImage, type HexSnapLogLevel } from "./hex-snap";
import { loadDetectionImageBytes } from "./detection-image";
import { withHexDetectionTotals } from "./ingestion-hex-totals";
import { describeFetchError } from "./fetch-retry";
import pLimit = require("p-limit");
import {
  buildSuspiciousHexContext,
  classifySuspiciousHex,
  type SuspiciousHexContext,
} from "./suspicious-hex";
import {
  loadFinishCatalog,
  mergeFinishLists,
  type FinishCatalog,
} from "./finishes";
import {
  applyIngestedFinishes,
  resolveNormalizedProductFinishes,
  type IngestedFinishResolution,
} from "./finish-text";
import { readProductText } from "./product-text";
import { classifyProductCategory } from "./product-category";
import { finishFamily, resolveProductCategory, type ProductCategory } from "swatchwatch-shared";
import { PoolClient } from "pg";
import { recordShadeSourceProduct } from "./buy-link";
import { MAKEUPAPI_CODE_SUFFIX_PATTERN, makeupApiNameKey, makeupApiNameKeySql } from "./makeupapi-dedupe";
import { materializeProductBarcodes, type BarcodeConflict } from "./barcodes";
import { correctBrandStoreShade, type BrandStoreCorrection } from "./brand-store-correction";
import { invalidatePolishCachesForUser } from "./polish-cache";
import {
  fingerprintColumnsSql,
  fingerprintFromColumns,
  fingerprintToColumns,
  getGalleryMaxImagesPerShade,
  planProductGalleryLinks,
  protectedSwatchSql,
  pruneStaleGallerySwatches,
  unlinkRetailerGallerySwatches,
  shadeSharedWithOtherProduct,
  storeImageFingerprint,
  type FingerprintColumns,
  type ImageFingerprint,
} from "./gallery-dedupe";
import { getSourceImageMaxPerProduct, planProductImageDownloads } from "./product-image-cap";
import { trackEvent } from "./telemetry";
import {
  catalogAuthorityForKind,
  isBrandSourceSql,
  planIngestedFinishes,
  planListingWrites,
  readIngestionSwitches,
  readSourceKind,
  type CatalogAuthority,
  type SourceKind,
} from "./source-settings";
import {
  ingestedVendorHexParams,
  ingestedVendorHexSetSql,
  planIngestedVendorHex,
  SHADE_VENDOR_HEX_COLUMNS,
  type ShadeVendorHexState,
} from "./vendor-hex";

export interface DataSourceRecord {
  dataSourceId: number;
  name: string;
  baseUrl: string | null;
  /**
   * Store currency set by hand in `data_source.metadata.currency` (raw value; connectors
   * validate it with `normalizeCurrencyCode`). Shopify connectors otherwise ask the shop.
   */
  currency?: string | null;
  /** Raw `data_source.metadata` (source kind, image permission, connector keys); see `readSourceSettings`. */
  metadata?: Record<string, unknown> | null;
  /** `data_source.enabled`; set by `getDataSourceByName` (the run endpoints refuse a disabled source). */
  enabled?: boolean;
}

export interface IngestionJobRecord {
  jobId: string;
  source: string;
  jobType: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  metrics?: Record<string, unknown>;
  error?: string;
}

export interface IngestionJobStartRecord {
  jobId: number;
  startedAt: string;
}

export interface ExternalProductUpsertMetrics {
  processed: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export interface MakeupApiMaterializationMetrics {
  variantRowsProcessed: number;
  brandsCreated: number;
  shadesCreated: number;
  skipped: number;
  /** Variants matched to an existing shade: only the MakeupAPI listing was recorded. */
  existingShadesLinked: number;
  /** Variants whose name matches several catalog shades of the brand: skipped, nothing created. */
  ambiguousShadesSkipped: number;
}

export interface HoloTacoMaterializationMetrics {
  processed: number;
  brandsCreated: number;
  shadesCreated: number;
  hexOverwritten: number;
  imageCandidates: number;
  imageUploads: number;
  imageUploadFailures: number;
  /** Gallery images not downloaded because of `SOURCE_IMAGE_MAX_PER_PRODUCT` (lib/product-image-cap.ts). */
  imagesSkippedByCap?: number;
  swatchesLinked: number;
  /**
   * `source_gallery` swatches unlinked: the product no longer lists the image, or a previous run
   * linked an image that is now skipped as a near-duplicate or over the cap.
   */
  gallerySwatchesPruned: number;
  /** Additional images not linked because they near-duplicate an image already linked for the product. */
  galleryNearDuplicatesSkipped: number;
  /** Additional images not linked because the product reached `GALLERY_MAX_IMAGES_PER_SHADE`. */
  galleryOverCapSkipped: number;
  /** Catalog `barcode` rows newly linked (product GTIN + variant barcodes, #21). */
  barcodesLinked: number;
  /** GTINs skipped because another shade already owns them (each one is in the job log). */
  barcodeConflicts: number;
  /** Records skipped because several shades fit them (each one is in the job log with the ids). */
  ambiguousShadesSkipped: number;
  /** Brand store corrections (`correctBrandStoreShade`): shades moved to the record's brand. */
  brandStoreShadesMoved: number;
  /** Shades renamed to the store's clean name (in place, with or without a brand move). */
  brandStoreShadesRenamed: number;
  /** Shades merged into the record's brand's existing shade. */
  brandStoreShadesMerged: number;
  /** Corrections skipped (protected shade, another brand store's listing, ambiguous target; each in the job log). */
  brandStoreCorrectionsSkipped: number;
  hexDetected: number;
  hexDetectionFailures: number;
  hexDetectionSkipped: number;
  hexDetectionPromptTokens?: number;
  hexDetectionCompletionTokens?: number;
  hexDetectionTotalTokens?: number;
  batchRequestsQueued?: number;
  aiBatch?: HoloTacoAiBatchDetails;
  skipped: number;
}

export interface HoloTacoMaterializationOptions {
  detectHexFromImage?: boolean;
  overwriteDetectedHex?: boolean;
  detectHexOnSuspiciousOnly?: boolean;
  useBatchForHexDetection?: boolean;
  batchMinImages?: number;
  /**
   * Kind of the data source (`data_source.metadata.kind`, `SourceSettings.kind`);
   * `materializeHoloTacoRecords` reads it from the database when unset. A `retailer` or `feed`
   * record adopts the brand's existing shade (any active or excluded same-name shade,
   * disambiguated by finish family) and writes it only under `planListingWrites` (fill-only on a
   * brand-store shade, images only to a shade without another source's product image, never a
   * replaced detected hex). Default `brand`: adopts only a same-name shade a retailer or feed
   * created (`catalog_authority = 'retailer'`) with no legacy finish and no collection, and takes
   * it over.
   */
  sourceKind?: SourceKind;
  /**
   * Job log sink (the worker's JobLogger). It receives milestones only: phase start/finish
   * with elapsed time, one summary per call, and every per-record warning/error. Step-by-step
   * per-record lines stay console-only so a whole-store run fits the bounded job log.
   */
  progressLogger?: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
  };
  /** Names the records in the summary line, e.g. "Records 11–20 of 250 on page 3". */
  chunkLabel?: string;
  /**
   * `false` (a source whose images are not permitted, `SourceSettings.imagesPermitted`): no image
   * is downloaded, stored or linked and no AI hex detection runs. Default true.
   */
  storeImages?: boolean;
  /**
   * Source the records come from. A record without a brand is skipped unless this is
   * `HoloTacoShopify` (or unset), which falls back to the "Holo Taco" brand.
   */
  sourceName?: string;
  /**
   * The admin who queued the job: the `admin_audit_event` actor of a brand-store correction
   * (`correctBrandStoreShade`). Unset or null: the correction is only in the job log.
   */
  actorUserId?: number | null;
}

interface MakeupColorVariant {
  name: string | null;
  hex: string | null;
}

interface MakeupProductNormalized {
  brand: string | null;
  name: string | null;
  colorVariants: MakeupColorVariant[];
  tags: string[];
}

export interface HoloTacoProductNormalized {
  brand: string | null;
  name: string | null;
  /** Original product title when it differs from the cleaned `name` (e.g. a trailing " PPU"); else null. */
  rawTitle: string | null;
  collection: string | null;
  /**
   * Legacy single finish: raw first `finishes` value from the connector. Still the
   * shade identity key (shade.finish), so it is intentionally NOT canonicalized here.
   */
  finish: string | null;
  primaryImageUrl: string | null;
  imageUrls: string[];
  /** `imageUrls` with Shopify alt text / position when the connector kept them (see image-selection.ts). */
  images: ProductImageCandidate[];
  tags: string[];
  vendorHex: string | null;
  nameHex: string | null;
  colorName: string | null;
  /** Vendor description / descriptors (#352), forwarded to the vision prompt as a finish hint. */
  descriptionText: string | null;
  descriptors: string[];
  /**
   * Rule category of the product (#349): name, color name, product type, tags and raw finishes
   * through `classifyProductCategory`. Hex detection runs only for `color`.
   */
  productCategory: ProductCategory;
}

/** A source image stored in blob storage, keyed by the connector URL it was downloaded from. */
interface StoredSourceImage {
  sourceUrl: string;
  storageUrl: string;
  checksumSha256: string;
  /** Perceptual fingerprint of the stored bytes (from the upload, or `image_asset` when reused); null when unknown. */
  fingerprint: ImageFingerprint | null;
}

interface HoloTacoPreparedImage {
  storageUrl: string | null;
  checksumSha256: string | null;
  /** Perceptual fingerprint of the primary image (null when unknown). */
  fingerprint: ImageFingerprint | null;
  /**
   * Connector URL of the image AI hex detection chose (chooseUploadedImageForDetection), which may
   * be a gallery image: it is always linked to the shade, never skipped as a near-duplicate or
   * over the gallery cap, so the unchanged-image check keeps finding it.
   */
  detectionSourceUrl: string | null;
  /** Connector URL of the primary image; recorded in source_image_url so reruns can skip it. */
  sourceUrl: string | null;
  detectedHex: string | null;
  detectedFinishes: string[] | null;
  /** Provenance for `detectedHex` (null when no detection ran). */
  detectedHexProvenance: DetectedHexProvenance | null;
  /**
   * AI detection applies to this record (job detection on, a color polish, an image to read), so a
   * brand store taking over a retailer shade waits for its hex before flipping `catalog_authority`.
   */
  detectionApplies: boolean;
  additionalImages: StoredSourceImage[];
  /**
   * The primary and every additional image of the product were stored this run, so
   * `additionalImages` is the product's whole current gallery and stale gallery swatches can be
   * pruned (`pruneStaleGallerySwatches`). False when any download failed.
   */
  imageSetComplete: boolean;
  /**
   * The record's shade, resolved before any image work (`preResolveRecordShades`); unset when it
   * could not be resolved there (no name or brand, or the lookup failed). The materializer reuses
   * it only for an adopting source; a brand source (and any `create`) is looked up again.
   */
  shadeResolution?: ExistingShadeLookup;
}

interface HoloTacoImagePreparationMetrics {
  imageCandidates: number;
  /** Primary images downloaded and uploaded this run (reused images are not counted). */
  imageUploads: number;
  imageUploadFailures: number;
  /** Gallery images downloaded and uploaded this run (reused images are not counted). */
  additionalImagesUploaded: number;
  /** Primary and gallery images whose source URL was already stored, so no download ran. */
  imagesReused: number;
  /**
   * Gallery images not downloaded because the product has more images than
   * `SOURCE_IMAGE_MAX_PER_PRODUCT` (lib/product-image-cap.ts). An image past the cap whose URL an
   * earlier run already stored is reused instead (counted in `imagesReused`, not here).
   */
  imagesSkippedByCap: number;
  hexDetected: number;
  hexDetectionFailures: number;
  hexDetectionSkipped: number;
  /** Subset of hexDetectionSkipped: same image as last run and the shade already has a hex. */
  hexDetectionSkippedUnchanged: number;
  /** Subset of hexDetectionSkipped: not a color polish (topper, coat, treatment; #349, D-D). */
  hexDetectionSkippedCategory: number;
  /** Subset of hexDetected whose hex was replaced by a measured palette chip (`HEX_DETECTION_SNAP_ENABLED`). */
  hexSnapped: number;
  batchRequestsQueued: number;
  batchFallbacks: number;
  hexDetectionPromptTokens: number;
  hexDetectionCompletionTokens: number;
  hexDetectionTotalTokens: number;
}

export interface HoloTacoAiBatchDetails {
  batchId: string;
  inputFileId: string;
  requestCount: number;
  submittedAt: string;
  status: "submitted";
  overwriteDetectedHex: boolean;
  /** Deployment / prompt the batch was built with; the poller stamps applied results with these. */
  deployment: string | null;
  promptVersion: string | null;
}

interface HoloTacoImagePreparationResult {
  byExternalId: Map<string, HoloTacoPreparedImage>;
  metrics: HoloTacoImagePreparationMetrics;
  aiBatch: HoloTacoAiBatchDetails | null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function canonicalizeBrandName(rawBrand: string): string {
  if (!/[A-Z]/.test(rawBrand)) {
    return rawBrand.replace(/\b([a-z])/g, (match) => match.toUpperCase());
  }
  return rawBrand;
}

function parseMakeupVariants(value: unknown): MakeupColorVariant[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return { name: null, hex: null };
    }

    const row = entry as Record<string, unknown>;
    return {
      name: asString(row.name),
      hex: asString(row.hex),
    };
  });
}

function parseMakeupNormalized(
  normalized: Record<string, unknown>
): MakeupProductNormalized {
  return {
    brand: asString(normalized.brand),
    name: asString(normalized.name),
    colorVariants: parseMakeupVariants(normalized.colorVariants),
    tags: asStringArray(normalized.tags),
  };
}

/**
 * Scalar subquery: the brand id whose canonical name equals the parameter (case-insensitive),
 * else the brand that has it as an alias, lowest id first. `param` is a SQL expression
 * such as `$1` or `input.brand_name`.
 */
export function INGESTED_BRAND_ID_SQL(param: string): string {
  return `(SELECT candidate.brand_id FROM (
    SELECT b.brand_id, 0 AS rank FROM brand b WHERE lower(b.name_canonical) = lower(${param})
    UNION ALL
    SELECT ba.brand_id, 1 AS rank FROM brand_alias ba WHERE lower(ba.alias) = lower(${param})
  ) candidate ORDER BY candidate.rank, candidate.brand_id LIMIT 1)`;
}

interface IngestedShadeQuery {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Finds the shade an ingested product belongs to: by the cleaned name first, then (when it
 * differs) by the raw product title an earlier ingest may have stored it under.
 */
export async function findShadeForIngestedName(
  client: IngestedShadeQuery,
  args: {
    brandId: number;
    name: string;
    rawTitle: string | null;
    finish: string | null;
    collection: string | null;
  }
): Promise<{ shadeId: number; matchedRaw: boolean } | null> {
  const byName = await client.query<{ shadeId: number }>(SHADE_BY_NAME_SQL, [
    args.brandId,
    args.name,
    args.finish,
    args.collection,
  ]);
  if (byName.rows.length > 0) return { shadeId: byName.rows[0].shadeId, matchedRaw: false };
  const rawShadeId = await findShadeByRawTitle(client, args);
  return rawShadeId !== null ? { shadeId: rawShadeId, matchedRaw: true } : null;
}

const SHADE_BY_NAME_SQL = `SELECT shade_id AS "shadeId"
     FROM shade
     WHERE brand_id = $1
       AND product_line_id IS NULL
       AND lower(shade_name_canonical) = lower($2)
       AND coalesce(finish, '') = coalesce($3, '')
       AND coalesce(collection, '') = coalesce($4, '')
     ORDER BY shade_id
     LIMIT 1`;

/**
 * The shade an earlier brand-store ingest stored under the raw store title. It is renamed
 * afterwards, so it must be a shared catalog row: never a user's private (`user_submitted`)
 * shade and never a merged-away one.
 */
export const SHADE_BY_RAW_TITLE_SQL = SHADE_BY_NAME_SQL.replace(
  "AND product_line_id IS NULL",
  "AND product_line_id IS NULL\n       AND status <> 'user_submitted'\n       AND merged_into_shade_id IS NULL"
);

/** The shade stored under `rawTitle` (when it differs from the clean name), else null. */
export async function findShadeByRawTitle(
  client: IngestedShadeQuery,
  args: { brandId: number; name: string; rawTitle: string | null; finish: string | null; collection: string | null }
): Promise<number | null> {
  if (!args.rawTitle || args.rawTitle.toLowerCase() === args.name.toLowerCase()) return null;
  const byRaw = await client.query<{ shadeId: number }>(SHADE_BY_RAW_TITLE_SQL, [
    args.brandId,
    args.rawTitle,
    args.finish,
    args.collection,
  ]);
  return byRaw.rows.length > 0 ? byRaw.rows[0].shadeId : null;
}

/** True when a raw-title shade exists that is a different row than the clean-name match (an admin should merge them). */
export function isRawTitleDuplicate(matchedShadeId: number, rawShadeId: number | null): boolean {
  return rawShadeId !== null && rawShadeId !== matchedShadeId;
}

/** Aliases a retailer listing adds to its shade: the vendor code and the raw listing title. */
async function recordRetailerAliases(
  client: IngestedShadeQuery,
  shadeId: number,
  shadeName: string,
  normalized: Record<string, unknown>
): Promise<void> {
  const name = shadeName.trim().toLowerCase();
  const seen = new Set<string>([name]);
  for (const key of ["vendorCode", "listingTitle"] as const) {
    const value = normalized[key];
    if (typeof value !== "string") continue;
    const alias = value.trim();
    if (!alias || seen.has(alias.toLowerCase())) continue;
    seen.add(alias.toLowerCase());
    await client.query(
      "INSERT INTO shade_alias (shade_id, alias) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [shadeId, alias]
    );
  }
}

/** Renames a shade stored under a raw title to the cleaned name and keeps the raw title as an alias. */
export async function renameShadeToCleanName(
  client: IngestedShadeQuery,
  shadeId: number,
  name: string,
  rawTitle: string
): Promise<void> {
  await client.query(`UPDATE shade SET shade_name_canonical = $2 WHERE shade_id = $1`, [shadeId, name]);
  await client.query(
    `INSERT INTO shade_alias (shade_id, alias) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [shadeId, rawTitle]
  );
}

/** Looks up a brand by name or alias; null when neither matches. */
export async function findIngestedBrandId(client: IngestedShadeQuery, brandName: string): Promise<number | null> {
  const result = await client.query<{ brandId: number | null }>(
    `SELECT ${INGESTED_BRAND_ID_SQL("$1")} AS "brandId"`,
    [brandName]
  );
  return result.rows[0]?.brandId ?? null;
}

/** Reads a stored Shopify-style `normalized_json` back into its typed product shape. */
export function parseHoloTacoNormalized(
  normalized: Record<string, unknown>
): HoloTacoProductNormalized {
  const collections = asStringArray(normalized.collections);
  const finishes = asStringArray(normalized.finishes);
  const name = asString(normalized.name);
  const colorName = asString(normalized.colorName);
  const tags = asStringArray(normalized.tags);
  const { category: productCategory } = classifyProductCategory({
    shadeName: name,
    colorName,
    finishes,
    // Classify from the raw product title: the cleaned name may have lost a coat cue
    // ("Base Coat by X | Shade" -> "Shade").
    products: [
      { title: asString(normalized.rawTitle) ?? name, productType: asString(normalized.productType), tags },
    ],
  });
  return {
    brand: asString(normalized.brand),
    name: asString(normalized.name),
    rawTitle: (() => {
      const raw = asString(normalized.rawTitle);
      return raw && raw !== name ? raw : null;
    })(),
    collection: collections[0] || null,
    finish: finishes[0] || null,
    primaryImageUrl: asString(normalized.primaryImageUrl),
    imageUrls: asStringArray(normalized.imageUrls),
    images: parseProductImageCandidates(normalized.images, asStringArray(normalized.imageUrls)),
    tags: asStringArray(normalized.tags),
    vendorHex: asString(normalized.vendorHex),
    nameHex: asString(normalized.nameHex),
    colorName: asString(normalized.colorName),
    ...readProductText(normalized),
    productCategory,
  };
}

/** Vision-prompt vendor context for an ingested product (same for the sync and batch paths). */
function holoTacoVendorContext(holo: HoloTacoProductNormalized): HexDetectionOptions["vendorContext"] {
  return {
    shadeName: holo.name,
    vendorHex: holo.vendorHex,
    tags: holo.tags,
    vendorJson: {
      finish: holo.finish,
      colorName: holo.colorName,
      collection: holo.collection,
    },
    descriptionText: holo.descriptionText,
    descriptors: holo.descriptors,
  };
}

/** Vision hex detection runs on color polishes only (#349, D-D). */
function detectsHex(holo: HoloTacoProductNormalized): boolean {
  return holo.productCategory === "color";
}

/**
 * Canonical finishes for an ingested product and where they came from: vendor tags
 * (`finish:<value>` + bare `<value>` tags) win, then descriptors, then description text (#352;
 * `resolveProductFinishes` in lib/finish-text.ts). The brand is masked out of the text.
 */
export function resolveIngestedShadeFinishResolution(
  normalized: Record<string, unknown> | null | undefined,
  catalog?: FinishCatalog
): IngestedFinishResolution {
  return resolveNormalizedProductFinishes(normalized, catalog);
}

/** Canonical finishes for an ingested product (see `resolveIngestedShadeFinishResolution`). */
export function resolveIngestedShadeFinishes(
  normalized: Record<string, unknown> | null | undefined,
  catalog?: FinishCatalog
): string[] {
  return resolveIngestedShadeFinishResolution(normalized, catalog).finishes;
}

/**
 * Write the classifier's category to an ingested shade (#349). Never touches a category an admin
 * set (`product_category_source = 'admin'`); a no-op when it is already right.
 */
export async function applyRuleProductCategory(
  client: Pick<PoolClient, "query">,
  shadeId: number,
  category: ProductCategory
): Promise<void> {
  await client.query(
    `UPDATE shade
     SET product_category = $2
     WHERE shade_id = $1
       AND product_category_source <> 'admin'
       AND product_category IS DISTINCT FROM $2`,
    [shadeId, category]
  );
}

function isHttpUrl(value: string | null): value is string {
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Pause between synchronous hex detection calls. The original 6s pacing targeted
// high-detail images (~26k prompt tokens each on gpt-4o-mini); low-detail calls cost ~3k,
// and 429s are already retried with Retry-After in ai-color-detection.
const DEFAULT_HEX_DETECTION_DELAY_MS = 1000;
const MAX_HEX_DETECTION_DELAY_MS = 60000;

function getHexDetectionDelayMs(): number {
  const parsed = Number.parseInt(process.env.HEX_DETECTION_DELAY_MS || "", 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_HEX_DETECTION_DELAY_MS;
  }
  return Math.min(MAX_HEX_DETECTION_DELAY_MS, Math.max(0, parsed));
}

// Synchronous hex detection calls in flight at once; each slot still pauses
// HEX_DETECTION_DELAY_MS after its call. The deployment's tokens-per-minute quota is the
// real ceiling, so raise this together with deployment capacity.
const DEFAULT_HEX_DETECTION_CONCURRENCY = 4;
const MAX_HEX_DETECTION_CONCURRENCY = 32;

function getHexDetectionConcurrency(): number {
  const parsed = Number.parseInt(process.env.HEX_DETECTION_CONCURRENCY || "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_HEX_DETECTION_CONCURRENCY;
  }
  return Math.min(MAX_HEX_DETECTION_CONCURRENCY, parsed);
}
const DEFAULT_HEX_BATCH_MIN_IMAGES = 5;
const INGESTION_AI_IMAGE_PROXY_ORIGIN = resolveIngestionAiImageProxyOrigin();
const HAS_STORAGE_CONNECTION = Boolean(process.env.AZURE_STORAGE_CONNECTION?.trim());

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveIngestionAiImageProxyOrigin(): string | null {
  const configured = process.env.INGESTION_AI_IMAGE_PROXY_ORIGIN?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return `${parsed.protocol}//${parsed.host}`;
      }
    } catch {
      // Fall through to WEBSITE_HOSTNAME.
    }
  }

  const hostname = process.env.WEBSITE_HOSTNAME?.trim();
  if (hostname) {
    return `https://${hostname}`;
  }

  return null;
}

function resolveAiImageUrl(storageUrl: string | null): string | null {
  if (!storageUrl || !isHttpUrl(storageUrl)) {
    return null;
  }

  if (HAS_STORAGE_CONNECTION) {
    if (!INGESTION_AI_IMAGE_PROXY_ORIGIN) {
      // When using storage but no proxy origin is available, skip AI detection.
      return null;
    }

    try {
      // Only ever catalog (SOURCE_IMAGE_CONTAINER) URLs from uploadSourceImageToBlob reach here, so this always mints a public v2 id Azure OpenAI can fetch anonymously (#227).
      return toImageProxyUrlFromOrigin(INGESTION_AI_IMAGE_PROXY_ORIGIN, storageUrl);
    } catch (error) {
      console.warn(
        `[ingestion-repo] Failed to build image proxy URL for AI detection, skipping image: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      // Avoid falling back to a likely-private blob URL that Azure OpenAI cannot fetch.
      return null;
    }
  }

  // No storage connection configured: the raw URL is expected to be directly accessible.
  return storageUrl;
}

function mergeStringArrays(
  existing: string[] | null | undefined,
  incoming: string[] | null | undefined
): string[] | null {
  const merged = Array.from(
    new Set([...(existing || []), ...(incoming || [])].map((entry) => entry.trim()).filter(Boolean))
  );
  return merged.length ? merged : null;
}

/**
 * Batch-level suspicious-hex context for one data source: counts repeated
 * vendor hexes so store template defaults (the same hex on 40 shades) are
 * caught alongside the static placeholder list.
 */
function buildVendorHexContext(records: ConnectorProductRecord[]): SuspiciousHexContext {
  const vendorHexes: Array<string | null> = [];
  for (const record of records) {
    const normalized =
      record.normalized && typeof record.normalized === "object"
        ? (record.normalized as Record<string, unknown>)
        : null;
    vendorHexes.push(normalized ? asString(normalized.vendorHex) : null);
  }
  return buildSuspiciousHexContext(vendorHexes);
}

function estimateBatchCandidateCount(
  records: ConnectorProductRecord[],
  detectHexFromImage: boolean,
  detectHexOnSuspiciousOnly: boolean,
  suspiciousContext: SuspiciousHexContext,
  adminCategories: ReadonlyMap<string, ProductCategory> = new Map()
): number {
  if (!detectHexFromImage) {
    return 0;
  }

  let count = 0;
  for (const record of records) {
    const normalized =
      record.normalized && typeof record.normalized === "object"
        ? (record.normalized as Record<string, unknown>)
        : null;
    if (!normalized) {
      continue;
    }

    const holo = parseHoloTacoNormalized(normalized);
    holo.productCategory = adminCategories.get(record.externalId) ?? holo.productCategory;
    if (!holo.name || !isHttpUrl(holo.primaryImageUrl) || !detectsHex(holo)) {
      continue;
    }

    const shouldRunAiDetection =
      !detectHexOnSuspiciousOnly ||
      classifySuspiciousHex(holo.vendorHex, suspiciousContext, {
        shadeName: holo.name ?? holo.colorName,
        tags: holo.tags,
      }).suspicious;
    if (shouldRunAiDetection) {
      count += 1;
    }
  }

  return count;
}

/** The only source whose records may omit the brand (its records are all Holo Taco). */
const HOLO_TACO_SOURCE_NAME = "HoloTacoShopify";

/**
 * Brand a Shopify record materializes under; shared with the unchanged-image lookup. Null when
 * the record has no brand and the source is not Holo Taco's own store (the record is skipped);
 * no `sourceName` keeps the Holo Taco fallback for older callers.
 */
function resolveHoloTacoBrandName(holo: HoloTacoProductNormalized, sourceName?: string): string | null {
  if (holo.brand) return canonicalizeBrandName(holo.brand);
  return sourceName === undefined || sourceName === HOLO_TACO_SOURCE_NAME
    ? canonicalizeBrandName("Holo Taco")
    : null;
}

export interface UnchangedImageCandidate {
  externalId: string;
  brandName: string;
  shadeName: string;
  finish: string | null;
  collection: string | null;
  checksumSha256: string;
}

/**
 * Joins `sh` to the shade a connector product (`input.external_id` of data source
 * `dataSourceParam`) materializes onto, the way `findExistingShadeForRecord` resolves it: the one
 * unmerged shade its `shade_source_product` listing links (exact also for adopted shades), else,
 * for a brand source only (`identityFallback`), the brand + name + legacy finish + collection
 * identity (restricted to the product's linked shades when it has several listings). A retailer or feed record without exactly one listing resolves nothing here (the
 * materializer skips an ambiguous one, and its shade lookup never uses that identity).
 */
function joinMaterializedShadeSql(dataSourceParam: string, identityFallback = true): string {
  return `JOIN LATERAL (
         SELECT COALESCE(
           (
             SELECT min(ssp.shade_id)
             FROM shade_source_product ssp
             JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
             JOIN shade lsh ON lsh.shade_id = ssp.shade_id
             WHERE ep.data_source_id = ${dataSourceParam}
               AND ep.external_id = input.external_id
               AND lsh.merged_into_shade_id IS NULL
             HAVING count(DISTINCT ssp.shade_id) = 1
           )${identityFallback ? "," : ""}
           ${identityFallback ? `(
             SELECT ish.shade_id
             FROM shade ish
             WHERE ish.brand_id = ${INGESTED_BRAND_ID_SQL("input.brand_name")}
               AND ish.product_line_id IS NULL
               AND lower(ish.shade_name_canonical) = lower(input.shade_name)
               AND coalesce(ish.finish, '') = coalesce(input.finish, '')
               AND coalesce(ish.collection, '') = coalesce(input.collection, '')
               -- A product with listings resolves only to one of its linked shades.
               AND (
                 NOT EXISTS (
                   SELECT 1
                   FROM shade_source_product fssp
                   JOIN external_product fep ON fep.external_product_id = fssp.external_product_id
                   WHERE fep.data_source_id = ${dataSourceParam}
                     AND fep.external_id = input.external_id
                 )
                 OR EXISTS (
                   SELECT 1
                   FROM shade_source_product fssp
                   JOIN external_product fep ON fep.external_product_id = fssp.external_product_id
                   WHERE fep.data_source_id = ${dataSourceParam}
                     AND fep.external_id = input.external_id
                     AND fssp.shade_id = ish.shade_id
                 )
               )
             ORDER BY ish.shade_id
             LIMIT 1
           )` : ""}
         ) AS shade_id
       ) resolved ON resolved.shade_id IS NOT NULL
       JOIN shade sh ON sh.shade_id = resolved.shade_id`;
}

/**
 * Admin-set product categories (#349) of the shades these records materialize into, by external
 * id. Detection is gated on the category the shade will have after this run: an admin `topper` or
 * `accessory` must not get a vision call because the connector's rule category says `color`.
 * Shades are matched the same way `materializePreparedHoloTacoRecord` resolves them
 * (`joinMaterializedShadeSql`). A lookup failure returns an empty map (the rule category
 * applies): it must never fail the job.
 */
export async function findAdminProductCategories(
  dataSourceId: number,
  allCandidates: Array<{
    externalId: string;
    brandName: string;
    shadeName: string;
    finish: string | null;
    collection: string | null;
    /** The shade the record was already resolved to (`preResolveRecordShades`), if any. */
    shadeId?: number | null;
  }>,
  options: { identityFallback?: boolean } = {}
): Promise<Map<string, ProductCategory>> {
  const out = new Map<string, ProductCategory>();
  if (allCandidates.length === 0) return out;
  const resolved = allCandidates.filter((c) => c.shadeId !== null && c.shadeId !== undefined);
  const candidates = allCandidates.filter((c) => c.shadeId === null || c.shadeId === undefined);
  try {
    if (resolved.length > 0) {
      // A resolved shade is read directly, so a shade adopted on this very run is gated too.
      const byShade = await query<{ shadeId: number | string; productCategory: ProductCategory }>(
        `SELECT shade_id AS "shadeId", product_category AS "productCategory"
         FROM shade
         WHERE shade_id = ANY($1::bigint[])
           AND product_category_source = 'admin'`,
        [[...new Set(resolved.map((c) => Number(c.shadeId)))]]
      );
      const categories = new Map(byShade.rows.map((row) => [Number(row.shadeId), row.productCategory]));
      for (const candidate of resolved) {
        const category = categories.get(Number(candidate.shadeId));
        if (category) out.set(candidate.externalId, resolveProductCategory(category));
      }
    }
    if (candidates.length === 0) return out;
    const result = await query<{ externalId: string; productCategory: ProductCategory }>(
      `WITH input AS (
         SELECT *
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
           AS t(external_id, brand_name, shade_name, finish, collection)
       )
       SELECT DISTINCT ON (input.external_id)
              input.external_id AS "externalId",
              sh.product_category AS "productCategory"
       FROM input
       ${joinMaterializedShadeSql("$6", options.identityFallback !== false)}
       WHERE sh.product_category_source = 'admin'
       ORDER BY input.external_id, sh.shade_id`,
      [
        candidates.map((c) => c.externalId),
        candidates.map((c) => c.brandName),
        candidates.map((c) => c.shadeName),
        candidates.map((c) => c.finish),
        candidates.map((c) => c.collection),
        dataSourceId,
      ]
    );
    for (const row of result.rows) out.set(row.externalId, resolveProductCategory(row.productCategory));
  } catch (error) {
    console.warn(
      `[ingestion-repo] Admin category lookup failed; using rule categories for hex detection: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return out;
}

/**
 * External IDs whose shade already has a detected hex and already has a swatch (product or gallery) on the exact
 * image chosen for detection (same checksum). Shades are matched the same way
 * materializePreparedHoloTacoRecord resolves them (`joinMaterializedShadeSql`). A lookup failure returns an empty set:
 * skipping detection is an optimization and must never fail the job.
 */
export async function findRecordsWithUnchangedDetectedHex(
  dataSourceId: number,
  candidates: UnchangedImageCandidate[],
  options: { identityFallback?: boolean } = {}
): Promise<Set<string>> {
  if (candidates.length === 0) {
    return new Set();
  }

  try {
    const result = await query<{ externalId: string }>(
      `WITH input AS (
         SELECT *
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
           AS t(external_id, brand_name, shade_name, finish, collection, checksum_sha256)
       )
       SELECT DISTINCT input.external_id AS "externalId"
       FROM input
       ${joinMaterializedShadeSql("$1", options.identityFallback !== false)}
       WHERE sh.detected_hex IS NOT NULL
         -- A retailer-authority shade is re-detected by the brand store that takes it over.
         AND sh.catalog_authority <> 'retailer'
         AND EXISTS (
           SELECT 1
           FROM swatch s
           JOIN image_asset ia ON ia.image_id = s.image_id_original
           WHERE s.shade_id = sh.shade_id
             -- The detection image may be a gallery image (image-selection.ts).
             AND s.swatch_type IN ('source_product', 'source_gallery')
             AND ia.owner_type = 'source'
             AND ia.owner_id = $1
             AND ia.checksum_sha256 = input.checksum_sha256
         )`,
      [
        dataSourceId,
        candidates.map((c) => c.externalId),
        candidates.map((c) => c.brandName),
        candidates.map((c) => c.shadeName),
        candidates.map((c) => c.finish),
        candidates.map((c) => c.collection),
        candidates.map((c) => c.checksumSha256),
      ]
    );
    return new Set(result.rows.map((row) => row.externalId));
  } catch (error) {
    console.warn(
      `[ingestion-repo] Unchanged-image lookup failed; running hex detection for all candidates: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return new Set();
  }
}

/**
 * External IDs whose resolved shade (`preResolveRecordShades`) already has a detected hex,
 * whichever source supplied its images. Retailer and feed listings use it to skip the AI call
 * before it is paid for: they never replace a detected hex, they only fill an empty one. A record
 * without a resolved shade is not in the set. A lookup failure returns an empty set.
 */
export async function findShadesWithDetectedHex(
  candidates: Array<{ externalId: string; shadeId: number }>
): Promise<Set<string>> {
  if (candidates.length === 0) {
    return new Set();
  }

  try {
    const result = await query<{ shadeId: number | string }>(
      `SELECT sh.shade_id AS "shadeId"
       FROM shade sh
       WHERE sh.shade_id = ANY($1::bigint[])
         AND sh.detected_hex IS NOT NULL`,
      [[...new Set(candidates.map((c) => c.shadeId))]]
    );
    const withHex = new Set(result.rows.map((row) => Number(row.shadeId)));
    return new Set(candidates.filter((c) => withHex.has(c.shadeId)).map((c) => c.externalId));
  } catch (error) {
    console.warn(
      `[ingestion-repo] Detected-hex lookup failed; running hex detection for all candidates: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return new Set();
  }
}

/**
 * Stored images for connector image URLs this data source has already ingested, keyed by URL.
 * Shopify CDN URLs carry a `?v=` version that changes when the image is replaced, so an
 * unchanged URL means an unchanged image and the download can be skipped. A lookup failure
 * returns an empty map: reuse is an optimization and must never fail the job. `onLookupFailed`
 * tells the caller the map is empty because the lookup failed, not because nothing was stored:
 * a capped run must then not prune (see `isProductImageSetComplete`).
 */
export async function findStoredSourceImages(
  dataSourceId: number,
  sourceUrls: string[],
  options: { onLookupFailed?: () => void } = {}
): Promise<Map<string, StoredSourceImage>> {
  const urls = Array.from(new Set(sourceUrls));
  if (urls.length === 0) {
    return new Map();
  }

  try {
    const result = await query<Omit<StoredSourceImage, "fingerprint"> & FingerprintColumns>(
      `SELECT
         siu.source_url AS "sourceUrl",
         ia.storage_url AS "storageUrl",
         ia.checksum_sha256 AS "checksumSha256",
         ${fingerprintColumnsSql("ia")}
       FROM source_image_url siu
       JOIN image_asset ia ON ia.image_id = siu.image_id
       WHERE siu.data_source_id = $1
         AND siu.source_url = ANY($2::text[])
         AND ia.checksum_sha256 IS NOT NULL`,
      [dataSourceId, urls]
    );
    return new Map(
      result.rows.map((row) => [
        row.sourceUrl,
        {
          sourceUrl: row.sourceUrl,
          storageUrl: row.storageUrl,
          checksumSha256: row.checksumSha256,
          fingerprint: fingerprintFromColumns(row),
        },
      ])
    );
  } catch (error) {
    console.warn(
      `[ingestion-repo] Stored source image lookup failed; downloading every image: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    options.onLookupFailed?.();
    return new Map();
  }
}

/**
 * Whether a product's stored images are its whole current image set, which is what lets
 * `pruneStaleGallerySwatches` unlink the rest. Images skipped by the per-product cap do not block
 * the prune, because one an earlier run stored is reused instead of skipped. That only holds when
 * the stored-image lookup worked: after a failed lookup a skipped image may be one the shade
 * already links and the vendor still lists, so the set is not known to be complete.
 */
export function isProductImageSetComplete(input: {
  primaryStored: boolean;
  additionalFailures: number;
  skippedByCap: number;
  storedLookupFailed: boolean;
}): boolean {
  if (!input.primaryStored || input.additionalFailures > 0) return false;
  return !(input.storedLookupFailed && input.skippedByCap > 0);
}

/** New catalog `image_asset` row for a stored source image, with its perceptual fingerprint when known. */
async function insertSourceImageAsset(
  client: PoolClient,
  dataSourceId: number,
  storageUrl: string,
  checksumSha256: string,
  fingerprint: ImageFingerprint | null
): Promise<number> {
  const columns = fingerprintToColumns(fingerprint);
  const inserted = await client.query<{ imageId: number }>(
    `INSERT INTO image_asset
       (owner_type, owner_id, storage_url, checksum_sha256, copyright_status, captured_at,
        perceptual_hash, thumb_fingerprint, image_width, image_height)
     VALUES ('source', $1, $2, $3, 'licensed_source', now(), $4, $5, $6, $7)
     RETURNING image_id AS "imageId"`,
    [
      dataSourceId,
      storageUrl,
      checksumSha256,
      columns.perceptualHash,
      columns.thumbFingerprint,
      columns.imageWidth,
      columns.imageHeight,
    ]
  );
  return inserted.rows[0].imageId;
}

async function recordSourceImageUrl(
  client: PoolClient,
  dataSourceId: number,
  sourceUrl: string,
  imageId: number
): Promise<void> {
  await client.query(
    `INSERT INTO source_image_url (data_source_id, source_url, image_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (data_source_id, source_url)
     DO UPDATE SET image_id = EXCLUDED.image_id, updated_at = now()
     WHERE source_image_url.image_id IS DISTINCT FROM EXCLUDED.image_id`,
    [dataSourceId, sourceUrl, imageId]
  );
}

async function prepareHoloTacoImageData(
  records: ConnectorProductRecord[],
  dataSourceId: number,
  options?: HoloTacoMaterializationOptions,
  sourceLogPrefix: string = "[HoloTaco]",
  onRecordPrepared?: (
    record: ConnectorProductRecord,
    preparedImage: HoloTacoPreparedImage
  ) => Promise<void>,
  finishCatalog?: FinishCatalog
): Promise<HoloTacoImagePreparationResult> {
  // A source whose images are not permitted stores none, so AI hex detection has nothing to read.
  const storeImages = options?.storeImages !== false;
  const detectHexFromImage = storeImages && options?.detectHexFromImage !== false;
  const detectHexOnSuspiciousOnly = options?.detectHexOnSuspiciousOnly === true;
  const recordsSourceName = options?.sourceName;
  // A retailer or feed adopts existing shades and writes them under the listing rules.
  const adoptsExistingShades = (options?.sourceKind ?? "brand") !== "brand";
  const batchMinImages = Math.max(1, options?.batchMinImages ?? DEFAULT_HEX_BATCH_MIN_IMAGES);
  const suspiciousContext = buildVendorHexContext(records);
  // Resolution before detection: each record's shade is known before any image work.
  const resolutions = await preResolveRecordShades(records, dataSourceId, {
    adopt: adoptsExistingShades,
    sourceName: recordsSourceName,
    finishCatalog,
    sourceLogPrefix,
  });
  // Records that get no upload and no detection: an ambiguous record (skipped at
  // materialization) and, for a retailer or feed, a shade already showing another source's image
  // (nothing this source stores would be linked).
  const skipImageWork = new Set(
    [...resolutions.entries()]
      .filter(([, resolved]) => resolved.lookup.outcome === "ambiguous" || resolved.foreignProductImage)
      .map(([externalId]) => externalId)
  );
  // Admin-set categories win over the connector's rule category for every hex-detection gate below.
  const adminCategories = detectHexFromImage
    ? await findAdminProductCategories(
        dataSourceId,
        records.flatMap((record) => {
          if (skipImageWork.has(record.externalId)) return [];
          const resolved = resolutions.get(record.externalId)?.lookup;
          const normalized =
            record.normalized && typeof record.normalized === "object"
              ? (record.normalized as Record<string, unknown>)
              : null;
          const holo = normalized ? parseHoloTacoNormalized(normalized) : null;
          const brandName = holo ? resolveHoloTacoBrandName(holo, recordsSourceName) : null;
          return holo?.name && brandName
            ? [
                {
                  externalId: record.externalId,
                  brandName,
                  shadeName: holo.name,
                  finish: holo.finish,
                  collection: holo.collection,
                  shadeId: resolved?.outcome === "found" ? resolved.shadeId : null,
                },
              ]
            : [];
        }),
        { identityFallback: !adoptsExistingShades }
      )
    : new Map<string, ProductCategory>();
  const estimatedBatchCandidates = estimateBatchCandidateCount(
    records.filter((record) => !skipImageWork.has(record.externalId)),
    detectHexFromImage,
    detectHexOnSuspiciousOnly,
    suspiciousContext,
    adminCategories
  );
  const useBatchForHexDetection =
    options?.useBatchForHexDetection === true &&
    detectHexFromImage &&
    estimatedBatchCandidates >= batchMinImages;
  const progressLogger = options?.progressLogger;
  // Snap diagnostics: info lines stay on the console, problems also reach the job log.
  const snapLogger =
    (externalId: string) =>
    (level: HexSnapLogLevel, message: string, data?: Record<string, unknown>): void => {
      const withRecord = `${sourceLogPrefix} ${externalId} ${message}`;
      if (level === "warn") {
        console.warn(withRecord, data ?? "");
        progressLogger?.warn(withRecord, data);
      } else {
        console.log(withRecord, data ?? "");
      }
    };
  const byExternalId = new Map<string, HoloTacoPreparedImage>();
  const queuedBatchRequests: Array<{
    customId: string;
    imageUrlOrDataUri: string;
    vendorContext: HexDetectionOptions["vendorContext"];
  }> = [];
  const metrics: HoloTacoImagePreparationMetrics = {
    imageCandidates: 0,
    imageUploads: 0,
    imageUploadFailures: 0,
    additionalImagesUploaded: 0,
    imagesReused: 0,
    imagesSkippedByCap: 0,
    hexDetected: 0,
    hexDetectionFailures: 0,
    hexDetectionSkipped: 0,
    hexDetectionSkippedUnchanged: 0,
    hexDetectionSkippedCategory: 0,
    hexSnapped: 0,
    batchRequestsQueued: 0,
    batchFallbacks: 0,
    hexDetectionPromptTokens: 0,
    hexDetectionCompletionTokens: 0,
    hexDetectionTotalTokens: 0,
  };

  console.log(
    `${sourceLogPrefix} Image preparation: processing ${records.length} records, detectHexFromImage=${detectHexFromImage}, detectHexOnSuspiciousOnly=${detectHexOnSuspiciousOnly}, estimatedBatchCandidates=${estimatedBatchCandidates}, useBatchForHexDetection=${useBatchForHexDetection}, batchMinImages=${batchMinImages}`
  );
  if (detectHexOnSuspiciousOnly && suspiciousContext.templateDefaults.size > 0) {
    const defaults = Array.from(suspiciousContext.templateDefaults)
      .map((hex) => `${hex}×${suspiciousContext.counts.get(hex) ?? 0}`)
      .join(", ");
    const message = `${sourceLogPrefix} Vendor hex template defaults detected across ${suspiciousContext.hexRecordCount} records: ${defaults}; AI detection will run for those shades`;
    console.log(message);
    progressLogger?.info(message, {
      vendorHexRecords: suspiciousContext.hexRecordCount,
      templateDefaults: Array.from(suspiciousContext.templateDefaults),
      thresholds: suspiciousContext.thresholds as unknown as Record<string, unknown>,
    });
  }

  // Ensure blob container exists once before parallel uploads
  const connectionString = process.env.AZURE_STORAGE_CONNECTION?.trim() || null;
  if (connectionString && storeImages) {
    const containerName = process.env.SOURCE_IMAGE_CONTAINER || "source-images";
    console.log(`${sourceLogPrefix} Ensuring container exists before parallel uploads`);
    try {
      await ensureContainer(connectionString, containerName);
    } catch (error) {
      console.error(
        `${sourceLogPrefix} Failed to ensure container before parallel uploads; continuing with per-record handling`,
        error
      );
      // Best-effort logging; do not abort the entire ingestion pipeline.
      progressLogger?.error?.(
        `${sourceLogPrefix} Failed to ensure container before parallel uploads; continuing with per-record handling`,
        {
          containerName,
          error:
            error instanceof Error
              ? { message: error.message, stack: error.stack }
              : String(error),
        }
      );
    }
  }

  const sourceName = sourceLogPrefix.replace(/[\[\]]/g, "");

  // --- Phase 1: Parallel image download/upload ---
  interface ImageUploadResult {
    record: ConnectorProductRecord;
    holo: HoloTacoProductNormalized | null;
    storageUrl: string | null;
    checksumSha256: string | null;
    fingerprint: ImageFingerprint | null;
    sourceUrl: string | null;
    additionalImages: StoredSourceImage[];
    /** Every image URL of the product was stored (see HoloTacoPreparedImage.imageSetComplete). */
    imageSetComplete: boolean;
    isCandidate: boolean;
    primaryReused: boolean;
    additionalUploaded: number;
    imagesReused: number;
    /** Gallery images left out by the per-product download cap (not downloaded, not stored before). */
    skippedByCap: number;
  }

  const limit = pLimit(4);
  // Per-product download cap: the primary, the likely on-nail photo AI detection would pick, then
  // vendor order (planProductImageDownloads). Read once per call.
  const maxImagesPerProduct = getSourceImageMaxPerProduct();
  const startTime = Date.now();

  const parsedRecords = records.map((record) => {
    const normalized =
      record.normalized && typeof record.normalized === "object"
        ? (record.normalized as Record<string, unknown>)
        : null;
    const holo = normalized ? parseHoloTacoNormalized(normalized) : null;
    if (holo) holo.productCategory = adminCategories.get(record.externalId) ?? holo.productCategory;
    return { record, holo };
  });

  // Images whose connector URL was already ingested are reused instead of downloaded: the
  // download (plus metadata strip and hashing) is what makes reruns slow, not the upload.
  let storedLookupFailed = false;
  const storedImages = storeImages
    ? await findStoredSourceImages(
        dataSourceId,
        parsedRecords.flatMap(({ holo }) =>
          holo?.name && isHttpUrl(holo.primaryImageUrl)
            ? [holo.primaryImageUrl, ...holo.imageUrls.slice(1).filter(isHttpUrl)]
            : []
        ),
        {
          onLookupFailed: () => {
            storedLookupFailed = true;
          },
        }
      )
    : new Map<string, StoredSourceImage>();
  progressLogger?.info(`${sourceLogPrefix} Image upload started for ${records.length} record(s)`, {
    records: records.length,
    storedImagesReusable: storedImages.size,
    detectHexFromImage,
    detectHexOnSuspiciousOnly,
    estimatedBatchCandidates,
    useBatchForHexDetection,
    batchMinImages,
    vendorHexRecords: suspiciousContext.hexRecordCount,
    vendorHexTemplateDefaults: Array.from(suspiciousContext.templateDefaults),
  });

  const storeSourceImage = async (
    sourceImageUrl: string,
    externalId: string
  ): Promise<{ image: StoredSourceImage; reused: boolean }> => {
    const stored = storedImages.get(sourceImageUrl);
    if (stored) {
      return { image: stored, reused: true };
    }
    const upload = await uploadSourceImageToBlob({
      sourceImageUrl,
      source: sourceName,
      externalId,
      skipContainerEnsure: true,
    });
    return {
      image: {
        sourceUrl: sourceImageUrl,
        storageUrl: upload.storageUrl,
        checksumSha256: upload.checksumSha256,
        fingerprint: upload.fingerprint ?? null,
      },
      reused: false,
    };
  };

  const uploadTasks = parsedRecords.map(({ record, holo }) =>
    limit(async (): Promise<ImageUploadResult> => {
      const notCandidate: ImageUploadResult = {
        record,
        holo,
        storageUrl: null,
        checksumSha256: null,
        fingerprint: null,
        sourceUrl: null,
        additionalImages: [],
        imageSetComplete: false,
        isCandidate: false,
        primaryReused: false,
        additionalUploaded: 0,
        imagesReused: 0,
        skippedByCap: 0,
      };
      if (!holo) {
        console.log(`${sourceLogPrefix} Skipping record ${record.externalId}: no normalized data`);
        return notCandidate;
      }
      if (!storeImages) {
        // The source has not permitted storing its images (SourceSettings.imagesPermitted).
        return notCandidate;
      }
      if (skipImageWork.has(record.externalId)) {
        const reason =
          resolutions.get(record.externalId)?.lookup.outcome === "ambiguous"
            ? "several shades fit it (skipped at materialization)"
            : "its shade already shows another source's product image";
        console.log(`${sourceLogPrefix} Not storing images for ${record.externalId}: ${reason}`);
        return notCandidate;
      }
      if (!resolveHoloTacoBrandName(holo, recordsSourceName)) {
        // No brand: the materializer skips the record, so its images are not stored either.
        return notCandidate;
      }

      if (!holo.name || !isHttpUrl(holo.primaryImageUrl)) {
        if (holo.name) {
          const noImageMessage = `${sourceLogPrefix} ${record.externalId} has no valid image URL; materializing without an image`;
          const noImageData = { externalId: record.externalId, name: holo.name, imageUrl: holo.primaryImageUrl };
          console.log(noImageMessage, noImageData);
          progressLogger?.warn(noImageMessage, noImageData);
        }
        return notCandidate;
      }

      console.log(`${sourceLogPrefix} Image candidate: externalId=${record.externalId}, name=${holo.name}, imageUrl=${holo.primaryImageUrl}`);

      let storageUrl: string | null = null;
      let checksumSha256: string | null = null;
      let fingerprint: ImageFingerprint | null = null;
      let primaryReused = false;
      let additionalUploaded = 0;
      let imagesReused = 0;
      let additionalFailures = 0;
      let skippedByCap = 0;
      const additionalImages: StoredSourceImage[] = [];

      // Upload primary image (container already ensured)
      try {
        const { image, reused } = await storeSourceImage(holo.primaryImageUrl, record.externalId);
        storageUrl = image.storageUrl;
        checksumSha256 = image.checksumSha256;
        fingerprint = image.fingerprint;
        primaryReused = reused;
        if (reused) imagesReused += 1;
        console.log(
          `${sourceLogPrefix} Primary image ${reused ? "reused" : "uploaded"} for ${record.externalId}: checksum=${checksumSha256}`
        );
      } catch (err) {
        const failure = describeImageStoreFailure(err);
        const message = `${sourceLogPrefix} Primary image upload failed for ${record.externalId} at ${failure.stepLabel}${failure.host ? ` (${failure.host})` : ""}`;
        console.error(`${message}:`, failure.error);
        progressLogger?.warn(message, {
          externalId: record.externalId,
          imageUrl: holo.primaryImageUrl,
          step: failure.step,
          host: failure.host,
          error: failure.error,
        });
      }

      // Additional images, in vendor order. Only the ones the per-product cap keeps are
      // downloaded; one past the cap whose URL an earlier run stored is reused (no download), so a
      // capped run never drops a gallery image the vendor still lists and the stored set stays
      // this product's whole current image set for pruning (imageSetComplete). The rest are
      // skipped: not downloaded, not stored, never linked.
      const downloadPlan = planProductImageDownloads({
        imageUrls: holo.imageUrls,
        images: holo.images,
        primaryUrl: holo.primaryImageUrl,
        maxImages: maxImagesPerProduct,
      });
      const keptUrls = new Set(downloadPlan.additional.map((image) => image.url));
      const seenUrls = new Set<string>([holo.primaryImageUrl]);
      for (let i = 1; i < holo.imageUrls.length; i++) {
        const imgUrl = holo.imageUrls[i];
        if (!isHttpUrl(imgUrl) || seenUrls.has(imgUrl)) continue;
        seenUrls.add(imgUrl);
        if (!keptUrls.has(imgUrl)) {
          const stored = storedImages.get(imgUrl);
          if (stored) {
            additionalImages.push(stored);
            imagesReused += 1;
          } else {
            skippedByCap += 1;
          }
          continue;
        }
        try {
          const { image, reused } = await storeSourceImage(imgUrl, `${record.externalId}-img${i}`);
          additionalImages.push(image);
          if (reused) {
            imagesReused += 1;
          } else {
            additionalUploaded += 1;
          }
        } catch (err) {
          additionalFailures += 1;
          const failure = describeImageStoreFailure(err);
          const message = `${sourceLogPrefix} Additional image ${i} upload failed for ${record.externalId} at ${failure.stepLabel}${failure.host ? ` (${failure.host})` : ""}`;
          console.error(`${message}:`, failure.error);
          progressLogger?.warn(message, {
            externalId: record.externalId,
            imageUrl: imgUrl,
            step: failure.step,
            host: failure.host,
            error: failure.error,
          });
        }
      }

      if (skippedByCap > 0) {
        console.log(
          `${sourceLogPrefix} ${record.externalId}: ${skippedByCap} of ${holo.imageUrls.length} image(s) not downloaded (SOURCE_IMAGE_MAX_PER_PRODUCT=${maxImagesPerProduct}${
            downloadPlan.detectionUrl ? `, kept detection image ${downloadPlan.detectionUrl}` : ""
          })`
        );
      }

      return {
        record,
        holo,
        storageUrl,
        checksumSha256,
        fingerprint,
        sourceUrl: storageUrl ? holo.primaryImageUrl : null,
        additionalImages,
        // Every image this run kept (downloaded or reused) was stored; images skipped by the cap
        // are not part of the product's stored set, so they do not block the stale-gallery prune,
        // unless the stored-image lookup failed (a skipped image may then be an already linked one).
        imageSetComplete: isProductImageSetComplete({
          primaryStored: storageUrl !== null,
          additionalFailures,
          skippedByCap,
          storedLookupFailed,
        }),
        isCandidate: true,
        primaryReused,
        additionalUploaded,
        imagesReused,
        skippedByCap,
      };
    })
  );

  const uploadResults = await Promise.all(uploadTasks);
  const uploadElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`${sourceLogPrefix} Phase 1 (parallel image upload) completed in ${uploadElapsed}s for ${records.length} records`);
  const uploadCandidates = uploadResults.filter((result) => result.isCandidate);
  const uploadSummary = {
    durationMs: Date.now() - startTime,
    candidates: uploadCandidates.length,
    primaryUploaded: uploadCandidates.filter((result) => result.storageUrl && !result.primaryReused).length,
    primaryFailed: uploadCandidates.filter((result) => !result.storageUrl).length,
    additionalUploaded: uploadResults.reduce((sum, result) => sum + result.additionalUploaded, 0),
    imagesReused: uploadResults.reduce((sum, result) => sum + result.imagesReused, 0),
    imagesSkippedByCap: uploadResults.reduce((sum, result) => sum + result.skippedByCap, 0),
    maxImagesPerProduct,
  };
  progressLogger?.info(
    `${sourceLogPrefix} Image upload finished in ${uploadElapsed}s: ${uploadSummary.primaryUploaded} uploaded, ${uploadSummary.imagesReused} reused, ${uploadSummary.primaryFailed} failed${
      uploadSummary.imagesSkippedByCap > 0
        ? `, ${uploadSummary.imagesSkippedByCap} not downloaded (over ${maxImagesPerProduct} per product)`
        : ""
    }`,
    uploadSummary
  );

  // AI hex detection runs on the image most likely to show the polish on a nail
  // (alt-text ranking, see image-selection.ts); the vendor's primary image stays
  // the fallback. The download cap above always kept that image, so the choice is the same
  // as without a cap.
  const chooseDetectionImage = (result: ImageUploadResult): UploadedImageChoice | null => {
    const { holo, storageUrl, checksumSha256, additionalImages } = result;
    if (!holo) return null;
    const uploadedRefs: UploadedImageRef[] = [];
    if (holo.primaryImageUrl && storageUrl) {
      uploadedRefs.push({ sourceUrl: holo.primaryImageUrl, storageUrl, checksumSha256 });
    }
    for (const additional of additionalImages) {
      uploadedRefs.push(additional);
    }
    return chooseUploadedImageForDetection(holo.images, holo.primaryImageUrl, uploadedRefs);
  };
  const detectionImages = new Map(uploadResults.map((result) => [result, chooseDetectionImage(result)] as const));

  // --- Phase 2: concurrent AI detection, sequential DB callbacks in record order ---
  const overwriteDetectedHex = options?.overwriteDetectedHex === true;
  const unchangedCandidates: UnchangedImageCandidate[] = detectHexFromImage
    ? uploadResults.flatMap((result): UnchangedImageCandidate[] => {
            const { holo } = result;
            // Compare against the image detection would run on, not always the primary.
            const checksumSha256 = detectionImages.get(result)?.checksumSha256 ?? result.checksumSha256;
            const brandName = holo ? resolveHoloTacoBrandName(holo, recordsSourceName) : null;
            if (!result.isCandidate || !holo?.name || !brandName || !checksumSha256 || !detectsHex(holo)) {
              return [];
            }
            if (
              detectHexOnSuspiciousOnly &&
              !classifySuspiciousHex(holo.vendorHex, suspiciousContext, {
                shadeName: holo.name ?? holo.colorName,
                tags: holo.tags,
              }).suspicious
            ) {
              return [];
            }
            return [
              {
                externalId: result.record.externalId,
                brandName,
                shadeName: holo.name,
                finish: holo.finish,
                collection: holo.collection,
                checksumSha256,
              },
            ];
          })
    : [];
  // A retailer never replaces a detected hex (even with overwrite on), so its AI call is skipped
  // for any shade that has one, whichever source supplied the image. Brand stores skip only an
  // unchanged image of their own.
  const unchangedWithHex = adoptsExistingShades
    ? await findShadesWithDetectedHex(
        unchangedCandidates.flatMap((candidate) => {
          const lookup = resolutions.get(candidate.externalId)?.lookup;
          return lookup?.outcome === "found" ? [{ externalId: candidate.externalId, shadeId: lookup.shadeId }] : [];
        })
      )
    : detectHexFromImage && !overwriteDetectedHex
      ? await findRecordsWithUnchangedDetectedHex(dataSourceId, unchangedCandidates, {
          identityFallback: !adoptsExistingShades,
        })
      : new Set<string>();
  if (unchangedWithHex.size > 0) {
    console.log(
      adoptsExistingShades
        ? `${sourceLogPrefix} Skipping AI for ${unchangedWithHex.size} record(s) whose shade already has a detected hex`
        : `${sourceLogPrefix} Skipping AI for ${unchangedWithHex.size} record(s) with an unchanged image and an existing detected hex`
    );
  }
  const detectionStartedAt = Date.now();
  const detectionConcurrency = getHexDetectionConcurrency();
  progressLogger?.info(
    `${sourceLogPrefix} Hex detection and database writes started for ${uploadResults.length} record(s)`,
    {
      mode: !detectHexFromImage ? "off" : useBatchForHexDetection ? "batch" : "sync",
      concurrency: detectionConcurrency,
      skippedUnchanged: unchangedWithHex.size,
    }
  );

  const prepareRecordImage = async (result: ImageUploadResult): Promise<HoloTacoPreparedImage> => {
    const { record, holo, additionalImages } = result;
    const { storageUrl, checksumSha256, sourceUrl } = result;

    if (!result.isCandidate) {
      return {
        storageUrl: null,
        checksumSha256: null,
        fingerprint: null,
        detectionSourceUrl: null,
        sourceUrl: null,
        detectedHex: null,
        detectedFinishes: null,
        detectedHexProvenance: null,
        detectionApplies: false,
        additionalImages: [],
        imageSetComplete: false,
      };
    }

    metrics.imageCandidates += 1;
    if (!storageUrl) {
      metrics.imageUploadFailures += 1;
    } else if (!result.primaryReused) {
      metrics.imageUploads += 1;
    }
    metrics.additionalImagesUploaded += result.additionalUploaded;
    metrics.imagesReused += result.imagesReused;
    metrics.imagesSkippedByCap += result.skippedByCap;

    let detectedHex: string | null = null;
    let detectedFinishes: string[] | null = null;
    let detectedHexProvenance: DetectedHexProvenance | null = null;

    const vendorHexVerdict = holo
      ? classifySuspiciousHex(holo.vendorHex, suspiciousContext, {
          shadeName: holo.name ?? holo.colorName,
          tags: holo.tags,
        })
      : null;
    const shouldRunAiDetection = detectHexFromImage &&
      holo && detectsHex(holo) && (!detectHexOnSuspiciousOnly || vendorHexVerdict!.suspicious);

    const detectionImage = detectionImages.get(result) ?? null;
    const imageForAi = resolveAiImageUrl(detectionImage?.storageUrl ?? storageUrl);

    if (shouldRunAiDetection && holo && detectionImage && imageForAi) {
      const selectionMessage = `${sourceLogPrefix} ${record.externalId} [image-selection] ${detectionImage.reason}`;
      const selectionData = {
        externalId: record.externalId,
        colorName: holo.name,
        chosenImageUrl: detectionImage.sourceUrl,
        primaryImageUrl: holo.primaryImageUrl,
        selectionSource: detectionImage.selection.source,
        confident: detectionImage.selection.confident,
        uploadFallback: detectionImage.uploadFallback,
        candidates: holo.images.length,
        candidatesWithAlt: holo.images.filter((image) => Boolean(image.alt)).length,
      };
      console.log(selectionMessage, selectionData);
    }

    if (shouldRunAiDetection && holo && unchangedWithHex.has(record.externalId)) {
      // Without overwriteDetectedHex the shade write keeps the existing detected_hex, so a
      // fresh detection on the same image would be paid for and then discarded.
      metrics.hexDetectionSkipped += 1;
      metrics.hexDetectionSkippedUnchanged += 1;
      console.log(
        adoptsExistingShades
          ? `${sourceLogPrefix} Skipping AI for ${record.externalId}: shade already has a detected hex`
          : `${sourceLogPrefix} Skipping AI for ${record.externalId}: image unchanged and shade already has a detected hex`
      );
    } else if (shouldRunAiDetection && holo) {
      if (!imageForAi) {
        metrics.hexDetectionSkipped += 1;
        const skipMessage = `${sourceLogPrefix} ${record.externalId} [ai-color-detection] Skipping AI: missing image URL payload`;
        console.warn(skipMessage, {
          externalId: record.externalId,
          brand: holo.brand || sourceName,
          colorName: holo.name,
          uploadSucceeded: Boolean(storageUrl),
        });
        progressLogger?.warn(skipMessage, {
          externalId: record.externalId,
          brand: holo.brand || sourceName,
          colorName: holo.name,
          uploadSucceeded: Boolean(storageUrl),
        });
      } else if (useBatchForHexDetection) {
        queuedBatchRequests.push({
          customId: record.externalId,
          imageUrlOrDataUri: imageForAi,
          vendorContext: holoTacoVendorContext(holo),
        });
        metrics.batchRequestsQueued += 1;
        const queuedMessage = `${sourceLogPrefix} ${record.externalId} [ai-color-detection] Queued for batch submission`;
        console.log(queuedMessage, {
          colorName: holo.name,
          vendorHex: holo.vendorHex,
          ...(detectHexOnSuspiciousOnly
            ? { reason: vendorHexVerdict?.reason ?? null, detail: vendorHexVerdict?.detail ?? null }
            : {}),
        });
      } else {
        if (holo.vendorHex) {
          const suspiciousMessage = detectHexOnSuspiciousOnly
            ? `${sourceLogPrefix} Vendor hex (${holo.vendorHex}) is suspicious (${vendorHexVerdict?.reason}), running AI detection for ${record.externalId}`
            : `${sourceLogPrefix} Vendor hex present (${holo.vendorHex}), running AI detection for ${record.externalId}`;
          console.log(
            suspiciousMessage,
            detectHexOnSuspiciousOnly
              ? { reason: vendorHexVerdict?.reason ?? null, detail: vendorHexVerdict?.detail ?? null }
              : ""
          );
        } else {
          console.log(`${sourceLogPrefix} No vendor hex for ${record.externalId}, running AI detection`);
        }
        try {
          const rawDetection = await detectHexWithAzureOpenAI(imageForAi, {
            onLog: (level, message, data) => {
              // Info lines are already on the console (emitLog); only problems reach the job log.
              const withRecord = `${sourceLogPrefix} ${record.externalId} ${message}`;
              if (level === "error") {
                progressLogger?.error(withRecord, data);
              } else if (level === "warn") {
                progressLogger?.warn(withRecord, data);
              }
            },
            vendorContext: holoTacoVendorContext(holo),
          });
          // Post-processing (HEX_DETECTION_SNAP_ENABLED): re-read the image the model was shown
          // and replace its hex with the nearest measured palette chip. Never throws.
          const snapped = await snapDetectionToImage(rawDetection, () => loadDetectionImageBytes(imageForAi), {
            label: record.externalId,
            onLog: snapLogger(record.externalId),
          });
          const detection = snapped.detection;
          if (snapped.skipped === null) {
            metrics.hexSnapped += 1;
          }
          const promptTokens = detection.usage?.promptTokens ?? 0;
          const completionTokens = detection.usage?.completionTokens ?? 0;
          const totalTokens = detection.usage?.totalTokens ?? 0;
          metrics.hexDetectionPromptTokens += promptTokens;
          metrics.hexDetectionCompletionTokens += completionTokens;
          metrics.hexDetectionTotalTokens += totalTokens;
          if (promptTokens > 0 || completionTokens > 0 || totalTokens > 0) {
            const tokenUsageData = {
              externalId: record.externalId,
              promptTokens,
              completionTokens,
              totalTokens,
            };
            const tokenUsageMessage = `${sourceLogPrefix} ${record.externalId} [ai-color-detection] Token usage`;
            console.log(tokenUsageMessage, tokenUsageData);
          }
          console.log(`${sourceLogPrefix} AI detection result for ${record.externalId}:`, {
            detectedHex: detection.hex,
            vendorHex: holo.vendorHex,
            ...(snapped.skipped === null ? { modelHex: rawDetection.hex, snapDistance: snapped.snap?.snapDistance ?? null } : {}),
          });
          if (detection.hex) {
            detectedHex = detection.hex;
            detectedFinishes = detection.finishes;
            detectedHexProvenance = provenanceFromDetection(detection);
            metrics.hexDetected += 1;
            const successData = {
              externalId: record.externalId,
              brand: holo.brand || sourceName,
              colorName: holo.name,
              hex: detection.hex,
              finishes: detection.finishes,
              confidence: detectedHexProvenance.confidence,
              method: detectedHexProvenance.method,
              model: detectedHexProvenance.model,
              promptVersion: detectedHexProvenance.promptVersion,
            };
            const successMessage = `${sourceLogPrefix} ${record.externalId} [ai-color-detection] Success`;
            console.log(successMessage, successData);
          } else {
            console.log(`${sourceLogPrefix} No hex returned from AI for ${record.externalId}`);
          }
          // Pacing is per concurrency slot: this slot waits before taking the next record.
          const delayMs = getHexDetectionDelayMs();
          if (delayMs > 0) {
            await sleep(delayMs);
          }
        } catch (err) {
          metrics.hexDetectionFailures += 1;
          console.error(`${sourceLogPrefix} AI hex detection failed for ${record.externalId}:`, String(err));
          progressLogger?.warn(`${sourceLogPrefix} AI hex detection failed for ${record.externalId}`, {
            externalId: record.externalId,
            colorName: holo.name,
            error: String(err),
          });
        }
      }
    } else {
      metrics.hexDetectionSkipped += 1;
      if (holo && detectHexFromImage && !detectsHex(holo)) {
        metrics.hexDetectionSkippedCategory += 1;
        console.log(`${sourceLogPrefix} Skipping AI for ${record.externalId}: not a color polish (${holo.productCategory})`);
      } else if (holo && detectHexOnSuspiciousOnly && holo.vendorHex && vendorHexVerdict && !vendorHexVerdict.suspicious) {
        const trustedMessage = `${sourceLogPrefix} Skipping AI for ${record.externalId}: vendor hex ${holo.vendorHex} not suspicious`;
        console.log(trustedMessage);
      } else {
        console.log(`${sourceLogPrefix} Skipping AI detection for ${record.externalId} (detectHexFromImage=${detectHexFromImage})`);
      }
    }

    return {
      storageUrl,
      checksumSha256,
      fingerprint: result.fingerprint,
      detectionSourceUrl: detectionImages.get(result)?.sourceUrl ?? null,
      sourceUrl,
      detectedHex,
      detectedFinishes,
      detectedHexProvenance,
      detectionApplies: Boolean(shouldRunAiDetection && imageForAi),
      additionalImages,
      imageSetComplete: result.imageSetComplete,
    };
  };

  const detectionLimit = pLimit(detectionConcurrency);
  // Tasks never reject (an unexpected error just drops that record's detection), so a DB
  // callback throwing below cannot leave a rejected promise unobserved.
  const preparedTasks = uploadResults.map((result) =>
    detectionLimit(() =>
      prepareRecordImage(result).catch((err): HoloTacoPreparedImage => {
        metrics.hexDetectionFailures += 1;
        console.error(
          `${sourceLogPrefix} Image preparation failed for ${result.record.externalId}:`,
          String(err)
        );
        progressLogger?.error(`${sourceLogPrefix} Image preparation failed for ${result.record.externalId}`, {
          externalId: result.record.externalId,
          error: String(err),
        });
        return {
          storageUrl: result.storageUrl,
          checksumSha256: result.checksumSha256,
          fingerprint: result.fingerprint,
          detectionSourceUrl: detectionImages.get(result)?.sourceUrl ?? null,
          sourceUrl: result.sourceUrl,
          detectedHex: null,
          detectedFinishes: null,
          detectedHexProvenance: null,
          detectionApplies: true,
          additionalImages: result.additionalImages,
          imageSetComplete: result.imageSetComplete,
        };
      })
    )
  );

  // DB writes stay sequential: materialization looks up then inserts brands and shades, so
  // two records for the same new brand or shade committed concurrently could duplicate it.
  // Each record commits as soon as its own detection resolves; later detections keep running.
  try {
    for (let i = 0; i < uploadResults.length; i++) {
      const { record } = uploadResults[i];
      const resolved = resolutions.get(record.externalId);
      const preparedImage: HoloTacoPreparedImage = {
        ...(await preparedTasks[i]),
        ...(resolved ? { shadeResolution: resolved.lookup } : {}),
      };
      byExternalId.set(record.externalId, preparedImage);
      if (onRecordPrepared) {
        await onRecordPrepared(record, preparedImage);
      }
    }
  } catch (error) {
    // A failed commit fails the chunk, so drop detections that haven't started: they would
    // be paid AI calls whose results are discarded. In-flight calls finish and are ignored.
    detectionLimit.clearQueue();
    throw error;
  }

  console.log(`${sourceLogPrefix} Image preparation complete:`, metrics);
  const detectionElapsed = ((Date.now() - detectionStartedAt) / 1000).toFixed(1);
  progressLogger?.info(
    `${sourceLogPrefix} Hex detection and database writes finished in ${detectionElapsed}s`,
    {
      durationMs: Date.now() - detectionStartedAt,
      hexDetected: metrics.hexDetected,
      hexDetectionFailures: metrics.hexDetectionFailures,
      hexDetectionSkipped: metrics.hexDetectionSkipped,
      hexDetectionSkippedUnchanged: metrics.hexDetectionSkippedUnchanged,
      hexDetectionSkippedCategory: metrics.hexDetectionSkippedCategory,
      hexSnapped: metrics.hexSnapped,
      batchRequestsQueued: metrics.batchRequestsQueued,
      hexDetectionTotalTokens: metrics.hexDetectionTotalTokens,
    }
  );

  let aiBatch: HoloTacoAiBatchDetails | null = null;
  if (useBatchForHexDetection && queuedBatchRequests.length > 0) {
    const batchStartedAt = Date.now();
    try {
      const batchResult = await submitVisionHexBatch(queuedBatchRequests);
      aiBatch = {
        batchId: batchResult.batchId,
        inputFileId: batchResult.inputFileId,
        requestCount: batchResult.requestCount,
        submittedAt: batchResult.submittedAt,
        status: "submitted",
        overwriteDetectedHex: options?.overwriteDetectedHex === true,
        deployment: batchResult.deployment,
        promptVersion: batchResult.promptVersion,
      };
      const batchElapsed = ((Date.now() - batchStartedAt) / 1000).toFixed(1);
      const submittedMessage = `${sourceLogPrefix} Submitted Azure OpenAI batch ${batchResult.batchId} with ${batchResult.requestCount} request(s) in ${batchElapsed}s`;
      console.log(submittedMessage);
      progressLogger?.info(submittedMessage, {
        ...(aiBatch as unknown as Record<string, unknown>),
        durationMs: Date.now() - batchStartedAt,
      });
    } catch (error) {
      // Batch submission failed: degrade to synchronous detection for this run so the
      // job still materializes detected hex instead of failing outright. Detections are
      // applied via the same shade write path the batch poller uses.
      const reason = describeFetchError(error);
      metrics.batchFallbacks += 1;
      const fallbackMessage = `${sourceLogPrefix} Batch submission failed (${reason}); falling back to synchronous hex detection for ${queuedBatchRequests.length} request(s)`;
      console.warn(fallbackMessage);
      progressLogger?.warn(fallbackMessage, {
        reason,
        requestCount: queuedBatchRequests.length,
      });

      const fallbackDetections: AiBatchShadeDetectionInput[] = [];
      const fallbackLimit = pLimit(getHexDetectionConcurrency());
      await Promise.all(
        queuedBatchRequests.map((queued) =>
          fallbackLimit(async () => {
            try {
              const rawDetection = await detectHexWithAzureOpenAI(queued.imageUrlOrDataUri, {
                vendorContext: queued.vendorContext,
                onLog: (level, message, data) => {
                  const withRecord = `${sourceLogPrefix} ${queued.customId} ${message}`;
                  if (level === "error") {
                    progressLogger?.error(withRecord, data);
                  } else if (level === "warn") {
                    progressLogger?.warn(withRecord, data);
                  }
                },
              });
              // Same post-processing as the sync path, on the image that was sent to the model.
              const snapped = await snapDetectionToImage(
                rawDetection,
                () => loadDetectionImageBytes(queued.imageUrlOrDataUri),
                { label: queued.customId, onLog: snapLogger(queued.customId) }
              );
              const detection = snapped.detection;
              if (snapped.skipped === null) {
                metrics.hexSnapped += 1;
              }
              metrics.hexDetectionPromptTokens += detection.usage?.promptTokens ?? 0;
              metrics.hexDetectionCompletionTokens += detection.usage?.completionTokens ?? 0;
              metrics.hexDetectionTotalTokens += detection.usage?.totalTokens ?? 0;
              if (detection.hex) {
                metrics.hexDetected += 1;
                fallbackDetections.push({
                  externalId: queued.customId,
                  detectedHex: detection.hex,
                  detectedFinishes: detection.finishes,
                  provenance: provenanceFromDetection(detection),
                });
              }
            } catch (detectionError) {
              metrics.hexDetectionFailures += 1;
              console.error(
                `${sourceLogPrefix} Fallback AI hex detection failed for ${queued.customId}:`,
                String(detectionError)
              );
              progressLogger?.warn(
                `${sourceLogPrefix} Fallback AI hex detection failed for ${queued.customId}`,
                { externalId: queued.customId, error: String(detectionError) }
              );
            }

            // Same per-slot pacing as the non-batch path to reduce rate-limit failures.
            await sleep(getHexDetectionDelayMs());
          })
        )
      );

      if (fallbackDetections.length > 0) {
        const applyMetrics = await applyAiBatchShadeDetections(
          dataSourceId,
          fallbackDetections,
          options?.overwriteDetectedHex === true,
          { sourceKind: options?.sourceKind ?? "brand" }
        );
        const fallbackElapsed = ((Date.now() - batchStartedAt) / 1000).toFixed(1);
        const appliedMessage = `${sourceLogPrefix} Applied ${applyMetrics.applied} synchronous fallback detection(s) in ${fallbackElapsed}s`;
        console.log(appliedMessage, applyMetrics);
        progressLogger?.info(appliedMessage, {
          ...(applyMetrics as unknown as Record<string, unknown>),
          durationMs: Date.now() - batchStartedAt,
        });
      }
    }
  }

  return {
    byExternalId,
    metrics,
    aiBatch,
  };
}

/** The `data_source` row with this name, or null. */
export async function getDataSourceByName(name: string): Promise<DataSourceRecord | null> {
  const result = await query<{
    dataSourceId: number;
    name: string;
    baseUrl: string | null;
    currency: string | null;
    metadata: Record<string, unknown> | null;
    enabled: boolean;
  }>(
    `SELECT
       data_source_id AS "dataSourceId",
       name,
       base_url AS "baseUrl",
       metadata ->> 'currency' AS currency,
       metadata,
       enabled
     FROM data_source
     WHERE name = $1
     LIMIT 1`,
    [name]
  );

  return result.rows[0] ?? null;
}

/**
 * Only Shopify `products.json` sources are auto-provisioned (from `SHOPIFY_SOURCE_BASE_URLS`).
 * Non-Shopify sources (product feeds, sitemaps, WooCommerce, Big Cartel) are registered by
 * migration only: their feed URL, kind and brand live in `data_source` and cannot be guessed.
 */
export function isAutoProvisionableSource(name: string): boolean {
  return isShopifyProductsSource(name);
}

async function createDataSourceIfMissing(name: string): Promise<DataSourceRecord | null> {
  if (!isAutoProvisionableSource(name)) {
    return null;
  }

  const baseUrl = defaultShopifyBaseUrl(name);
  // Sources awaiting owner approval are provisioned disabled (hidden from the admin UI).
  const enabled = isShopifySourceEnabledByDefault(name);
  const metadata = {
    priority: "medium",
    mvp: "yes",
    notes: enabled
      ? "Auto-provisioned Shopify source from supported connector list."
      : "Auto-provisioned Shopify source, disabled pending owner approval.",
    autoProvisioned: true,
    ...(isShopifyRetailerSource(name) ? { kind: "retailer" } : {}),
  };

  const inserted = await query<{
    dataSourceId: number;
    name: string;
    baseUrl: string | null;
    enabled: boolean;
  }>(
    `INSERT INTO data_source (name, source_type, base_url, enabled, metadata)
     VALUES ($1, 'api', $2, $3, $4::jsonb)
     ON CONFLICT (name) DO NOTHING
     RETURNING data_source_id AS "dataSourceId", name, base_url AS "baseUrl", metadata, enabled`,
    [name, baseUrl, enabled, JSON.stringify(metadata)]
  );

  if (inserted.rows.length > 0) {
    return inserted.rows[0];
  }

  return getDataSourceByName(name);
}

/** The `data_source` row with this name, created first when it is missing and auto-provisionable. */
export async function ensureDataSourceByName(name: string): Promise<DataSourceRecord | null> {
  const existing = await getDataSourceByName(name);
  if (existing) {
    return existing;
  }
  return createDataSourceIfMissing(name);
}

/** Creates the missing `data_source` rows of every auto-provisionable supported source. */
export async function ensureSupportedShopifyDataSources(): Promise<void> {
  const shopifySources = SUPPORTED_SOURCES.filter((source) => isAutoProvisionableSource(source));
  for (const source of shopifySources) {
    await ensureDataSourceByName(source);
  }
}

export interface DataSourceSettings {
  downloadImages: boolean;
  detectHex: boolean;
  overwriteExisting: boolean;
}

export interface DataSourceRecordWithSettings extends DataSourceRecord {
  settings: DataSourceSettings;
  enabled: boolean;
}

/** Data sources (enabled ones only by default). */
export async function listDataSources(enabledOnly = true): Promise<DataSourceRecord[]> {
  const whereClause = enabledOnly ? "WHERE enabled = true" : "";
  const result = await query<{
    dataSourceId: number;
    name: string;
    baseUrl: string | null;
  }>(
    `SELECT
       data_source_id AS "dataSourceId",
       name,
       base_url AS "baseUrl"
     FROM data_source
     ${whereClause}
     ORDER BY name`,
    []
  );

  return result.rows;
}

/** Data sources with their ingestion settings from `metadata` (enabled ones only by default). */
export async function listDataSourcesWithSettings(enabledOnly = true): Promise<DataSourceRecordWithSettings[]> {
  const whereClause = enabledOnly ? "WHERE enabled = true" : "";
  const result = await query<{
    dataSourceId: number;
    name: string;
    baseUrl: string | null;
    enabled: boolean;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT
       data_source_id AS "dataSourceId",
       name,
       base_url AS "baseUrl",
       enabled,
       metadata
     FROM data_source
     ${whereClause}
     ORDER BY name`,
    []
  );

  const defaultSettings: DataSourceSettings = {
    downloadImages: true,
    detectHex: true,
    overwriteExisting: false,
  };

  return result.rows.map((row) => ({
    dataSourceId: row.dataSourceId,
    name: row.name,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    // metadata stays internal: the admin settings response carries only `settings`. The switches
    // are read like the worker reads them (`readIngestionSwitches`: on unless explicitly false).
    settings: {
      ...defaultSettings,
      ...readIngestionSwitches(row.metadata),
      overwriteExisting:
        (row.metadata?.ingestion as Record<string, unknown> | undefined)?.overwriteExisting === true,
    },
  }));
}

/** Merges ingestion settings into a data source's `metadata`. */
export async function updateDataSourceSettings(
  dataSourceId: number,
  settings: Partial<DataSourceSettings>
): Promise<void> {
  // Get current metadata
  const result = await query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata FROM data_source WHERE data_source_id = $1`,
    [dataSourceId]
  );

  const currentMetadata = result.rows[0]?.metadata || {};
  const currentIngestion = currentMetadata.ingestion || {};
  
  const newIngestion = {
    ...currentIngestion,
    ...settings,
  };

  await query(
    `UPDATE data_source 
     SET metadata = metadata || $2::jsonb 
     WHERE data_source_id = $1`,
    [dataSourceId, JSON.stringify({ ingestion: newIngestion })]
  );
}

export interface GlobalSettings {
  downloadImages: boolean;
  detectHex: boolean;
}

/** The global ingestion settings (`app_settings` key `ingestion`), with defaults when unset. */
export async function getGlobalSettings(): Promise<GlobalSettings> {
  const result = await query<{ setting_value: Record<string, unknown> }>(
    `SELECT setting_value FROM app_settings WHERE setting_key = 'ingestion'`,
    []
  );

  if (result.rows.length === 0) {
    return { downloadImages: true, detectHex: true };
  }

  return result.rows[0].setting_value as unknown as GlobalSettings;
}

/** Merges into the global ingestion settings and upserts them. */
export async function updateGlobalSettings(settings: Partial<GlobalSettings>): Promise<void> {
  const current = await getGlobalSettings();
  const newValue = { ...current, ...settings };

  await query(
    `INSERT INTO app_settings (setting_key, setting_value, description)
     VALUES ('ingestion', $1::jsonb, 'Global ingestion settings')
     ON CONFLICT (setting_key) 
     DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = now()`,
    [JSON.stringify(newValue)]
  );
}




/** Inserts an `ingestion_job` row (queued by default) and returns its id and start time. */
export async function createIngestionJob(
  dataSourceId: number,
  jobType: string,
  metrics: Record<string, unknown>,
  status: "queued" | "running" = "queued"
): Promise<IngestionJobStartRecord> {
  const result = await query<{ jobId: number; startedAt: string }>(
    `INSERT INTO ingestion_job (data_source_id, job_type, status, metrics_json)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING ingestion_job_id AS "jobId", started_at::text AS "startedAt"`,
    [dataSourceId, jobType, status, metrics]
  );

  return result.rows[0];
}

/** Sets a job to `running`, clearing its error, with the given metrics. */
export async function markIngestionJobRunning(
  jobId: number,
  metrics: Record<string, unknown>
): Promise<void> {
  await query(
    `UPDATE ingestion_job
     SET status = 'running',
         error = NULL,
         metrics_json = $2::jsonb
     WHERE ingestion_job_id = $1`,
    [jobId, withHexDetectionTotals(metrics)]
  );
}

/** Replaces a job's `metrics_json`. */
export async function updateIngestionJobMetrics(
  jobId: number,
  metrics: Record<string, unknown>
): Promise<void> {
  await query(
    `UPDATE ingestion_job
     SET metrics_json = $2::jsonb
     WHERE ingestion_job_id = $1`,
    [jobId, withHexDetectionTotals(metrics)]
  );
}

/**
 * Update metrics only while the job is still `running`, in one statement, so a cancel that
 * lands between a status check and this write is never overwritten. Returns false when the
 * job is no longer running (nothing was written).
 */
export async function updateRunningIngestionJobMetrics(
  jobId: number,
  metrics: Record<string, unknown>
): Promise<boolean> {
  const result = await query(
    `UPDATE ingestion_job
     SET metrics_json = $2::jsonb
     WHERE ingestion_job_id = $1
       AND status = 'running'`,
    [jobId, withHexDetectionTotals(metrics)]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Sets a job to `succeeded` with its final metrics. */
export async function markIngestionJobSucceeded(
  jobId: number,
  metrics: Record<string, unknown>
): Promise<void> {
  await query(
    `UPDATE ingestion_job
     SET status = 'succeeded',
         finished_at = now(),
         metrics_json = $2::jsonb
     WHERE ingestion_job_id = $1`,
    [jobId, withHexDetectionTotals(metrics)]
  );
}

/** Sets a job to `failed` with its error and metrics, and emits `ingestion.job_failed` for the alert. */
export async function markIngestionJobFailed(
  jobId: number,
  errorMessage: string,
  metrics: Record<string, unknown>
): Promise<void> {
  await query(
    `UPDATE ingestion_job
     SET status = 'failed',
         finished_at = now(),
         error = $2,
         metrics_json = $3::jsonb
     WHERE ingestion_job_id = $1`,
    [jobId, errorMessage, withHexDetectionTotals(metrics)]
  );
  // Signal for the prod "ingestion job failed" alert (infrastructure/main.tf).
  trackEvent("ingestion.job_failed", { jobId, error: errorMessage.slice(0, 500) });
}

/** Sets a job to `cancelled` with the reason. */
export async function cancelIngestionJob(
  jobId: number,
  cancelReason: string
): Promise<void> {
  await query(
    `UPDATE ingestion_job
     SET status = 'cancelled',
         finished_at = now(),
         error = $2
     WHERE ingestion_job_id = $1
     AND status IN ('queued', 'running')`,
    [jobId, cancelReason]
  );
}

/** Inserts or updates the connector records as `external_product` rows of the data source, in one transaction. */
export async function upsertExternalProducts(
  dataSourceId: number,
  records: ConnectorProductRecord[]
): Promise<ExternalProductUpsertMetrics> {
  return transaction(async (client) => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const record of records) {
      const externalId = record.externalId?.trim();
      if (!externalId) {
        skipped += 1;
        continue;
      }

      const result = await client.query<{ inserted: boolean }>(
        `WITH upsert AS (
           INSERT INTO external_product
             (data_source_id, gtin, external_id, raw_json, normalized_json, etag, fetched_at)
           VALUES
             ($1, $2, $3, $4::jsonb, $5::jsonb, $6, now())
           ON CONFLICT (data_source_id, external_id)
           DO UPDATE SET
             gtin = EXCLUDED.gtin,
             raw_json = EXCLUDED.raw_json,
             normalized_json = EXCLUDED.normalized_json,
             etag = EXCLUDED.etag,
             fetched_at = now(),
             missing_since = NULL
           RETURNING (xmax = 0) AS inserted
         )
         SELECT inserted FROM upsert`,
        [
          dataSourceId,
          record.gtin || null,
          externalId,
          record.raw || {},
          record.normalized || {},
          record.etag || null,
        ]
      );

      if (result.rows[0]?.inserted) {
        inserted += 1;
      } else {
        updated += 1;
      }
    }

    return {
      processed: records.length,
      inserted,
      updated,
      skipped,
    };
  });
}

/** One ingestion job with its source name, or null. */
export async function getIngestionJobById(jobId: number): Promise<IngestionJobRecord | null> {
  const result = await query<{
    jobId: string;
    source: string;
    jobType: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    startedAt: string;
    finishedAt: string | null;
    metrics: Record<string, unknown> | null;
    error: string | null;
  }>(
    `SELECT
       j.ingestion_job_id::text AS "jobId",
       s.name AS source,
       j.job_type AS "jobType",
       j.status,
       j.started_at::text AS "startedAt",
       j.finished_at::text AS "finishedAt",
       j.metrics_json AS metrics,
       j.error
     FROM ingestion_job j
     JOIN data_source s ON s.data_source_id = j.data_source_id
     WHERE j.ingestion_job_id = $1
     LIMIT 1`,
    [jobId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    jobId: row.jobId,
    source: row.source,
    jobType: row.jobType,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt || undefined,
    metrics: row.metrics ? withHexDetectionTotals(row.metrics) : undefined,
    error: row.error || undefined,
  };
}

export interface AwaitingAiBatchJobRecord {
  jobId: number;
  source: string;
  dataSourceId: number;
  /** `data_source.metadata` (its `kind` decides the apply rules, `readSourceSettings`). */
  sourceMetadata?: Record<string, unknown> | null;
  metrics: Record<string, unknown>;
  startedAt: string;
}

/** Running jobs paused in `awaiting_ai` with a submitted AI batch, oldest first. */
export async function listIngestionJobsAwaitingAiBatch(
  limit = 20
): Promise<AwaitingAiBatchJobRecord[]> {
  const result = await query<{
    jobId: number;
    source: string;
    dataSourceId: number;
    sourceMetadata: Record<string, unknown> | null;
    metrics: Record<string, unknown> | null;
    startedAt: string;
  }>(
    `SELECT
       j.ingestion_job_id AS "jobId",
       s.name AS source,
       s.data_source_id AS "dataSourceId",
       s.metadata AS "sourceMetadata",
       j.metrics_json AS metrics,
       j.started_at::text AS "startedAt"
     FROM ingestion_job j
     JOIN data_source s ON s.data_source_id = j.data_source_id
     WHERE j.status = 'running'
       AND j.metrics_json -> 'pipeline' ->> 'stage' = 'awaiting_ai'
       AND COALESCE(j.metrics_json -> 'aiBatch' ->> 'batchId', '') <> ''
     ORDER BY j.started_at ASC
     LIMIT $1`,
    [limit]
  );

  // node-postgres returns BIGINT columns as strings; normalise so callers can compare ids
  // against numeric queue payloads (the poller checks resumeMessage.jobId === job.jobId).
  return result.rows.map((row) => ({
    jobId: Number(row.jobId),
    source: row.source,
    dataSourceId: Number(row.dataSourceId),
    sourceMetadata: row.sourceMetadata ?? null,
    metrics: row.metrics || {},
    startedAt: row.startedAt,
  }));
}

export interface AiBatchShadeDetectionInput {
  externalId: string;
  detectedHex: string | null;
  detectedFinishes: string[] | null;
  /** Provenance written alongside `detectedHex` (confidence, method, model, prompt version). */
  provenance?: DetectedHexProvenance | null;
}

export interface ApplyAiBatchShadeDetectionsMetrics {
  processed: number;
  /** Rows matched to a shade (hex and/or finishes). */
  applied: number;
  /** Subset of `applied` that carried a detected hex, the batch counterpart of `hexDetected`. */
  appliedHex: number;
  skippedNoDetection: number;
  noShadeMatch: number;
}

/**
 * Overwrite predicate of the batch apply UPDATE: the job-wide switch, or a brand-store job on a
 * shade a retailer created (its hex is replaced by the brand's regardless of the switch).
 */
export const BATCH_OVERWRITE_SQL =
  "($5::boolean OR (src.is_brand_store AND sh.catalog_authority = 'retailer'))";

/**
 * Overwrite predicate for `detected_hex` and its provenance: like `BATCH_OVERWRITE_SQL`, but a
 * retailer job never replaces an existing hex, even with the job-wide switch on (the same rule as
 * the sync materializer's `effectiveOverwrite`). A retailer still fills an empty hex.
 */
export const BATCH_HEX_OVERWRITE_SQL =
  "(src.is_brand_store AND ($5::boolean OR sh.catalog_authority = 'retailer'))";

/** Writes AI batch hex/finish detections to the shades behind the data source's products. */
export async function applyAiBatchShadeDetections(
  dataSourceId: number,
  detections: AiBatchShadeDetectionInput[],
  overwriteDetectedHex: boolean,
  /**
   * `sourceKind` (`SourceSettings.kind`, default `brand`): for a retailer or feed only the
   * product's single listing names the shade (no identity fallback, so a record materialization
   * skipped as ambiguous is never applied to one of its candidates), and detected finishes only
   * fill a shade that has none (fill-only adoption). The hex rules read the same kind in SQL.
   */
  options: { sourceKind?: SourceKind } = {}
): Promise<ApplyAiBatchShadeDetectionsMetrics> {
  const adopts = (options.sourceKind ?? "brand") !== "brand";
  let applied = 0;
  let appliedHex = 0;
  let skippedNoDetection = 0;
  let noShadeMatch = 0;

  for (const detection of detections) {
    const externalId = detection.externalId.trim();
    if (!externalId) {
      skippedNoDetection += 1;
      continue;
    }

    const detectedHex = detection.detectedHex;
    const detectedFinishes = mergeStringArrays(null, detection.detectedFinishes);
    if (!detectedHex && !detectedFinishes?.length) {
      skippedNoDetection += 1;
      continue;
    }

    // The listing materialization wrote (recordShadeSourceProduct) names the shade exactly, also
    // for a shade the record adopted, when it links exactly one unmerged shade (the lookup's step
    // 0). Otherwise a brand source falls back to the brand + name + finish + collection identity
    // (products materialized before listings existed); a retailer or feed source applies nothing.
    const listing = await query<{ shadeId: number | string }>(
      `SELECT DISTINCT ssp.shade_id AS "shadeId"
       FROM shade_source_product ssp
       JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
       JOIN shade lsh ON lsh.shade_id = ssp.shade_id
       WHERE ep.data_source_id = $1
         AND ep.external_id = $2
         AND lsh.merged_into_shade_id IS NULL
       ORDER BY ssp.shade_id`,
      [dataSourceId, externalId]
    );
    const listedShadeId = listing.rows.length === 1 ? listing.rows[0].shadeId : null;
    if (listedShadeId === null && adopts) {
      noShadeMatch += 1;
      continue;
    }
    const targetSql =
      listedShadeId !== null
        ? `target AS (
         SELECT ssp.shade_id
         FROM shade_source_product ssp
         JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
         WHERE ep.data_source_id = $1
           AND ep.external_id = $2
           AND ssp.shade_id = $10::bigint
         LIMIT 1
       )`
        : `ext AS (
         SELECT
           COALESCE(NULLIF(trim(normalized_json ->> 'brand'), ''), 'Holo Taco') AS brand_name,
           NULLIF(trim(normalized_json ->> 'name'), '') AS shade_name,
           NULLIF(trim((normalized_json -> 'finishes' ->> 0)), '') AS finish_name,
           NULLIF(trim((normalized_json -> 'collections' ->> 0)), '') AS collection_name
         FROM external_product
         WHERE data_source_id = $1
           AND external_id = $2
         ORDER BY fetched_at DESC
         LIMIT 1
       ),
       target AS (
         SELECT sh.shade_id
         FROM ext
         JOIN LATERAL (SELECT ${INGESTED_BRAND_ID_SQL("ext.brand_name")} AS brand_id) b ON b.brand_id IS NOT NULL
         JOIN shade sh
           ON sh.brand_id = b.brand_id
          AND lower(sh.shade_name_canonical) = lower(ext.shade_name)
          AND coalesce(sh.finish, '') = coalesce(ext.finish_name, '')
          AND coalesce(sh.collection, '') = coalesce(ext.collection_name, '')
         ${
           listing.rows.length > 1
             ? `WHERE sh.shade_id IN (
           SELECT ssp.shade_id
           FROM shade_source_product ssp
           JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
           WHERE ep.data_source_id = $1
             AND ep.external_id = $2
         )`
             : ""
         }
         ORDER BY sh.shade_id DESC
         LIMIT 1
       )`;

    const result = await query<{ shadeId: number }>(
      `WITH ${targetSql},
       src AS (
         SELECT ${isBrandSourceSql("metadata")} AS is_brand_store
         FROM data_source
         WHERE data_source_id = $1
       )
       UPDATE shade sh
       SET detected_hex = CASE
             WHEN ${BATCH_HEX_OVERWRITE_SQL} AND $3::text IS NOT NULL THEN $3::text
             ELSE COALESCE(sh.detected_hex, $3::text)
           END,
           detected_finishes = CASE
             WHEN ${BATCH_OVERWRITE_SQL} AND $4::text[] IS NOT NULL THEN $4::text[]
             ${adopts ? "WHEN cardinality(sh.detected_finishes) > 0 THEN sh.detected_finishes" : ""}
             WHEN sh.detected_finishes IS NULL THEN $4::text[]
             WHEN $4::text[] IS NULL THEN sh.detected_finishes
             ELSE (
               SELECT ARRAY(
                 SELECT DISTINCT f
                 FROM unnest(COALESCE(sh.detected_finishes, ARRAY[]::text[]) || $4::text[]) AS f
                 ORDER BY f
               )
             )
           END,
           -- Provenance follows detected_hex: written when overwriting or when it was empty.
           -- hex_agreement is a generated column and refreshes itself.
           ${detectedHexProvenanceSetSql(
             `(${BATCH_HEX_OVERWRITE_SQL} AND $3::text IS NOT NULL) OR (sh.detected_hex IS NULL AND $3::text IS NOT NULL)`,
             6,
             "sh."
           )},
           -- The brand store's detected hex lands on a retailer-created shade: it is the brand's now.
           catalog_authority = CASE
             WHEN src.is_brand_store AND sh.catalog_authority = 'retailer' AND $3::text IS NOT NULL
               THEN 'brand_store'
             ELSE sh.catalog_authority
           END,
           updated_at = now()
       FROM target, src
       WHERE sh.shade_id = target.shade_id
       RETURNING sh.shade_id AS "shadeId"`,
      [
        dataSourceId,
        externalId,
        detectedHex,
        detectedFinishes,
        overwriteDetectedHex,
        ...provenanceParams(detection.provenance ?? EMPTY_DETECTED_HEX_PROVENANCE),
        ...(listedShadeId !== null ? [listedShadeId] : []),
      ]
    );

    if (result.rows.length > 0) {
      applied += 1;
      if (detectedHex) {
        appliedHex += 1;
      }
    } else {
      noShadeMatch += 1;
    }
  }

  return {
    processed: detections.length,
    applied,
    appliedHex,
    skippedNoDetection,
    noShadeMatch,
  };
}

/** The newest ingestion jobs (optionally for one source) and the total count. */
export async function listIngestionJobs(
  limit: number,
  source?: string
): Promise<{ jobs: IngestionJobRecord[]; total: number }> {
  const filters: string[] = [];
  const params: Array<number | string> = [];
  let index = 1;

  if (source) {
    filters.push(`s.name = $${index}`);
    params.push(source);
    index += 1;
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  const jobsResult = await query<{
    jobId: string;
    source: string;
    jobType: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    startedAt: string;
    finishedAt: string | null;
    metrics: Record<string, unknown> | null;
    error: string | null;
  }>(
    `SELECT
       j.ingestion_job_id::text AS "jobId",
       s.name AS source,
       j.job_type AS "jobType",
       j.status,
       j.started_at::text AS "startedAt",
       j.finished_at::text AS "finishedAt",
       j.metrics_json AS metrics,
       j.error
     FROM ingestion_job j
     JOIN data_source s ON s.data_source_id = j.data_source_id
     ${where}
     ORDER BY j.started_at DESC
     LIMIT $${index}`,
    [...params, limit]
  );

  const countResult = await query<{ total: string }>(
    `SELECT COUNT(*) AS total
     FROM ingestion_job j
     JOIN data_source s ON s.data_source_id = j.data_source_id
     ${where}`,
    params
  );

  return {
    jobs: jobsResult.rows.map((row) => ({
      jobId: row.jobId,
      source: row.source,
      jobType: row.jobType,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt || undefined,
      metrics: row.metrics ? withHexDetectionTotals(row.metrics) : undefined,
      error: row.error || undefined,
    })),
    total: parseInt(countResult.rows[0].total, 10),
  };
}

/**
 * The catalog shade a MakeupAPI color variant belongs to, matched with the MakeupAPI dedupe's
 * name rule (`makeupApiNameKey`: case, whitespace and a trailing "(40052)" code ignored) against
 * the brand's shade names and aliases (a merge keeps the merged name as an alias). A merged row
 * resolves to the shade it was merged into. Users' private `user_submitted` shades are never
 * matched, and only a shade of the same product category counts. Several distinct candidates are
 * `ambiguous`: nothing is guessed.
 */
async function findMakeupApiShade(
  client: PoolClient,
  brandId: number,
  shadeName: string,
  productCategory: string
): Promise<{ kind: "match"; shadeId: number } | { kind: "none" } | { kind: "ambiguous" }> {
  const key = makeupApiNameKey(shadeName);
  if (!key) return { kind: "none" };
  type Row = { shadeId: string; mergedIntoShadeId: string | null };
  const candidates = await client.query<Row>(
    `SELECT s.shade_id::text AS "shadeId", s.merged_into_shade_id::text AS "mergedIntoShadeId"
     FROM shade s
     WHERE s.brand_id = $1
       AND s.status <> 'user_submitted'
       AND (
         (s.product_line_id IS NULL AND ${makeupApiNameKeySql("s.shade_name_canonical", "$3")} = $2)
         OR EXISTS (
           SELECT 1 FROM shade_alias sa
           WHERE sa.shade_id = s.shade_id AND ${makeupApiNameKeySql("sa.alias", "$3")} = $2
         )
       )
     ORDER BY s.shade_id`,
    [brandId, key, MAKEUPAPI_CODE_SUFFIX_PATTERN]
  );

  // Follow merges to the survivor (bounded, in case of a cycle).
  const survivors = new Set<string>();
  for (const candidate of candidates.rows) {
    let row: Row | null = candidate;
    for (let hops = 0; row && row.mergedIntoShadeId !== null && hops < 10; hops += 1) {
      const next: { rows: Row[] } = await client.query<Row>(
        `SELECT shade_id::text AS "shadeId", merged_into_shade_id::text AS "mergedIntoShadeId"
         FROM shade
         WHERE shade_id = $1`,
        [row.mergedIntoShadeId]
      );
      row = next.rows[0] ?? null;
    }
    if (row && row.mergedIntoShadeId === null) survivors.add(row.shadeId);
  }
  if (survivors.size === 0) return { kind: "none" };

  const eligible = await client.query<{ shadeId: string }>(
    `SELECT shade_id::text AS "shadeId"
     FROM shade
     WHERE shade_id = ANY($1::bigint[])
       AND merged_into_shade_id IS NULL
       AND status <> 'user_submitted'
       AND product_category = $2
     ORDER BY shade_id`,
    [[...survivors], productCategory]
  );
  if (eligible.rows.length === 0) return { kind: "none" };
  if (eligible.rows.length > 1) return { kind: "ambiguous" };
  return { kind: "match", shadeId: Number(eligible.rows[0].shadeId) };
}

/** Materializes MakeupAPI records into catalog shades (see the MakeupAPI rules in CLAUDE.md). */
export async function materializeMakeupApiRecords(
  records: ConnectorProductRecord[],
  /** MakeupAPI data_source id; when set, each shade is linked to its product (buy links, #267). */
  dataSourceId?: number
): Promise<MakeupApiMaterializationMetrics> {
  const finishCatalog = await loadFinishCatalog();
  return transaction(async (client) => {
    let variantRowsProcessed = 0;
    let brandsCreated = 0;
    let shadesCreated = 0;
    let skipped = 0;
    let existingShadesLinked = 0;
    let ambiguousShadesSkipped = 0;

    const brandCache = new Map<string, number>();

    for (const record of records) {
      const normalized =
        record.normalized && typeof record.normalized === "object"
          ? (record.normalized as Record<string, unknown>)
          : null;

      if (!normalized) {
        skipped += 1;
        continue;
      }

      const makeup = parseMakeupNormalized(normalized);
      // Tags, else descriptors, else description text (#352).
      const finishResolution = resolveIngestedShadeFinishResolution(normalized, finishCatalog);
      if (!makeup.brand || !makeup.name) {
        skipped += 1;
        continue;
      }

      const brandName = canonicalizeBrandName(makeup.brand);
      const brandKey = brandName.toLowerCase();
      let brandId = brandCache.get(brandKey);

      if (!brandId) {
        const existingBrand = await client.query<{ brandId: number }>(
          `SELECT brand_id AS "brandId"
           FROM brand
           WHERE lower(name_canonical) = lower($1)
           ORDER BY brand_id
           LIMIT 1`,
          [brandName]
        );

        if (existingBrand.rows.length > 0) {
          brandId = existingBrand.rows[0].brandId;
        } else {
          const insertedBrand = await client.query<{ brandId: number }>(
            `INSERT INTO brand (name_canonical)
             VALUES ($1)
             RETURNING brand_id AS "brandId"`,
            [brandName]
          );
          brandId = insertedBrand.rows[0].brandId;
          brandsCreated += 1;
        }

        brandCache.set(brandKey, brandId);
      }

      const variants =
        makeup.colorVariants.length > 0
          ? makeup.colorVariants
          : [{ name: null, hex: null }];

      if (makeup.colorVariants.length > 0) {
        // Remove legacy product-level shades from earlier imports once variant rows are available.
        await client.query(
          `DELETE FROM shade sh
           WHERE sh.brand_id = $1
             AND lower(sh.shade_name_canonical) = lower($2)
             AND coalesce(sh.collection, '') = ''
             -- Never a store shade (it has listings) or a user's shade that shares the product name.
             AND sh.created_by_user_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM shade_source_product ssp WHERE ssp.shade_id = sh.shade_id)
             AND NOT EXISTS (SELECT 1 FROM user_inventory_item ui WHERE ui.shade_id = sh.shade_id)
             AND NOT EXISTS (SELECT 1 FROM sku s WHERE s.shade_id = sh.shade_id)
             AND NOT EXISTS (SELECT 1 FROM manicure_polish mp WHERE mp.shade_id = sh.shade_id)`,
          [brandId, makeup.name]
        );
      }

      for (const variant of variants) {
        const shadeName = variant.name || makeup.name;
        if (!shadeName) {
          skipped += 1;
          continue;
        }
        variantRowsProcessed += 1;

        const collection = makeup.name;
        const resolvedColorName = variant.name || makeup.name;
        // Tag finishes are canonicalized and deduped like the Holo Taco path; descriptor/description
        // finishes fill in when there are none (#352); null leaves finishes empty.
        const mergedFinishes = applyIngestedFinishes([], finishResolution, finishCatalog, null);
        const { category: productCategory } = classifyProductCategory({
          shadeName,
          colorName: resolvedColorName,
          finishes: mergedFinishes ?? [],
          products: [{ title: makeup.name, productType: asString(normalized.category), tags: makeup.tags }],
        });

        // Identity is brand + color name, never the product name: MakeupAPI lists the sibling colors
        // of a family on every product of the family (Dior), so keying on `collection` made a copy
        // per product. A shade merged away by the MakeupAPI dedupe resolves to its survivor.
        const existingShade = await findMakeupApiShade(client, brandId, shadeName, productCategory);
        if (existingShade.kind === "ambiguous") {
          // The catalog already has several shades by that name: leave them to an admin.
          ambiguousShadesSkipped += 1;
          continue;
        }
        if (existingShade.kind === "match") {
          // MakeupAPI's feed is frozen 2015 data with scraped hexes: it only writes catalog data to a
          // shade it creates. An existing shade (a store or seed shade, or a merge survivor) only
          // gains the MakeupAPI listing, so it never takes MakeupAPI's hex, color name or finishes.
          if (dataSourceId !== undefined) {
            await recordShadeSourceProduct(client, existingShade.shadeId, dataSourceId, record.externalId);
          }
          existingShadesLinked += 1;
          continue;
        }

        const insertedShade = await client.query<{ shadeId: number }>(
          `INSERT INTO shade (brand_id, shade_name_canonical, collection, status)
           VALUES ($1, $2, $3, 'active')
           RETURNING shade_id AS "shadeId"`,
          [brandId, shadeName, collection]
        );
        const shadeId = insertedShade.rows[0].shadeId;
        shadesCreated += 1;

        if (dataSourceId !== undefined) {
          await recordShadeSourceProduct(client, shadeId, dataSourceId, record.externalId);
        }

        // Write color data to the new shade
        const vendorHexPlan = planIngestedVendorHex(null, variant.hex || null, true);
        await client.query(
          `UPDATE shade SET
             color_name = COALESCE($2, color_name),
             ${ingestedVendorHexSetSql("$3", 5)},
             finishes = COALESCE($4::text[], finishes),
             updated_at = now()
           WHERE shade_id = $1`,
          [shadeId, resolvedColorName, vendorHexPlan.vendorHex, mergedFinishes, ...ingestedVendorHexParams(vendorHexPlan)]
        );
        await applyRuleProductCategory(client, shadeId, productCategory);
      }
    }

    return {
      variantRowsProcessed,
      brandsCreated,
      shadesCreated,
      skipped,
      existingShadesLinked,
      ambiguousShadesSkipped,
    };
  });
}

/** The rule category stored with a shade; reads the raw product title like the connector gate does. */
export function classifyMaterializedCategory(input: {
  name: string;
  rawTitle: string | null;
  colorName?: string | null;
  finishes: string[];
  productType: string | null;
  tags: string[];
}): ProductCategory {
  return classifyProductCategory({
    shadeName: input.name,
    colorName: input.colorName,
    finishes: input.finishes,
    products: [{ title: input.rawTitle ?? input.name, productType: input.productType, tags: input.tags }],
  }).category;
}

interface HoloTacoRecordMaterializationDelta {
  processed: number;
  brandsCreated: number;
  shadesCreated: number;
  hexOverwritten: number;
  swatchesLinked: number;
  gallerySwatchesPruned: number;
  galleryNearDuplicatesSkipped: number;
  galleryOverCapSkipped: number;
  /** The materialized shade (unset when the record was skipped). */
  shadeId?: number;
  /** Catalog barcodes newly linked to the shade (#21). */
  barcodesLinked: number;
  /** GTINs another shade already owns (kept by that shade; logged by the caller). */
  barcodeConflicts: BarcodeConflict[];
  /** GTINs stored although their check digit is wrong (logged by the caller). */
  barcodeInvalidCheckDigits: string[];
  /** Another shade holds the product's raw store title while the clean name matched (admin should merge; logged by the caller). */
  rawTitleDuplicate?: { brand: string; name: string; rawTitle: string; matchedShadeId: number; rawShadeId: number };
  /** A brand store moved, renamed, merged or left (skipped) the shade its listing pointed at (logged by the caller). */
  correction?: BrandStoreCorrection;
  skipped: number;
  /** Why the record was skipped (job-log text); unset = no normalized data or shade name. */
  skipReason?: string;
  /** Extra job-log data for the skip warning (e.g. the ambiguous `candidateShadeIds`). */
  skipDetails?: Record<string, unknown>;
  /** The record was skipped because several shades fit it (listings or candidates). */
  ambiguousShadesSkipped: number;
}

/**
 * How a record looks for an existing shade: `brand` (the brand's own store) or `adopt` (a retailer
 * or feed source, `HoloTacoMaterializationOptions.sourceKind`).
 */
type ShadeLookupKind = "brand" | "adopt";

type ExistingShadeLookup =
  /**
   * Materialize onto this shade. `via`: the product's own listing (step 0), the exact identity
   * (step 1) or a same-name candidate (step 2); only a listing match is corrected
   * (`correctBrandStoreShade`).
   */
  | { outcome: "found"; shadeId: number; via?: "listing" | "identity" | "candidate" }
  /** Create a new shade; `candidateShadeIds` are same-name shades whose finishes did not fit. */
  | { outcome: "create"; candidateShadeIds: number[] }
  /** Several listings or candidates fit: skip the record, never pick one. */
  | { outcome: "ambiguous"; candidateShadeIds: number[] };

/**
 * The existing shade a connector record materializes onto, or none (create a new shade).
 *
 * 0. For every source kind, the product's own `shade_source_product` listing wins outright when
 *    exactly one links it to an unmerged shade of any status (written by an earlier run, so it is
 *    exact for adopted shades too, and an admin-`excluded` shade is reused rather than
 *    duplicated). Several such links: an adopting source skips the record as ambiguous; a brand
 *    source takes the step-1 identity match only when it is one of the linked shades, and
 *    otherwise skips the record too (never a third link, never step 2).
 * 1. A brand source then tries the exact identity (brand + name + legacy `finish` +
 *    `collection`). An adopting source skips it: its records carry no legacy finish or
 *    collection, so the exact match would attach any listing to a same-name shade.
 * 2. Then the brand's `active` or `excluded`, unmerged same-name shades: all of them for an
 *    adopting source; for a brand source only those with no legacy finish and no collection that a
 *    retailer or feed created (`catalog_authority = 'retailer'`) and no brand listing points at yet
 *    (a takeover flips the authority only once the brand's detected hex is written, so the
 *    listing is what stops a second same-name brand product adopting it; a brand's same-name
 *    re-release still gets its own shade, and the brand takes an adopted one over), kept
 *    by `finishesFitRecord`. Exactly one left is adopted; none left means a new shade; several
 *    (never picked by listing count) skip the record. `candidateShadeIds` lists every same-name
 *    candidate so the caller can warn.
 */
async function findExistingShadeForRecord(
  client: Pick<PoolClient, "query">,
  params: {
    kind: ShadeLookupKind;
    dataSourceId: number;
    externalId: string;
    brandId: number;
    name: string;
    finish: string | null;
    collection: string | null;
    finishes: readonly string[];
    /** The product's raw store title when it differs from the cleaned name (`normalized.rawTitle`). */
    rawTitle?: string | null;
  },
  finishCatalog?: FinishCatalog
): Promise<ExistingShadeLookup> {
  const { kind, dataSourceId, externalId, brandId, name, finish, collection, finishes } = params;
  const listed = await client.query<{ shadeId: number }>(
    `SELECT DISTINCT ssp.shade_id AS "shadeId"
     FROM shade_source_product ssp
     JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
     JOIN shade sh ON sh.shade_id = ssp.shade_id
     WHERE ep.data_source_id = $1
       AND ep.external_id = $2
       AND sh.merged_into_shade_id IS NULL
     ORDER BY ssp.shade_id`,
    [dataSourceId, externalId]
  );
  const listedShadeIds = listed.rows
    .map((row) => row.shadeId)
    .filter((id) => id !== null && id !== undefined)
    .map(Number);
  if (listedShadeIds.length === 1) {
    return { outcome: "found", shadeId: listedShadeIds[0], via: "listing" };
  }
  if (listedShadeIds.length > 1 && kind === "adopt") {
    return { outcome: "ambiguous", candidateShadeIds: listedShadeIds };
  }

  if (kind === "brand") {
    // The clean name, else the raw store title an earlier ingest stored it under (renamed later).
    const exact = await findShadeForIngestedName(client, {
      brandId,
      name,
      rawTitle: params.rawTitle ?? null,
      finish,
      collection,
    });
    if (listedShadeIds.length > 1) {
      // Several listings for one product: the exact identity decides only among the linked shades,
      // so the product never gains a third link; otherwise skip it like any ambiguous record.
      return exact && listedShadeIds.includes(Number(exact.shadeId))
        ? { outcome: "found", shadeId: Number(exact.shadeId), via: "listing" }
        : { outcome: "ambiguous", candidateShadeIds: listedShadeIds };
    }
    if (exact) {
      return { outcome: "found", shadeId: Number(exact.shadeId), via: "identity" };
    }
  }

  const candidates = await client.query<{ shadeId: number; finishes: string[] | null }>(
    `SELECT shade_id AS "shadeId", finishes
     FROM shade
     WHERE brand_id = $1
       AND product_line_id IS NULL
       AND lower(shade_name_canonical) = lower($2)
       AND status IN ('active', 'excluded')
       AND merged_into_shade_id IS NULL
       ${
         kind === "brand"
           ? `AND finish IS NULL AND collection IS NULL
       AND catalog_authority = 'retailer'
       -- A brand listing already adopted it (its takeover may still wait for the detected hex).
       AND NOT EXISTS (
         SELECT 1
         FROM shade_source_product kssp
         JOIN external_product kep ON kep.external_product_id = kssp.external_product_id
         JOIN data_source kds ON kds.data_source_id = kep.data_source_id
         WHERE kssp.shade_id = shade.shade_id
           AND ${isBrandSourceSql("kds.metadata")}
       )`
           : ""
       }
     ORDER BY shade_id`,
    [brandId, name]
  );
  if (candidates.rows.length === 0) {
    return { outcome: "create", candidateShadeIds: [] };
  }

  const compatible = candidates.rows.filter((candidate) =>
    finishesFitRecord(finishes, candidate.finishes ?? [], finishCatalog)
  );
  const candidateShadeIds = candidates.rows.map((candidate) => Number(candidate.shadeId));
  if (compatible.length === 1) {
    return { outcome: "found", shadeId: Number(compatible[0].shadeId), via: "candidate" };
  }
  return { outcome: compatible.length === 0 ? "create" : "ambiguous", candidateShadeIds };
}

/**
 * Whether a same-name shade's finishes fit a record's (the adoption check). A shared canonical
 * finish name always fits. A finish without a family (`finish_type.family`, CLAUDE.md finish
 * families rule) carries no information and is ignored, so it never makes a candidate unfit; a
 * side left with no family-bearing finish (or no finishes at all) fits anything. Otherwise the
 * two must share a family.
 */
function finishesFitRecord(
  recordFinishes: readonly string[],
  candidateFinishes: readonly string[],
  finishCatalog?: FinishCatalog
): boolean {
  const key = (value: string) => value.trim().toLowerCase();
  const recordNames = new Set(recordFinishes.map(key));
  if (candidateFinishes.some((value) => recordNames.has(key(value)))) return true;
  const familiesOf = (list: readonly string[]): Set<string> =>
    new Set(
      list.flatMap((value) => {
        const family = finishFamily(value, finishCatalog?.families);
        return family ? [family] : [];
      })
    );
  const recordFamilies = familiesOf(recordFinishes);
  const candidateFamilies = familiesOf(candidateFinishes);
  if (recordFamilies.size === 0 || candidateFamilies.size === 0) return true;
  return [...candidateFamilies].some((family) => recordFamilies.has(family));
}

/**
 * Whether the shade's newest `source_product` swatch shows another source's image (retailer and
 * feed images never replace it). A shade without a product swatch, or whose product image this
 * source stored itself, answers false.
 */
async function shadeHasForeignProductImage(
  client: Pick<PoolClient, "query">,
  shadeId: number,
  dataSourceId: number
): Promise<boolean> {
  const productSwatch = await client.query<{ ownImage: boolean }>(
    `SELECT (ia.owner_type = 'source' AND ia.owner_id = $2) IS TRUE AS "ownImage"
     FROM swatch sw
     LEFT JOIN image_asset ia ON ia.image_id = sw.image_id_original
     WHERE sw.shade_id = $1
       AND sw.swatch_type = 'source_product'
     ORDER BY sw.swatch_id DESC
     LIMIT 1`,
    [shadeId, dataSourceId]
  );
  return productSwatch.rows.length > 0 && !productSwatch.rows[0].ownImage;
}

interface PreResolvedRecordShade {
  lookup: ExistingShadeLookup;
  /** Adopting source only: the found shade already shows another source's product image. */
  foreignProductImage: boolean;
}

/**
 * Resolution before detection: every record's shade is looked up (`findExistingShadeForRecord`,
 * read-only: a brand that does not exist yet means `create`) before any image is downloaded, so
 * an ambiguous record costs no upload or vision call, the admin-category gate sees a shade adopted
 * on this very run, and an adopting source skips images it would never link. A record without a
 * name or brand, or whose lookup fails, is left out (the materializer resolves it itself).
 */
async function preResolveRecordShades(
  records: ConnectorProductRecord[],
  dataSourceId: number,
  params: {
    adopt: boolean;
    sourceName?: string;
    finishCatalog?: FinishCatalog;
    sourceLogPrefix: string;
  }
): Promise<Map<string, PreResolvedRecordShade>> {
  const out = new Map<string, PreResolvedRecordShade>();
  const client = { query } as Pick<PoolClient, "query">;
  const brandIds = new Map<string, Promise<number | null>>();
  const brandIdFor = (brandName: string): Promise<number | null> => {
    const key = brandName.toLowerCase();
    let pending = brandIds.get(key);
    if (!pending) {
      // By canonical name or brand alias, like the materializer (`findIngestedBrandId`).
      pending = findIngestedBrandId(client, brandName).then((brandId) =>
        brandId === null ? null : Number(brandId)
      );
      brandIds.set(key, pending);
    }
    return pending;
  };

  const limit = pLimit(4);
  await Promise.all(
    records.map((record) =>
      limit(async () => {
        const normalized =
          record.normalized && typeof record.normalized === "object"
            ? (record.normalized as Record<string, unknown>)
            : null;
        if (!normalized) return;
        const holo = parseHoloTacoNormalized(normalized);
        const brandName = holo.name ? resolveHoloTacoBrandName(holo, params.sourceName) : null;
        if (!holo.name || !brandName) return;
        try {
          const brandId = await brandIdFor(brandName);
          if (brandId === null) {
            out.set(record.externalId, { lookup: { outcome: "create", candidateShadeIds: [] }, foreignProductImage: false });
            return;
          }
          const lookup = await findExistingShadeForRecord(
            client,
            {
              kind: params.adopt ? "adopt" : "brand",
              dataSourceId,
              externalId: record.externalId,
              brandId,
              name: holo.name,
              finish: holo.finish,
              collection: holo.collection,
              finishes: resolveIngestedShadeFinishResolution(normalized, params.finishCatalog).finishes,
              rawTitle: holo.rawTitle,
            },
            params.finishCatalog
          );
          const foreignProductImage =
            params.adopt && lookup.outcome === "found"
              ? await shadeHasForeignProductImage(client, lookup.shadeId, dataSourceId)
              : false;
          out.set(record.externalId, { lookup, foreignProductImage });
        } catch (error) {
          console.warn(
            `${params.sourceLogPrefix} Shade pre-resolution failed for ${record.externalId}; resolving at materialization: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      })
    )
  );
  return out;
}

async function materializePreparedHoloTacoRecord(
  client: PoolClient,
  dataSourceId: number,
  record: ConnectorProductRecord,
  preparedImage: HoloTacoPreparedImage,
  overwriteDetectedHex: boolean,
  sourceLogPrefix: string,
  brandCache: Map<string, number>,
  finishCatalog?: FinishCatalog,
  sourceOptions: Pick<HoloTacoMaterializationOptions, "sourceKind" | "sourceName" | "progressLogger" | "actorUserId"> = {}
): Promise<HoloTacoRecordMaterializationDelta> {
  const delta: HoloTacoRecordMaterializationDelta = {
    processed: 0,
    brandsCreated: 0,
    shadesCreated: 0,
    hexOverwritten: 0,
    swatchesLinked: 0,
    gallerySwatchesPruned: 0,
    galleryNearDuplicatesSkipped: 0,
    galleryOverCapSkipped: 0,
    barcodesLinked: 0,
    barcodeConflicts: [],
    barcodeInvalidCheckDigits: [],
    skipped: 0,
    ambiguousShadesSkipped: 0,
  };

  const normalized =
    record.normalized && typeof record.normalized === "object"
      ? (record.normalized as Record<string, unknown>)
      : null;

  if (!normalized) {
    delta.skipped += 1;
    return delta;
  }

  const holo = parseHoloTacoNormalized(normalized);
  if (!holo.name) {
    delta.skipped += 1;
    return delta;
  }
  // Tags, else descriptors, else description text (#352).
  const finishResolution = resolveIngestedShadeFinishResolution(normalized, finishCatalog);
  const ingestedFinishes = finishResolution.finishes;

  console.log(`${sourceLogPrefix} Processing record: externalId=${record.externalId}, name=${holo.name}`);

  const brandName = resolveHoloTacoBrandName(holo, sourceOptions.sourceName);
  if (!brandName) {
    // Only Holo Taco's own store may omit the brand; elsewhere the shade's brand is unknown.
    delta.skipped += 1;
    delta.skipReason = "no brand";
    return delta;
  }
  const brandKey = brandName.toLowerCase();
  let brandId = brandCache.get(brandKey);

  if (!brandId) {
    const existingBrandId = await findIngestedBrandId(client, brandName);

    if (existingBrandId !== null) {
      brandId = existingBrandId;
    } else {
      const insertedBrand = await client.query<{ brandId: number }>(
        `INSERT INTO brand (name_canonical)
         VALUES ($1)
         RETURNING brand_id AS "brandId"`,
        [brandName]
      );
      brandId = insertedBrand.rows[0].brandId;
      delta.brandsCreated += 1;
    }

    brandCache.set(brandKey, brandId);
  }

  const sourceKind: SourceKind = sourceOptions.sourceKind ?? "brand";
  const adoptsExistingShades = sourceKind !== "brand";
  // The image phase resolved the record before any image work (`preResolveRecordShades`). For an
  // adopting source a found shade is used unless it has since been merged away (or deleted), and
  // an ambiguous record stays skipped. A `create` is looked up again: an earlier record of this
  // run may have created it. A brand source always looks up again inside this transaction: an
  // earlier record's takeover can disqualify a step-2 candidate (it must still have
  // `catalog_authority = 'retailer'` and no brand listing), so a pre-resolved adoption may be stale.
  const preResolved = adoptsExistingShades ? preparedImage.shadeResolution ?? null : null;
  let existingShade: ExistingShadeLookup | null = null;
  if (preResolved?.outcome === "ambiguous") {
    existingShade = preResolved;
  } else if (preResolved?.outcome === "found") {
    const stillThere = await client.query(
      `SELECT 1 FROM shade WHERE shade_id = $1 AND merged_into_shade_id IS NULL`,
      [preResolved.shadeId]
    );
    if (stillThere.rows.length > 0) existingShade = preResolved;
  }
  if (!existingShade) {
    existingShade = await findExistingShadeForRecord(
      client,
      {
        kind: adoptsExistingShades ? "adopt" : "brand",
        dataSourceId,
        externalId: record.externalId,
        brandId,
        name: holo.name,
        finish: holo.finish,
        collection: holo.collection,
        finishes: ingestedFinishes,
        rawTitle: holo.rawTitle,
      },
      finishCatalog
    );
  }

  if (existingShade.outcome === "ambiguous") {
    // Several shades fit (listings or same-name candidates): never pick one by guesswork.
    delta.skipped += 1;
    delta.ambiguousShadesSkipped += 1;
    delta.skipReason = `several ${brandName} shades named "${holo.name}" fit it`;
    delta.skipDetails = { brand: brandName, name: holo.name, candidateShadeIds: existingShade.candidateShadeIds };
    return delta;
  }

  delta.processed += 1;

  let shadeId: number;
  if (existingShade.outcome === "found") {
    shadeId = existingShade.shadeId;
    if (sourceKind === "brand" && existingShade.via === "listing") {
      // An earlier run may have filed the product under a vendor spelling or its raw title: move,
      // rename or merge the shade onto the record's brand and clean name (lib/brand-store-correction.ts).
      const correction = await correctBrandStoreShade(client, {
        shadeId,
        dataSourceId,
        sourceName: sourceOptions.sourceName,
        externalId: record.externalId,
        record: { brandId: Number(brandId), brand: brandName, name: holo.name, finish: holo.finish, collection: holo.collection },
        rawTitle: holo.rawTitle,
        actorUserId: sourceOptions.actorUserId ?? null,
        finishesFit: (candidateFinishes) => finishesFitRecord(ingestedFinishes, candidateFinishes, finishCatalog),
      });
      if (correction.outcome !== "unchanged") delta.correction = correction;
      if (correction.outcome === "merged") shadeId = correction.targetShadeId;
    }
    if (holo.rawTitle && holo.rawTitle.toLowerCase() !== holo.name.toLowerCase()) {
      const rawShadeId = await findShadeByRawTitle(client, {
        brandId,
        name: holo.name,
        rawTitle: holo.rawTitle,
        finish: holo.finish,
        collection: holo.collection,
      });
      if (rawShadeId === shadeId) {
        // Still stored under the raw store title (e.g. "Sniff Test PPU"): take the cleaned name and
        // keep the raw one as an alias, unless another shade already has the clean name.
        const clean = await findShadeForIngestedName(client, {
          brandId,
          name: holo.name,
          rawTitle: null,
          finish: holo.finish,
          collection: holo.collection,
        });
        if (!clean) {
          await renameShadeToCleanName(client, shadeId, holo.name, holo.rawTitle);
        } else if (clean.shadeId !== shadeId) {
          delta.rawTitleDuplicate = {
            brand: brandName,
            name: holo.name,
            rawTitle: holo.rawTitle,
            matchedShadeId: Number(clean.shadeId),
            rawShadeId: shadeId,
          };
        }
      } else if (isRawTitleDuplicate(shadeId, rawShadeId) && rawShadeId !== null) {
        // Matched by the clean name: a brand-store shade stored under the raw title may still exist.
        delta.rawTitleDuplicate = {
          brand: brandName,
          name: holo.name,
          rawTitle: holo.rawTitle,
          matchedShadeId: shadeId,
          rawShadeId,
        };
      }
    }
  } else {
    if (existingShade.candidateShadeIds.length > 0) {
      const message = `${sourceLogPrefix} ${record.externalId}: no same-name ${brandName} shade "${holo.name}" fits its finishes; creating a new shade`;
      const data = { externalId: record.externalId, brand: brandName, name: holo.name, candidateShadeIds: existingShade.candidateShadeIds };
      console.warn(message, data);
      sourceOptions.progressLogger?.warn(message, data);
    }
    const insertedShade = await client.query<{ shadeId: number }>(
      `INSERT INTO shade (brand_id, shade_name_canonical, finish, collection, status, finishes, catalog_authority)
       VALUES ($1, $2, $3, $4, 'active', $5::text[], $6)
       RETURNING shade_id AS "shadeId"`,
      [brandId, holo.name, holo.finish, holo.collection, ingestedFinishes, catalogAuthorityForKind(sourceKind)]
    );
    shadeId = insertedShade.rows[0].shadeId;
    delta.shadesCreated += 1;
  }

  // Remember which product this shade came from (drives the "Buy from brand" link, #267).
  await recordShadeSourceProduct(client, shadeId, dataSourceId, record.externalId);
  delta.shadeId = shadeId;
  // Retailer listings carry the vendor code ("NLB83") and the raw listing title; both become
  // aliases, so typed catalog search and CSV import match the code or title through the alias
  // (the capture / bottle resolver does not read shade_alias).
  await recordRetailerAliases(client, shadeId, holo.name, record.normalized);
  // Catalog barcodes (#21): the product GTIN and variant barcodes resolve scans to this shade.
  const barcodeResult = await materializeProductBarcodes(client, { shadeId, dataSourceId, record });
  delta.barcodesLinked += barcodeResult.inserted;
  delta.barcodeConflicts.push(...barcodeResult.conflicts);
  delta.barcodeInvalidCheckDigits.push(...barcodeResult.invalidCheckDigit);

  const vendorHex = holo.vendorHex;
  const detectedHex = preparedImage.detectedHex || null;
  let detectedFinishes = preparedImage.detectedFinishes || null;
  const detectedHexProvenance = preparedImage.detectedHexProvenance ?? EMPTY_DETECTED_HEX_PROVENANCE;
  const nameHex = holo.nameHex;
  console.log(
    `${sourceLogPrefix} Shade color update: shadeId=${shadeId}, vendorHex=${vendorHex}, detectedHex=${detectedHex}, nameHex=${nameHex}, confidence=${detectedHexProvenance.confidence}, method=${detectedHexProvenance.method}, model=${detectedHexProvenance.model}, promptVersion=${detectedHexProvenance.promptVersion}`
  );

  // Read current shade color data for overwrite comparison
  const currentShade = await client.query<ShadeVendorHexState & {
    detectedHex: string | null;
    detectedFinishes: string[] | null;
    nameHex: string | null;
    finishes: string[] | null;
    finishesSource: string | null;
    catalogAuthority: string | null;
  }>(
    `SELECT
       ${SHADE_VENDOR_HEX_COLUMNS},
       detected_hex AS "detectedHex",
       detected_finishes AS "detectedFinishes",
       name_hex AS "nameHex",
       finishes,
       finishes_source AS "finishesSource",
       catalog_authority AS "catalogAuthority"
     FROM shade WHERE shade_id = $1
     FOR UPDATE`,
    [shadeId]
  );
  // Vendor tag finishes are merged (never removed) so manual edits survive re-imports;
  // descriptor/description finishes only fill a shade that has none yet (#352); an admin-set
  // list (finishes_source = 'admin') is written back exactly as it is.
  // A fill-only listing (a retailer or feed on a brand-store shade) keeps a shade's finishes once
  // it has any (`planListingWrites`).
  const currentFinishes = currentShade.rows[0]?.finishes ?? [];
  const currentFinishesSource = currentShade.rows[0]?.finishesSource ?? null;

  // Source-kind write rules (`planListingWrites`): a retailer or feed only fills gaps on a
  // brand-store shade; a brand store takes over a shade a retailer or feed created (replaces its
  // finishes and colors with its own).
  const shadeCreated = existingShade.outcome !== "found";
  const shadeAuthority: CatalogAuthority =
    currentShade.rows[0]?.catalogAuthority === "retailer" ? "retailer" : "brand_store";
  const shadeHasForeignImage =
    adoptsExistingShades && !shadeCreated ? await shadeHasForeignProductImage(client, shadeId, dataSourceId) : false;
  const writePlan = planListingWrites({
    sourceKind,
    shadeCreated,
    shadeAuthority,
    shadeHasForeignProductImage: shadeHasForeignImage,
    shadeHasDetectedHex: currentShade.rows[0]?.detectedHex != null,
  });
  const { takeOver, fillOnly } = writePlan;
  // Only a brand store (or the listing that created the shade) may overwrite colors; a takeover
  // overwrites for this shade even without the job's overwrite switch.
  const effectiveOverwrite =
    takeOver || (overwriteDetectedHex && (shadeCreated || sourceKind === "brand"));
  // A takeover flips the authority only once the brand's detected hex is in (or no detection
  // applies); otherwise the shade stays 'retailer' and the next brand run (or the batch apply)
  // finishes the job. Every takeover write is idempotent.
  const authorityToSet =
    takeOver && preparedImage.detectionApplies && !preparedImage.detectedHex ? null : writePlan.setAuthority;
  if (takeOver) {
    console.log(`${sourceLogPrefix} Brand store takes over retailer-created shade ${shadeId}`);
  }

  const mergedFinishes = planIngestedFinishes<string>({
    current: currentFinishes,
    adminSet: currentFinishesSource === "admin",
    takeOver,
    // A retailer or feed on a brand-store shade fills finishes only when the shade has none.
    restrictedRetailer: fillOnly,
    fromEmpty: applyIngestedFinishes([], finishResolution, finishCatalog),
    merged:
      applyIngestedFinishes(currentFinishes, finishResolution, finishCatalog) ??
      mergeFinishLists([currentFinishes], finishCatalog),
  });
  if (adoptsExistingShades && !shadeCreated && (currentShade.rows[0]?.detectedFinishes?.length ?? 0) > 0) {
    // A retailer or feed never replaces AI-detected data, only fills it: NULL makes the UPDATE
    // keep detected_finishes (the row is locked FOR UPDATE above).
    detectedFinishes = null;
  }

  // A vendor hex follows the overwrite rule, except an admin-promoted manual label, which
  // ingestion never replaces (#321, D12): the vendor value is kept in vendor_hex_previous.
  const vendorHexPlan = planIngestedVendorHex(currentShade.rows[0] ?? null, vendorHex || null, effectiveOverwrite);

  const shouldOverwrite = effectiveOverwrite;
  if (
    shouldOverwrite && currentShade.rows.length > 0 &&
    (vendorHexPlan.vendorHexChanged ||
      (detectedHex && detectedHex !== currentShade.rows[0].detectedHex) ||
      (detectedFinishes &&
        JSON.stringify(detectedFinishes) !==
          JSON.stringify(currentShade.rows[0].detectedFinishes || [])) ||
      (nameHex && nameHex !== currentShade.rows[0].nameHex))
  ) {
    delta.hexOverwritten += 1;
  }

  // Write color data to shade (product-level)
  await client.query(
    `UPDATE shade
     SET color_name = CASE
           WHEN $17::boolean AND $2::text IS NOT NULL THEN $2::text
           ELSE COALESCE(color_name, $2)
         END,
         ${ingestedVendorHexSetSql("$3", 13)},
         detected_hex = CASE
           WHEN $6::boolean AND $4::text IS NOT NULL THEN $4::text
           ELSE COALESCE(detected_hex, $4::text)
         END,
         detected_finishes = CASE
           WHEN $6::boolean AND $5::text[] IS NOT NULL THEN $5::text[]
           WHEN detected_finishes IS NULL THEN $5::text[]
           WHEN $5::text[] IS NULL THEN detected_finishes
           ELSE (
             SELECT ARRAY(
               SELECT DISTINCT f
               FROM unnest(COALESCE(detected_finishes, ARRAY[]::text[]) || $5::text[]) AS f
               ORDER BY f
             )
           )
         END,
         name_hex = CASE
           WHEN $6::boolean AND $7::text IS NOT NULL THEN $7::text
           ELSE COALESCE(name_hex, $7::text)
         END,
         finishes = $8::text[],
         -- detected_hex provenance follows the same overwrite/COALESCE rule as detected_hex:
         -- rewritten when overwriting, otherwise only filled when detected_hex was NULL.
         -- hex_agreement (vendor_hex ↔ detected_hex OKLAB distance) is a generated column.
         ${detectedHexProvenanceSetSql(
           "($6::boolean AND $4::text IS NOT NULL) OR (detected_hex IS NULL AND $4::text IS NOT NULL)",
           9
         )},
         -- Catalog data confirms a user-submitted shade: promote it to the shared catalog.
         status = CASE WHEN status = 'user_submitted' AND merged_into_shade_id IS NULL THEN 'active' ELSE status END,
         catalog_authority = COALESCE($16::text, catalog_authority),
         updated_at = now()
     WHERE shade_id = $1`,
    [
      shadeId,
      holo.name,
      vendorHexPlan.vendorHex,
      detectedHex,
      detectedFinishes,
      effectiveOverwrite,
      nameHex,
      mergedFinishes,
      ...provenanceParams(detectedHexProvenance),
      ...ingestedVendorHexParams(vendorHexPlan),
      authorityToSet,
      takeOver,
    ]
  );

  // Product category (#349): the connector's rule category, re-checked with the merged finishes
  // (a `topper` finish makes a topper). An admin-set category is never changed, and a retailer or
  // feed never re-classifies a brand-store shade (its "Top Coat" tag must not flip a brand shade).
  const productCategory = classifyMaterializedCategory({
    name: holo.name,
    rawTitle: holo.rawTitle,
    colorName: holo.colorName,
    finishes: [...asStringArray(normalized.finishes), ...(mergedFinishes ?? [])],
    productType: asString(normalized.productType),
    tags: holo.tags,
  });
  if (writePlan.writeCategory) {
    await applyRuleProductCategory(client, shadeId, productCategory);
  }


  // Image ids of the product's current images (primary first), for the gallery prune below.
  const currentImageIds: number[] = [];
  let galleryLinked = preparedImage.imageSetComplete;

  if (preparedImage.storageUrl && preparedImage.checksumSha256) {
    console.log(`${sourceLogPrefix} Processing swatch for shade ${shadeId}: checksum=${preparedImage.checksumSha256}`);
    const existingImage = await client.query<{ imageId: number }>(
      `SELECT image_id AS "imageId"
       FROM image_asset
       WHERE owner_type = 'source'
         AND owner_id = $1
         AND checksum_sha256 = $2
       LIMIT 1`,
      [dataSourceId, preparedImage.checksumSha256]
    );

    let imageId: number;
    if (existingImage.rows.length > 0) {
      imageId = existingImage.rows[0].imageId;
      console.log(`${sourceLogPrefix} Found existing image ${imageId}`);
      await storeImageFingerprint(client, imageId, preparedImage.fingerprint);
    } else {
      imageId = await insertSourceImageAsset(
        client,
        dataSourceId,
        preparedImage.storageUrl,
        preparedImage.checksumSha256,
        preparedImage.fingerprint
      );
      console.log(`${sourceLogPrefix} Inserted new image ${imageId}`);
    }
    currentImageIds.push(imageId);
    if (preparedImage.sourceUrl) {
      await recordSourceImageUrl(client, dataSourceId, preparedImage.sourceUrl, imageId);
    }

    // A retailer listing that may not link images (the brand store already supplied them) still
    // records the stored asset and its source URL above, so later runs reuse it instead of
    // downloading it again; only the swatch links below are skipped.
    if (writePlan.linkGallery) {
      const existingSwatch = await client.query<{ swatchId: number; imageIdOriginal: number }>(
        `SELECT
           swatch_id AS "swatchId",
           image_id_original AS "imageIdOriginal"
         FROM swatch
         WHERE shade_id = $1
           AND swatch_type = 'source_product'
         ORDER BY swatch_id DESC
         LIMIT 1`,
        [shadeId]
      );

      if (existingSwatch.rows.length === 0) {
        console.log(`${sourceLogPrefix} Inserting new swatch for shade ${shadeId} with image ${imageId}`);
        await client.query(
          `INSERT INTO swatch (shade_id, image_id_original, swatch_type, lighting, background, quality_score)
           VALUES ($1, $2, 'source_product', 'unknown', 'transparent', 80.0)`,
          [shadeId, imageId]
        );
        delta.swatchesLinked += 1;
        console.log(`${sourceLogPrefix} Inserted swatch successfully`);
      } else if (existingSwatch.rows[0].imageIdOriginal !== imageId) {
        console.log(`${sourceLogPrefix} Updating swatch ${existingSwatch.rows[0].swatchId} with new image ${imageId}`);
        await client.query(
          `UPDATE swatch
           SET image_id_original = $2
           WHERE swatch_id = $1
             AND swatch_type = 'source_product'`,
          [existingSwatch.rows[0].swatchId, imageId]
        );
        delta.swatchesLinked += 1;
        console.log(`${sourceLogPrefix} Updated swatch successfully`);
      }

      // A gallery swatch on the primary image duplicates the product swatch, e.g. after the
      // shop promotes a gallery image to primary. The old primary is re-linked as gallery below.
      await client.query(
        `DELETE FROM swatch
         WHERE shade_id = $1
           AND image_id_original = $2
           AND swatch_type = 'source_gallery'`,
        [shadeId, imageId]
      );
    }
  }

  // Store additional images as image_assets and link each as a source_gallery swatch, except
  // near-duplicates of an image already linked for this product (vendor re-crops / re-exports of
  // one photo) and images past GALLERY_MAX_IMAGES_PER_SHADE. Skipped images are still stored and
  // stay in the prune keep-set (currentImageIds); a swatch an earlier run linked for one is
  // unlinked here, so the decision is the same on every run for the same vendor gallery. AI
  // detection already chose its image from every upload, and that image is always linked.
  const galleryPlan = planProductGalleryLinks({
    primary: preparedImage.checksumSha256
      ? { key: preparedImage.checksumSha256, fingerprint: preparedImage.fingerprint }
      : null,
    additional: preparedImage.additionalImages.map((image) => ({
      key: image.checksumSha256,
      fingerprint: image.fingerprint,
      pinned: preparedImage.detectionSourceUrl !== null && image.sourceUrl === preparedImage.detectionSourceUrl,
    })),
    maxGalleryImages: getGalleryMaxImagesPerShade(),
  });
  let sharedShade: boolean | null = null;
  for (const [index, addImg] of preparedImage.additionalImages.entries()) {
    const decision = galleryPlan[index];
    try {
      const existingAdditional = await client.query<{ imageId: number }>(
        `SELECT image_id AS "imageId"
         FROM image_asset
         WHERE owner_type = 'source'
           AND owner_id = $1
           AND checksum_sha256 = $2
         LIMIT 1`,
        [dataSourceId, addImg.checksumSha256]
      );

      let galleryImageId: number;
      if (existingAdditional.rows.length === 0) {
        galleryImageId = await insertSourceImageAsset(
          client,
          dataSourceId,
          addImg.storageUrl,
          addImg.checksumSha256,
          addImg.fingerprint
        );
        console.log(
          `${sourceLogPrefix} Stored additional image for ${record.externalId}: checksum=${addImg.checksumSha256}`
        );
      } else {
        galleryImageId = existingAdditional.rows[0].imageId;
        await storeImageFingerprint(client, galleryImageId, addImg.fingerprint);
      }
      currentImageIds.push(galleryImageId);
      await recordSourceImageUrl(client, dataSourceId, addImg.sourceUrl, galleryImageId);

      if (!writePlan.linkGallery) {
        // Stored and its URL recorded for reuse, but never linked to a brand-store shade.
        continue;
      }
      if (decision.reason === "same_image") {
        // Same stored image as the primary or an earlier gallery image: already linked.
        continue;
      }
      if (!decision.link) {
        if (decision.reason === "near_duplicate") {
          delta.galleryNearDuplicatesSkipped += 1;
        } else {
          delta.galleryOverCapSkipped += 1;
        }
        // Like the stale prune: never unlink when another product of this source maps to the shade.
        sharedShade ??= await shadeSharedWithOtherProduct(client, {
          shadeId,
          dataSourceId,
          externalId: record.externalId,
        });
        const unlinked = sharedShade
          ? { rows: [] }
          : await client.query(
              `DELETE FROM swatch sw
               WHERE sw.shade_id = $1
                 AND sw.image_id_original = $2
                 AND sw.swatch_type = 'source_gallery'
                 AND NOT ${protectedSwatchSql("sw")}
               RETURNING sw.swatch_id`,
              [shadeId, galleryImageId]
            );
        delta.gallerySwatchesPruned += unlinked.rows.length;
        console.log(
          `${sourceLogPrefix} Not linking additional image ${galleryImageId} to shade ${shadeId}: ${
            decision.reason === "near_duplicate"
              ? `near-duplicate of checksum=${decision.duplicateOfKey}`
              : "gallery cap reached"
          }${unlinked.rows.length > 0 ? " (unlinked the earlier swatch)" : ""}`
        );
        continue;
      }

      const existingGallerySwatch = await client.query<{ swatchId: number }>(
        `SELECT swatch_id AS "swatchId"
         FROM swatch
         WHERE shade_id = $1
           AND image_id_original = $2
         LIMIT 1`,
        [shadeId, galleryImageId]
      );

      if (existingGallerySwatch.rows.length === 0) {
        await client.query(
          `INSERT INTO swatch (shade_id, image_id_original, swatch_type, lighting, background, quality_score)
           VALUES ($1, $2, 'source_gallery', 'unknown', 'transparent', 70.0)`,
          [shadeId, galleryImageId]
        );
        delta.swatchesLinked += 1;
        console.log(
          `${sourceLogPrefix} Linked additional image to shade ${shadeId}: imageId=${galleryImageId}`
        );
      }
    } catch (err) {
      galleryLinked = false;
      console.error(`${sourceLogPrefix} Error storing additional image:`, String(err));
      // Non-fatal: don't throw for additional images
    }
  }

  // Gallery swatches are otherwise only ever added, so every image ever stored for the shade
  // (including the same picture stored twice under different checksums by older ingests) would
  // stay linked. Reconcile this data source's gallery with the product's current images, but
  // only when all of them were stored and linked: a failed download must not unlink anything.
  if (writePlan.linkGallery && galleryLinked && currentImageIds.length > 0) {
    const pruned = await pruneStaleGallerySwatches(client, {
      shadeId,
      dataSourceId,
      externalId: record.externalId,
      keepImageIds: currentImageIds,
    });
    if (pruned.deleted > 0) {
      delta.gallerySwatchesPruned += pruned.deleted;
      console.log(
        `${sourceLogPrefix} Unlinked ${pruned.deleted} stale gallery image(s) from shade ${shadeId}`
      );
    } else if (pruned.skippedSharedShade) {
      console.log(
        `${sourceLogPrefix} Gallery prune skipped for shade ${shadeId}: another product of this source maps to it`
      );
    }
  }

  // The brand's own images are linked above; the retailer's replace-able ones go (R8).
  // Only once the brand's own primary is linked and its whole image set stored; otherwise the
  // retailer images stay until the next brand run.
  if (takeOver && galleryLinked && currentImageIds.length > 0) {
    const unlinked = await unlinkRetailerGallerySwatches(client, shadeId);
    if (unlinked > 0) {
      delta.gallerySwatchesPruned += unlinked;
      console.log(`${sourceLogPrefix} Unlinked ${unlinked} retailer image(s) from shade ${shadeId}`);
    }
  }

  return delta;
}

/**
 * Job-log line(s) for one brand-store correction (info for a move, rename or merge, warn for a
 * skip) and the counts it adds to the job metrics. After a merge the polish caches of the users
 * whose inventory moved are dropped (the record's transaction has committed).
 */
async function reportBrandStoreCorrection(
  correction: BrandStoreCorrection,
  externalId: string,
  sourceLogPrefix: string,
  progressLogger: HoloTacoMaterializationOptions["progressLogger"]
): Promise<{ moved: number; renamed: number; merged: number; skipped: number }> {
  const counts = { moved: 0, renamed: 0, merged: 0, skipped: 0 };
  if (correction.outcome === "unchanged") return counts;
  if (correction.outcome === "moved") {
    counts.moved = correction.brandChanged ? 1 : 0;
    counts.renamed = correction.renamed ? 1 : 0;
    const what = [
      correction.brandChanged ? `brand ${correction.fromBrand} → ${correction.toBrand}` : null,
      correction.renamed ? `name "${correction.fromName}" → "${correction.toName}"` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const message = `${sourceLogPrefix} Corrected shade ${correction.shadeId} of ${externalId}: ${what}`;
    console.log(message);
    progressLogger?.info(message, { externalId, ...correction });
    return counts;
  }
  if (correction.outcome === "merged") {
    counts.merged = 1;
    const message = `${sourceLogPrefix} Merged shade ${correction.sourceShadeId} (${correction.fromBrand} "${correction.fromName}") of ${externalId} into ${correction.toBrand} shade ${correction.targetShadeId} "${correction.targetName}" (${correction.movedInventoryRows + correction.combinedInventoryRows} inventory rows moved)`;
    console.log(message);
    progressLogger?.info(message, { externalId, ...correction });
    for (const userId of correction.affectedUserIds) {
      try {
        await invalidatePolishCachesForUser(userId, [correction.sourceShadeId, correction.targetShadeId]);
      } catch (error) {
        console.warn(`${sourceLogPrefix} Cache invalidation failed for user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return counts;
  }
  counts.skipped = 1;
  const message = `${sourceLogPrefix} Left shade ${correction.shadeId} (${correction.fromBrand} "${correction.fromName}") of ${externalId} as it is (${correction.reason}); the store files it as ${correction.toBrand} "${correction.toName}"`;
  console.warn(message);
  progressLogger?.warn(message, { externalId, ...correction });
  return counts;
}

/**
 * One job-log line per materialized chunk, e.g.
 * `Records 11–20 of 250 on page 3: 10 shades (2 new), 8 hex detected, 0 upload failures, 41.0s`.
 */
export function formatMaterializationSummary(
  label: string,
  metrics: Pick<
    HoloTacoMaterializationMetrics,
    "processed" | "shadesCreated" | "hexDetected" | "imageUploadFailures" | "skipped"
  > & {
    hexDetectionFailures?: number;
    batchRequestsQueued?: number;
    imagesSkippedByCap?: number;
    ambiguousShadesSkipped?: number;
    brandStoreShadesMoved?: number;
    brandStoreShadesRenamed?: number;
    brandStoreShadesMerged?: number;
  },
  durationMs: number
): string {
  const parts = [
    `${metrics.processed} shade${metrics.processed === 1 ? "" : "s"} (${metrics.shadesCreated} new)`,
    `${metrics.hexDetected} hex detected`,
  ];
  const corrections = [
    metrics.brandStoreShadesMoved ? `${metrics.brandStoreShadesMoved} moved to the brand` : null,
    metrics.brandStoreShadesRenamed ? `${metrics.brandStoreShadesRenamed} renamed` : null,
    metrics.brandStoreShadesMerged ? `${metrics.brandStoreShadesMerged} merged` : null,
  ].filter(Boolean);
  if (corrections.length > 0) {
    parts.push(`shades corrected: ${corrections.join(", ")}`);
  }
  if (metrics.batchRequestsQueued) {
    parts.push(`${metrics.batchRequestsQueued} queued for batch detection`);
  }
  if (metrics.hexDetectionFailures) {
    parts.push(`${metrics.hexDetectionFailures} hex detection failures`);
  }
  parts.push(`${metrics.imageUploadFailures} upload failures`);
  if (metrics.imagesSkippedByCap) {
    parts.push(`${metrics.imagesSkippedByCap} images over the per-product cap not downloaded`);
  }
  if (metrics.skipped) {
    parts.push(
      metrics.ambiguousShadesSkipped
        ? `${metrics.skipped} skipped (${metrics.ambiguousShadesSkipped} ambiguous)`
        : `${metrics.skipped} skipped`
    );
  }
  return `${label}: ${parts.join(", ")}, ${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * The source's kind from `data_source.metadata.kind` (`readSourceKind`): an unknown kind or a
 * failed lookup fails the job, since a retailer must never run with brand-store rules.
 */
async function loadDataSourceKind(dataSourceId: number): Promise<SourceKind> {
  const result = await query<{ metadata: unknown }>(
    `SELECT metadata FROM data_source WHERE data_source_id = $1`,
    [dataSourceId]
  );
  const metadata = result.rows[0]?.metadata;
  const kind =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as { kind?: unknown }).kind
      : undefined;
  return readSourceKind(kind);
}

/** Materializes Shopify-style connector records into catalog shades and their listings for the data source. */
export async function materializeHoloTacoRecords(
  dataSourceId: number,
  records: ConnectorProductRecord[],
  options?: HoloTacoMaterializationOptions,
  sourceLogPrefix: string = "[HoloTaco]"
): Promise<HoloTacoMaterializationMetrics> {
  const overwriteDetectedHex = options?.overwriteDetectedHex === true;
  const sourceKind = options?.sourceKind ?? (await loadDataSourceKind(dataSourceId));
  options = { ...options, sourceKind };
  const startedAt = Date.now();
  let processed = 0;
  let brandsCreated = 0;
  let shadesCreated = 0;
  let hexOverwritten = 0;
  let swatchesLinked = 0;
  let gallerySwatchesPruned = 0;
  let galleryNearDuplicatesSkipped = 0;
  let galleryOverCapSkipped = 0;
  let barcodesLinked = 0;
  let barcodeConflicts = 0;
  let ambiguousShadesSkipped = 0;
  let brandStoreShadesMoved = 0;
  let brandStoreShadesRenamed = 0;
  let brandStoreShadesMerged = 0;
  let brandStoreCorrectionsSkipped = 0;
  let skipped = 0;

  const brandCache = new Map<string, number>();
  const finishCatalog = await loadFinishCatalog({
    onFallback: (message) =>
      console.warn(`${sourceLogPrefix} Falling back to built-in finish catalog (${message})`),
  });

  console.log(
    `${sourceLogPrefix} Starting materialization for ${records.length} records, dataSourceId=${dataSourceId}, overwriteDetectedHex=${overwriteDetectedHex}`
  );

  const preparedImageData = await prepareHoloTacoImageData(
    records,
    dataSourceId,
    options,
    sourceLogPrefix,
    async (record, preparedImage) => {
      const delta = await transaction(async (client) =>
        materializePreparedHoloTacoRecord(
          client,
          dataSourceId,
          record,
          preparedImage,
          overwriteDetectedHex,
          sourceLogPrefix,
          brandCache,
          finishCatalog,
          {
            sourceKind,
            sourceName: options?.sourceName,
            progressLogger: options?.progressLogger,
            actorUserId: options?.actorUserId ?? null,
          }
        )
      );
      if (delta.correction) {
        const counts = await reportBrandStoreCorrection(delta.correction, record.externalId, sourceLogPrefix, options?.progressLogger);
        brandStoreShadesMoved += counts.moved;
        brandStoreShadesRenamed += counts.renamed;
        brandStoreShadesMerged += counts.merged;
        brandStoreCorrectionsSkipped += counts.skipped;
      }

      processed += delta.processed;
      brandsCreated += delta.brandsCreated;
      shadesCreated += delta.shadesCreated;
      hexOverwritten += delta.hexOverwritten;
      swatchesLinked += delta.swatchesLinked;
      gallerySwatchesPruned += delta.gallerySwatchesPruned;
      galleryNearDuplicatesSkipped += delta.galleryNearDuplicatesSkipped;
      galleryOverCapSkipped += delta.galleryOverCapSkipped;
      barcodesLinked += delta.barcodesLinked;
      barcodeConflicts += delta.barcodeConflicts.length;
      for (const gtin of delta.barcodeInvalidCheckDigits) {
        // Kept (a vendor typo still names the bottle), but worth a look.
        options?.progressLogger?.warn(
          `${sourceLogPrefix} Barcode ${gtin} of ${record.externalId} has a wrong check digit; stored anyway`,
          { externalId: record.externalId, gtin, shadeId: delta.shadeId }
        );
      }
      for (const conflict of delta.barcodeConflicts) {
        // First shade wins: the GTIN stays where it is; an admin can move it if it is wrong.
        options?.progressLogger?.warn(
          `${sourceLogPrefix} Barcode ${conflict.gtin} of ${record.externalId} already belongs to shade ${conflict.existingShadeId}; kept there`,
          {
            externalId: record.externalId,
            gtin: conflict.gtin,
            shadeId: delta.shadeId,
            existingShadeId: conflict.existingShadeId,
          }
        );
      }
      if (delta.rawTitleDuplicate) {
        const dup = delta.rawTitleDuplicate;
        options?.progressLogger?.warn(
          `${sourceLogPrefix} Possible duplicate shade for ${dup.brand} "${dup.name}": shade ${dup.matchedShadeId} matched the clean name, but shade ${dup.rawShadeId} is stored under the raw title "${dup.rawTitle}"; an admin can merge them`,
          { externalId: record.externalId, ...dup }
        );
      }
      skipped += delta.skipped;
      ambiguousShadesSkipped += delta.ambiguousShadesSkipped;
      if (delta.skipped > 0) {
        options?.progressLogger?.warn(
          `${sourceLogPrefix} Skipped record ${record.externalId}: ${delta.skipReason ?? "no normalized data or shade name"}`,
          { externalId: record.externalId, ...delta.skipDetails }
        );
      }
    },
    finishCatalog
  );

  const result = {
    processed,
    brandsCreated,
    shadesCreated,
    hexOverwritten,
    ...preparedImageData.metrics,
    ...(preparedImageData.aiBatch ? { aiBatch: preparedImageData.aiBatch } : {}),
    swatchesLinked,
    gallerySwatchesPruned,
    galleryNearDuplicatesSkipped,
    galleryOverCapSkipped,
    barcodesLinked,
    barcodeConflicts,
    ambiguousShadesSkipped,
    brandStoreShadesMoved,
    brandStoreShadesRenamed,
    brandStoreShadesMerged,
    brandStoreCorrectionsSkipped,
    skipped,
  };

  console.log(`${sourceLogPrefix} Materialization complete:`, result);
  const durationMs = Date.now() - startedAt;
  options?.progressLogger?.info(
    `${sourceLogPrefix} ${formatMaterializationSummary(
      options?.chunkLabel ?? `${records.length} record(s)`,
      result,
      durationMs
    )}`,
    { ...result, durationMs }
  );
  return result;
}
