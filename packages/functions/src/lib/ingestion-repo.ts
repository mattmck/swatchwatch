import { query, transaction } from "./db";
import { ConnectorProductRecord } from "./connectors/types";
import { SUPPORTED_SOURCES } from "./connectors/types";
import { defaultShopifyBaseUrl } from "./connectors/shopify-generic";
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
import { toImageProxyUrlFromOrigin } from "./image-proxy";
import pLimit = require("p-limit");
import {
  buildSuspiciousHexContext,
  classifySuspiciousHex,
  type SuspiciousHexContext,
} from "./suspicious-hex";
import {
  loadFinishCatalog,
  mergeFinishLists,
  parseFinishesFromTags,
  type FinishCatalog,
} from "./finishes";
import { PoolClient } from "pg";

export interface DataSourceRecord {
  dataSourceId: number;
  name: string;
  baseUrl: string | null;
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
  inventoryInserted: number;
  inventoryUpdated: number;
  legacyRowsDeleted: number;
  skipped: number;
}

export interface HoloTacoMaterializationMetrics {
  processed: number;
  brandsCreated: number;
  shadesCreated: number;
  inventoryInserted: number;
  inventoryUpdated: number;
  hexOverwritten: number;
  imageCandidates: number;
  imageUploads: number;
  imageUploadFailures: number;
  swatchesLinked: number;
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
  progressLogger?: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
  };
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

interface HoloTacoProductNormalized {
  brand: string | null;
  name: string | null;
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
}

/** A source image stored in blob storage, keyed by the connector URL it was downloaded from. */
interface StoredSourceImage {
  sourceUrl: string;
  storageUrl: string;
  checksumSha256: string;
}

