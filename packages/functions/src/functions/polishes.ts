import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  Polish,
  PolishCreateRequest,
  PolishUpdateRequest,
  PolishListResponse,
  PolishImageMatchResponse,
  MEDIUM_CONFIDENCE_MAX_DISTANCE,
  resolveDisplayHexDetailed,
  type HexReviewItem,
  type HexReviewResponse,
  type HexReviewSort,
  type PolishStatus,
} from "swatchwatch-shared";
import { query, transaction } from "../lib/db";
import { withAuth, withAdmin } from "../lib/auth";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { ImageProxyScopeError, toImageProxyUrl } from "../lib/image-proxy";
import { detectHexWithAzureOpenAI } from "../lib/ai-color-detection";
import {
  DETECTED_HEX_METHOD_CLIENT_SUPPLIED,
  provenanceFromDetection,
} from "../lib/hex-provenance";
import { isCatalogStorageUrl, isUserMediaStorageUrl, readBlobFromStorageUrl } from "../lib/blob-storage";
import {
  cacheDelete,
  cacheDeleteByPrefix,
  cacheGetJson,
  cacheSetJson,
  hashCacheKey,
} from "../lib/cache";
import { trackEvent, trackException } from "../lib/telemetry";
import { deleteNailPhotoBlobs, detachNailPhotosForShade } from "../lib/nail-photos";
import { invalidatePolishCachesForUser } from "../lib/polish-cache";
import { recomputeWearStats } from "../lib/manicure";
import {
  extractImagePalette,
  MatchImageInputError,
  parseMatchImageRequest,
  rankPolishMatches,
} from "../lib/color-match";
import {
  canonicalizeFinish,
  canonicalizeFinishes,
  loadFinishCatalog,
  requestCarriesFinishData,
  resolveRequestedFinishes,
  type ShadeFinishUpdate,
} from "../lib/finishes";
import { withBuyUrls } from "../lib/buy-link";
import { parseColorFamilyFilter } from "../lib/color-family-filter";
import {
  InventoryValidationError,
  defaultStatusForNewItem,
  parseBooleanFlag,
  parseInventoryFields,
  parseStatusFilter,
  providedInventoryFields,
  type InventoryFieldsUpdate,
} from "../lib/inventory";
import { PoolClient } from "pg";

const FINISH_NORMALIZATION_MAP: Record<string, string> = {
  cream: "creme",
};

function normalizeFinish(value?: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return FINISH_NORMALIZATION_MAP[normalized] || normalized || null;
}

/** Legacy single finish to store/match on `shade.finish` for a request. */
function primaryFinishForRequest(
  body: Pick<PolishCreateRequest, "finish">,
  finishUpdate: ShadeFinishUpdate | undefined
): string | undefined {
  return body.finish || finishUpdate?.values[0] || undefined;
}

/**
 * Apply a requested finish change to a shade.
 *
 * Shades are shared catalog rows, so (mirroring the color rule) user input may only FILL an
 * EMPTY `shade.finishes`; it never replaces, removes or appends to a non-empty array.
 * The only exception is the caller's own `user_submitted` shade (`ownSubmitted`), which is
 * private to them until approved and can be edited freely. `shade.finish` (the legacy single
 * field and part of the dedup key) is never written here.
 */
async function applyShadeFinishUpdate(
  client: PoolClient,
  shadeId: number,
  finishUpdate: ShadeFinishUpdate | undefined,
  ownSubmitted: boolean
): Promise<void> {
  if (!finishUpdate) return;

  if (!ownSubmitted) {
    if (finishUpdate.values.length === 0) return;
    // Fill-only: the guard is part of the statement so a concurrent write cannot be clobbered.
    await client.query(
      `UPDATE shade SET finishes = $2::text[], updated_at = now()
       WHERE shade_id = $1 AND cardinality(COALESCE(finishes, ARRAY[]::text[])) = 0`,
      [shadeId, finishUpdate.values]
    );
    return;
  }

  if (finishUpdate.mode === "replace") {
    await client.query(
      `UPDATE shade SET finishes = $2::text[], updated_at = now() WHERE shade_id = $1`,
      [shadeId, finishUpdate.values]
    );
    return;
  }
  if (finishUpdate.values.length === 0) return;
  // Append new finishes, keeping existing order (primary first) and de-duplicating.
  await client.query(
    `UPDATE shade
     SET finishes = ARRAY(
           SELECT f
           FROM unnest(COALESCE(finishes, ARRAY[]::text[]) || $2::text[]) WITH ORDINALITY AS u(f, ord)
           GROUP BY f
           ORDER BY min(ord)
         ),
         updated_at = now()
     WHERE shade_id = $1`,
    [shadeId, finishUpdate.values]
  );
}

/**
 * Visibility of a shade to a user (alias `s` = shade, `ui` = the caller's inventory join,
 * `$1` = caller id as in POLISH_SELECT). Shades created through the user API start as
 * `user_submitted` and stay private to their creator (and anyone holding them in inventory)
 * until an admin promotes them to `active`. A submission an admin merged into another shade
 * (`merged_into_shade_id`, admin review queue) is retired and visible to nobody.
 */
const POLISH_VISIBLE_SQL = `(s.merged_into_shade_id IS NULL AND (s.status <> 'user_submitted' OR s.created_by_user_id = $1 OR ui.inventory_item_id IS NOT NULL))`;

/**
 * Look up a shade by id if the caller may see it. Returns null when it is missing, another
 * user's private `user_submitted` shade, or retired by an admin merge (callers answer 404 for
 * all of them, so existence never leaks).
 */
