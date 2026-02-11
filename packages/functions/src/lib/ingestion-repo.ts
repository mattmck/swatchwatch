import { query, transaction } from "./db";
import { ConnectorProductRecord } from "./connectors/types";
import { detectHexWithAzureOpenAI } from "./ai-color-detection";
import { uploadSourceImageToBlob } from "./blob-storage";

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
  skipped: number;
}

export interface HoloTacoMaterializationOptions {
  detectHexFromImage?: boolean;
  overwriteDetectedHex?: boolean;
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
  tags: string[];
}

interface HoloTacoPreparedImage {
  storageUrl: string | null;
  checksumSha256: string | null;
  detectedHex: string | null;
}

interface HoloTacoImagePreparationMetrics {
  imageCandidates: number;
  imageUploads: number;
  imageUploadFailures: number;
  hexDetected: number;
  hexDetectionFailures: number;
  hexDetectionSkipped: number;
}

interface HoloTacoImagePreparationResult {
  byExternalId: Map<string, HoloTacoPreparedImage>;
  metrics: HoloTacoImagePreparationMetrics;
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
    tags: asStringArray(normalized.tags),
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

async function prepareHoloTacoImageData(
  records: ConnectorProductRecord[],
  options?: HoloTacoMaterializationOptions
): Promise<HoloTacoImagePreparationResult> {
  const detectHexFromImage = options?.detectHexFromImage !== false;
  const byExternalId = new Map<string, HoloTacoPreparedImage>();
  const metrics: HoloTacoImagePreparationMetrics = {
    imageCandidates: 0,
    imageUploads: 0,
    imageUploadFailures: 0,
    hexDetected: 0,
    hexDetectionFailures: 0,
    hexDetectionSkipped: 0,
  };

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

    metrics.imageCandidates += 1;

    let storageUrl: string | null = null;
    let checksumSha256: string | null = null;
    let detectedHex: string | null = null;

    try {
      const upload = await uploadSourceImageToBlob({
        sourceImageUrl: holo.primaryImageUrl,
        source: "HoloTacoShopify",
        externalId: record.externalId,
      });
      storageUrl = upload.storageUrl;
      checksumSha256 = upload.checksumSha256;
      metrics.imageUploads += 1;
    } catch {
      metrics.imageUploadFailures += 1;
    }

    if (detectHexFromImage) {
      try {
        const detection = await detectHexWithAzureOpenAI(holo.primaryImageUrl);
        if (detection.hex) {
          detectedHex = detection.hex;
          metrics.hexDetected += 1;
        }
      } catch {
        metrics.hexDetectionFailures += 1;
      }
    } else {
      metrics.hexDetectionSkipped += 1;
    }

    byExternalId.set(record.externalId, {
      storageUrl,
      checksumSha256,
      detectedHex,
    });
  }

