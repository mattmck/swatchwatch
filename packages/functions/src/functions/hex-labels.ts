import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  HEX_LABEL_SAMPLE_SIZES,
  MEDIUM_CONFIDENCE_MAX_DISTANCE,
  type HexLabel,
  type HexLabelDeleteResponse,
  type HexLabelImage,
  type HexLabelQueueItem,
  type HexLabelQueueResponse,
  type HexLabelSampleMethod,
  type HexLabelSamplePoint,
  type HexLabelSaveResponse,
} from "swatchwatch-shared";
import { query, transaction } from "../lib/db";
import { withAdmin } from "../lib/auth";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { isCatalogStorageUrl } from "../lib/blob-storage";
import { toImageProxyUrl } from "../lib/image-proxy";
import { trackEvent } from "../lib/telemetry";

/**
 * Admin Hex Labeling tool: hand-picked ground-truth hexes for the hex-detection eval.
 *
 * An admin samples the polish colour from one of a shade's catalog product images (canvas
 * eyedropper in the web admin console). Labels are `color_training_sample` rows with
 * `source_type = 'manual'` (one per shade, migration 20261017170047543_hex-ground-truth-labels)
 * and are exported by `npm run eval:hex:populate` as `manual` ground-truth cases.
 * `shade.vendor_hex` / `shade.detected_hex` are never written here.
 *
 * All routes are admin-only (`withAdmin`); every statement is parameterized.
 */

export const HEX_LABEL_DEFAULT_PAGE_SIZE = 20;
export const HEX_LABEL_MAX_PAGE_SIZE = 100;
export const HEX_LABEL_MAX_NOTE_LENGTH = 1000;
const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const ID_PATTERN = /^\d+$/;
const SAMPLE_METHODS: ReadonlySet<HexLabelSampleMethod> = new Set(["canvas", "eyedropper", "manual"]);
const SAMPLE_SIZES: ReadonlySet<number> = new Set(HEX_LABEL_SAMPLE_SIZES);
/** Upper bound for a recorded natural image dimension (sanity check, not a resize limit). */
const MAX_IMAGE_DIMENSION = 20000;

// ── Validation (pure) ───────────────────────────────────────────────────────

/** Positive safe-integer id from a digits-only string/number, or null. */
export function parseId(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!ID_PATTERN.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** `#RRGGBB` (uppercased) or null. Strict: no 3-digit shorthand, `#` required. */
export function parseLabelHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return HEX_PATTERN.test(trimmed) ? trimmed.toUpperCase() : null;
}

export interface ParsedHexLabelRequest {
  shadeId: number;
  hex: string | null;
  imageId: number | null;
  unreliable: boolean;
  note: string | null;
  method: HexLabelSampleMethod | null;
  samplePoint: HexLabelSamplePoint | null;
}

export type HexLabelRequestParseResult = { ok: true; value: ParsedHexLabelRequest } | { ok: false; error: string };

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_IMAGE_DIMENSION;
}