async function getVisibleShade(
  shadeId: number,
  userId: number
): Promise<{ ownSubmitted: boolean; brand: string | null; shadeName: string | null } | null> {
  const result = await query<{ ownSubmitted: boolean; brand: string | null; shadeName: string | null }>(
    `SELECT (s.status = 'user_submitted' AND s.created_by_user_id = $2) AS "ownSubmitted",
            b.name_canonical AS brand,
            s.shade_name_canonical AS "shadeName"
     FROM shade s
     LEFT JOIN brand b ON b.brand_id = s.brand_id
     WHERE s.shade_id = $1
       AND s.merged_into_shade_id IS NULL
       AND (
         s.status <> 'user_submitted'
         OR s.created_by_user_id = $2
         OR EXISTS (SELECT 1 FROM user_inventory_item ui WHERE ui.shade_id = s.shade_id AND ui.user_id = $2)
       )
     LIMIT 1`,
    [shadeId, userId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { ownSubmitted: Boolean(row.ownSubmitted), brand: row.brand ?? null, shadeName: row.shadeName ?? null };
}

/**
 * Write color data to a shade. Shared catalog shades are fill-only: user input only fills NULL
 * columns and never overwrites values other users see. The caller's own private submission
 * takes explicit corrections ($6 = true lets provided values replace stored ones).
 */
async function applyShadeColorUpdate(
  client: PoolClient,
  shadeId: number,
  colorData: { colorName?: string | null; vendorHex?: string | null; detectedHex?: string | null; nameHex?: string | null },
  ownSubmitted: boolean
): Promise<void> {
  await client.query(
    `UPDATE shade SET
       color_name   = CASE WHEN $6 THEN COALESCE($2, color_name)   ELSE COALESCE(color_name, $2)   END,
       vendor_hex   = CASE WHEN $6 THEN COALESCE($3, vendor_hex)   ELSE COALESCE(vendor_hex, $3)   END,
       detected_hex = CASE WHEN $6 THEN COALESCE($4, detected_hex) ELSE COALESCE(detected_hex, $4) END,
       name_hex     = CASE WHEN $6 THEN COALESCE($5, name_hex)     ELSE COALESCE(name_hex, $5)     END,
       -- When this request changes detected_hex (filling an empty value, or an owner
       -- correction), record it as client-supplied and clear the AI provenance that no
       -- longer describes it; hex_agreement is a generated column.
       detected_hex_method = CASE
         WHEN $4 IS NOT NULL AND (detected_hex IS NULL OR ($6 AND detected_hex IS DISTINCT FROM $4)) THEN $7
         ELSE detected_hex_method END,
       detected_hex_confidence = CASE
         WHEN $4 IS NOT NULL AND (detected_hex IS NULL OR ($6 AND detected_hex IS DISTINCT FROM $4)) THEN NULL
         ELSE detected_hex_confidence END,
       detected_hex_model = CASE
         WHEN $4 IS NOT NULL AND (detected_hex IS NULL OR ($6 AND detected_hex IS DISTINCT FROM $4)) THEN NULL
         ELSE detected_hex_model END,
       detected_hex_prompt_version = CASE
         WHEN $4 IS NOT NULL AND (detected_hex IS NULL OR ($6 AND detected_hex IS DISTINCT FROM $4)) THEN NULL
         ELSE detected_hex_prompt_version END,
       detected_hex_at = CASE
         WHEN $4 IS NOT NULL AND (detected_hex IS NULL OR ($6 AND detected_hex IS DISTINCT FROM $4)) THEN now()
         ELSE detected_hex_at END,
       updated_at   = now()
     WHERE shade_id = $1`,
    [
      shadeId,
      colorData.colorName || null,
      colorData.vendorHex || null,
      colorData.detectedHex || null,
      colorData.nameHex || null,
      ownSubmitted,
      DETECTED_HEX_METHOD_CLIENT_SUPPLIED,
    ]
  );
}

/**
 * Shared SELECT fragment — returns global shade data plus the requesting user's inventory fields.
 * `$1` is always the requesting user id so list/detail queries can join consistently.
 */
const POLISH_COLUMNS = `
    s.shade_id::text                             AS id,
    s.shade_id::text                             AS "shadeId",
    ui.inventory_item_id::text                   AS "inventoryItemId",
    $1::text                                     AS "userId",
    COALESCE(b.name_canonical, '')               AS brand,
    COALESCE(s.shade_name_canonical, '')         AS name,
    COALESCE(s.color_name, '')                   AS color,
    s.vendor_hex                                 AS "vendorHex",
    s.detected_hex                               AS "detectedHex",
    s.name_hex                                   AS "nameHex",
    -- detected_hex provenance (migration 20261017024958000_shade-detected-hex-provenance). NUMERIC columns are cast so node-postgres
    -- returns numbers instead of strings.
    s.detected_hex_confidence::float8            AS "detectedHexConfidence",
    s.detected_hex_method                        AS "detectedHexMethod",
    s.detected_hex_model                         AS "detectedHexModel",
    s.detected_hex_prompt_version                AS "detectedHexPromptVersion",
    s.detected_hex_at                            AS "detectedHexAt",
    s.hex_agreement::float8                      AS "hexAgreement",
    s.color_family                               AS "colorFamily",
    -- Legacy single finish; falls back to the primary multi-finish value when unset.
    COALESCE(NULLIF(s.finish, ''), s.finishes[1], '') AS finish,
    COALESCE(s.finishes, ARRAY[]::text[])        AS finishes,
    COALESCE(s.collection, '')                   AS collection,
    ui.quantity,
    -- Inventory status model (migration 20261017061336791_inventory-status). NULL status means
    -- the caller has no inventory row (plain catalog entry); "untried" is derived, not stored.
    ui.status,
    COALESCE(ui.status = 'owned' AND ui.tried_at IS NULL, false) AS "isUntried",
    ui.tried_at                                  AS "triedAt",
    ui.last_worn_at                              AS "lastWornAt",
    ui.wear_count                                AS "wearCount",
    ui.purchase_price::float8                    AS "purchasePrice",
    ui.purchase_currency                         AS "purchaseCurrency",
    ui.size_display                              AS size,
    ui.rating,
    ui.notes,
    swatch_img.storage_url                       AS "swatchImageUrl",
    ui.tags,
    ui.purchase_date                             AS "purchaseDate",
    ui.expiration_date                           AS "expirationDate",
    COALESCE(ui.created_at, s.created_at)        AS "createdAt",
    COALESCE(ui.updated_at, s.updated_at)        AS "updatedAt"`;

const POLISH_FROM = `
  FROM shade s
  JOIN brand b ON s.brand_id = b.brand_id
  LEFT JOIN user_inventory_item ui
    ON ui.shade_id = s.shade_id
   AND ui.user_id = $1
  LEFT JOIN LATERAL (
    SELECT ia.storage_url
    FROM swatch sw
    JOIN image_asset ia ON ia.image_id = sw.image_id_original
    WHERE sw.shade_id = s.shade_id
    ORDER BY COALESCE(sw.swatch_type = 'source_product', false) DESC, sw.swatch_id DESC
    LIMIT 1
  ) AS swatch_img ON true`;

const POLISH_SELECT = `
  SELECT
${POLISH_COLUMNS}
${POLISH_FROM}`;

/**
 * List variant of POLISH_SELECT: carries the filtered total as a window column so a page
 * and its total come from one scan instead of a separate COUNT(*) query per page.
 */
const POLISH_LIST_SELECT = `
  SELECT
${POLISH_COLUMNS},
    COUNT(*) OVER()                              AS "totalCount"
${POLISH_FROM}`;

/**
 * Find or create a brand + shade, returning the shade_id.
 * Uses a transaction client so this can be part of a larger transaction.
 */
async function findOrCreateShade(
  client: PoolClient,
  userId: number,
  brandName: string,
  shadeName: string,
  finish?: string,
  collection?: string,
  colorData?: { colorName?: string; vendorHex?: string; detectedHex?: string; nameHex?: string },
  finishUpdate?: ShadeFinishUpdate
): Promise<number> {
  // Find or create brand
  await client.query(
    `INSERT INTO brand (name_canonical) VALUES ($1) ON CONFLICT (name_canonical) DO NOTHING`,
    [brandName]
  );
  const brandResult = await client.query<{ brand_id: number }>(
    `SELECT brand_id FROM brand WHERE name_canonical = $1`,
    [brandName]
  );
  const brandId = brandResult.rows[0].brand_id;

  // Find an existing shade the caller can see (match on brand + name + finish, with NULL-safe
  // finish comparison). Another user's private `user_submitted` shade is never matched: the
  // caller must not be linked to (or learn about) it. idx_shade_unique includes product_line_id
  // (NULL here, and NULLs are distinct in a unique index), so the caller can still get their own
  // row with the same brand + name + finish. Catalog rows are preferred over private ones.
  // A submission an admin merged into a catalog shade (review queue) resolves to its merge target.
  const existingShade = await client.query<{ shade_id: number; own_submitted: boolean; merged_into_shade_id: number | null }>(
    `SELECT s.shade_id,
            (s.status = 'user_submitted' AND s.created_by_user_id = $4 AND s.merged_into_shade_id IS NULL) AS own_submitted,
            s.merged_into_shade_id
     FROM shade s
     WHERE s.brand_id = $1
       AND s.shade_name_canonical = $2
       AND s.product_line_id IS NULL
       AND COALESCE(s.finish, '') = COALESCE($3, '')
       AND (
         s.status <> 'user_submitted'
         OR s.created_by_user_id = $4
         OR EXISTS (SELECT 1 FROM user_inventory_item ui WHERE ui.shade_id = s.shade_id AND ui.user_id = $4)
       )
     ORDER BY (s.status = 'user_submitted') ASC, (s.merged_into_shade_id IS NOT NULL) ASC, s.shade_id ASC
     LIMIT 1`,
    [brandId, shadeName, normalizeFinish(finish), userId]
  );

  if (existingShade.rows.length > 0) {
    const shadeId = existingShade.rows[0].merged_into_shade_id ?? existingShade.rows[0].shade_id;
    const ownSubmitted = Boolean(existingShade.rows[0].own_submitted);
    if (colorData) {
      await applyShadeColorUpdate(client, shadeId, colorData, ownSubmitted);
    }
    await applyShadeFinishUpdate(client, shadeId, finishUpdate, ownSubmitted);
    return shadeId;
  }

  // Create a new shade owned by the caller. It stays private ('user_submitted') until an admin
  // promotes it to 'active'.
  const newShade = await client.query<{ shade_id: number }>(
    `INSERT INTO shade (brand_id, shade_name_canonical, finish, collection, status, created_by_user_id, color_name, vendor_hex, detected_hex, name_hex, finishes,
                        detected_hex_method, detected_hex_at)
     VALUES ($1, $2, $3, $4, 'user_submitted', $5, $6, $7, $8, $9, $10::text[],
             -- A request-supplied detected hex is recorded as client-supplied (constant, not user input).
             CASE WHEN $8::text IS NOT NULL THEN '${DETECTED_HEX_METHOD_CLIENT_SUPPLIED}' END,
             CASE WHEN $8::text IS NOT NULL THEN now() END)
     RETURNING shade_id`,
    [
      brandId, shadeName, normalizeFinish(finish), collection || null, userId,
      colorData?.colorName || null, colorData?.vendorHex || null,
      colorData?.detectedHex || null, colorData?.nameHex || null,
      finishUpdate?.values ?? [],
    ]
  );
  return newShade.rows[0].shade_id;
}

/**
 * Insert or update the caller's inventory row for a shade (keyed on `(user_id, shade_id)`, so
 * it can only ever touch the caller's own row).
 *
 * Omitted fields keep their stored value. On a NEW row an omitted `status` defaults from the
 * quantity (`defaultStatusForNewItem`) and an omitted `quantity` from the status (one bottle
 * when owned/destash, else none), so clients that predate the status model behave as before.
 * The clearable fields (`triedAt`, `purchasePrice`, `purchaseCurrency`) are written whenever
 * they are present in the request, including `null`;
 * `$14` lists which ones were sent. `$15` is the status a new row gets. Returns the
 * inventory item id.
 */
async function upsertInventoryItem(
  client: PoolClient,
  userId: number,
  shadeId: number,
  body: PolishUpdateRequest,
  fields: InventoryFieldsUpdate
): Promise<string | undefined> {
  const quantity = body.quantity ?? null;
  const insertStatus = fields.status ?? defaultStatusForNewItem(quantity === null ? null : Number(quantity));
  const result = await client.query<{ inventoryItemId: string }>(
    `INSERT INTO user_inventory_item
       (user_id, shade_id, quantity, notes, purchase_date, expiration_date,
        rating, tags, size_display, status, tried_at, purchase_price, purchase_currency)
     VALUES ($1, $2, COALESCE($3::int, CASE WHEN $15::text IN ('owned', 'destash') THEN 1 ELSE 0 END),
             $4, $5, $6, $7, $8, $9,
             $15::text, $11::timestamptz, $12::numeric, $13::text)
     ON CONFLICT (user_id, shade_id) DO UPDATE SET
       quantity          = CASE WHEN $3::int IS NULL THEN user_inventory_item.quantity ELSE EXCLUDED.quantity END,
       notes             = CASE WHEN $4 IS NULL THEN user_inventory_item.notes ELSE EXCLUDED.notes END,
       purchase_date     = CASE WHEN $5 IS NULL THEN user_inventory_item.purchase_date ELSE EXCLUDED.purchase_date END,
       expiration_date   = CASE WHEN $6 IS NULL THEN user_inventory_item.expiration_date ELSE EXCLUDED.expiration_date END,
       rating            = CASE WHEN $7 IS NULL THEN user_inventory_item.rating ELSE EXCLUDED.rating END,
       tags              = CASE WHEN $8 IS NULL THEN user_inventory_item.tags ELSE EXCLUDED.tags END,
       size_display      = CASE WHEN $9 IS NULL THEN user_inventory_item.size_display ELSE EXCLUDED.size_display END,
       status            = CASE WHEN $10::text IS NULL THEN user_inventory_item.status ELSE EXCLUDED.status END,
       tried_at          = CASE WHEN 'triedAt' = ANY($14::text[]) THEN EXCLUDED.tried_at ELSE user_inventory_item.tried_at END,
       purchase_price    = CASE WHEN 'purchasePrice' = ANY($14::text[]) THEN EXCLUDED.purchase_price ELSE user_inventory_item.purchase_price END,
       purchase_currency = CASE WHEN 'purchaseCurrency' = ANY($14::text[]) THEN EXCLUDED.purchase_currency ELSE user_inventory_item.purchase_currency END,
       updated_at        = now()
     RETURNING inventory_item_id::text AS "inventoryItemId"`,
    [
      userId,
      shadeId,
      quantity,
      body.notes ?? null,
      body.purchaseDate ?? null,
      body.expirationDate ?? null,
      body.rating ?? null,
      body.tags && body.tags.length ? body.tags : null,
      body.size ?? null,
      fields.status ?? null,
      fields.triedAt ?? null,
      fields.purchasePrice ?? null,
      fields.purchaseCurrency ?? null,
      providedInventoryFields(fields),
      insertStatus,
    ]
  );
  return result.rows[0]?.inventoryItemId;
}

/** Whitelist of allowed sort columns to prevent SQL injection */
const SORT_COLUMNS: Record<string, string> = {
  // Owned first, then wishlist, destash, archived; catalog rows without inventory last.
  status:
    "CASE ui.status WHEN 'owned' THEN 0 WHEN 'wishlist' THEN 1 WHEN 'destash' THEN 2 WHEN 'archived' THEN 3 ELSE 4 END",
  name: "s.shade_name_canonical",
  brand: "b.name_canonical",
  finish: "COALESCE(s.finishes[1], NULLIF(s.finish, ''), '')",
  collection: "COALESCE(s.collection, '')",
  createdAt: "COALESCE(ui.created_at, s.created_at)",
  rating: "ui.rating",
};

const POLISH_LIST_CACHE_TTL_SECONDS = 45;
const POLISH_DETAIL_CACHE_TTL_SECONDS = 90;

function getRequestOrigin(requestUrl: string): string {
  try {
    return new URL(requestUrl).origin.toLowerCase();
  } catch {
    return "unknown";
  }
}

function normalizeFilterValue(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function parseTagsFilter(tagsParam?: string | null): string[] {
  if (!tagsParam) {
    return [];
  }
  return tagsParam
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag): tag is string => tag.length > 0);
}

function canonicalizeTagsForCache(tags: string[]): string {
  if (tags.length === 0) {
    return "";
  }
  return Array.from(new Set(tags))
    .sort((a, b) => a.localeCompare(b))
    .join(",");
}

function buildPolishDetailCacheKey(userId: number, shadeId: number, requestOrigin: string): string {
  const originHash = hashCacheKey(requestOrigin.toLowerCase());
  return `polishes:detail:u:${userId}:id:${shadeId}:o:${originHash}`;
}

function buildPolishListCacheKey(
  userId: number,
  requestOrigin: string,
  payload: {
    search: string;
    brand: string;
    finish: string;
    finishes: string;
    scope: string;
    availability: string;
    status: string;
    untried: boolean;
    tags: string;
    family?: string;
    sortBy: string;
    sortOrder: "ASC" | "DESC";
    page: number;
    pageSize: number;
  }
): string {
  const originHash = hashCacheKey(requestOrigin.toLowerCase());
  const hash = hashCacheKey(JSON.stringify(payload));
  return `polishes:list:u:${userId}:o:${originHash}:h:${hash}`;
}

async function invalidateGlobalPolishCaches(): Promise<void> {
  await Promise.all([
    cacheDeleteByPrefix("polishes:list:u:"),
    cacheDeleteByPrefix("polishes:detail:u:"),
  ]);
}

async function invalidateCatalogCaches(shadeIds: number[] = []): Promise<void> {
  await Promise.all([
    cacheDeleteByPrefix("catalog:search:"),
    ...shadeIds.map((shadeId) => cacheDelete(`catalog:shade:id:${shadeId}`)),
  ]);
}

function withReadableSwatchUrl<T extends { swatchImageUrl?: string | null; sourceImageUrls?: string[] }>(
  row: T,
  requestUrl: string
): T {
  const normalizedRow = withNormalizedFinish(row as T & { finish?: string | null });
  const swatchUrl = row.swatchImageUrl?.trim();
  if (!swatchUrl) {
    return normalizedRow as T;
  }

  const readableSourceImageUrls = Array.isArray(normalizedRow.sourceImageUrls)
    ? normalizedRow.sourceImageUrls
        .map((url) => withReadableImageUrl(url, requestUrl))
        .filter((url): url is string => Boolean(url))
    : normalizedRow.sourceImageUrls;

  return {
    ...(normalizedRow as T),
    swatchImageUrl: withReadableImageUrl(swatchUrl, requestUrl),
    sourceImageUrls: readableSourceImageUrls,
  };
}

function mapReadableSwatchUrls<T extends { swatchImageUrl?: string | null; sourceImageUrls?: string[] }>(
  rows: T[],
  requestUrl: string
): T[] {
  return rows.map((row) => withReadableSwatchUrl(row, requestUrl));
}

function withNormalizedFinish<T extends { finish?: string | null }>(row: T): T {
  if (typeof row.finish === "undefined") return row;
  const normalized = normalizeFinish(row.finish);
  if (!normalized || normalized === row.finish) return row;
  return { ...row, finish: normalized };
}

const BLOB_HOST_PATTERN = /^https?:\/\/[^/]*\.blob\./i;

function isStorageUrlProxied(url: string): boolean {
  if (BLOB_HOST_PATTERN.test(url)) {
    return true;
  }

  try {
    const parsed = new URL(url);
    if (!parsed.hostname) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if ((host === "127.0.0.1" || host === "localhost") && parsed.port === "10000") {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Rewrite blob URLs to signed `/api/images/{id}` capability URLs.
 *
 * - Catalog blobs (`SOURCE_IMAGE_CONTAINER`) get public `v2` ids; `ownerUserId` is ignored.
 * - A blob in the user-media container (`USER_MEDIA_CONTAINER`) gets an owner-scoped `v3` id only
 *   when `ownerUserId` is given, i.e. when the caller has verified the image_asset row belongs to
 *   the requesting user (#227). Without an owner it is omitted (null): that is the expected
 *   outcome for another user's media, so it is not logged as an error.
 * - Any other blob is omitted (null): the proxy would refuse to read it under either scope, so
 *   minting an id would only produce a dead link.
 *
 * Fails closed: if a URL cannot be signed (e.g. IMAGE_PROXY_SIGNING_KEY missing), the image is
 * omitted (null) rather than leaking the raw storage URL or failing the whole response.
 */
function withReadableImageUrl(
  imageUrl: string,
  requestUrl: string,
  options: { ownerUserId?: number } = {}
): string | null {
  const normalized = imageUrl.trim();
  if (!normalized) {
    return normalized;
  }
  if (!isStorageUrlProxied(normalized)) {
    return normalized;
  }
  try {
    if (
      options.ownerUserId !== undefined &&
      !isCatalogStorageUrl(normalized) &&
      !isUserMediaStorageUrl(normalized)
    ) {
      return null;
    }
    return toImageProxyUrl(
      requestUrl,
      normalized,
      options.ownerUserId !== undefined ? { ownerUserId: options.ownerUserId } : undefined
    );
  } catch (error) {
    if (error instanceof ImageProxyScopeError) {
      // Non-catalog media the caller does not own: omit it silently.
      return null;
    }
    console.error(
      `[polishes] Omitting image: failed to build signed image proxy URL (${
        error instanceof Error ? error.message : String(error)
      })`
    );
    return null;
  }
}

async function getPolishes(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  context.log("GET /api/polishes");

  const id = request.params.id;
  const requestOrigin = getRequestOrigin(request.url);

  // Single polish by shade id
  if (id) {
    try {
      const shadeId = parseInt(id, 10);
      if (Number.isNaN(shadeId) || shadeId <= 0) {
        return { status: 400, jsonBody: { error: "Invalid polish id" } };
      }
      const detailCacheKey = buildPolishDetailCacheKey(userId, shadeId, requestOrigin);
      const cachedPolish = await cacheGetJson<Record<string, unknown>>(detailCacheKey);
      if (cachedPolish) {
        return { status: 200, jsonBody: cachedPolish };
      }

      const result = await query<Polish>(
        `${POLISH_SELECT}
         WHERE s.shade_id = $2
           AND ${POLISH_VISIBLE_SQL}`,
        [userId, shadeId]
      );

      if (result.rows.length === 0) {
        return { status: 404, jsonBody: { error: "Polish not found" } };
      }

      const imagesResult = await query<{
        storageUrl: string;
        ownerType: string | null;
        ownerId: string | number | null;
      }>(
        `SELECT ia.storage_url AS "storageUrl", ia.owner_type AS "ownerType", ia.owner_id AS "ownerId"
         FROM swatch sw
         JOIN image_asset ia ON ia.image_id = sw.image_id_original
         WHERE sw.shade_id = $1
         ORDER BY COALESCE(sw.swatch_type = 'source_product', false) DESC, sw.swatch_id DESC`,
        [shadeId]
      );

      const sourceImageUrls = Array.from(
        new Set(
          imagesResult.rows
            .filter((r) => typeof r.storageUrl === "string" && r.storageUrl.trim().length > 0)
            .map((r) =>
              // Private media is minted owner-scoped only for image_asset rows the caller owns.
              withReadableImageUrl(r.storageUrl, request.url, {
                ownerUserId:
                  r.ownerType === "user" && Number(r.ownerId) === Number(userId) ? Number(userId) : undefined,
              })
            )
            .filter((url): url is string => Boolean(url))
        )
      );

      // "Buy from brand" link (#267): validated stored product URL, absent when none.
      const [polishWithBuyUrl] = await withBuyUrls([result.rows[0]], (row) => row.id);
      const responseBody = withReadableSwatchUrl(
        {
          ...polishWithBuyUrl,
          sourceImageUrls: sourceImageUrls.length > 0 ? sourceImageUrls : undefined,
        },
        request.url
      );

      await cacheSetJson(detailCacheKey, responseBody, POLISH_DETAIL_CACHE_TTL_SECONDS);

      return {
        status: 200,
        jsonBody: responseBody,
      };
    } catch (error: any) {
      return internalServerError(context, error, "Failed to fetch polish", "polishes.get");
    }
  }

  // Collection list
  try {
    const url = new URL(request.url);

    const search = url.searchParams.get("search");
    const brandFilter = url.searchParams.get("brand");
    const finishFilter = url.searchParams.get("finish");
    const finishesParam = url.searchParams.get("finishes");
    const scope = url.searchParams.get("scope");
    const availability = url.searchParams.get("availability") || url.searchParams.get("avail");
    let statusFilter: PolishStatus[];
    let untriedOnly: boolean;
    try {
      statusFilter = parseStatusFilter(url.searchParams.get("status"));
      untriedOnly = parseBooleanFlag("untried", url.searchParams.get("untried"));
    } catch (error) {
      if (error instanceof InventoryValidationError) {
        return { status: 400, jsonBody: { error: error.message } };
      }
      throw error;
    }
    const tagsParam = url.searchParams.get("tags");
    const sortBy = url.searchParams.get("sortBy")?.trim() || "createdAt";
    const sortOrder = url.searchParams.get("sortOrder")?.toUpperCase() === "ASC" ? "ASC" : "DESC";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(250, Math.max(1, parseInt(url.searchParams.get("pageSize") || "50", 10)));
    const offset = (page - 1) * pageSize;
    const normalizedSearch = normalizeFilterValue(search);
    const normalizedBrandFilter = normalizeFilterValue(brandFilter);
    const normalizedFinishFilter = normalizeFinish(finishFilter) ?? "";
    const parsedFinishesFilter = parseTagsFilter(finishesParam).map((value) => value.toLowerCase());
    const normalizedScope = normalizeFilterValue(scope);
    const normalizedAvailability = normalizeFilterValue(availability);
    const parsedTags = parseTagsFilter(tagsParam);
    const familyFilter = parseColorFamilyFilter(url.searchParams);
    if (!familyFilter.ok) {
      return { status: 400, jsonBody: { error: familyFilter.error } };
    }
    const listCacheKey = buildPolishListCacheKey(userId, requestOrigin, {
      search: normalizedSearch,
      brand: normalizedBrandFilter,
      finish: normalizedFinishFilter,
      finishes: canonicalizeTagsForCache(parsedFinishesFilter),
      scope: normalizedScope,
      availability: normalizedAvailability,
      status: statusFilter.join(","),
      untried: untriedOnly,
      tags: canonicalizeTagsForCache(parsedTags),
      // Only present when filtering so existing cache keys are unchanged.
      ...(familyFilter.families.length > 0 ? { family: familyFilter.families.join(",") } : {}),
      sortBy,
      sortOrder,
      page,
      pageSize,
    });
    const cachedList = await cacheGetJson<PolishListResponse>(listCacheKey);
    if (cachedList) {
      return {
        status: 200,
        jsonBody: cachedList,
      };
    }

    const conditions: string[] = [POLISH_VISIBLE_SQL];
    const params: Array<number | string | string[]> = [userId];
    let paramIndex = 2;

    if (normalizedSearch) {
      conditions.push(
        `(b.name_canonical ILIKE $${paramIndex}
          OR s.shade_name_canonical ILIKE $${paramIndex}
          OR s.color_name ILIKE $${paramIndex}
          OR s.collection ILIKE $${paramIndex}
          OR ui.notes ILIKE $${paramIndex}
          OR EXISTS (
            SELECT 1 FROM unnest(COALESCE(ui.tags, ARRAY[]::text[])) AS tag
            WHERE tag ILIKE $${paramIndex}
          ))`
      );
      params.push(`%${normalizedSearch}%`);
      paramIndex++;
    }

    if (normalizedBrandFilter) {
      conditions.push(`b.name_canonical = $${paramIndex}`);
      params.push(normalizedBrandFilter);
      paramIndex++;
    }

    const finishFilterGroups: string[][] = [];
    if (normalizedFinishFilter) {
      finishFilterGroups.push([normalizedFinishFilter]);
    }
    if (parsedFinishesFilter.length > 0) {
      finishFilterGroups.push(parsedFinishesFilter);
    }
    if (finishFilterGroups.length > 0) {
      const catalog = await loadFinishCatalog();
      for (const group of finishFilterGroups) {
        // Match the multi-finish array (canonical values), or the legacy single finish column
        // only for shades that have no finishes array yet (a populated array is authoritative).
        const canonicalValues = canonicalizeFinishes(group, catalog);
        const legacyValues = Array.from(
          new Set([...group, ...canonicalValues, ...(canonicalValues.includes("creme") ? ["cream"] : [])])
        );
        conditions.push(
          `(COALESCE(s.finishes, ARRAY[]::text[]) && $${paramIndex}::text[] OR (cardinality(COALESCE(s.finishes, ARRAY[]::text[])) = 0 AND LOWER(s.finish) = ANY($${paramIndex + 1}::text[])))`
        );
        params.push(canonicalValues, legacyValues);
        paramIndex += 2;
      }
    }

    // Ownership comes from the inventory status (never from quantity). A NULL ui.status (no
    // inventory row) never matches a status condition.
    if (normalizedScope === "collection") {
      conditions.push(`ui.status = 'owned'`);
    }

    // Legacy `availability` alias for the status filter.
    if (normalizedAvailability === "owned") {
      conditions.push(`ui.status = 'owned'`);
    } else if (normalizedAvailability === "wishlist") {
      conditions.push(`ui.status = 'wishlist'`);
    }

    if (statusFilter.length > 0) {
      conditions.push(`ui.status = ANY($${paramIndex}::text[])`);
      params.push(statusFilter);
      paramIndex++;
    }

    if (untriedOnly) {
      conditions.push(`(ui.status = 'owned' AND ui.tried_at IS NULL)`);
    }

    if (parsedTags.length > 0) {
      conditions.push(`ui.tags @> $${paramIndex}`);
      params.push(parsedTags);
      paramIndex++;
    }

    // Color family (#103): shade.color_family is a generated column, so this is a plain indexed
    // WHERE clause and COUNT(*) OVER() / the fallback count stay correct.
    if (familyFilter.families.length > 0) {
      conditions.push(`s.color_family = ANY($${paramIndex}::text[])`);
      params.push(familyFilter.families);
      paramIndex++;
    }

    const sortColumn = SORT_COLUMNS[sortBy] || SORT_COLUMNS.createdAt;
    const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "TRUE";

    const result = await query<Polish & { totalCount: string }>(
      `${POLISH_LIST_SELECT}
       WHERE ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder} NULLS LAST
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, pageSize, offset]
    );

    let total: number;
    if (result.rows.length > 0) {
      total = parseInt(result.rows[0].totalCount, 10);
    } else if (offset === 0) {
      total = 0;
    } else {
      // Page past the end: the window count is unavailable, fall back to an explicit count.
      const countResult = await query(
        `SELECT COUNT(*) AS total
         FROM shade s
         JOIN brand b ON s.brand_id = b.brand_id
         LEFT JOIN user_inventory_item ui
           ON ui.shade_id = s.shade_id
          AND ui.user_id = $1
         WHERE ${whereClause}`,
        params
      );
      total = parseInt(countResult.rows[0].total, 10);
    }

    const polishes = await withBuyUrls(
      result.rows.map(({ totalCount: _totalCount, ...polish }) => polish as Polish),
      (polish) => polish.id
    );

    const responseBody = {
      polishes: mapReadableSwatchUrls(polishes, request.url),
      total,
      page,
      pageSize,
    } as PolishListResponse;

    await cacheSetJson(listCacheKey, responseBody, POLISH_LIST_CACHE_TTL_SECONDS);

    return {
      status: 200,
      jsonBody: responseBody,
    };
  } catch (error: any) {
    return internalServerError(context, error, "Failed to fetch polishes", "polishes.list");
  }
}

async function createPolish(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  context.log("POST /api/polishes");

  try {
    const body = (await request.json()) as PolishCreateRequest;
    let inventoryFields: InventoryFieldsUpdate;
    try {
      inventoryFields = parseInventoryFields(body);
    } catch (error) {
      if (error instanceof InventoryValidationError) {
        return { status: 400, jsonBody: { error: error.message } };
      }
      throw error;
    }
    const adoptingExistingShade = typeof body.shadeId === "string" && body.shadeId.trim().length > 0;

    if (!adoptingExistingShade && (!body.brand || !body.name)) {
      return { status: 400, jsonBody: { error: "Either shadeId or brand + name are required" } };
    }

    const shadeIdFromBody = adoptingExistingShade ? parseInt(body.shadeId!, 10) : null;
    if (adoptingExistingShade && (shadeIdFromBody === null || Number.isNaN(shadeIdFromBody))) {
      return { status: 400, jsonBody: { error: "Invalid shadeId" } };
    }

    // Adopting by id: another user's private user_submitted shade is indistinguishable from a missing one.
    let adoptedShade: { ownSubmitted: boolean } | null = null;
    if (adoptingExistingShade) {
      adoptedShade = await getVisibleShade(shadeIdFromBody!, userId);
      if (!adoptedShade) {
        return { status: 404, jsonBody: { error: "Shade not found" } };
      }
    }

    const finishUpdate = requestCarriesFinishData(body)
      ? resolveRequestedFinishes(body, await loadFinishCatalog())
      : undefined;

    const { shadeId } = await transaction(async (client) => {
      const resolvedShadeId =
        shadeIdFromBody ??
        (await findOrCreateShade(
          client,
          userId,
          body.brand!,
          body.name!,
          primaryFinishForRequest(body, finishUpdate),
          body.collection,
          { colorName: body.color, vendorHex: body.vendorHex, detectedHex: body.detectedHex, nameHex: body.nameHex },
          finishUpdate
        ));

      if (adoptingExistingShade) {
        await applyShadeFinishUpdate(client, resolvedShadeId, finishUpdate, adoptedShade!.ownSubmitted);
      }

      if (adoptingExistingShade && (body.color || body.vendorHex || body.detectedHex || body.nameHex)) {
        // Same rule as PUT: owners may correct their own submission; shared shades are fill-only.
        await applyShadeColorUpdate(
          client,
          resolvedShadeId,
          { colorName: body.color, vendorHex: body.vendorHex, detectedHex: body.detectedHex, nameHex: body.nameHex },
          adoptedShade!.ownSubmitted
        );
      }

      await upsertInventoryItem(client, userId, resolvedShadeId, body, inventoryFields);
      // A re-added polish picks its wear stats back up from the mani log (#269).
      await recomputeWearStats(client, userId, [resolvedShadeId], { fillTriedAt: false });

      return { shadeId: resolvedShadeId };
    });

    const created = await query<Polish>(
      `${POLISH_SELECT}
       WHERE s.shade_id = $2`,
      [userId, shadeId]
    );

    if (created.rows.length === 0) {
      return { status: 500, jsonBody: { error: "Created polish not found" } };
    }

    await Promise.all([
      invalidatePolishCachesForUser(userId, [shadeId]),
      invalidateCatalogCaches([shadeId]),
    ]);

    trackEvent("polish.created", {
      shadeId,
      userId,
      source: adoptingExistingShade ? "existing_shade" : "new_shade",
      hasFinish: Boolean(body.finish) || Boolean(finishUpdate?.values.length),
      finishCount: finishUpdate?.values.length ?? 0,
      hasCollection: Boolean(body.collection),
    });

    return {
      status: 201,
      jsonBody: withReadableSwatchUrl(created.rows[0], request.url),
    };
  } catch (error: any) {
    return internalServerError(context, error, "Failed to create polish", "polishes.create");
  }
}

async function updatePolish(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  context.log("PUT /api/polishes");

  const id = request.params.id;
  if (!id) {
    return { status: 400, jsonBody: { error: "Polish id is required" } };
  }

  const shadeId = parseInt(id, 10);
  if (Number.isNaN(shadeId) || shadeId <= 0) {
    return { status: 400, jsonBody: { error: "Invalid polish id" } };
  }

  try {
    const body = (await request.json()) as PolishUpdateRequest;
    let inventoryFields: InventoryFieldsUpdate;
    try {
      inventoryFields = parseInventoryFields(body);
    } catch (error) {
      if (error instanceof InventoryValidationError) {
        return { status: 400, jsonBody: { error: error.message } };
      }
      throw error;
    }
    const finishUpdate = requestCarriesFinishData(body)
      ? resolveRequestedFinishes(body, await loadFinishCatalog())
      : undefined;

    // Updating by id (no brand + name): the target must be visible to the caller.
    let targetShade: { ownSubmitted: boolean } | null = null;
    if (!(body.brand && body.name)) {
      targetShade = await getVisibleShade(shadeId, userId);
      if (!targetShade) {
        return { status: 404, jsonBody: { error: "Polish not found" } };
      }
    } else {
      // Brand + name unchanged: edit the URL's shade in place. Resolving by identity would key
      // the lookup on the requested primary finish, so a finish-only edit could land on (or
      // create) a different shade and leave the original inventory item behind.
      const visible = await getVisibleShade(shadeId, userId);
      if (visible && visible.brand === body.brand && visible.shadeName === body.name) {
        targetShade = visible;
      }
    }
    const resolveByIdentity = targetShade === null;

    const updatedShadeId = await transaction(async (client) => {
      let targetShadeId = shadeId;

      if (resolveByIdentity && body.brand && body.name) {
        targetShadeId = await findOrCreateShade(
          client,
          userId,
          body.brand,
          body.name,
          primaryFinishForRequest(body, finishUpdate),
          body.collection,
          { colorName: body.color, vendorHex: body.vendorHex, detectedHex: body.detectedHex, nameHex: body.nameHex },
          finishUpdate
        );
      } else {
        await applyShadeFinishUpdate(client, targetShadeId, finishUpdate, targetShade!.ownSubmitted);
      }

      if (!resolveByIdentity && (body.color || body.vendorHex || body.detectedHex || body.nameHex)) {
        await applyShadeColorUpdate(
          client,
          targetShadeId,
          { colorName: body.color, vendorHex: body.vendorHex, detectedHex: body.detectedHex, nameHex: body.nameHex },
          targetShade!.ownSubmitted
        );
      }

      const inventoryItemId = await upsertInventoryItem(client, userId, targetShadeId, body, inventoryFields);
      if (!inventoryItemId) {
        throw new Error("Inventory upsert failed");
      }
      // wear_count / last_worn_at are derived from the mani log (#269); tried_at is left as sent.
      await recomputeWearStats(client, userId, [targetShadeId], { fillTriedAt: false });

      return targetShadeId;
    });

    const fullResult = await query<Polish>(
      `${POLISH_SELECT}
       WHERE s.shade_id = $2`,
      [userId, updatedShadeId]
    );

    if (fullResult.rows.length === 0) {
      return { status: 500, jsonBody: { error: "Failed to load polish after update" } };
    }

    await Promise.all([
      invalidatePolishCachesForUser(userId, [shadeId, updatedShadeId]),
      invalidateCatalogCaches([updatedShadeId]),
    ]);

    return { status: 200, jsonBody: withReadableSwatchUrl(fullResult.rows[0], request.url) };
  } catch (error: any) {
    return internalServerError(context, error, "Failed to update polish", "polishes.update");
  }
}

async function deletePolish(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  context.log("DELETE /api/polishes");

  const id = request.params.id;
  if (!id) {
    return { status: 400, jsonBody: { error: "Polish id is required" } };
  }

  try {

    const shadeId = parseInt(id, 10);
    if (Number.isNaN(shadeId) || shadeId <= 0) {
      return { status: 400, jsonBody: { error: "Invalid polish id" } };
    }

    // #270: the item and its private nail photo (image_asset rows) are deleted in one transaction;
    // the photo blobs are deleted only after it commits, so a failure leaves both untouched.
    const { deletedId, nailPhotoBlobUrls } = await transaction(async (client) => {
      // Lock the caller's row first: a concurrent nail-photo PUT locks it too, so it cannot attach
      // a new photo between the detach and the delete.
      await client.query(
        `SELECT inventory_item_id
         FROM user_inventory_item
         WHERE shade_id = $1 AND user_id = $2
         FOR UPDATE`,
        [shadeId, userId]
      );
      const blobUrls = await detachNailPhotosForShade(client, userId, shadeId);
      const result = await client.query<{ id: string }>(
        `DELETE FROM user_inventory_item
         WHERE shade_id = $1 AND user_id = $2
         RETURNING inventory_item_id::text AS id`,
        [shadeId, userId]
      );
      return { deletedId: result.rows[0]?.id ?? null, nailPhotoBlobUrls: blobUrls };
    });

    await deleteNailPhotoBlobs(nailPhotoBlobUrls, context);

    if (deletedId === null) {
      return { status: 404, jsonBody: { error: "Polish not found for user" } };
    }

    await invalidatePolishCachesForUser(userId, [shadeId]);

    return { status: 200, jsonBody: { message: "Polish deleted successfully", id: deletedId } };
  } catch (error: any) {
    return internalServerError(context, error, "Failed to delete polish", "polishes.delete");
  }
}

async function recalcHex(request: HttpRequest, context: InvocationContext, _userId: number): Promise<HttpResponseInit> {
  context.log("POST /api/polishes/{id}/recalc-hex");

  const id = request.params.id;
  if (!id) {
    return { status: 400, jsonBody: { error: "Polish id is required" } };
  }

  const shadeId = parseInt(id, 10);
  if (Number.isNaN(shadeId) || shadeId <= 0) {
    return { status: 400, jsonBody: { error: "Invalid polish id" } };
  }

  try {
    const shadeResult = await query<{
      shade_id: number;
      shade_name_canonical: string;
      detected_hex: string | null;
      vendor_hex: string | null;
      hex_agreement: number | null;
      storage_url: string | null;
      vendor_tags: string[] | null;
    }>(
      `SELECT s.shade_id,
              s.shade_name_canonical,
              s.detected_hex,
              s.vendor_hex,
              s.hex_agreement::float8 AS hex_agreement,
              ia.storage_url,
              CASE
                WHEN cardinality(s.finishes) > 0
                  THEN s.finishes
                WHEN s.finish IS NOT NULL AND btrim(s.finish) <> ''
                  THEN ARRAY[s.finish]::text[]
                ELSE NULL::text[]
              END AS vendor_tags
       FROM shade s
       LEFT JOIN swatch sw ON sw.shade_id = s.shade_id
       LEFT JOIN image_asset ia ON ia.image_id = sw.image_id_original
       WHERE s.shade_id = $1
       ORDER BY COALESCE(sw.swatch_type = 'source_product', false) DESC, sw.swatch_id DESC
       LIMIT 1`,
      [shadeId]
    );

    if (shadeResult.rows.length === 0) {
      return { status: 404, jsonBody: { error: "Shade not found" } };
    }

    const shade = shadeResult.rows[0];

    if (!shade.storage_url) {
      return {
        status: 422,
        jsonBody: {
          error: "No image available for hex detection",
          shadeId: String(shade.shade_id),
          shadeName: shade.shade_name_canonical,
        },
      };
    }

    const blob = await readBlobFromStorageUrl(shade.storage_url);
    const dataUri = `data:${blob.contentType};base64,${blob.bytes.toString("base64")}`;

    const result = await detectHexWithAzureOpenAI(dataUri, {
      onLog: (level, msg) => {
        if (level === "error") context.error(msg);
        else if (level === "warn") context.warn(msg);
        else context.log(msg);
      },
      vendorContext: {
        shadeName: shade.shade_name_canonical,
        vendorHex: shade.vendor_hex,
        tags: shade.vendor_tags,
      },
    });
    const tokenUsage = result.usage || null;
    if (tokenUsage) {
      const tokenUsageLog = {
        shadeId: String(shade.shade_id),
        promptTokens: tokenUsage.promptTokens,
        completionTokens: tokenUsage.completionTokens,
        totalTokens: tokenUsage.totalTokens,
      };
      context.log("[recalc-hex] Azure OpenAI token usage", tokenUsageLog);
    }

    const previousHex = shade.detected_hex;
    const previousAgreement = shade.hex_agreement;
    const provenance = provenanceFromDetection(result);
    const finishCatalog = await loadFinishCatalog();
    const vendorFinishes =
      shade.vendor_tags
        ?.map((t) => canonicalizeFinish(t, finishCatalog) || normalizeFinish(t) || t.trim().toLowerCase())
        .filter((v): v is string => Boolean(v)) ?? [];
    const aiFinishes = result.finishes ?? [];
    const mergedFinishes = Array.from(new Set([...vendorFinishes, ...aiFinishes]));

    if (!result.hex) {
      return {
        status: 200,
        jsonBody: {
          message: "Could not detect hex from image",
          shadeId: String(shade.shade_id),
          shadeName: shade.shade_name_canonical,
          previousHex,
          detectedHex: null,
          confidence: result.confidence,
          method: provenance.method,
          model: provenance.model,
          promptVersion: provenance.promptVersion,
          finishes: mergedFinishes.length ? mergedFinishes : null,
          tokenUsage,
        },
      };
    }

    // Admin recalculation always overwrites, so provenance is rewritten unconditionally.
    // hex_agreement (vendor_hex ↔ detected_hex) is a generated column; read it back below.
    const updated = await query<{ hexAgreement: number | null }>(
      `UPDATE shade
         SET detected_hex = $2,
             detected_finishes = $3,
             detected_hex_confidence = $4,
             detected_hex_method = $5,
             detected_hex_model = $6,
             detected_hex_prompt_version = $7,
             detected_hex_at = now(),
             updated_at = now()
       WHERE shade_id = $1
       RETURNING hex_agreement::float8 AS "hexAgreement"`,
      [
        shadeId,
        result.hex,
        mergedFinishes.length ? mergedFinishes : null,
        provenance.confidence,
        provenance.method,
        provenance.model,
        provenance.promptVersion,
      ]
    );
    const hexAgreement = updated.rows[0]?.hexAgreement ?? null;

    await Promise.all([
      invalidateGlobalPolishCaches(),
      invalidateCatalogCaches([shadeId]),
    ]);

    return {
      status: 200,
      jsonBody: {
        message: previousHex
          ? `Updated detected hex from ${previousHex} to ${result.hex}`
          : `Detected hex ${result.hex}`,
        shadeId: String(shade.shade_id),
        shadeName: shade.shade_name_canonical,
        previousHex,
        detectedHex: result.hex,
        confidence: result.confidence,
        method: provenance.method,
        model: provenance.model,
        promptVersion: provenance.promptVersion,
        vendorHex: shade.vendor_hex,
        previousHexAgreement: previousAgreement,
        hexAgreement,
        finishes: mergedFinishes.length ? mergedFinishes : null,
        tokenUsage,
      },
    };
  } catch (error: any) {
    return internalServerError(context, error, "Failed to recalculate hex", "polishes.recalc-hex");
  }
}

/**
 * Upper bound on the raw JSON body. The decoded image is capped at 5 MB by
 * validateImageUpload; base64 inflates that by 4/3, plus a little slack for the
 * data-URL prefix and option fields.
 */
const MATCH_IMAGE_MAX_BODY_BYTES = Math.ceil((5 * 1024 * 1024 * 4) / 3) + 16 * 1024;

/**
 * POST /api/polishes/match-image — extract the dominant colors of an uploaded
 * photo and rank the caller's owned polishes by OKLAB distance to them.
 *
 * Privacy: the image is decoded in memory only. It is never written to blob
 * storage, the database, the cache, or logs.
 */
async function matchImage(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/polishes/match-image");

  const contentLength = parseInt(request.headers.get("content-length") || "", 10);
  if (Number.isFinite(contentLength) && contentLength > MATCH_IMAGE_MAX_BODY_BYTES) {
    return { status: 413, jsonBody: { error: "Image too large (max 5MB)" } };
  }

  let body: unknown;
  try {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MATCH_IMAGE_MAX_BODY_BYTES) {
      return { status: 413, jsonBody: { error: "Image too large (max 5MB)" } };
    }
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  let extractedColors: PolishImageMatchResponse["extractedColors"];
  let limit: number;
  try {
    const parsed = parseMatchImageRequest(body);
    limit = parsed.limit;
    extractedColors = await extractImagePalette(parsed.bytes, parsed.maxColors);
  } catch (error) {
    if (error instanceof MatchImageInputError) {
      return { status: 400, jsonBody: { error: error.message } };
    }
    context.error("Error extracting image colors:", error);
    trackException(error, { route: "polishes-match-image", stage: "extract" });
    return { status: 500, jsonBody: { error: "Failed to process image" } };
  }

  if (extractedColors.length === 0) {
    const emptyBody: PolishImageMatchResponse = { extractedColors: [], matches: [], candidateCount: 0 };
    return { status: 200, jsonBody: emptyBody };
  }

  try {
    // Owned polishes only: POLISH_SELECT's inventory LEFT JOIN is scoped to $1,
    // so requiring an inventory row with status 'owned' limits this to the
    // caller's own collection.
    const result = await query<Polish>(
      `${POLISH_SELECT}
       WHERE ui.inventory_item_id IS NOT NULL
         AND ui.status = 'owned'
         AND ${POLISH_VISIBLE_SQL}`,
      [userId]
    );

    const polishes = mapReadableSwatchUrls(result.rows, request.url);
    const { matches, candidateCount } = rankPolishMatches(polishes, extractedColors, limit);

    trackEvent("polish.match_image", {
      userId,
      extractedColorCount: extractedColors.length,
      candidateCount,
      matchCount: matches.length,
      highConfidenceCount: matches.filter((m) => m.confidence === "high").length,
    });

    const responseBody: PolishImageMatchResponse = { extractedColors, matches, candidateCount };
    return { status: 200, jsonBody: responseBody };
  } catch (error: any) {
    context.error("Error matching polishes to image:", error);
    trackException(error, { route: "polishes-match-image", stage: "match" });
    return { status: 500, jsonBody: { error: "Failed to match polishes" } };
  }
}

/**
 * ORDER BY clauses for the admin hex-review queue. `agreement` puts the largest
 * vendor↔detected OKLAB distance first (shades without both hexes last); `confidence`
 * puts the lowest detector confidence first (unrecorded confidence last).
 */
const HEX_REVIEW_ORDER: Record<HexReviewSort, string> = {
  agreement: "s.hex_agreement DESC NULLS LAST, s.detected_hex_confidence ASC NULLS LAST, s.shade_id",
  confidence: "s.detected_hex_confidence ASC NULLS LAST, s.hex_agreement DESC NULLS LAST, s.shade_id",
};

/**
 * GET /api/polishes-admin/hex-review (admin-only)
 *
 * Lists shades that have a detected hex, ordered by worst vendor↔detected agreement
 * (`sort=agreement`, default) or lowest detection confidence (`sort=confidence`), so
 * weak detections can be reviewed and re-run with recalc-hex.
 *
 * Query: `sort`, `page` (default 1), `pageSize` (default 50, max 200),
 * `flaggedOnly=true` (only agreement > MEDIUM), `method`, `promptVersion`, `brand`.
 */
async function getHexReview(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/polishes-admin/hex-review");
  try {
    const url = new URL(request.url);
    const sortParam = url.searchParams.get("sort")?.trim().toLowerCase() || "agreement";
    if (sortParam !== "agreement" && sortParam !== "confidence") {
      return { status: 400, jsonBody: { error: "sort must be 'agreement' or 'confidence'" } };
    }
    const sort: HexReviewSort = sortParam;
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get("pageSize") || "50", 10) || 50));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = ["s.detected_hex IS NOT NULL"];
    const params: Array<string | number> = [];
    const addParam = (value: string | number) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (url.searchParams.get("flaggedOnly") === "true") {
      conditions.push(`s.hex_agreement > ${addParam(MEDIUM_CONFIDENCE_MAX_DISTANCE)}`);
    }
    const method = url.searchParams.get("method")?.trim();
    if (method) conditions.push(`s.detected_hex_method = ${addParam(method)}`);
    const promptVersion = url.searchParams.get("promptVersion")?.trim();
    if (promptVersion) conditions.push(`s.detected_hex_prompt_version = ${addParam(promptVersion)}`);
    const brand = url.searchParams.get("brand")?.trim();
    if (brand) conditions.push(`b.name_canonical ILIKE ${addParam(`%${brand}%`)}`);

    const where = conditions.join(" AND ");

    const countResult = await query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM shade s
       JOIN brand b ON b.brand_id = s.brand_id
       WHERE ${where}`,
      params
    );

    const rowsResult = await query<Omit<HexReviewItem, "displayHex" | "displaySource" | "flagged">>(
      `SELECT
         s.shade_id::text                      AS "shadeId",
         COALESCE(b.name_canonical, '')        AS brand,
         COALESCE(s.shade_name_canonical, '')  AS name,
         s.status,
         s.vendor_hex                          AS "vendorHex",
         s.detected_hex                        AS "detectedHex",
         s.name_hex                            AS "nameHex",
         s.detected_hex_confidence::float8     AS "detectedHexConfidence",
         s.detected_hex_method                 AS "detectedHexMethod",
         s.detected_hex_model                  AS "detectedHexModel",
         s.detected_hex_prompt_version         AS "detectedHexPromptVersion",
         s.detected_hex_at                     AS "detectedHexAt",
         s.hex_agreement::float8               AS "hexAgreement"
       FROM shade s
       JOIN brand b ON b.brand_id = s.brand_id
       WHERE ${where}
       ORDER BY ${HEX_REVIEW_ORDER[sort]}
       LIMIT ${addParam(pageSize)} OFFSET ${addParam(offset)}`,
      params
    );

    const items: HexReviewItem[] = rowsResult.rows.map((row) => {
      const resolution = resolveDisplayHexDetailed({
        vendorHex: row.vendorHex ?? undefined,
        detectedHex: row.detectedHex ?? undefined,
        nameHex: row.nameHex ?? undefined,
        hexAgreement: row.hexAgreement,
      });
      return {
        ...row,
        displayHex: resolution.hex ?? null,
        displaySource: resolution.source,
        flagged: resolution.flagged,
      };
    });

    const body: HexReviewResponse = {
      items,
      total: parseInt(countResult.rows[0]?.total ?? "0", 10),
      page,
      pageSize,
      sort,
      disagreementThreshold: MEDIUM_CONFIDENCE_MAX_DISTANCE,
    };
    return { status: 200, jsonBody: body };
  } catch (error: any) {
    return internalServerError(context, error, "Failed to list hex review queue", "polishes.hex-review");
  }
}

app.http("polishes-list", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "polishes/{id?}",
  handler: withCors(withAuth(getPolishes)),
});

app.http("polishes-create", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "polishes",
  handler: withCors(withAuth(createPolish)),
});

app.http("polishes-mutate", {
  methods: ["PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "polishes/{id}",
  handler: withCors(
    withAuth(async (request, context, userId) => {
      if (request.method?.toUpperCase() === "PUT") {
        return updatePolish(request, context, userId);
      }
      if (request.method?.toUpperCase() === "DELETE") {
        return deletePolish(request, context, userId);
      }
      return { status: 405, jsonBody: { error: "Method not allowed" } };
    })
  ),
});

app.http("polishes-recalc-hex", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "polishes/{id}/recalc-hex",
  handler: withCors(withAdmin(recalcHex)),
});

app.http("polishes-admin-hex-review", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "polishes-admin/hex-review",
  handler: withCors(withAdmin(async (request, context) => getHexReview(request, context))),
});

app.http("polishes-match-image", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "polishes/match-image",
  handler: withCors(withAuth(matchImage)),
});
