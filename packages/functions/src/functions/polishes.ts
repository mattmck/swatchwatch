import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { PolishCreateRequest, PolishUpdateRequest, PolishListResponse } from "swatchwatch-shared";
import { query, transaction } from "../lib/db";
import { withAuth, withAdmin } from "../lib/auth";
import { withCors } from "../lib/http";
import { toImageProxyUrl } from "../lib/image-proxy";
import { detectHexWithAzureOpenAI } from "../lib/ai-color-detection";
import { readBlobFromStorageUrl } from "../lib/blob-storage";
import { trackEvent, trackException } from "../lib/telemetry";
import { PoolClient } from "pg";

const FINISH_NORMALIZATION_MAP: Record<string, string> = {
  cream: "creme",
};

function normalizeFinish(value?: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return FINISH_NORMALIZATION_MAP[normalized] || normalized || null;
}

/**
 * Shared SELECT fragment — returns global shade data plus the requesting user's inventory fields.
 * `$1` is always the requesting user id so list/detail queries can join consistently.
 */
const POLISH_SELECT = `
  SELECT
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
    COALESCE(s.finish, '')                       AS finish,
    COALESCE(s.collection, '')                   AS collection,
    ui.quantity,
    ui.size_display                              AS size,
    ui.rating,
    ui.notes,
    swatch_img.storage_url                       AS "swatchImageUrl",
    ui.tags,
    ui.purchase_date                             AS "purchaseDate",
    ui.expiration_date                           AS "expirationDate",
    COALESCE(ui.created_at, s.created_at)        AS "createdAt",
    COALESCE(ui.updated_at, s.updated_at)        AS "updatedAt"
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
    ORDER BY sw.swatch_id DESC
    LIMIT 1
  ) AS swatch_img ON true`;

/**
 * Find or create a brand + shade, returning the shade_id.
 * Uses a transaction client so this can be part of a larger transaction.
 */
async function findOrCreateShade(
  client: PoolClient,
  brandName: string,
  shadeName: string,
  finish?: string,
  collection?: string,
  colorData?: { colorName?: string; vendorHex?: string; detectedHex?: string; nameHex?: string }
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

  // Find existing shade (match on brand + name + finish, with NULL-safe finish comparison)
  const existingShade = await client.query<{ shade_id: number }>(
    `SELECT shade_id FROM shade
     WHERE brand_id = $1
       AND shade_name_canonical = $2
       AND product_line_id IS NULL
       AND COALESCE(finish, '') = COALESCE($3, '')`,
    [brandId, shadeName, normalizeFinish(finish)]
  );

  if (existingShade.rows.length > 0) {
    const shadeId = existingShade.rows[0].shade_id;
    // Backfill color data if provided
    if (colorData) {
      await client.query(
        `UPDATE shade SET
           color_name   = COALESCE($2, color_name),
           vendor_hex   = COALESCE($3, vendor_hex),
           detected_hex = COALESCE($4, detected_hex),
           name_hex     = COALESCE($5, name_hex),
           updated_at   = now()
         WHERE shade_id = $1`,
        [shadeId, colorData.colorName || null, colorData.vendorHex || null, colorData.detectedHex || null, colorData.nameHex || null]
      );
    }
    return shadeId;
  }

  // Create new shade with color data
  const newShade = await client.query<{ shade_id: number }>(
    `INSERT INTO shade (brand_id, shade_name_canonical, finish, collection, status, color_name, vendor_hex, detected_hex, name_hex)
     VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8)
     RETURNING shade_id`,
    [
      brandId, shadeName, normalizeFinish(finish), collection || null,
      colorData?.colorName || null, colorData?.vendorHex || null,
      colorData?.detectedHex || null, colorData?.nameHex || null,
    ]
  );
  return newShade.rows[0].shade_id;
}

/** Whitelist of allowed sort columns to prevent SQL injection */
const SORT_COLUMNS: Record<string, string> = {
  status: "CASE WHEN COALESCE(ui.quantity, 0) > 0 THEN 0 ELSE 1 END",
  name: "s.shade_name_canonical",
  brand: "b.name_canonical",
  finish: "COALESCE(s.finish, '')",
  collection: "COALESCE(s.collection, '')",
  createdAt: "COALESCE(ui.created_at, s.created_at)",
  rating: "ui.rating",
};

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
    ? normalizedRow.sourceImageUrls.map((url) => withReadableImageUrl(url, requestUrl))
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

function withReadableImageUrl(imageUrl: string, requestUrl: string): string {
  const normalized = imageUrl.trim();
  if (!normalized) {
    return normalized;
  }
  return isStorageUrlProxied(normalized)
    ? toImageProxyUrl(requestUrl, normalized)
    : normalized;
}