/** Validate a `POST /api/hex-labels-admin/labels` body. Pure. */
export function parseHexLabelRequest(body: unknown): HexLabelRequestParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;

  const shadeId = parseId(raw.shadeId);
  if (shadeId === null) return { ok: false, error: "shadeId must be a positive integer id" };

  if (raw.unreliable !== undefined && typeof raw.unreliable !== "boolean") {
    return { ok: false, error: "unreliable must be a boolean" };
  }
  const unreliable = raw.unreliable === true;

  let hex: string | null = null;
  if (raw.hex !== undefined && raw.hex !== null && raw.hex !== "") {
    hex = parseLabelHex(raw.hex);
    if (!hex) return { ok: false, error: "hex must be a #RRGGBB colour" };
  }
  if (!hex && !unreliable) {
    return { ok: false, error: "hex is required unless the images are flagged unreliable" };
  }

  let imageId: number | null = null;
  if (raw.imageId !== undefined && raw.imageId !== null && raw.imageId !== "") {
    imageId = parseId(raw.imageId);
    if (imageId === null) return { ok: false, error: "imageId must be a positive integer id" };
  }

  let note: string | null = null;
  if (raw.note !== undefined && raw.note !== null) {
    if (typeof raw.note !== "string") return { ok: false, error: "note must be a string" };
    const trimmed = raw.note.trim();
    if (trimmed.length > HEX_LABEL_MAX_NOTE_LENGTH) {
      return { ok: false, error: `note must be at most ${HEX_LABEL_MAX_NOTE_LENGTH} characters` };
    }
    note = trimmed || null;
  }

  let method: HexLabelSampleMethod | null = null;
  if (raw.method !== undefined && raw.method !== null) {
    if (typeof raw.method !== "string" || !SAMPLE_METHODS.has(raw.method as HexLabelSampleMethod)) {
      return { ok: false, error: "method must be one of canvas, eyedropper, manual" };
    }
    method = raw.method as HexLabelSampleMethod;
  }

  let samplePoint: HexLabelSamplePoint | null = null;
  if (raw.samplePoint !== undefined && raw.samplePoint !== null) {
    const point = raw.samplePoint as Record<string, unknown>;
    if (
      typeof point !== "object" ||
      Array.isArray(point) ||
      !isUnitInterval(point.x) ||
      !isUnitInterval(point.y) ||
      typeof point.size !== "number" ||
      !SAMPLE_SIZES.has(point.size) ||
      !isDimension(point.imageWidth) ||
      !isDimension(point.imageHeight)
    ) {
      return {
        ok: false,
        error: `samplePoint must be {x, y in 0..1, size in ${HEX_LABEL_SAMPLE_SIZES.join("/")}, imageWidth, imageHeight}`,
      };
    }
    if (imageId === null) return { ok: false, error: "samplePoint requires imageId" };
    samplePoint = {
      x: point.x,
      y: point.y,
      size: point.size,
      imageWidth: point.imageWidth,
      imageHeight: point.imageHeight,
    };
  }

  return { ok: true, value: { shadeId, hex, imageId, unreliable, note, method, samplePoint } };
}

// ── Queue cursor (pure) ─────────────────────────────────────────────────────

/**
 * Keyset position in the queue order: labeled last (`l`), shades with images first (`i`),
 * worst vendor↔detected agreement first (`a`, the NUMERIC as text, exact; -1 when unknown), then
 * shade id.
 */
export interface HexLabelQueueCursor {
  l: 0 | 1;
  i: 0 | 1;
  a: string;
  s: string;
}

const AGREEMENT_RANK_PATTERN = /^-?\d{1,6}(\.\d{1,8})?$/;

