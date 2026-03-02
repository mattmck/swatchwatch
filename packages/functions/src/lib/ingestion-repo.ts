import { query, transaction } from "./db";
import { ConnectorProductRecord } from "./connectors/types";
import { SUPPORTED_SOURCES } from "./connectors/types";
import { defaultShopifyBaseUrl } from "./connectors/shopify-generic";
import { detectHexWithAzureOpenAI, type HexDetectionOptions } from "./ai-color-detection";
import { submitVisionHexBatch } from "./azure-openai-batch";
import { uploadSourceImageToBlob } from "./blob-storage";
import { isSuspiciousHex } from "./suspicious-hex";
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
}

interface HoloTacoProductNormalized {
  brand: string | null;
  name: string | null;
  collection: string | null;
  finish: string | null;
  primaryImageUrl: string | null;
  imageUrls: string[];
  tags: string[];
  vendorHex: string | null;
  nameHex: string | null;
  colorName: string | null;
}

interface HoloTacoPreparedImage {
  storageUrl: string | null;
  checksumSha256: string | null;
  detectedHex: string | null;
  detectedFinishes: string[] | null;
  additionalImages: Array<{ storageUrl: string; checksumSha256: string }>;
}

interface HoloTacoImagePreparationMetrics {
  imageCandidates: number;
  imageUploads: number;
  imageUploadFailures: number;
  additionalImagesUploaded: number;
  hexDetected: number;
  hexDetectionFailures: number;
  hexDetectionSkipped: number;
  batchRequestsQueued: number;
}

export interface HoloTacoAiBatchDetails {
  batchId: string;
  inputFileId: string;
  requestCount: number;
  submittedAt: string;
  status: "submitted";
  overwriteDetectedHex: boolean;
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
    tags: asStringArray(normalized.tags),
    vendorHex: asString(normalized.vendorHex),
    nameHex: asString(normalized.nameHex),
    colorName: asString(normalized.colorName),
  };
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

const HEX_DETECTION_DELAY_MS = 6000;
const DEFAULT_HEX_BATCH_MIN_IMAGES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function estimateBatchCandidateCount(
  records: ConnectorProductRecord[],
  detectHexFromImage: boolean,
  detectHexOnSuspiciousOnly: boolean
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
      !detectHexOnSuspiciousOnly || isSuspiciousHex(holo.vendorHex);
    if (shouldRunAiDetection) {
      count += 1;
    }
  }

  return count;
}