interface HoloTacoPreparedImage {
  storageUrl: string | null;
  checksumSha256: string | null;
  /** Connector URL of the primary image; recorded in source_image_url so reruns can skip it. */
  sourceUrl: string | null;
  detectedHex: string | null;
  detectedFinishes: string[] | null;
  /** Provenance for `detectedHex` (null when no detection ran). */
  detectedHexProvenance: DetectedHexProvenance | null;
  additionalImages: StoredSourceImage[];
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
  hexDetected: number;
  hexDetectionFailures: number;
  hexDetectionSkipped: number;
  /** Subset of hexDetectionSkipped: same image as last run and the shade already has a hex. */
  hexDetectionSkippedUnchanged: number;
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

function parseHoloTacoNormalized(
  normalized: Record<string, unknown>
): HoloTacoProductNormalized {
  const collections = asStringArray(normalized.collections);
  const finishes = asStringArray(normalized.finishes);
  return {
    brand: asString(normalized.brand),
    name: asString(normalized.name),
    collection: collections[0] || null,
    finish: finishes[0] || null,
    primaryImageUrl: asString(normalized.primaryImageUrl),
    imageUrls: asStringArray(normalized.imageUrls),
    images: parseProductImageCandidates(normalized.images, asStringArray(normalized.imageUrls)),
    tags: asStringArray(normalized.tags),
    vendorHex: asString(normalized.vendorHex),
    nameHex: asString(normalized.nameHex),
    colorName: asString(normalized.colorName),
  };
}

/**
 * Canonical finishes for an ingested product, derived from its vendor tags
 * (`finish:<value>` + bare `<value>` tags) via `parseFinishesFromTags`.
 */
export function resolveIngestedShadeFinishes(
  normalized: Record<string, unknown> | null | undefined,
  catalog?: FinishCatalog
): string[] {
  if (!normalized) return [];
  return parseFinishesFromTags(asStringArray(normalized.tags), catalog);
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
  suspiciousContext: SuspiciousHexContext
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
    if (!holo.name || !isHttpUrl(holo.primaryImageUrl)) {
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

/** Brand a Shopify record materializes under; shared with the unchanged-image lookup. */
function resolveHoloTacoBrandName(holo: HoloTacoProductNormalized): string {
  return canonicalizeBrandName(holo.brand || "Holo Taco");
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
 * External IDs whose shade already has a detected hex and already has a swatch (product or gallery) on the exact
 * image chosen for detection (same checksum). Shades are matched the same way
 * materializePreparedHoloTacoRecord resolves them. A lookup failure returns an empty set:
 * skipping detection is an optimization and must never fail the job.
 */
export async function findRecordsWithUnchangedDetectedHex(
  dataSourceId: number,
  candidates: UnchangedImageCandidate[]
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
       JOIN LATERAL (
         SELECT brand_id
         FROM brand
         WHERE lower(name_canonical) = lower(input.brand_name)
         ORDER BY brand_id
         LIMIT 1
       ) b ON true
       JOIN shade sh
         ON sh.brand_id = b.brand_id
        AND sh.product_line_id IS NULL
        AND lower(sh.shade_name_canonical) = lower(input.shade_name)
        AND coalesce(sh.finish, '') = coalesce(input.finish, '')
        AND coalesce(sh.collection, '') = coalesce(input.collection, '')
       WHERE sh.detected_hex IS NOT NULL
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
 * Stored images for connector image URLs this data source has already ingested, keyed by URL.
 * Shopify CDN URLs carry a `?v=` version that changes when the image is replaced, so an
 * unchanged URL means an unchanged image and the download can be skipped. A lookup failure
 * returns an empty map: reuse is an optimization and must never fail the job.
 */
export async function findStoredSourceImages(
  dataSourceId: number,
  sourceUrls: string[]
): Promise<Map<string, StoredSourceImage>> {
  const urls = Array.from(new Set(sourceUrls));
  if (urls.length === 0) {
    return new Map();
  }

  try {
    const result = await query<StoredSourceImage>(
      `SELECT
         siu.source_url AS "sourceUrl",
         ia.storage_url AS "storageUrl",
         ia.checksum_sha256 AS "checksumSha256"
       FROM source_image_url siu
       JOIN image_asset ia ON ia.image_id = siu.image_id
       WHERE siu.data_source_id = $1
         AND siu.source_url = ANY($2::text[])
         AND ia.checksum_sha256 IS NOT NULL`,
      [dataSourceId, urls]
    );
    return new Map(result.rows.map((row) => [row.sourceUrl, row]));
  } catch (error) {
    console.warn(
      `[ingestion-repo] Stored source image lookup failed; downloading every image: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return new Map();
  }
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
  ) => Promise<void>
): Promise<HoloTacoImagePreparationResult> {
  const detectHexFromImage = options?.detectHexFromImage !== false;
  const detectHexOnSuspiciousOnly = options?.detectHexOnSuspiciousOnly === true;
  const batchMinImages = Math.max(1, options?.batchMinImages ?? DEFAULT_HEX_BATCH_MIN_IMAGES);
  const suspiciousContext = buildVendorHexContext(records);
  const estimatedBatchCandidates = estimateBatchCandidateCount(
    records,
    detectHexFromImage,
    detectHexOnSuspiciousOnly,
    suspiciousContext
  );
  const useBatchForHexDetection =
    options?.useBatchForHexDetection === true &&
    detectHexFromImage &&
    estimatedBatchCandidates >= batchMinImages;
  const progressLogger = options?.progressLogger;
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
    hexDetected: 0,
    hexDetectionFailures: 0,
    hexDetectionSkipped: 0,
    hexDetectionSkippedUnchanged: 0,
    batchRequestsQueued: 0,
    batchFallbacks: 0,
    hexDetectionPromptTokens: 0,
    hexDetectionCompletionTokens: 0,
    hexDetectionTotalTokens: 0,
  };

  console.log(
    `${sourceLogPrefix} Image preparation: processing ${records.length} records, detectHexFromImage=${detectHexFromImage}, detectHexOnSuspiciousOnly=${detectHexOnSuspiciousOnly}, estimatedBatchCandidates=${estimatedBatchCandidates}, useBatchForHexDetection=${useBatchForHexDetection}, batchMinImages=${batchMinImages}`
  );
  progressLogger?.info(`${sourceLogPrefix} Image preparation config`, {
    records: records.length,
    detectHexFromImage,
    detectHexOnSuspiciousOnly,
    estimatedBatchCandidates,
    useBatchForHexDetection,
    batchMinImages,
    vendorHexRecords: suspiciousContext.hexRecordCount,
    vendorHexTemplateDefaults: Array.from(suspiciousContext.templateDefaults),
  });
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
  if (connectionString) {
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
    sourceUrl: string | null;
    additionalImages: StoredSourceImage[];
    isCandidate: boolean;
    primaryReused: boolean;
    additionalUploaded: number;
    imagesReused: number;
  }

  const limit = pLimit(4);
  const startTime = Date.now();

  const parsedRecords = records.map((record) => {
    const normalized =
      record.normalized && typeof record.normalized === "object"
        ? (record.normalized as Record<string, unknown>)
        : null;
    return { record, holo: normalized ? parseHoloTacoNormalized(normalized) : null };
  });

  // Images whose connector URL was already ingested are reused instead of downloaded: the
  // download (plus metadata strip and hashing) is what makes reruns slow, not the upload.
  const storedImages = await findStoredSourceImages(
    dataSourceId,
    parsedRecords.flatMap(({ holo }) =>
      holo?.name && isHttpUrl(holo.primaryImageUrl)
        ? [holo.primaryImageUrl, ...holo.imageUrls.slice(1).filter(isHttpUrl)]
        : []
    )
  );
  if (storedImages.size > 0) {
    progressLogger?.info(
      `${sourceLogPrefix} Reusing ${storedImages.size} stored image(s) whose source URL is unchanged`
    );
  }

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
      image: { sourceUrl: sourceImageUrl, storageUrl: upload.storageUrl, checksumSha256: upload.checksumSha256 },
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
        sourceUrl: null,
        additionalImages: [],
        isCandidate: false,
        primaryReused: false,
        additionalUploaded: 0,
        imagesReused: 0,
      };
      if (!holo) {
        console.log(`${sourceLogPrefix} Skipping record ${record.externalId}: no normalized data`);
        return notCandidate;
      }

      if (!holo.name || !isHttpUrl(holo.primaryImageUrl)) {
        if (holo.name) {
          console.log(`${sourceLogPrefix} Skipping record ${record.externalId}: invalid image URL`, {
            name: holo.name,
            imageUrl: holo.primaryImageUrl,
          });
        }
        return notCandidate;
      }

      console.log(`${sourceLogPrefix} Image candidate: externalId=${record.externalId}, name=${holo.name}, imageUrl=${holo.primaryImageUrl}`);

      let storageUrl: string | null = null;
      let checksumSha256: string | null = null;
      let primaryReused = false;
      let additionalUploaded = 0;
      let imagesReused = 0;
      const additionalImages: StoredSourceImage[] = [];

      // Upload primary image (container already ensured)
      try {
        const { image, reused } = await storeSourceImage(holo.primaryImageUrl, record.externalId);
        storageUrl = image.storageUrl;
        checksumSha256 = image.checksumSha256;
        primaryReused = reused;
        if (reused) imagesReused += 1;
        console.log(
          `${sourceLogPrefix} Primary image ${reused ? "reused" : "uploaded"} for ${record.externalId}: checksum=${checksumSha256}`
        );
      } catch (err) {
        console.error(`${sourceLogPrefix} Primary image upload failed for ${record.externalId}:`, String(err));
      }

      // Upload additional images
      for (let i = 1; i < holo.imageUrls.length; i++) {
        const imgUrl = holo.imageUrls[i];
        if (!isHttpUrl(imgUrl)) continue;
        try {
          const { image, reused } = await storeSourceImage(imgUrl, `${record.externalId}-img${i}`);
          additionalImages.push(image);
          if (reused) {
            imagesReused += 1;
          } else {
            additionalUploaded += 1;
          }
        } catch (err) {
          console.error(`${sourceLogPrefix} Additional image ${i} upload failed for ${record.externalId}:`, String(err));
        }
      }

      return {
        record,
        holo,
        storageUrl,
        checksumSha256,
        sourceUrl: storageUrl ? holo.primaryImageUrl : null,
        additionalImages,
        isCandidate: true,
        primaryReused,
        additionalUploaded,
        imagesReused,
      };
    })
  );

  const uploadResults = await Promise.all(uploadTasks);
  const uploadElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`${sourceLogPrefix} Phase 1 (parallel image upload) completed in ${uploadElapsed}s for ${records.length} records`);

  // AI hex detection runs on the image most likely to show the polish on a nail
  // (alt-text ranking, see image-selection.ts); the vendor's primary image stays
  // the fallback and the blob upload set above is unchanged.
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
  const unchangedWithHex =
    detectHexFromImage && !overwriteDetectedHex
      ? await findRecordsWithUnchangedDetectedHex(
          dataSourceId,
          uploadResults.flatMap((result): UnchangedImageCandidate[] => {
            const { holo } = result;
            // Compare against the image detection would run on, not always the primary.
            const checksumSha256 = detectionImages.get(result)?.checksumSha256 ?? result.checksumSha256;
            if (!result.isCandidate || !holo?.name || !checksumSha256) {
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
                brandName: resolveHoloTacoBrandName(holo),
                shadeName: holo.name,
                finish: holo.finish,
                collection: holo.collection,
                checksumSha256,
              },
            ];
          })
        )
      : new Set<string>();
  if (unchangedWithHex.size > 0) {
    progressLogger?.info(
      `${sourceLogPrefix} Skipping AI for ${unchangedWithHex.size} record(s) with an unchanged image and an existing detected hex`
    );
  }

  const prepareRecordImage = async (result: ImageUploadResult): Promise<HoloTacoPreparedImage> => {
    const { record, holo, additionalImages } = result;
    const { storageUrl, checksumSha256, sourceUrl } = result;

    if (!result.isCandidate) {
      return {
        storageUrl: null,
        checksumSha256: null,
        sourceUrl: null,
        detectedHex: null,
        detectedFinishes: null,
        detectedHexProvenance: null,
        additionalImages: [],
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
      holo && (!detectHexOnSuspiciousOnly || vendorHexVerdict!.suspicious);

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
      progressLogger?.info(selectionMessage, selectionData);
    }

    if (shouldRunAiDetection && holo && unchangedWithHex.has(record.externalId)) {
      // Without overwriteDetectedHex the shade write keeps the existing detected_hex, so a
      // fresh detection on the same image would be paid for and then discarded.
      metrics.hexDetectionSkipped += 1;
      metrics.hexDetectionSkippedUnchanged += 1;
      console.log(
        `${sourceLogPrefix} Skipping AI for ${record.externalId}: image unchanged and shade already has a detected hex`
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
          vendorContext: {
            shadeName: holo.name!,
            vendorHex: holo.vendorHex,
            description: holo.collection,
            tags: holo.tags,
            vendorJson: {
              finish: holo.finish,
              colorName: holo.colorName,
            },
          },
        });
        metrics.batchRequestsQueued += 1;
        const queuedMessage = `${sourceLogPrefix} ${record.externalId} [ai-color-detection] Queued for batch submission`;
        console.log(queuedMessage);
        progressLogger?.info(queuedMessage, {
          externalId: record.externalId,
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
          console.log(suspiciousMessage);
          if (detectHexOnSuspiciousOnly) {
            progressLogger?.info(suspiciousMessage, {
              externalId: record.externalId,
              colorName: holo.name,
              vendorHex: holo.vendorHex,
              reason: vendorHexVerdict?.reason ?? null,
              detail: vendorHexVerdict?.detail ?? null,
            });
          }
        } else {
          console.log(`${sourceLogPrefix} No vendor hex for ${record.externalId}, running AI detection`);
        }
        try {
          const detection = await detectHexWithAzureOpenAI(imageForAi, {
            onLog: (level, message, data) => {
              const withRecord = `${sourceLogPrefix} ${record.externalId} ${message}`;
              if (level === "error") {
                progressLogger?.error(withRecord, data);
              } else if (level === "warn") {
                progressLogger?.warn(withRecord, data);
              } else {
                progressLogger?.info(withRecord, data);
              }
            },
            vendorContext: {
              shadeName: holo.name!,
              vendorHex: holo.vendorHex,
              description: holo.collection,
              tags: holo.tags,
              vendorJson: {
                finish: holo.finish,
                colorName: holo.colorName,
              },
            },
          });
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
            progressLogger?.info(tokenUsageMessage, tokenUsageData);
          }
          console.log(`${sourceLogPrefix} AI detection result for ${record.externalId}:`, { detectedHex: detection.hex, vendorHex: holo.vendorHex });
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
            progressLogger?.info(successMessage, successData);
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
        }
      }
    } else {
      metrics.hexDetectionSkipped += 1;
      if (holo && detectHexOnSuspiciousOnly && holo.vendorHex && vendorHexVerdict && !vendorHexVerdict.suspicious) {
        const trustedMessage = `${sourceLogPrefix} Skipping AI for ${record.externalId}: vendor hex ${holo.vendorHex} not suspicious`;
        console.log(trustedMessage);
        progressLogger?.info(trustedMessage, {
          externalId: record.externalId,
          colorName: holo.name,
          vendorHex: holo.vendorHex,
        });
      } else {
        console.log(`${sourceLogPrefix} Skipping AI detection for ${record.externalId} (detectHexFromImage=${detectHexFromImage})`);
      }
    }

    return {
      storageUrl,
      checksumSha256,
      sourceUrl,
      detectedHex,
      detectedFinishes,
      detectedHexProvenance,
      additionalImages,
    };
  };

  const detectionLimit = pLimit(getHexDetectionConcurrency());
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
        return {
          storageUrl: result.storageUrl,
          checksumSha256: result.checksumSha256,
          sourceUrl: result.sourceUrl,
          detectedHex: null,
          detectedFinishes: null,
          detectedHexProvenance: null,
          additionalImages: result.additionalImages,
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
      const preparedImage = await preparedTasks[i];
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

  let aiBatch: HoloTacoAiBatchDetails | null = null;
  if (useBatchForHexDetection && queuedBatchRequests.length > 0) {
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
      const submittedMessage = `${sourceLogPrefix} Submitted Azure OpenAI batch ${batchResult.batchId} with ${batchResult.requestCount} request(s)`;
      console.log(submittedMessage);
      progressLogger?.info(submittedMessage, aiBatch as unknown as Record<string, unknown>);
    } catch (error) {
      // Batch submission failed: degrade to synchronous detection for this run so the
      // job still materializes detected hex instead of failing outright. Detections are
      // applied via the same shade write path the batch poller uses.
      const reason = error instanceof Error ? error.message : String(error);
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
              const detection = await detectHexWithAzureOpenAI(queued.imageUrlOrDataUri, {
                vendorContext: queued.vendorContext,
                onLog: (level, message, data) => {
                  const withRecord = `${sourceLogPrefix} ${queued.customId} ${message}`;
                  if (level === "error") {
                    progressLogger?.error(withRecord, data);
                  } else if (level === "warn") {
                    progressLogger?.warn(withRecord, data);
                  } else {
                    progressLogger?.info(withRecord, data);
                  }
                },
              });
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
          options?.overwriteDetectedHex === true
        );
        const appliedMessage = `${sourceLogPrefix} Applied ${applyMetrics.applied} synchronous fallback detection(s)`;
        console.log(appliedMessage, applyMetrics);
        progressLogger?.info(appliedMessage, applyMetrics as unknown as Record<string, unknown>);
      }
    }
  }

  return {
    byExternalId,
    metrics,
    aiBatch,
  };
}

export async function getDataSourceByName(name: string): Promise<DataSourceRecord | null> {
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
     WHERE name = $1
     LIMIT 1`,
    [name]
  );

  return result.rows[0] ?? null;
}

function isAutoProvisionableSource(name: string): boolean {
  return name.endsWith("Shopify");
}

async function createDataSourceIfMissing(name: string): Promise<DataSourceRecord | null> {
  if (!isAutoProvisionableSource(name)) {
    return null;
  }

  const baseUrl = defaultShopifyBaseUrl(name);
  const metadata = {
    priority: "medium",
    mvp: "yes",
    notes: "Auto-provisioned Shopify source from supported connector list.",
    autoProvisioned: true,
  };

  const inserted = await query<{
    dataSourceId: number;
    name: string;
    baseUrl: string | null;
  }>(
    `INSERT INTO data_source (name, source_type, base_url, enabled, metadata)
     VALUES ($1, 'api', $2, true, $3::jsonb)
     ON CONFLICT (name) DO NOTHING
     RETURNING data_source_id AS "dataSourceId", name, base_url AS "baseUrl"`,
    [name, baseUrl, JSON.stringify(metadata)]
  );

  if (inserted.rows.length > 0) {
    return inserted.rows[0];
  }

  return getDataSourceByName(name);
}

export async function ensureDataSourceByName(name: string): Promise<DataSourceRecord | null> {
  const existing = await getDataSourceByName(name);
  if (existing) {
    return existing;
  }
  return createDataSourceIfMissing(name);
}

export async function ensureSupportedShopifyDataSources(): Promise<void> {
  const shopifySources = SUPPORTED_SOURCES.filter((source) => source.endsWith("Shopify"));
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
    settings: (row.metadata?.ingestion) as DataSourceSettings || defaultSettings,
  }));
}

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
    [jobId, metrics]
  );
}

export async function updateIngestionJobMetrics(
  jobId: number,
  metrics: Record<string, unknown>
): Promise<void> {
  await query(
    `UPDATE ingestion_job
     SET metrics_json = $2::jsonb
     WHERE ingestion_job_id = $1`,
    [jobId, metrics]
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
    [jobId, metrics]
  );
  return (result.rowCount ?? 0) > 0;
}

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
    [jobId, metrics]
  );
}

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
    [jobId, errorMessage, metrics]
  );
}

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
             fetched_at = now()
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
    metrics: row.metrics || undefined,
    error: row.error || undefined,
  };
}

