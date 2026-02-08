import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { PolishCreateRequest, PolishUpdateRequest, PolishListResponse } from "swatchwatch-shared";
import { query, transaction } from "../lib/db";
import { PoolClient } from "pg";

/**
 * Shared SELECT fragment — returns Polish-shaped rows.
 * Joins canonical brand/shade data with user-facing inventory columns.
 */
const POLISH_SELECT = `
  SELECT
    ui.inventory_item_id::text  AS id,
    ui.user_id::text            AS "userId",
    COALESCE(b.name_canonical, '')              AS brand,
    COALESCE(s.shade_name_canonical, '')        AS name,
    COALESCE(ui.color_name, '')                 AS color,
    ui.color_hex                                AS "colorHex",
    COALESCE(s.finish, '')                      AS finish,
    COALESCE(s.collection, '')                  AS collection,
    ui.quantity,
    ui.size_display                             AS size,
    ui.rating,
    ui.notes,
    ui.tags,
    ui.purchase_date                            AS "purchaseDate",
    ui.expiration_date                          AS "expirationDate",
    ui.created_at                               AS "createdAt",
    ui.updated_at                               AS "updatedAt"
  FROM user_inventory_item ui
  LEFT JOIN shade s  ON ui.shade_id = s.shade_id
  LEFT JOIN brand b  ON s.brand_id  = b.brand_id`;

/**
 * Find or create a brand + shade, returning the shade_id.
 * Uses a transaction client so this can be part of a larger transaction.
 */
async function findOrCreateShade(
  client: PoolClient,
  brandName: string,
  shadeName: string,
  finish?: string,
  collection?: string
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
    [brandId, shadeName, finish || null]
  );

  if (existingShade.rows.length > 0) {
    return existingShade.rows[0].shade_id;
  }

  // Create new shade
  const newShade = await client.query<{ shade_id: number }>(
    `INSERT INTO shade (brand_id, shade_name_canonical, finish, collection, status)
     VALUES ($1, $2, $3, $4, 'active')
     RETURNING shade_id`,
    [brandId, shadeName, finish || null, collection || null]
  );
  return newShade.rows[0].shade_id;
}

/** Whitelist of allowed sort columns to prevent SQL injection */
const SORT_COLUMNS: Record<string, string> = {
  name: "s.shade_name_canonical",
  brand: "b.name_canonical",
  createdAt: "ui.created_at",
  rating: "ui.rating",
};