async function prepareHoloTacoImageData(
  records: ConnectorProductRecord[],
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
  const estimatedBatchCandidates = estimateBatchCandidateCount(
    records,
    detectHexFromImage,
    detectHexOnSuspiciousOnly
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
    hexDetected: 0,
    hexDetectionFailures: 0,
    hexDetectionSkipped: 0,
    batchRequestsQueued: 0,
  };

  console.log(
    `${sourceLogPrefix} Image preparation: processing ${records.length} records, detectHexFromImage=${detectHexFromImage}, detectHexOnSuspiciousOnly=${detectHexOnSuspiciousOnly}, estimatedBatchCandidates=${estimatedBatchCandidates}, useBatchForHexDetection=${useBatchForHexDetection}, batchMinImages=${batchMinImages}`
  );

  for (const record of records) {
    const emptyPrepared: HoloTacoPreparedImage = {
      storageUrl: null,
      checksumSha256: null,
      detectedHex: null,
      detectedFinishes: null,
      additionalImages: [],
    };

    const normalized =
      record.normalized && typeof record.normalized === "object"
        ? (record.normalized as Record<string, unknown>)
        : null;
    if (!normalized) {
      console.log(`${sourceLogPrefix} Skipping record ${record.externalId}: no normalized data`);
      byExternalId.set(record.externalId, emptyPrepared);
      if (onRecordPrepared) {
        await onRecordPrepared(record, emptyPrepared);
      }
      continue;
    }

    const holo = parseHoloTacoNormalized(normalized);
    if (!holo.name) {
      byExternalId.set(record.externalId, emptyPrepared);
      if (onRecordPrepared) {
        await onRecordPrepared(record, emptyPrepared);
      }
      continue;
    }

    if (!isHttpUrl(holo.primaryImageUrl)) {
      console.log(`${sourceLogPrefix} Skipping record ${record.externalId}: missing name or invalid image URL`, {
        name: holo.name,
        imageUrl: holo.primaryImageUrl,
      });
      byExternalId.set(record.externalId, emptyPrepared);
      if (onRecordPrepared) {
        await onRecordPrepared(record, emptyPrepared);
      }
      continue;
    }

    console.log(`${sourceLogPrefix} Image candidate: externalId=${record.externalId}, name=${holo.name}, imageUrl=${holo.primaryImageUrl}`);
    metrics.imageCandidates += 1;

    let storageUrl: string | null = null;
    let checksumSha256: string | null = null;
    let detectedHex: string | null = null;
    let detectedFinishes: string[] | null = null;
    let imageBase64DataUri: string | null = null;
    const additionalImages: Array<{ storageUrl: string; checksumSha256: string }> = [];

    // Step 1: Upload primary image to blob storage
    try {
      console.log(`${sourceLogPrefix} BEFORE: Uploading primary image for ${record.externalId} from ${holo.primaryImageUrl}`);
      const upload = await uploadSourceImageToBlob({
        sourceImageUrl: holo.primaryImageUrl,
        source: sourceLogPrefix.replace(/[\[\]]/g, ""),
        externalId: record.externalId,
      });
      storageUrl = upload.storageUrl;
      checksumSha256 = upload.checksumSha256;
      imageBase64DataUri = upload.imageBase64DataUri;
      metrics.imageUploads += 1;
      console.log(`${sourceLogPrefix} AFTER: Primary image uploaded: checksum=${checksumSha256}, storageUrl=${storageUrl}`);
    } catch (err) {
      metrics.imageUploadFailures += 1;
      console.error(`${sourceLogPrefix} Primary image upload failed for ${record.externalId}:`, String(err));
    }

    // Step 2: Upload additional images (index 1+) — no AI detection on these
    for (let i = 1; i < holo.imageUrls.length; i++) {
      const imgUrl = holo.imageUrls[i];
      if (!isHttpUrl(imgUrl)) continue;
      try {
        const upload = await uploadSourceImageToBlob({
          sourceImageUrl: imgUrl,
          source: sourceLogPrefix.replace(/[\[\]]/g, ""),
          externalId: `${record.externalId}-img${i}`,
        });
        additionalImages.push({
          storageUrl: upload.storageUrl,
          checksumSha256: upload.checksumSha256,
        });
        metrics.additionalImagesUploaded += 1;
      } catch (err) {
        console.error(`${sourceLogPrefix} Additional image ${i} upload failed for ${record.externalId}:`, String(err));
      }
    }

    // Step 3: AI hex detection on primary image only
    // Conditions: detectHexFromImage must be true, and if detectHexOnSuspiciousOnly
    // is set, only run when vendor hex is suspicious/missing
    const shouldRunAiDetection = detectHexFromImage &&
      (!detectHexOnSuspiciousOnly || isSuspiciousHex(holo.vendorHex));
    const imageForAi = imageBase64DataUri;

    if (shouldRunAiDetection) {
      if (!imageForAi) {
        metrics.hexDetectionSkipped += 1;
        const skipMessage = `${sourceLogPrefix} ${record.externalId} [ai-color-detection] Skipping AI: missing base64 image payload`;
        console.warn(skipMessage, {
          externalId: record.externalId,
          brand: holo.brand || sourceLogPrefix.replace(/[\[\]]/g, ""),
          colorName: holo.name,
          uploadSucceeded: Boolean(storageUrl),
        });
        progressLogger?.warn(skipMessage, {
          externalId: record.externalId,
          brand: holo.brand || sourceLogPrefix.replace(/[\[\]]/g, ""),
          colorName: holo.name,
          uploadSucceeded: Boolean(storageUrl),
        });
      } else if (useBatchForHexDetection) {
        queuedBatchRequests.push({
          customId: record.externalId,
          imageUrlOrDataUri: imageForAi,
          vendorContext: {
            shadeName: holo.name,
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
        });
      } else {
        if (holo.vendorHex) {
          console.log(`${sourceLogPrefix} Vendor hex (${holo.vendorHex}) is suspicious, running AI detection for ${record.externalId}`);
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
              shadeName: holo.name,
              vendorHex: holo.vendorHex,
              description: holo.collection,
              tags: holo.tags,
              vendorJson: {
                finish: holo.finish,
                colorName: holo.colorName,
              },
            },
          });
          console.log(`${sourceLogPrefix} AI detection result for ${record.externalId}:`, { detectedHex: detection.hex, vendorHex: holo.vendorHex });
          if (detection.hex) {
            detectedHex = detection.hex;
            detectedFinishes = detection.finishes;
            metrics.hexDetected += 1;
            const successData = {
              externalId: record.externalId,
              brand: holo.brand || sourceLogPrefix.replace(/[\[\]]/g, ""),
              colorName: holo.name,
              hex: detection.hex,
              finishes: detection.finishes,
            };
            const successMessage = `${sourceLogPrefix} ${record.externalId} [ai-color-detection] Success`;
            console.log(successMessage, successData);
            progressLogger?.info(successMessage, successData);
          } else {
            console.log(`${sourceLogPrefix} No hex returned from AI for ${record.externalId}`);
          }
          console.log(`${sourceLogPrefix} Sleeping ${HEX_DETECTION_DELAY_MS}ms before next detection`);
          await sleep(HEX_DETECTION_DELAY_MS);
        } catch (err) {
          metrics.hexDetectionFailures += 1;
          console.error(`${sourceLogPrefix} AI hex detection failed for ${record.externalId}:`, String(err));
        }
      }
    } else {
      metrics.hexDetectionSkipped += 1;
      if (detectHexOnSuspiciousOnly && holo.vendorHex && !isSuspiciousHex(holo.vendorHex)) {
        console.log(`${sourceLogPrefix} Skipping AI for ${record.externalId}: vendor hex ${holo.vendorHex} not suspicious`);
      } else {
        console.log(`${sourceLogPrefix} Skipping AI detection for ${record.externalId} (detectHexFromImage=${detectHexFromImage})`);
      }
    }

    const preparedImage: HoloTacoPreparedImage = {
      storageUrl,
      checksumSha256,
      detectedHex,
      detectedFinishes,
      additionalImages,
    };
    byExternalId.set(record.externalId, preparedImage);
    if (onRecordPrepared) {
      await onRecordPrepared(record, preparedImage);
    }
  }

  console.log(`${sourceLogPrefix} Image preparation complete:`, metrics);

  let aiBatch: HoloTacoAiBatchDetails | null = null;
  if (useBatchForHexDetection && queuedBatchRequests.length > 0) {
    const batchResult = await submitVisionHexBatch(queuedBatchRequests);
    aiBatch = {
      batchId: batchResult.batchId,
      inputFileId: batchResult.inputFileId,
      requestCount: batchResult.requestCount,
      submittedAt: batchResult.submittedAt,
      status: "submitted",
      overwriteDetectedHex: options?.overwriteDetectedHex === true,
    };
    const submittedMessage = `${sourceLogPrefix} Submitted Azure OpenAI batch ${batchResult.batchId} with ${batchResult.requestCount} request(s)`;
    console.log(submittedMessage);
    progressLogger?.info(submittedMessage, aiBatch as unknown as Record<string, unknown>);
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
       AND COALESCE(j.metrics_json -> 'aiBatch' ->> 'status', '') = 'submitted'
       AND COALESCE(j.metrics_json -> 'aiBatch' ->> 'batchId', '') <> ''
     ORDER BY j.started_at ASC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map((row) => ({
    jobId: row.jobId,
    source: row.source,
    dataSourceId: row.dataSourceId,
    metrics: row.metrics || {},
    startedAt: row.startedAt,
  }));
}