  return {
    byExternalId,
    metrics,
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

        const inventory = await client.query<{
          inventoryItemId: number;
          colorName: string | null;
          colorHex: string | null;
        }>(
          `SELECT
             inventory_item_id AS "inventoryItemId",
             color_name AS "colorName",
             color_hex AS "colorHex"
           FROM user_inventory_item
           WHERE user_id = $1
             AND shade_id = $2
           LIMIT 1`,
          [userId, shadeId]
        );

        const resolvedColorName = variant.name || makeup.name;
        const resolvedColorHex = variant.hex;
        const importNote = `Imported from MakeupAPI external_id=${record.externalId}`;

        if (inventory.rows.length === 0) {
          await client.query(
            `INSERT INTO user_inventory_item
               (user_id, shade_id, quantity, color_name, color_hex, notes, tags)
             VALUES ($1, $2, 0, $3, $4, $5, ARRAY['imported','makeupapi']::text[])`,
            [userId, shadeId, resolvedColorName, resolvedColorHex, importNote]
          );
          inventoryInserted += 1;
        } else {
          const inventoryItemId = inventory.rows[0].inventoryItemId;
          await client.query(
            `UPDATE user_inventory_item
             SET color_name = COALESCE(color_name, $2),
                 color_hex = COALESCE(color_hex, $3),
                 notes = COALESCE(notes, $4),
                 tags = (
                   SELECT ARRAY(
                     SELECT DISTINCT t
                     FROM unnest(COALESCE(user_inventory_item.tags, ARRAY[]::text[]) || ARRAY['imported','makeupapi']::text[]) AS t
                     ORDER BY t
                   )
                 )
             WHERE inventory_item_id = $1`,
            [inventoryItemId, resolvedColorName, resolvedColorHex, importNote]
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

export async function materializeHoloTacoRecords(
  userId: number,
  dataSourceId: number,
  records: ConnectorProductRecord[],
  options?: HoloTacoMaterializationOptions
): Promise<HoloTacoMaterializationMetrics> {
  const preparedImageData = await prepareHoloTacoImageData(records, options);
  const overwriteDetectedHex = options?.overwriteDetectedHex === true;

  return transaction(async (client) => {
    let processed = 0;
    let brandsCreated = 0;
    let shadesCreated = 0;
    let inventoryInserted = 0;
    let inventoryUpdated = 0;
    let hexOverwritten = 0;
    let swatchesLinked = 0;
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

      const holo = parseHoloTacoNormalized(normalized);
      if (!holo.name) {
        skipped += 1;
        continue;
      }

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
          brandsCreated += 1;
        }

        brandCache.set(brandKey, brandId);
      }

      processed += 1;

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
        shadesCreated += 1;
      }

      const inventory = await client.query<{ inventoryItemId: number; colorHex: string | null }>(
        `SELECT inventory_item_id AS "inventoryItemId"
                color_hex AS "colorHex"
         FROM user_inventory_item
         WHERE user_id = $1
           AND shade_id = $2
         LIMIT 1`,
        [userId, shadeId]
      );

      const importNote = `Imported from HoloTacoShopify external_id=${record.externalId}`;
      const preparedImage = preparedImageData.byExternalId.get(record.externalId);
      const detectedHex = preparedImage?.detectedHex || null;
      const sourceTags = Array.from(
        new Set(
          [...holo.tags, "imported", "holotaco", "shopify"]
            .map((tag) => tag.trim())
            .filter(Boolean)
        )
      );

      if (inventory.rows.length === 0) {
        await client.query(
          `INSERT INTO user_inventory_item
             (user_id, shade_id, quantity, color_name, color_hex, notes, tags)
           VALUES ($1, $2, 0, $3, $4, $5, $6::text[])`,
          [userId, shadeId, holo.name, detectedHex, importNote, sourceTags]
        );
        inventoryInserted += 1;
      } else {
        const inventoryItemId = inventory.rows[0].inventoryItemId;
        const existingColorHex = inventory.rows[0].colorHex;
        const shouldOverwriteHex = overwriteDetectedHex && Boolean(detectedHex);

        if (shouldOverwriteHex && detectedHex !== existingColorHex) {
          hexOverwritten += 1;
        }

        await client.query(
          `UPDATE user_inventory_item
           SET color_name = COALESCE(color_name, $2),
               color_hex = CASE
                 WHEN $6::boolean AND $3 IS NOT NULL THEN $3
                 ELSE COALESCE(color_hex, $3)
               END,
               notes = COALESCE(notes, $4),
               tags = (
                 SELECT ARRAY(
                   SELECT DISTINCT t
                   FROM unnest(COALESCE(user_inventory_item.tags, ARRAY[]::text[]) || $5::text[]) AS t
                   ORDER BY t
                 )
               )
           WHERE inventory_item_id = $1`,
          [inventoryItemId, holo.name, detectedHex, importNote, sourceTags, overwriteDetectedHex]
        );
        inventoryUpdated += 1;
      }

      if (preparedImage?.storageUrl && preparedImage.checksumSha256) {
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
        } else {
          const insertedImage = await client.query<{ imageId: number }>(
            `INSERT INTO image_asset
               (owner_type, owner_id, storage_url, checksum_sha256, copyright_status, captured_at)
             VALUES ('source', $1, $2, $3, 'licensed_source', now())
             RETURNING image_id AS "imageId"`,
            [dataSourceId, preparedImage.storageUrl, preparedImage.checksumSha256]
          );
          imageId = insertedImage.rows[0].imageId;
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
          await client.query(
            `INSERT INTO swatch (shade_id, image_id_original, swatch_type, lighting, background, quality_score)
             VALUES ($1, $2, 'source_product', 'unknown', 'transparent', 80.0)`,
            [shadeId, imageId]
          );
          swatchesLinked += 1;
        } else if (existingSwatch.rows[0].imageIdOriginal !== imageId) {
          await client.query(
            `UPDATE swatch
             SET image_id_original = $2
             WHERE swatch_id = $1`,
            [existingSwatch.rows[0].swatchId, imageId]
          );
          swatchesLinked += 1;
        }
      }
    }

    return {
      processed,
      brandsCreated,
      shadesCreated,
      inventoryInserted,
      inventoryUpdated,
      hexOverwritten,
      ...preparedImageData.metrics,
      swatchesLinked,
      skipped,
    };
  });
}
