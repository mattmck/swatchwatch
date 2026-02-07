import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { Polish, PolishCreateRequest, PolishUpdateRequest, PolishListResponse } from "swatchwatch-shared";
import { query } from "../lib/db";

async function getPolishes(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/polishes - Listing polishes");

  const id = request.params.id;

  if (id) {
    try {
      const result = await query<any>(
        `SELECT 
          ui.inventory_item_id as id,
          ui.user_id as "userId",
          b.name_canonical as brand,
          s.shade_name_canonical as name,
          s.collection as collection,
          s.finish as finish,
          ui.quantity,
          ui.notes,
          ui.purchase_date as "purchaseDate",
          ui.created_at as "createdAt"
        FROM user_inventory_item ui
        LEFT JOIN shade s ON ui.shade_id = s.shade_id
        LEFT JOIN brand b ON s.brand_id = b.brand_id
        WHERE ui.inventory_item_id = $1`,
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
      `SELECT 
        ui.inventory_item_id as id,
        ui.user_id as "userId",
        b.name_canonical as brand,
        s.shade_name_canonical as name,
        '' as color,
        s.collection,
        s.finish,
        ui.quantity,
        ui.notes,
        ui.purchase_date as "purchaseDate",
        ui.created_at as "createdAt",
        ui.created_at as "updatedAt"
      FROM user_inventory_item ui
      LEFT JOIN shade s ON ui.shade_id = s.shade_id
      LEFT JOIN brand b ON s.brand_id = b.brand_id
      WHERE ui.user_id = $1
      ORDER BY ui.created_at DESC`,
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

    // For MVP, create unlinked inventory item (shade_id = NULL)
    // Later, matching resolver will link to canonical shade
    const result = await query<any>(
      `INSERT INTO user_inventory_item 
        (user_id, quantity, notes, purchase_date, status)
      VALUES ($1, $2, $3, $4, 'active')
      RETURNING 
        inventory_item_id as id,
        user_id as "userId",
        quantity,
        notes,
        purchase_date as "purchaseDate",
        created_at as "createdAt",
        created_at as "updatedAt"`,
      [userId, body.quantity || 1, body.notes || "", body.purchaseDate || null]
    );

    const created = result.rows[0];
    
    // Return with user-provided brand/name (no canonical link yet)
    return {
      status: 201,
      jsonBody: {
        ...created,
        brand: body.brand,
        name: body.name,
        color: body.color || "",
        finish: body.finish,
        collection: body.collection,
      },
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
        quantity = COALESCE($1, quantity),
        notes = COALESCE($2, notes),
        purchase_date = COALESCE($3, purchase_date)
      WHERE inventory_item_id = $4 AND user_id = $5
      RETURNING 
        inventory_item_id as id,
        user_id as "userId",
        quantity,
        notes,
        purchase_date as "purchaseDate",
        created_at as "createdAt",
        created_at as "updatedAt"`,
      [body.quantity, body.notes, body.purchaseDate, parseInt(id, 10), userId]
    );

    if (result.rows.length === 0) {
      return {
        status: 404,
        jsonBody: { error: "Polish not found or unauthorized" },
      };
    }

    // Fetch joined data for full response
    const fullResult = await query<any>(
      `SELECT 
        ui.inventory_item_id as id,
        ui.user_id as "userId",
        b.name_canonical as brand,
        s.shade_name_canonical as name,
        '' as color,
        s.collection,
        s.finish,
        ui.quantity,
        ui.notes,
        ui.purchase_date as "purchaseDate",
        ui.created_at as "createdAt",
        ui.created_at as "updatedAt"
      FROM user_inventory_item ui
      LEFT JOIN shade s ON ui.shade_id = s.shade_id
      LEFT JOIN brand b ON s.brand_id = b.brand_id
      WHERE ui.inventory_item_id = $1`,
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