export interface AiBatchShadeDetectionInput {
  externalId: string;
  detectedHex: string | null;
  detectedFinishes: string[] | null;
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
           updated_at = now()
       FROM target
       WHERE sh.shade_id = target.shade_id
       RETURNING sh.shade_id AS "shadeId"`,
      [dataSourceId, externalId, detectedHex, detectedFinishes, overwriteDetectedHex]
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
             AND NOT EXISTS (SELECT 1 FROM sku s WHERE s.shade_id = sh.shade_id)`,
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

        const existingShade = await client.query<{ shadeId: number }>(
          `SELECT shade_id AS "shadeId"
           FROM shade
           WHERE brand_id = $1
             AND product_line_id IS NULL
             AND lower(shade_name_canonical) = lower($2)
             AND coalesce(collection, '') = coalesce($3, '')
           LIMIT 1`,
          [brandId, shadeName, collection]
        );

        let shadeId: number;
        if (existingShade.rows.length > 0) {
          shadeId = existingShade.rows[0].shadeId;
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
        await client.query(
          `UPDATE shade SET
             color_name = COALESCE($2, color_name),
             vendor_hex = COALESCE($3, vendor_hex),
             updated_at = now()
           WHERE shade_id = $1`,
          [shadeId, resolvedColorName, resolvedVendorHex]
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
               (user_id, shade_id, quantity, notes, tags)
             VALUES ($1, $2, 0, $3, ARRAY['imported','makeupapi']::text[])`,
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
  brandCache: Map<string, number>
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

  console.log(`${sourceLogPrefix} Processing record: externalId=${record.externalId}, name=${holo.name}`);

  const brandName = canonicalizeBrandName(holo.brand || "Holo Taco");
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
      `INSERT INTO shade (brand_id, shade_name_canonical, finish, collection, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING shade_id AS "shadeId"`,
      [brandId, holo.name, holo.finish, holo.collection]
    );
    shadeId = insertedShade.rows[0].shadeId;
    delta.shadesCreated += 1;
  }

  const importNote = `Imported from ${sourceLogPrefix.replace(/[\[\]]/g, "")} external_id=${record.externalId}`;
  const vendorHex = holo.vendorHex;
  const detectedHex = preparedImage.detectedHex || null;
  const detectedFinishes = preparedImage.detectedFinishes || null;
  const nameHex = holo.nameHex;
  const sourceTags = Array.from(
    new Set(
      [...holo.tags, "imported", "shopify"]
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );

  console.log(
    `${sourceLogPrefix} Shade color update: shadeId=${shadeId}, vendorHex=${vendorHex}, detectedHex=${detectedHex}, nameHex=${nameHex}`
  );

  // Read current shade color data for overwrite comparison
  const currentShade = await client.query<{
    vendorHex: string | null;
    detectedHex: string | null;
    detectedFinishes: string[] | null;
    nameHex: string | null;
  }>(
    `SELECT
       vendor_hex AS "vendorHex",
       detected_hex AS "detectedHex",
       detected_finishes AS "detectedFinishes",
       name_hex AS "nameHex"
     FROM shade WHERE shade_id = $1`,
    [shadeId]
  );

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
         updated_at = now()
     WHERE shade_id = $1`,
    [shadeId, holo.name, vendorHex, detectedHex, detectedFinishes, overwriteDetectedHex, nameHex]
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
         (user_id, shade_id, quantity, notes, tags)
       VALUES ($1, $2, 0, $3, $4::text[])`,
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

    const existingSwatch = await client.query<{ swatchId: number; imageIdOriginal: number }>(
      `SELECT
         swatch_id AS "swatchId",
         image_id_original AS "imageIdOriginal"
       FROM swatch
       WHERE shade_id = $1
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
         WHERE swatch_id = $1`,
        [existingSwatch.rows[0].swatchId, imageId]
      );
      delta.swatchesLinked += 1;
      console.log(`${sourceLogPrefix} Updated swatch successfully`);
    }
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

  console.log(
    `${sourceLogPrefix} Starting materialization for ${records.length} records, userId=${userId}, dataSourceId=${dataSourceId}, overwriteDetectedHex=${overwriteDetectedHex}`
  );

  const preparedImageData = await prepareHoloTacoImageData(
    records,
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
          brandCache
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
