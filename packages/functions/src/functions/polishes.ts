import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { Polish, PolishCreateRequest, PolishUpdateRequest, PolishListResponse } from "swatchwatch-shared";
import { query } from "../lib/db";

/**
 * Shared SELECT fragment — returns Polish-shaped rows.
 * Uses COALESCE so user-facing columns take priority over canonical shade/brand joins.
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
    ui.created_at                               AS "createdAt",
    ui.updated_at                               AS "updatedAt"
  FROM user_inventory_item ui
  LEFT JOIN shade s  ON ui.shade_id = s.shade_id
  LEFT JOIN brand b  ON s.brand_id  = b.brand_id`;

async function getPolishes(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/polishes - Listing polishes");

  const id = request.params.id;

  if (id) {
    try {
      const result = await query<any>(
        `${POLISH_SELECT} WHERE ui.inventory_item_id = $1`,
        [parseInt(id, 10)]
      );

      if (result.rows.length === 0) {
        return {
          status: 404,
          jsonBody: { error: "Polish not found" },
        };
      }

      return {
        status: 200,
        jsonBody: result.rows[0],
      };
    } catch (error: any) {
      context.error("Error fetching polish:", error);
      return {
        status: 500,
        jsonBody: { error: "Failed to fetch polish", details: error.message },
      };
    }
  }

  // List all polishes for the user (TODO: get userId from auth token)
  try {
    const userId = 1; // Placeholder — will come from auth token

    const result = await query<any>(
      `${POLISH_SELECT} WHERE ui.user_id = $1 ORDER BY ui.created_at DESC`,
      [userId]
    );

    return {
      status: 200,
      jsonBody: {
        polishes: result.rows,
        total: result.rows.length,
        page: 1,
        pageSize: result.rows.length,
      } as PolishListResponse,
    };
  } catch (error: any) {
    context.error("Error fetching polishes:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to fetch polishes", details: error.message },
    };
  }
}

async function createPolish(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("POST /api/polishes - Creating polish");

  try {
    const body = (await request.json()) as PolishCreateRequest;

    if (!body.brand || !body.name) {
      return {
        status: 400,
        jsonBody: { error: "Brand and name are required" },
      };
    }

    const userId = 1; // TODO: get from auth token

    // Insert inventory item with user-facing columns.
    // shade_id is left NULL for now — matching resolver will link later.
    const result = await query<any>(
      `INSERT INTO user_inventory_item
        (user_id, quantity, notes, purchase_date, color_name, color_hex, rating, tags, size_display)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING inventory_item_id AS id`,
      [
        userId,
        body.quantity || 1,
        body.notes || null,
        body.purchaseDate || null,
        body.color || null,
        body.colorHex || null,
        body.rating || null,
        body.tags && body.tags.length ? body.tags : null,
        body.size || null,
      ]
    );

    // Re-fetch via shared SELECT for consistent shape
    const created = await query<any>(
      `${POLISH_SELECT} WHERE ui.inventory_item_id = $1`,
      [result.rows[0].id]
    );

    // Overlay user-provided brand/name (no canonical link yet)
    const row = created.rows[0];
    row.brand = row.brand || body.brand;
    row.name = row.name || body.name;
    row.finish = row.finish || body.finish || "";
    row.collection = row.collection || body.collection || "";

    return {
      status: 201,
      jsonBody: row,
    };
  } catch (error: any) {
    context.error("Error creating polish:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to create polish", details: error.message },
    };
  }
}

async function updatePolish(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("PUT /api/polishes - Updating polish");

  const id = request.params.id;
  if (!id) {
    return {
      status: 400,
      jsonBody: { error: "Polish id is required" },
    };
  }

  try {
    const body = (await request.json()) as PolishUpdateRequest;
    const userId = 1; // TODO: get from auth token

    const result = await query<any>(
      `UPDATE user_inventory_item 
      SET 
        quantity       = COALESCE($1, quantity),
        notes          = COALESCE($2, notes),
        purchase_date  = COALESCE($3, purchase_date),
        color_name     = COALESCE($4, color_name),
        color_hex      = COALESCE($5, color_hex),
        rating         = COALESCE($6, rating),
        tags           = COALESCE($7, tags),
        size_display   = COALESCE($8, size_display),
        updated_at     = now()
      WHERE inventory_item_id = $9 AND user_id = $10
      RETURNING inventory_item_id AS id`,
      [
        body.quantity, body.notes, body.purchaseDate,
        body.color, body.colorHex, body.rating,
        body.tags && body.tags.length ? body.tags : null,
        body.size,
        parseInt(id, 10), userId,
      ]
    );

    if (result.rows.length === 0) {
      return {
        status: 404,
        jsonBody: { error: "Polish not found or unauthorized" },
      };
    }

    // Re-fetch via shared SELECT for consistent shape
    const fullResult = await query<any>(
      `${POLISH_SELECT} WHERE ui.inventory_item_id = $1`,
      [parseInt(id, 10)]
    );

    return {
      status: 200,
      jsonBody: fullResult.rows[0],
    };
  } catch (error: any) {
    context.error("Error updating polish:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to update polish", details: error.message },
    };
  }
}

async function deletePolish(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("DELETE /api/polishes - Deleting polish");

  const id = request.params.id;
  if (!id) {
    return {
      status: 400,
      jsonBody: { error: "Polish id is required" },
    };
  }

  try {
    const userId = 1; // TODO: get from auth token

    const result = await query<any>(
      `DELETE FROM user_inventory_item 
      WHERE inventory_item_id = $1 AND user_id = $2
      RETURNING inventory_item_id as id`,
      [parseInt(id, 10), userId]
    );

    if (result.rows.length === 0) {
      return {
        status: 404,
        jsonBody: { error: "Polish not found or unauthorized" },
      };
    }

    return {
      status: 200,
      jsonBody: { message: "Polish deleted successfully", id: result.rows[0].id },
    };
  } catch (error: any) {
    context.error("Error deleting polish:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to delete polish", details: error.message },
    };
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