async function getPolishes(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/polishes");

  const id = request.params.id;

  // Single polish by ID
  if (id) {
    try {
      const result = await query(
        `${POLISH_SELECT} WHERE ui.inventory_item_id = $1`,
        [parseInt(id, 10)]
      );

      if (result.rows.length === 0) {
        return { status: 404, jsonBody: { error: "Polish not found" } };
      }

      return { status: 200, jsonBody: result.rows[0] };
    } catch (error: any) {
      context.error("Error fetching polish:", error);
      return { status: 500, jsonBody: { error: "Failed to fetch polish", details: error.message } };
    }
  }

  // List with filtering, search, sorting, and pagination
  try {
    const userId = 1; // TODO: get from auth token
    const url = new URL(request.url);

    const search = url.searchParams.get("search");
    const brandFilter = url.searchParams.get("brand");
    const finishFilter = url.searchParams.get("finish");
    const tagsParam = url.searchParams.get("tags");
    const sortBy = url.searchParams.get("sortBy") || "createdAt";
    const sortOrder = url.searchParams.get("sortOrder")?.toUpperCase() === "ASC" ? "ASC" : "DESC";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "50", 10)));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = ["ui.user_id = $1"];
    const params: any[] = [userId];
    let paramIndex = 2;

    if (search) {
      conditions.push(
        `(b.name_canonical ILIKE $${paramIndex}
          OR s.shade_name_canonical ILIKE $${paramIndex}
          OR ui.color_name ILIKE $${paramIndex})`
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
      conditions.push(`s.finish = $${paramIndex}`);
      params.push(finishFilter);
      paramIndex++;
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
    const where = conditions.join(" AND ");

    const result = await query(
      `${POLISH_SELECT}
       WHERE ${where}
       ORDER BY ${sortColumn} ${sortOrder} NULLS LAST
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, pageSize, offset]
    );

    const countResult = await query(
      `SELECT COUNT(*) AS total
       FROM user_inventory_item ui
       LEFT JOIN shade s ON ui.shade_id = s.shade_id
       LEFT JOIN brand b ON s.brand_id = b.brand_id
       WHERE ${where}`,
      params
    );

    return {
      status: 200,
      jsonBody: {
        polishes: result.rows,
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

async function createPolish(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("POST /api/polishes");

  try {
    const body = (await request.json()) as PolishCreateRequest;

    if (!body.brand || !body.name) {
      return { status: 400, jsonBody: { error: "Brand and name are required" } };
    }

    const userId = 1; // TODO: get from auth token

    const inventoryId = await transaction(async (client) => {
      // Find or create canonical brand + shade
      const shadeId = await findOrCreateShade(
        client, body.brand, body.name, body.finish, body.collection
      );

      // Insert inventory item linked to the shade
      const result = await client.query<{ id: number }>(
        `INSERT INTO user_inventory_item
          (user_id, shade_id, quantity, notes, purchase_date, expiration_date,
           color_name, color_hex, rating, tags, size_display)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING inventory_item_id AS id`,
        [
          userId,
          shadeId,
          body.quantity || 1,
          body.notes || null,
          body.purchaseDate || null,
          body.expirationDate || null,
          body.color || null,
          body.colorHex || null,
          body.rating || null,
          body.tags && body.tags.length ? body.tags : null,
          body.size || null,
        ]
      );
      return result.rows[0].id;
    });

    // Re-fetch via shared SELECT for consistent shape
    const created = await query(
      `${POLISH_SELECT} WHERE ui.inventory_item_id = $1`,
      [inventoryId]
    );

    return { status: 201, jsonBody: created.rows[0] };
  } catch (error: any) {
    context.error("Error creating polish:", error);
    return { status: 500, jsonBody: { error: "Failed to create polish", details: error.message } };
  }
}

async function updatePolish(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("PUT /api/polishes");

  const id = request.params.id;
  if (!id) {
    return { status: 400, jsonBody: { error: "Polish id is required" } };
  }

  try {
    const body = (await request.json()) as PolishUpdateRequest;
    const userId = 1; // TODO: get from auth token
    const itemId = parseInt(id, 10);

    const updated = await transaction(async (client) => {
      // If brand or name changed, find-or-create the new shade and update the link
      if (body.brand && body.name) {
        const shadeId = await findOrCreateShade(
          client, body.brand, body.name, body.finish, body.collection
        );
        await client.query(
          `UPDATE user_inventory_item SET shade_id = $1 WHERE inventory_item_id = $2 AND user_id = $3`,
          [shadeId, itemId, userId]
        );
      }

      // Update user-facing columns
      const result = await client.query<{ id: number }>(
        `UPDATE user_inventory_item
        SET
          quantity        = COALESCE($1, quantity),
          notes           = COALESCE($2, notes),
          purchase_date   = COALESCE($3, purchase_date),
          expiration_date = COALESCE($4, expiration_date),
          color_name      = COALESCE($5, color_name),
          color_hex       = COALESCE($6, color_hex),
          rating          = COALESCE($7, rating),
          tags            = COALESCE($8, tags),
          size_display    = COALESCE($9, size_display),
          updated_at      = now()
        WHERE inventory_item_id = $10 AND user_id = $11
        RETURNING inventory_item_id AS id`,
        [
          body.quantity ?? null,
          body.notes ?? null,
          body.purchaseDate ?? null,
          body.expirationDate ?? null,
          body.color ?? null,
          body.colorHex ?? null,
          body.rating ?? null,
          body.tags && body.tags.length ? body.tags : null,
          body.size ?? null,
          itemId,
          userId,
        ]
      );

      return result.rows.length > 0 ? result.rows[0].id : null;
    });

    if (updated === null) {
      return { status: 404, jsonBody: { error: "Polish not found or unauthorized" } };
    }

    // Re-fetch via shared SELECT for consistent shape
    const fullResult = await query(
      `${POLISH_SELECT} WHERE ui.inventory_item_id = $1`,
      [itemId]
    );

    return { status: 200, jsonBody: fullResult.rows[0] };
  } catch (error: any) {
    context.error("Error updating polish:", error);
    return { status: 500, jsonBody: { error: "Failed to update polish", details: error.message } };
  }
}

async function deletePolish(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("DELETE /api/polishes");

  const id = request.params.id;
  if (!id) {
    return { status: 400, jsonBody: { error: "Polish id is required" } };
  }

  try {
    const userId = 1; // TODO: get from auth token

    const result = await query(
      `DELETE FROM user_inventory_item
      WHERE inventory_item_id = $1 AND user_id = $2
      RETURNING inventory_item_id::text as id`,
      [parseInt(id, 10), userId]
    );

    if (result.rows.length === 0) {
      return { status: 404, jsonBody: { error: "Polish not found or unauthorized" } };
    }

    return { status: 200, jsonBody: { message: "Polish deleted successfully", id: result.rows[0].id } };
  } catch (error: any) {
    context.error("Error deleting polish:", error);
    return { status: 500, jsonBody: { error: "Failed to delete polish", details: error.message } };
  }
}

app.http("polishes-list", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "polishes/{id?}",
  handler: getPolishes,
});

app.http("polishes-create", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "polishes",
  handler: createPolish,
});

app.http("polishes-update", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "polishes/{id}",
  handler: updatePolish,
});

app.http("polishes-delete", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "polishes/{id}",
  handler: deletePolish,
});
