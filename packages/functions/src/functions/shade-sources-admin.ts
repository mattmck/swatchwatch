import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { ShadeSourceProduct, ShadeSourceProductsResponse } from "swatchwatch-shared";
import { withAdmin } from "../lib/auth";
import { query } from "../lib/db";
import { internalServerError } from "../lib/errors";
import { withCors } from "../lib/http";

/**
 * GET /api/shades-admin/{id}/source-products — every connector product materialized into the
 * shade (`shade_source_product` → `external_product`), newest sighting first, with the raw payload
 * and the normalized record. Admin-only (`withAdmin`); a shade with no linked product (user
 * submissions, products ingested before the link existed) returns an empty list.
 */
export async function getShadeSourceProducts(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const raw = (request.params.id ?? "").trim();
  if (!/^\d{1,18}$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
    return { status: 400, jsonBody: { error: "Invalid shade id" } };
  }
  const shadeId = Number(raw);

  try {
    const shade = await query(`SELECT 1 FROM shade WHERE shade_id = $1`, [shadeId]);
    if (shade.rows.length === 0) return { status: 404, jsonBody: { error: "Shade not found" } };

    const result = await query<Omit<ShadeSourceProduct, "fetchedAt" | "firstSeenAt" | "lastSeenAt"> & {
      fetchedAt: Date | string;
      firstSeenAt: Date | string;
      lastSeenAt: Date | string;
    }>(
      `SELECT ep.external_product_id::text AS "externalProductId",
              ds.name AS source,
              ds.enabled AS "sourceEnabled",
              ep.external_id AS "externalId",
              ep.gtin,
              ep.normalized_json ->> 'productUrl' AS "productUrl",
              ep.fetched_at AS "fetchedAt",
              ssp.first_seen_at AS "firstSeenAt",
              ssp.last_seen_at AS "lastSeenAt",
              ep.raw_json AS "rawJson",
              ep.normalized_json AS "normalizedJson"
       FROM shade_source_product ssp
       JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
       JOIN data_source ds ON ds.data_source_id = ep.data_source_id
       WHERE ssp.shade_id = $1
       ORDER BY ssp.last_seen_at DESC, ep.external_product_id DESC`,
      [shadeId]
    );
    const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : String(value));
    const response: ShadeSourceProductsResponse = {
      shadeId: String(shadeId),
      products: result.rows.map((row) => ({
        ...row,
        fetchedAt: iso(row.fetchedAt),
        firstSeenAt: iso(row.firstSeenAt),
        lastSeenAt: iso(row.lastSeenAt),
      })),
    };
    return { status: 200, jsonBody: response };
  } catch (error) {
    return internalServerError(context, error, "Failed to load the shade's source products", "shades-admin.source-products");
  }
}

app.http("shades-admin-source-products", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/{id}/source-products",
  handler: withCors(withAdmin(async (request, context) => getShadeSourceProducts(request, context))),
});