async function getPolishes(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  context.log("GET /api/polishes");

  const id = request.params.id;

  // Single polish by shade id
  if (id) {
    try {
      const shadeId = parseInt(id, 10);
      if (Number.isNaN(shadeId) || shadeId <= 0) {
        return { status: 400, jsonBody: { error: "Invalid polish id" } };
      }

      const result = await query(
        `${POLISH_SELECT}
         WHERE s.shade_id = $2`,
        [userId, shadeId]
      );

      if (result.rows.length === 0) {
        return { status: 404, jsonBody: { error: "Polish not found" } };
      }

      const imagesResult = await query<{ storageUrl: string }>(
        `SELECT ia.storage_url AS "storageUrl"
         FROM swatch sw
         JOIN image_asset ia ON ia.image_id = sw.image_id_original
         WHERE sw.shade_id = $1
         ORDER BY sw.swatch_id DESC`,
        [shadeId]
      );

      const sourceImageUrls = Array.from(
        new Set(
          imagesResult.rows
            .map((r) => r.storageUrl)
            .filter((url): url is string => typeof url === "string" && url.trim().length > 0)
            .map((url) => withReadableImageUrl(url, request.url))
        )
      );

      return {
        status: 200,
        jsonBody: withReadableSwatchUrl(
          {
            ...result.rows[0],
            sourceImageUrls: sourceImageUrls.length > 0 ? sourceImageUrls : undefined,
          },
          request.url
        ),
      };
    } catch (error: any) {
      context.error("Error fetching polish:", error);
      return { status: 500, jsonBody: { error: "Failed to fetch polish", details: error.message } };
    }
  }

  // Collection list
  try {
    const url = new URL(request.url);

    const search = url.searchParams.get("search");
    const brandFilter = url.searchParams.get("brand");
    const finishFilter = url.searchParams.get("finish");
    const scope = url.searchParams.get("scope");
    const availability = url.searchParams.get("availability") || url.searchParams.get("avail");
    const tagsParam = url.searchParams.get("tags");
    const sortBy = url.searchParams.get("sortBy") || "createdAt";
    const sortOrder = url.searchParams.get("sortOrder")?.toUpperCase() === "ASC" ? "ASC" : "DESC";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(250, Math.max(1, parseInt(url.searchParams.get("pageSize") || "50", 10)));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: Array<number | string | string[]> = [userId];
    let paramIndex = 2;

    if (search) {
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
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (brandFilter) {
      conditions.push(`b.name_canonical = $${paramIndex}`);
      params.push(brandFilter);
      paramIndex++;
    }

    if (finishFilter) {
      const normalizedFilter = normalizeFinish(finishFilter);
      const filterValues =
        normalizedFilter === "creme" ? ["creme", "cream"] : normalizedFilter ? [normalizedFilter] : [];
      if (filterValues.length > 0) {
        conditions.push(`LOWER(s.finish) = ANY($${paramIndex}::text[])`);
        params.push(filterValues);
        paramIndex++;
      }
    }

    if (scope === "collection") {
      conditions.push(`COALESCE(ui.quantity, 0) > 0`);
    }

    if (availability === "owned") {
      conditions.push(`COALESCE(ui.quantity, 0) > 0`);
    } else if (availability === "wishlist") {
      conditions.push(`COALESCE(ui.quantity, 0) <= 0`);
    }

    if (tagsParam) {
      const tags = tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
      if (tags.length > 0) {
        conditions.push(`ui.tags @> $${paramIndex}`);
        params.push(tags);
        paramIndex++;
      }
    }

    const sortColumn = SORT_COLUMNS[sortBy] || SORT_COLUMNS.createdAt;
    const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "TRUE";

    const result = await query(
      `${POLISH_SELECT}
       WHERE ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder} NULLS LAST
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, pageSize, offset]
    );

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

    return {
      status: 200,
      jsonBody: {
        polishes: mapReadableSwatchUrls(result.rows, request.url),
        total: parseInt(countResult.rows[0].total, 10),
        page,
        pageSize,
      } as PolishListResponse,
    };
  } catch (error: any) {
    context.error("Error fetching polishes:", error);
    return { status: 500, jsonBody: { error: "Failed to fetch polishes", details: error.message } };
  }
}

async function createPolish(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  context.log("POST /api/polishes");

  try {
    const body = (await request.json()) as PolishCreateRequest;
    const adoptingExistingShade = typeof body.shadeId === "string" && body.shadeId.trim().length > 0;

    if (!adoptingExistingShade && (!body.brand || !body.name)) {
      return { status: 400, jsonBody: { error: "Either shadeId or brand + name are required" } };
    }

    const shadeIdFromBody = adoptingExistingShade ? parseInt(body.shadeId!, 10) : null;
    if (adoptingExistingShade && (shadeIdFromBody === null || Number.isNaN(shadeIdFromBody))) {
      return { status: 400, jsonBody: { error: "Invalid shadeId" } };
    }

    if (adoptingExistingShade) {
      const exists = await query(
        `SELECT 1 FROM shade WHERE shade_id = $1 LIMIT 1`,
        [shadeIdFromBody]
      );
      if (exists.rows.length === 0) {
        return { status: 404, jsonBody: { error: "Shade not found" } };
      }
    }

    const { shadeId } = await transaction(async (client) => {
      const resolvedShadeId =
        shadeIdFromBody ??
        (await findOrCreateShade(
          client,
          body.brand!,
          body.name!,
          body.finish,
          body.collection,
          { colorName: body.color, vendorHex: body.vendorHex, detectedHex: body.detectedHex, nameHex: body.nameHex }
        ));

      if (adoptingExistingShade && (body.color || body.vendorHex || body.detectedHex || body.nameHex)) {
        await client.query(
          `UPDATE shade SET
             color_name   = COALESCE($2, color_name),
             vendor_hex   = COALESCE($3, vendor_hex),
             detected_hex = COALESCE($4, detected_hex),
             name_hex     = COALESCE($5, name_hex),
             updated_at   = now()
           WHERE shade_id = $1`,
          [resolvedShadeId, body.color ?? null, body.vendorHex ?? null, body.detectedHex ?? null, body.nameHex ?? null]
        );
      }

      await client.query(
        `INSERT INTO user_inventory_item
           (user_id, shade_id, quantity, notes, purchase_date, expiration_date,
            rating, tags, size_display)
         VALUES ($1, $2, COALESCE($3, 0), $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, shade_id) DO UPDATE SET
           quantity        = CASE WHEN $3 IS NULL THEN user_inventory_item.quantity ELSE EXCLUDED.quantity END,
           notes           = CASE WHEN $4 IS NULL THEN user_inventory_item.notes ELSE EXCLUDED.notes END,
           purchase_date   = CASE WHEN $5 IS NULL THEN user_inventory_item.purchase_date ELSE EXCLUDED.purchase_date END,
           expiration_date = CASE WHEN $6 IS NULL THEN user_inventory_item.expiration_date ELSE EXCLUDED.expiration_date END,
           rating          = CASE WHEN $7 IS NULL THEN user_inventory_item.rating ELSE EXCLUDED.rating END,
           tags            = CASE WHEN $8 IS NULL THEN user_inventory_item.tags ELSE EXCLUDED.tags END,
           size_display    = CASE WHEN $9 IS NULL THEN user_inventory_item.size_display ELSE EXCLUDED.size_display END,
           updated_at      = now()`,
        [
          userId,
          resolvedShadeId,
          body.quantity ?? null,
          body.notes ?? null,
          body.purchaseDate ?? null,
          body.expirationDate ?? null,
          body.rating ?? null,
          body.tags && body.tags.length ? body.tags : null,
          body.size ?? null,
        ]
      );

      return { shadeId: resolvedShadeId };
    });

    const created = await query(
      `${POLISH_SELECT}
       WHERE s.shade_id = $2`,
      [userId, shadeId]
    );

    if (created.rows.length === 0) {
      return { status: 500, jsonBody: { error: "Created polish not found" } };
    }

    trackEvent("polish.created", {
      shadeId,
      userId,
      source: adoptingExistingShade ? "existing_shade" : "new_shade",
      hasFinish: Boolean(body.finish),
      hasCollection: Boolean(body.collection),
    });

    return {
      status: 201,
      jsonBody: withReadableSwatchUrl(created.rows[0], request.url),
    };
  } catch (error: any) {
    context.error("Error creating polish:", error);
    trackException(error, { endpoint: "polishes.create" });
    return { status: 500, jsonBody: { error: "Failed to create polish", details: error.message } };
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

    const updatedShadeId = await transaction(async (client) => {
      let targetShadeId = shadeId;

      if (body.brand && body.name) {
        targetShadeId = await findOrCreateShade(
          client,
          body.brand,
          body.name,
          body.finish,
          body.collection,
          { colorName: body.color, vendorHex: body.vendorHex, detectedHex: body.detectedHex, nameHex: body.nameHex }
        );
      } else if (body.color || body.vendorHex || body.detectedHex || body.nameHex) {
        await client.query(
          `UPDATE shade SET
             color_name   = COALESCE($2, color_name),
             vendor_hex   = COALESCE($3, vendor_hex),
             detected_hex = COALESCE($4, detected_hex),
             name_hex     = COALESCE($5, name_hex),
             updated_at   = now()
           WHERE shade_id = $1`,
          [targetShadeId, body.color ?? null, body.vendorHex ?? null, body.detectedHex ?? null, body.nameHex ?? null]
        );
      }

      const result = await client.query<{ inventoryItemId: string }>(
        `INSERT INTO user_inventory_item
           (user_id, shade_id, quantity, notes, purchase_date, expiration_date,
            rating, tags, size_display)
         VALUES ($1, $2, COALESCE($3, 0), $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, shade_id) DO UPDATE SET
           quantity        = CASE WHEN $3 IS NULL THEN user_inventory_item.quantity ELSE EXCLUDED.quantity END,
           notes           = CASE WHEN $4 IS NULL THEN user_inventory_item.notes ELSE EXCLUDED.notes END,
           purchase_date   = CASE WHEN $5 IS NULL THEN user_inventory_item.purchase_date ELSE EXCLUDED.purchase_date END,
           expiration_date = CASE WHEN $6 IS NULL THEN user_inventory_item.expiration_date ELSE EXCLUDED.expiration_date END,
           rating          = CASE WHEN $7 IS NULL THEN user_inventory_item.rating ELSE EXCLUDED.rating END,
           tags            = CASE WHEN $8 IS NULL THEN user_inventory_item.tags ELSE EXCLUDED.tags END,
           size_display    = CASE WHEN $9 IS NULL THEN user_inventory_item.size_display ELSE EXCLUDED.size_display END,
           updated_at      = now()
         RETURNING inventory_item_id::text AS "inventoryItemId"`,
        [
          userId,
          targetShadeId,
          body.quantity ?? null,
          body.notes ?? null,
          body.purchaseDate ?? null,
          body.expirationDate ?? null,
          body.rating ?? null,
          body.tags && body.tags.length ? body.tags : null,
          body.size ?? null,
        ]
      );

      if (result.rows.length === 0) {
        throw new Error("Inventory upsert failed");
      }

      return targetShadeId;
    });

    const fullResult = await query(
      `${POLISH_SELECT}
       WHERE s.shade_id = $2`,
      [userId, updatedShadeId]
    );

    if (fullResult.rows.length === 0) {
      return { status: 500, jsonBody: { error: "Failed to load polish after update" } };
    }

    return { status: 200, jsonBody: withReadableSwatchUrl(fullResult.rows[0], request.url) };
  } catch (error: any) {
    context.error("Error updating polish:", error);
    return { status: 500, jsonBody: { error: "Failed to update polish", details: error.message } };
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

    const result = await query(
      `DELETE FROM user_inventory_item
       WHERE shade_id = $1 AND user_id = $2
       RETURNING inventory_item_id::text AS id`,
      [shadeId, userId]
    );

    if (result.rows.length === 0) {
      return { status: 404, jsonBody: { error: "Polish not found for user" } };
    }

    return { status: 200, jsonBody: { message: "Polish deleted successfully", id: result.rows[0].id } };
  } catch (error: any) {
    context.error("Error deleting polish:", error);
    return { status: 500, jsonBody: { error: "Failed to delete polish", details: error.message } };
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
      storage_url: string | null;
      vendor_tags: string[] | null;
    }>(
      `SELECT s.shade_id,
              s.shade_name_canonical,
              s.detected_hex,
              s.vendor_hex,
              ia.storage_url,
              CASE
                WHEN s.finish IS NOT NULL AND btrim(s.finish) <> ''
                  THEN ARRAY[s.finish]::text[]
                ELSE NULL::text[]
              END AS vendor_tags
       FROM shade s
       LEFT JOIN swatch sw ON sw.shade_id = s.shade_id
       LEFT JOIN image_asset ia ON ia.image_id = sw.image_id_original
       WHERE s.shade_id = $1
       ORDER BY sw.swatch_id DESC
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

    const previousHex = shade.detected_hex;
    const vendorFinishes =
      shade.vendor_tags
        ?.map((t) => normalizeFinish(t) || t.trim().toLowerCase())
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
          finishes: mergedFinishes.length ? mergedFinishes : null,
        },
      };
    }

    await query(
      `UPDATE shade
         SET detected_hex = $2,
             detected_finishes = $3,
             updated_at = now()
       WHERE shade_id = $1`,
      [shadeId, result.hex, mergedFinishes.length ? mergedFinishes : null]
    );

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
        finishes: mergedFinishes.length ? mergedFinishes : null,
      },
    };
  } catch (error: any) {
    context.error("Error recalculating hex:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to recalculate hex", details: error.message },
    };
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