export interface AwaitingAiBatchJobRecord {
  jobId: number;
  source: string;
  dataSourceId: number;
  metrics: Record<string, unknown>;
  startedAt: string;
}

export async function listIngestionJobsAwaitingAiBatch(
  limit = 20
): Promise<AwaitingAiBatchJobRecord[]> {
  const result = await query<{
    jobId: number;
    source: string;
    dataSourceId: number;
    metrics: Record<string, unknown> | null;
    startedAt: string;
  }>(
    `SELECT
       j.ingestion_job_id AS "jobId",
       s.name AS source,
       s.data_source_id AS "dataSourceId",
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
  applied: number;
  skippedNoDetection: number;
  noShadeMatch: number;
}

export async function applyAiBatchShadeDetections(
  dataSourceId: number,
  detections: AiBatchShadeDetectionInput[],
  overwriteDetectedHex: boolean
): Promise<ApplyAiBatchShadeDetectionsMetrics> {
  let applied = 0;
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

    const result = await query<{ shadeId: number }>(
      `WITH ext AS (
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
         JOIN brand b ON lower(b.name_canonical) = lower(ext.brand_name)
         JOIN shade sh
           ON sh.brand_id = b.brand_id
          AND lower(sh.shade_name_canonical) = lower(ext.shade_name)
          AND coalesce(sh.finish, '') = coalesce(ext.finish_name, '')
          AND coalesce(sh.collection, '') = coalesce(ext.collection_name, '')
         ORDER BY sh.shade_id DESC
         LIMIT 1
       )
       UPDATE shade sh
       SET detected_hex = CASE
             WHEN $5::boolean AND $3::text IS NOT NULL THEN $3::text
             ELSE COALESCE(sh.detected_hex, $3::text)
           END,
           detected_finishes = CASE
             WHEN $5::boolean AND $4::text[] IS NOT NULL THEN $4::text[]
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
             "($5::boolean AND $3::text IS NOT NULL) OR (sh.detected_hex IS NULL AND $3::text IS NOT NULL)",
             6,
             "sh."
           )},
           updated_at = now()
       FROM target
       WHERE sh.shade_id = target.shade_id
       RETURNING sh.shade_id AS "shadeId"`,
      [
        dataSourceId,
        externalId,
        detectedHex,
        detectedFinishes,
        overwriteDetectedHex,
        ...provenanceParams(detection.provenance ?? EMPTY_DETECTED_HEX_PROVENANCE),
      ]
    );

    if (result.rows.length > 0) {
      applied += 1;
    } else {
      noShadeMatch += 1;
    }
  }

  return {
    processed: detections.length,
    applied,
    skippedNoDetection,
    noShadeMatch,
  };
}

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
      metrics: row.metrics || undefined,
      error: row.error || undefined,
    })),
    total: parseInt(countResult.rows[0].total, 10),
  };
}

export async function materializeMakeupApiRecords(
  userId: number,
  records: ConnectorProductRecord[]
): Promise<MakeupApiMaterializationMetrics> {
  const finishCatalog = await loadFinishCatalog();
  return transaction(async (client) => {
    let variantRowsProcessed = 0;
    let brandsCreated = 0;
    let shadesCreated = 0;
    let inventoryInserted = 0;
    let inventoryUpdated = 0;
    let legacyRowsDeleted = 0;
    let skipped = 0;

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
      const tagFinishes = parseFinishesFromTags(makeup.tags, finishCatalog);
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
        // Remove legacy product-level rows from earlier imports once variant rows are available.
        const deletedLegacy = await client.query(
          `DELETE FROM user_inventory_item ui
           USING shade sh
           WHERE ui.shade_id = sh.shade_id
             AND ui.user_id = $1
             AND sh.brand_id = $2
             AND lower(sh.shade_name_canonical) = lower($3)
             AND coalesce(sh.collection, '') = ''
             AND ui.quantity = 0
             AND ui.status = 'wishlist'
             AND ui.notes LIKE 'Imported from MakeupAPI%'
             AND ui.tags @> ARRAY['makeupapi']::text[]`,
          [userId, brandId, makeup.name]
        );
        legacyRowsDeleted += deletedLegacy.rowCount ?? 0;

        await client.query(
          `DELETE FROM shade sh
           WHERE sh.brand_id = $1
             AND lower(sh.shade_name_canonical) = lower($2)
             AND coalesce(sh.collection, '') = ''
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

        const existingShade = await client.query<{ shadeId: number; finishes: string[] | null }>(
          `SELECT shade_id AS "shadeId", finishes
           FROM shade
           WHERE brand_id = $1
             AND product_line_id IS NULL
             AND lower(shade_name_canonical) = lower($2)
             AND coalesce(collection, '') = coalesce($3, '')
           LIMIT 1`,
          [brandId, shadeName, collection]
        );

        let shadeId: number;
        let currentFinishes: string[] = [];
        if (existingShade.rows.length > 0) {
          shadeId = existingShade.rows[0].shadeId;
          currentFinishes = existingShade.rows[0].finishes ?? [];
        } else {
          const insertedShade = await client.query<{ shadeId: number }>(
            `INSERT INTO shade (brand_id, shade_name_canonical, collection, status)
             VALUES ($1, $2, $3, 'active')
             RETURNING shade_id AS "shadeId"`,
            [brandId, shadeName, collection]
          );
          shadeId = insertedShade.rows[0].shadeId;
          shadesCreated += 1;
        }

        // Write color data to shade (product-level)
        const resolvedColorName = variant.name || makeup.name;
        const resolvedVendorHex = variant.hex;
        // Merge (never remove) tag finishes in TypeScript, like the Holo Taco path, so aliases
        // and legacy values are canonicalized and deduped; null leaves finishes untouched.
        const mergedFinishes =
          tagFinishes.length > 0 ? mergeFinishLists([currentFinishes, tagFinishes], finishCatalog) : null;
        await client.query(
          `UPDATE shade SET
             color_name = COALESCE($2, color_name),
             vendor_hex = COALESCE($3, vendor_hex),
             finishes = COALESCE($4::text[], finishes),
             -- Catalog data confirms a user-submitted shade: promote it to the shared catalog.
             status = CASE WHEN status = 'user_submitted' THEN 'active' ELSE status END,
             updated_at = now()
           WHERE shade_id = $1`,
          [shadeId, resolvedColorName, resolvedVendorHex, mergedFinishes]
        );

        const inventory = await client.query<{
          inventoryItemId: number;
        }>(
          `SELECT inventory_item_id AS "inventoryItemId"
           FROM user_inventory_item
           WHERE user_id = $1
             AND shade_id = $2
           LIMIT 1`,
          [userId, shadeId]
        );

        const importNote = `Imported from MakeupAPI external_id=${record.externalId}`;

        if (inventory.rows.length === 0) {
          await client.query(
            `INSERT INTO user_inventory_item
               (user_id, shade_id, quantity, status, notes, tags)
             VALUES ($1, $2, 0, 'wishlist', $3, ARRAY['imported','makeupapi']::text[])`,
            [userId, shadeId, importNote]
          );
          inventoryInserted += 1;
        } else {
          const inventoryItemId = inventory.rows[0].inventoryItemId;
          await client.query(
            `UPDATE user_inventory_item
             SET notes = COALESCE(notes, $2),
                 tags = (
                   SELECT ARRAY(
                     SELECT DISTINCT t
                     FROM unnest(COALESCE(user_inventory_item.tags, ARRAY[]::text[]) || ARRAY['imported','makeupapi']::text[]) AS t
                     ORDER BY t
                   )
                 )
             WHERE inventory_item_id = $1`,
            [inventoryItemId, importNote]
          );
          inventoryUpdated += 1;
        }
      }
    }

    return {
      variantRowsProcessed,
      brandsCreated,
      shadesCreated,
      inventoryInserted,
      inventoryUpdated,
      legacyRowsDeleted,
      skipped,
    };
  });
}