export function encodeQueueCursor(cursor: HexLabelQueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Decode a cursor; null when it is malformed (the route answers 400). */
export function decodeQueueCursor(value: string): HexLabelQueueCursor | null {
  if (!value || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const { l, i, a, s } = parsed;
    if ((l !== 0 && l !== 1) || (i !== 0 && i !== 1)) return null;
    if (typeof a !== "string" || !AGREEMENT_RANK_PATTERN.test(a)) return null;
    if (typeof s !== "string" || parseId(s) === null) return null;
    return { l, i, a, s };
  } catch {
    return null;
  }
}

// ── Queue SQL (pure builder) ────────────────────────────────────────────────

export interface HexLabelQueueQueryOptions {
  brand: string | null;
  disagreeOnly: boolean;
  showLabeled: boolean;
  includeWithoutImages: boolean;
  cursor: HexLabelQueueCursor | null;
  /** Rows to fetch (page size + 1 to detect a next page). */
  limit: number;
}

/**
 * Catalog shades + their manual label + how many catalog images they have. `user_submitted`
 * shades are private to their creator and never queued; only `owner_type = 'source'` images
 * count (private user media is never shown to the labeler).
 */
const QUEUE_FROM = `
  FROM shade s
  JOIN brand b ON b.brand_id = s.brand_id
  LEFT JOIN color_training_sample lbl
    ON lbl.shade_id = s.shade_id
   AND lbl.source_type = 'manual'
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS image_count
    FROM swatch sw
    JOIN image_asset ia ON ia.image_id = sw.image_id_original
    WHERE sw.shade_id = s.shade_id
      AND ia.owner_type = 'source'
  ) img ON true`;

/** Columns of one queue item (shade, hexes, current manual label, sort ranks). Shared with the single-shade read. */
const QUEUE_COLUMNS = `
      s.shade_id                                    AS "shadeKey",
      s.shade_id::text                              AS "shadeId",
      COALESCE(b.name_canonical, '')                AS brand,
      COALESCE(s.shade_name_canonical, '')          AS name,
      COALESCE(s.finishes, ARRAY[]::text[])         AS finishes,
      NULLIF(s.finish, '')                          AS "legacyFinish",
      s.vendor_hex                                  AS "vendorHex",
      s.detected_hex                                AS "detectedHex",
      s.name_hex                                    AS "nameHex",
      s.hex_agreement::float8                       AS "hexAgreement",
      s.detected_hex_confidence::float8             AS "detectedHexConfidence",
      s.detected_hex_method                         AS "detectedHexMethod",
      lbl.training_sample_id::text                  AS "labelId",
      lbl.hex                                       AS "labelHex",
      lbl.training_status                           AS "labelStatus",
      lbl.image_id::text                            AS "labelImageId",
      lbl.notes                                     AS "labelNote",
      lbl.label_meta                                AS "labelMeta",
      lbl.labeled_by_user_id::text                  AS "labelUserId",
      lbl.updated_at                                AS "labelAt",
      (lbl.training_sample_id IS NOT NULL)::int     AS "labeledRank",
      (img.image_count > 0)::int                    AS "imageRank",
      COALESCE(s.hex_agreement, -1)                 AS "agreementRank"`;

/** Queue order; must match the keyset predicate in `buildQueueQueries`. */
export const HEX_LABEL_QUEUE_ORDER = `q."labeledRank" ASC, q."imageRank" DESC, q."agreementRank" DESC, q."shadeKey" ASC`;

/**
 * Build the count + page statements for the queue. Filters are bound parameters; the only
 * interpolated text is fixed SQL chosen by booleans.
 */
export function buildQueueQueries(options: HexLabelQueueQueryOptions): {
  count: { sql: string; params: unknown[] };
  page: { sql: string; params: unknown[] };
} {
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const base: string[] = ["s.status <> 'user_submitted'"];
  if (options.brand) base.push(`b.name_canonical ILIKE ${add(`%${options.brand}%`)}`);
  if (options.disagreeOnly) base.push(`s.hex_agreement > ${add(MEDIUM_CONFIDENCE_MAX_DISTANCE)}`);
  if (!options.includeWithoutImages) base.push("img.image_count > 0");

  const countSql = `SELECT count(*)::int AS total,
         count(lbl.training_sample_id)::int AS labeled
  ${QUEUE_FROM}
  WHERE ${base.join(" AND ")}`;
  const countParams = [...params];

  const inner = [...base];
  if (!options.showLabeled) inner.push("lbl.training_sample_id IS NULL");

  let cursorSql = "";
  if (options.cursor) {
    const l = add(options.cursor.l);
    const i = add(options.cursor.i);
    const a = add(options.cursor.a);
    const s = add(options.cursor.s);
    cursorSql = `WHERE (q."labeledRank" > ${l})
     OR (q."labeledRank" = ${l} AND q."imageRank" < ${i})
     OR (q."labeledRank" = ${l} AND q."imageRank" = ${i} AND q."agreementRank" < ${a}::numeric)
     OR (q."labeledRank" = ${l} AND q."imageRank" = ${i} AND q."agreementRank" = ${a}::numeric AND q."shadeKey" > ${s}::bigint)`;
  }
  const limit = add(options.limit);

  const pageSql = `SELECT q.*
  FROM (
    SELECT
      ${QUEUE_COLUMNS}
    ${QUEUE_FROM}
    WHERE ${inner.join(" AND ")}
  ) q
  ${cursorSql}
  ORDER BY ${HEX_LABEL_QUEUE_ORDER}
  LIMIT ${limit}`;

  return { count: { sql: countSql, params: countParams }, page: { sql: pageSql, params } };
}

/** Catalog images of the given shades, primary product image first. `$1` = bigint[] of shade ids. */
export const SHADE_IMAGES_SQL = `SELECT
       sw.shade_id::text      AS "shadeId",
       ia.image_id::text      AS "imageId",
       ia.owner_id::text      AS "dataSourceId",
       ia.storage_url         AS "storageUrl",
       sw.swatch_type         AS "swatchType",
       siu.source_url         AS "sourceUrl"
     FROM swatch sw
     JOIN image_asset ia ON ia.image_id = sw.image_id_original
     LEFT JOIN LATERAL (
       SELECT u.source_url
       FROM source_image_url u
       WHERE u.image_id = ia.image_id
       ORDER BY u.updated_at DESC
       LIMIT 1
     ) siu ON true
     WHERE sw.shade_id = ANY($1::bigint[])
       AND ia.owner_type = 'source'
     ORDER BY sw.shade_id, COALESCE(sw.swatch_type = 'source_product', false) DESC, sw.swatch_id`;

// ── Row mapping ─────────────────────────────────────────────────────────────

interface ShadeImageRow {
  shadeId: string;
  imageId: string;
  dataSourceId: string | null;
  storageUrl: string;
  swatchType: string | null;
  sourceUrl: string | null;
}

const BLOB_HOST_PATTERN = /^https?:\/\/[^/]*\.blob\./i;

function isBlobLikeUrl(url: string): boolean {
  if (BLOB_HOST_PATTERN.test(url)) return true;
  try {
    const parsed = new URL(url);
    return ["127.0.0.1", "localhost"].includes(parsed.hostname.toLowerCase()) && parsed.port === "10000";
  } catch {
    return false;
  }
}

/**
 * Browser-readable URL for a catalog image: a signed public (v2) proxy id for catalog blobs, the
 * URL itself for a non-blob http(s) URL, null otherwise (any other container, signing failure).
 */
export function readableCatalogImageUrl(storageUrl: string, requestUrl: string): string | null {
  const url = storageUrl.trim();
  if (!url) return null;
  try {
    if (isCatalogStorageUrl(url)) return toImageProxyUrl(requestUrl, url);
  } catch (error) {
    console.error(
      `[hex-labels] Omitting image: failed to build signed image proxy URL (${
        error instanceof Error ? error.message : String(error)
      })`
    );
    return null;
  }
  if (isBlobLikeUrl(url)) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/** Dedupe by image id and keep the SQL order (primary product image first). */
function groupImages(rows: ShadeImageRow[]): Map<string, ShadeImageRow[]> {
  const byShade = new Map<string, ShadeImageRow[]>();
  for (const row of rows) {
    const list = byShade.get(row.shadeId) ?? [];
    if (!list.some((existing) => existing.imageId === row.imageId)) list.push(row);
    byShade.set(row.shadeId, list);
  }
  return byShade;
}

function toLabelImages(rows: ShadeImageRow[], requestUrl: string): HexLabelImage[] {
  const images: HexLabelImage[] = [];
  for (const row of rows) {
    const url = readableCatalogImageUrl(row.storageUrl, requestUrl);
    if (!url) continue;
    images.push({
      imageId: row.imageId,
      url,
      swatchType: row.swatchType,
      sourceUrl: row.sourceUrl,
      isPrimary: row.swatchType === "source_product",
    });
  }
  return images;
}

interface LabelColumns {
  labelId: string | null;
  labelHex: string | null;
  labelStatus: string | null;
  labelImageId: string | null;
  labelNote: string | null;
  labelMeta: unknown;
  labelUserId: string | null;
  labelAt: Date | string | null;
}

function parseLabelMeta(meta: unknown): { method: HexLabelSampleMethod | null; samplePoint: HexLabelSamplePoint | null } {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return { method: null, samplePoint: null };
  const record = meta as Record<string, unknown>;
  const method =
    typeof record.method === "string" && SAMPLE_METHODS.has(record.method as HexLabelSampleMethod)
      ? (record.method as HexLabelSampleMethod)
      : null;
  const point = record.samplePoint as Record<string, unknown> | undefined;
  const samplePoint =
    point && typeof point === "object" && isUnitInterval(point.x) && isUnitInterval(point.y)
      ? {
          x: point.x,
          y: point.y,
          size: typeof point.size === "number" ? point.size : 1,
          imageWidth: typeof point.imageWidth === "number" ? point.imageWidth : 0,
          imageHeight: typeof point.imageHeight === "number" ? point.imageHeight : 0,
        }
      : null;
  return { method, samplePoint };
}

function toIso(value: Date | string | null): string {
  if (value instanceof Date) return value.toISOString();
  return value ?? new Date(0).toISOString();
}

export function toHexLabel(shadeId: string, row: LabelColumns): HexLabel | null {
  if (!row.labelId) return null;
  const { method, samplePoint } = parseLabelMeta(row.labelMeta);
  return {
    trainingSampleId: row.labelId,
    shadeId,
    hex: row.labelHex,
    unreliable: row.labelStatus === "rejected",
    imageId: row.labelImageId,
    note: row.labelNote,
    method,
    samplePoint,
    labeledByUserId: row.labelUserId,
    labeledAt: toIso(row.labelAt),
  };
}

// ── GET /api/hex-labels-admin/queue ─────────────────────────────────────────

function parseFlag(value: string | null): boolean | null {
  if (value === null || value === "") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return null;
}

interface QueueRow extends LabelColumns {
  shadeKey: string;
  shadeId: string;
  brand: string;
  name: string;
  finishes: string[] | null;
  legacyFinish: string | null;
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
  hexAgreement: number | null;
  detectedHexConfidence: number | null;
  detectedHexMethod: string | null;
  labeledRank: number;
  imageRank: number;
  agreementRank: string;
}

function toQueueItem(row: QueueRow, imageRows: ShadeImageRow[], requestUrl: string): HexLabelQueueItem {
  const finishes = row.finishes?.length ? row.finishes : row.legacyFinish ? [row.legacyFinish] : [];
  return {
    shadeId: row.shadeId,
    brand: row.brand,
    name: row.name,
    finishes,
    vendorHex: row.vendorHex,
    detectedHex: row.detectedHex,
    nameHex: row.nameHex,
    hexAgreement: row.hexAgreement,
    detectedHexConfidence: row.detectedHexConfidence,
    detectedHexMethod: row.detectedHexMethod,
    flagged: row.hexAgreement !== null && row.hexAgreement > MEDIUM_CONFIDENCE_MAX_DISTANCE,
    images: toLabelImages(imageRows, requestUrl),
    label: toHexLabel(row.shadeId, row),
  };
}

/**
 * GET /api/hex-labels-admin/queue (admin-only)
 *
 * Shades to label, one page at a time: unlabeled first, shades with catalog images first, then
 * worst vendor↔detected agreement first. Query: `brand` (substring), `disagreeOnly=true`
 * (`hex_agreement > 0.10`), `showLabeled=true`, `includeWithoutImages=true`, `cursor`
 * (from `nextCursor`), `pageSize` (default 20, max 100).
 */
export async function getHexLabelQueue(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const url = new URL(request.url);
    const search = url.searchParams;

    const flags: Record<string, boolean> = {};
    for (const name of ["disagreeOnly", "showLabeled", "includeWithoutImages"]) {
      const raw = search.get(name);
      const parsed = parseFlag(raw);
      if (raw !== null && raw !== "" && parsed === null) {
        return { status: 400, jsonBody: { error: `${name} must be true or false` } };
      }
      flags[name] = parsed ?? false;
    }

    let pageSize = HEX_LABEL_DEFAULT_PAGE_SIZE;
    const pageSizeRaw = search.get("pageSize");
    if (pageSizeRaw !== null && pageSizeRaw !== "") {
      const parsed = parseId(pageSizeRaw);
      if (parsed === null) return { status: 400, jsonBody: { error: "pageSize must be a positive integer" } };
      pageSize = Math.min(HEX_LABEL_MAX_PAGE_SIZE, parsed);
    }

    let cursor: HexLabelQueueCursor | null = null;
    const cursorRaw = search.get("cursor");
    if (cursorRaw) {
      cursor = decodeQueueCursor(cursorRaw);
      if (!cursor) return { status: 400, jsonBody: { error: "Invalid cursor" } };
    }

    const brand = search.get("brand")?.trim().slice(0, 200) || null;
    const queries = buildQueueQueries({
      brand,
      disagreeOnly: flags.disagreeOnly,
      showLabeled: flags.showLabeled,
      includeWithoutImages: flags.includeWithoutImages,
      cursor,
      limit: pageSize + 1,
    });

    const [countResult, pageResult] = await Promise.all([
      query<{ total: number; labeled: number }>(queries.count.sql, queries.count.params),
      query<QueueRow>(queries.page.sql, queries.page.params),
    ]);

    const rows = pageResult.rows.slice(0, pageSize);
    const hasMore = pageResult.rows.length > pageSize;

    const imageRows = rows.length
      ? (await query<ShadeImageRow>(SHADE_IMAGES_SQL, [rows.map((row) => row.shadeId)])).rows
      : [];
    const imagesByShade = groupImages(imageRows);

    const items: HexLabelQueueItem[] = rows.map((row) =>
      toQueueItem(row, imagesByShade.get(row.shadeId) ?? [], request.url)
    );

    const last = rows[rows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeQueueCursor({
            l: Number(last.labeledRank) === 1 ? 1 : 0,
            i: Number(last.imageRank) === 1 ? 1 : 0,
            a: String(last.agreementRank),
            s: String(last.shadeKey),
          })
        : null;

    const body: HexLabelQueueResponse = {
      items,
      nextCursor,
      total: Number(countResult.rows[0]?.total ?? 0),
      labeled: Number(countResult.rows[0]?.labeled ?? 0),
      pageSize,
      disagreementThreshold: MEDIUM_CONFIDENCE_MAX_DISTANCE,
    };
    return { status: 200, jsonBody: body };
  } catch (error) {
    return internalServerError(context, error, "Failed to load hex labeling queue", "hex-labels.queue");
  }
}

// ── GET /api/hex-labels-admin/shades/{shadeId} ──────────────────────────────

/**
 * One shade's labeling payload (same shape as a queue item), for the polish detail page (#351).
 * Mirrors the queue's scope: `user_submitted` shades are private to their creator and answer 404
 * like a missing shade; only catalog (`owner_type = 'source'`) images are returned.
 */
export async function getHexLabelShade(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const shadeId = parseId(request.params.shadeId);
  if (shadeId === null) return { status: 400, jsonBody: { error: "Invalid shade id" } };
  try {
    const result = await query<QueueRow>(
      `SELECT ${QUEUE_COLUMNS}
       ${QUEUE_FROM}
       WHERE s.shade_id = $1
         AND s.status <> 'user_submitted'`,
      [shadeId]
    );
    const row = result.rows[0];
    if (!row) return { status: 404, jsonBody: { error: "Shade not found" } };
    const imageRows = (await query<ShadeImageRow>(SHADE_IMAGES_SQL, [[row.shadeId]])).rows;
    const item = toQueueItem(row, groupImages(imageRows).get(row.shadeId) ?? [], request.url);
    return { status: 200, jsonBody: item };
  } catch (error) {
    return internalServerError(context, error, "Failed to load hex labeling shade", "hex-labels.shade");
  }
}

// ── POST /api/hex-labels-admin/labels ───────────────────────────────────────

const LABEL_RETURNING = `training_sample_id::text AS "labelId",
         hex AS "labelHex",
         training_status AS "labelStatus",
         image_id::text AS "labelImageId",
         notes AS "labelNote",
         label_meta AS "labelMeta",
         labeled_by_user_id::text AS "labelUserId",
         updated_at AS "labelAt"`;

/**
 * Create or replace the shade's manual label (one per shade, partial unique index
 * `idx_color_training_manual_shade`). `$1` shade_id … `$12` label_meta.
 */
export const UPSERT_MANUAL_LABEL_SQL = `INSERT INTO color_training_sample
         (shade_id, data_source_id, image_id, image_urls, hex, color_name, brand_name,
          source_type, training_status, notes, labeled_by_user_id, label_meta)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 'manual', $8, $9, $10, $11::jsonb)
       ON CONFLICT (shade_id) WHERE source_type = 'manual' AND shade_id IS NOT NULL
       DO UPDATE SET
         data_source_id = EXCLUDED.data_source_id,
         image_id = EXCLUDED.image_id,
         image_urls = EXCLUDED.image_urls,
         hex = EXCLUDED.hex,
         color_name = EXCLUDED.color_name,
         brand_name = EXCLUDED.brand_name,
         training_status = EXCLUDED.training_status,
         notes = EXCLUDED.notes,
         labeled_by_user_id = EXCLUDED.labeled_by_user_id,
         label_meta = EXCLUDED.label_meta,
         updated_at = now()
       RETURNING ${LABEL_RETURNING}`;

/** One `color_training_sample.image_urls` entry written by the labeler. */
export interface ManualLabelImageEntry {
  /** Public vendor URL (what the eval downloads); null when the source URL is unknown. */
  url: string | null;
  storage_path: string;
  image_id: string;
  swatch_type: string | null;
  /** The image the eval should score against: the sampled image (else the shade's primary). */
  is_primary: boolean;
}

/** `image_urls` for a manual label: the sampled image first and marked primary. Pure. */
export function buildManualLabelImageUrls(images: ShadeImageRow[], pickedImageId: number | null): ManualLabelImageEntry[] {
  const picked = pickedImageId !== null ? images.find((img) => Number(img.imageId) === pickedImageId) : undefined;
  const primary = picked ?? images[0];
  const ordered = primary ? [primary, ...images.filter((img) => img !== primary)] : [];
  return ordered.map((img) => ({
    url: img.sourceUrl && /^https?:\/\//i.test(img.sourceUrl) ? img.sourceUrl : null,
    storage_path: img.storageUrl,
    image_id: img.imageId,
    swatch_type: img.swatchType,
    is_primary: img === primary,
  }));
}

export async function saveHexLabel(
  request: HttpRequest,
  context: InvocationContext,
  adminUserId: number
): Promise<HttpResponseInit> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }
  const parsed = parseHexLabelRequest(body);
  if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };
  const input = parsed.value;

  try {
    const shadeResult = await query<{ shadeId: string; brand: string; name: string }>(
      `SELECT s.shade_id::text AS "shadeId",
              COALESCE(b.name_canonical, '') AS brand,
              COALESCE(s.shade_name_canonical, '') AS name
       FROM shade s
       JOIN brand b ON b.brand_id = s.brand_id
       WHERE s.shade_id = $1`,
      [input.shadeId]
    );
    const shade = shadeResult.rows[0];
    if (!shade) return { status: 404, jsonBody: { error: "Shade not found" } };

    const images = (await query<ShadeImageRow>(SHADE_IMAGES_SQL, [[String(input.shadeId)]])).rows;
    const uniqueImages = groupImages(images).get(String(input.shadeId)) ?? [];
    if (input.imageId !== null && !uniqueImages.some((img) => Number(img.imageId) === input.imageId)) {
      return { status: 400, jsonBody: { error: "imageId is not one of this shade's catalog images" } };
    }

    const imageUrls = buildManualLabelImageUrls(uniqueImages, input.imageId);
    const primary = imageUrls.find((entry) => entry.is_primary);
    const primaryRow = uniqueImages.find((img) => img.imageId === primary?.image_id);
    const dataSourceId = primaryRow?.dataSourceId ? parseId(primaryRow.dataSourceId) : null;
    const method: HexLabelSampleMethod | null = input.method ?? (input.samplePoint ? "canvas" : input.hex ? "manual" : null);
    const labelMeta = { method, samplePoint: input.samplePoint };

    const result = await transaction(async (client) => {
      const previousResult = await client.query<LabelColumns>(
        `SELECT ${LABEL_RETURNING}
         FROM color_training_sample
         WHERE shade_id = $1
           AND source_type = 'manual'
         FOR UPDATE`,
        [input.shadeId]
      );
      const saved = await client.query<LabelColumns>(UPSERT_MANUAL_LABEL_SQL, [
        input.shadeId,
        dataSourceId,
        input.imageId,
        JSON.stringify(imageUrls),
        input.hex,
        shade.name,
        shade.brand,
        input.unreliable ? "rejected" : "approved",
        input.note,
        adminUserId,
        JSON.stringify(labelMeta),
      ]);
      return { previous: previousResult.rows[0] ?? null, saved: saved.rows[0] };
    });

    const label = toHexLabel(shade.shadeId, result.saved);
    if (!label) throw new Error("Upsert returned no row");
    const previous = result.previous ? toHexLabel(shade.shadeId, result.previous) : null;

    trackEvent("hex_label.saved", {
      shadeId: shade.shadeId,
      adminUserId,
      method: method ?? "none",
      unreliable: input.unreliable,
      replaced: previous !== null,
      hasPublicImageUrl: Boolean(primary?.url),
    });

    const responseBody: HexLabelSaveResponse = { label, previous };
    return { status: previous ? 200 : 201, jsonBody: responseBody };
  } catch (error) {
    return internalServerError(context, error, "Failed to save hex label", "hex-labels.save");
  }
}