interface HoloTacoRecordMaterializationDelta {
  processed: number;
  brandsCreated: number;
  shadesCreated: number;
  inventoryInserted: number;
  inventoryUpdated: number;
  hexOverwritten: number;
  swatchesLinked: number;
  skipped: number;
}

async function materializePreparedHoloTacoRecord(
  client: PoolClient,
  userId: number,
  dataSourceId: number,
  record: ConnectorProductRecord,
  preparedImage: HoloTacoPreparedImage,
  overwriteDetectedHex: boolean,
  sourceLogPrefix: string,
  brandCache: Map<string, number>,
  finishCatalog?: FinishCatalog
): Promise<HoloTacoRecordMaterializationDelta> {
  const delta: HoloTacoRecordMaterializationDelta = {
    processed: 0,
    brandsCreated: 0,
    shadesCreated: 0,
    inventoryInserted: 0,
    inventoryUpdated: 0,
    hexOverwritten: 0,
    swatchesLinked: 0,
    skipped: 0,
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
  const tagFinishes = resolveIngestedShadeFinishes(normalized, finishCatalog);

  console.log(`${sourceLogPrefix} Processing record: externalId=${record.externalId}, name=${holo.name}`);

  const brandName = resolveHoloTacoBrandName(holo);
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
      delta.brandsCreated += 1;
    }

    brandCache.set(brandKey, brandId);
  }

  delta.processed += 1;

  const existingShade = await client.query<{ shadeId: number }>(
    `SELECT shade_id AS "shadeId"
     FROM shade
     WHERE brand_id = $1
       AND product_line_id IS NULL
       AND lower(shade_name_canonical) = lower($2)
       AND coalesce(finish, '') = coalesce($3, '')
       AND coalesce(collection, '') = coalesce($4, '')
     LIMIT 1`,
    [brandId, holo.name, holo.finish, holo.collection]
  );

  let shadeId: number;
  if (existingShade.rows.length > 0) {
    shadeId = existingShade.rows[0].shadeId;
  } else {
    const insertedShade = await client.query<{ shadeId: number }>(
      `INSERT INTO shade (brand_id, shade_name_canonical, finish, collection, status, finishes)
       VALUES ($1, $2, $3, $4, 'active', $5::text[])
       RETURNING shade_id AS "shadeId"`,
      [brandId, holo.name, holo.finish, holo.collection, tagFinishes]
    );
    shadeId = insertedShade.rows[0].shadeId;
    delta.shadesCreated += 1;
  }

  const importNote = `Imported from ${sourceLogPrefix.replace(/[\[\]]/g, "")} external_id=${record.externalId}`;
  const vendorHex = holo.vendorHex;
  const detectedHex = preparedImage.detectedHex || null;
  const detectedFinishes = preparedImage.detectedFinishes || null;
  const detectedHexProvenance = preparedImage.detectedHexProvenance ?? EMPTY_DETECTED_HEX_PROVENANCE;
  const nameHex = holo.nameHex;
  const sourceTags = Array.from(
    new Set(
      [...holo.tags, "imported", "shopify"]
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );

  console.log(
    `${sourceLogPrefix} Shade color update: shadeId=${shadeId}, vendorHex=${vendorHex}, detectedHex=${detectedHex}, nameHex=${nameHex}, confidence=${detectedHexProvenance.confidence}, method=${detectedHexProvenance.method}, model=${detectedHexProvenance.model}, promptVersion=${detectedHexProvenance.promptVersion}`
  );

  // Read current shade color data for overwrite comparison
  const currentShade = await client.query<{
    vendorHex: string | null;
    detectedHex: string | null;
    detectedFinishes: string[] | null;
    nameHex: string | null;
    finishes: string[] | null;
  }>(
    `SELECT
       vendor_hex AS "vendorHex",
       detected_hex AS "detectedHex",
       detected_finishes AS "detectedFinishes",
       name_hex AS "nameHex",
       finishes
     FROM shade WHERE shade_id = $1`,
    [shadeId]
  );
  // Vendor tag finishes are merged (never removed) so manual edits survive re-imports.
  const currentFinishes = currentShade.rows[0]?.finishes ?? [];
  const mergedFinishes = mergeFinishLists([currentFinishes, tagFinishes], finishCatalog);

  const shouldOverwrite = overwriteDetectedHex;
  if (
    shouldOverwrite && currentShade.rows.length > 0 &&
    ((vendorHex && vendorHex !== currentShade.rows[0].vendorHex) ||
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
     SET color_name = COALESCE(color_name, $2),
         vendor_hex = CASE
           WHEN $6::boolean AND $3::text IS NOT NULL THEN $3::text
           ELSE COALESCE(vendor_hex, $3::text)
         END,
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
         status = CASE WHEN status = 'user_submitted' THEN 'active' ELSE status END,
         updated_at = now()
     WHERE shade_id = $1`,
    [
      shadeId,
      holo.name,
      vendorHex,
      detectedHex,
      detectedFinishes,
      overwriteDetectedHex,
      nameHex,
      mergedFinishes,
      ...provenanceParams(detectedHexProvenance),
    ]
  );

  const inventory = await client.query<{
    inventoryItemId: number;
  }>(
    `SELECT inventory_item_id AS "inventoryItemId"
     FROM user_inventory_item
     WHERE user_id = $1
       AND shade_id = $2
     LIMIT 1`,
    [userId, shadeId]
  );

  if (inventory.rows.length === 0) {
    console.log(`${sourceLogPrefix} Inserting new inventory item for shade ${shadeId}`);
    await client.query(
      `INSERT INTO user_inventory_item
         (user_id, shade_id, quantity, status, notes, tags)
       VALUES ($1, $2, 0, 'wishlist', $3, $4::text[])`,
      [userId, shadeId, importNote, sourceTags]
    );
    delta.inventoryInserted += 1;
    console.log(`${sourceLogPrefix} Inserted inventory item successfully`);
  } else {
    const inventoryItemId = inventory.rows[0].inventoryItemId;

    console.log(
      `${sourceLogPrefix} Updating inventory item ${inventoryItemId}`
    );

    await client.query(
      `UPDATE user_inventory_item
       SET notes = COALESCE(notes, $2),
           tags = (
             SELECT ARRAY(
               SELECT DISTINCT t
               FROM unnest(COALESCE(user_inventory_item.tags, ARRAY[]::text[]) || $3::text[]) AS t
               ORDER BY t
             )
           )
       WHERE inventory_item_id = $1`,
      [inventoryItemId, importNote, sourceTags]
    );
    delta.inventoryUpdated += 1;
    console.log(`${sourceLogPrefix} Updated inventory item successfully`);
  }

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
    } else {
      const insertedImage = await client.query<{ imageId: number }>(
        `INSERT INTO image_asset
           (owner_type, owner_id, storage_url, checksum_sha256, copyright_status, captured_at)
         VALUES ('source', $1, $2, $3, 'licensed_source', now())
         RETURNING image_id AS "imageId"`,
        [dataSourceId, preparedImage.storageUrl, preparedImage.checksumSha256]
      );
      imageId = insertedImage.rows[0].imageId;
      console.log(`${sourceLogPrefix} Inserted new image ${imageId}`);
    }
    if (preparedImage.sourceUrl) {
      await recordSourceImageUrl(client, dataSourceId, preparedImage.sourceUrl, imageId);
    }

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

  // Store additional images as image_assets (no swatch — for training data)
  if (preparedImage.additionalImages.length > 0) {
    for (const addImg of preparedImage.additionalImages) {
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
          const insertedAdditional = await client.query<{ imageId: number }>(
            `INSERT INTO image_asset
               (owner_type, owner_id, storage_url, checksum_sha256, copyright_status, captured_at)
             VALUES ('source', $1, $2, $3, 'licensed_source', now())
             RETURNING image_id AS "imageId"`,
            [dataSourceId, addImg.storageUrl, addImg.checksumSha256]
          );
          galleryImageId = insertedAdditional.rows[0].imageId;
          console.log(
            `${sourceLogPrefix} Stored additional image for ${record.externalId}: checksum=${addImg.checksumSha256}`
          );
        } else {
          galleryImageId = existingAdditional.rows[0].imageId;
        }
        await recordSourceImageUrl(client, dataSourceId, addImg.sourceUrl, galleryImageId);

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
        console.error(`${sourceLogPrefix} Error storing additional image:`, String(err));
        // Non-fatal: don't throw for additional images
      }
    }
  }

  return delta;
}

export async function materializeHoloTacoRecords(
  userId: number,
  dataSourceId: number,
  records: ConnectorProductRecord[],
  options?: HoloTacoMaterializationOptions,
  sourceLogPrefix: string = "[HoloTaco]"
): Promise<HoloTacoMaterializationMetrics> {
  const overwriteDetectedHex = options?.overwriteDetectedHex === true;
  let processed = 0;
  let brandsCreated = 0;
  let shadesCreated = 0;
  let inventoryInserted = 0;
  let inventoryUpdated = 0;
  let hexOverwritten = 0;
  let swatchesLinked = 0;
  let skipped = 0;

  const brandCache = new Map<string, number>();
  const finishCatalog = await loadFinishCatalog({
    onFallback: (message) =>
      console.warn(`${sourceLogPrefix} Falling back to built-in finish catalog (${message})`),
  });

  console.log(
    `${sourceLogPrefix} Starting materialization for ${records.length} records, userId=${userId}, dataSourceId=${dataSourceId}, overwriteDetectedHex=${overwriteDetectedHex}`
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
          userId,
          dataSourceId,
          record,
          preparedImage,
          overwriteDetectedHex,
          sourceLogPrefix,
          brandCache,
          finishCatalog
        )
      );

      processed += delta.processed;
      brandsCreated += delta.brandsCreated;
      shadesCreated += delta.shadesCreated;
      inventoryInserted += delta.inventoryInserted;
      inventoryUpdated += delta.inventoryUpdated;
      hexOverwritten += delta.hexOverwritten;
      swatchesLinked += delta.swatchesLinked;
      skipped += delta.skipped;
    }
  );

  const result = {
    processed,
    brandsCreated,
    shadesCreated,
    inventoryInserted,
    inventoryUpdated,
    hexOverwritten,
    ...preparedImageData.metrics,
    ...(preparedImageData.aiBatch ? { aiBatch: preparedImageData.aiBatch } : {}),
    swatchesLinked,
    skipped,
  };

  console.log(`${sourceLogPrefix} Materialization complete:`, result);
  return result;
}