// ── DELETE /api/hex-labels-admin/labels/{id} ────────────────────────────────

export async function deleteHexLabel(
  request: HttpRequest,
  context: InvocationContext,
  adminUserId: number
): Promise<HttpResponseInit> {
  const id = parseId(request.params.id);
  if (id === null) return { status: 400, jsonBody: { error: "Invalid label id" } };
  try {
    // Only manual labels: vendor_option / ai_detected samples are never deletable here.
    const result = await query<{ id: string }>(
      `DELETE FROM color_training_sample
       WHERE training_sample_id = $1
         AND source_type = 'manual'
       RETURNING training_sample_id::text AS id`,
      [id]
    );
    if (result.rows.length === 0) return { status: 404, jsonBody: { error: "Label not found" } };
    trackEvent("hex_label.deleted", { trainingSampleId: id, adminUserId });
    const responseBody: HexLabelDeleteResponse = { deleted: result.rows[0].id };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    return internalServerError(context, error, "Failed to delete hex label", "hex-labels.delete");
  }
}

app.http("admin-hex-labels-queue", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "hex-labels-admin/queue",
  handler: withCors(withAdmin(async (request, context) => getHexLabelQueue(request, context))),
});

app.http("admin-hex-labels-shade", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "hex-labels-admin/shades/{shadeId}",
  handler: withCors(withAdmin(async (request, context) => getHexLabelShade(request, context))),
});

app.http("admin-hex-labels-save", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "hex-labels-admin/labels",
  handler: withCors(withAdmin(saveHexLabel)),
});

app.http("admin-hex-labels-item", {
  methods: ["DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "hex-labels-admin/labels/{id}",
  handler: withCors(withAdmin(deleteHexLabel)),
});
