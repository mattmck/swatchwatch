import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { CatalogSearchResponse, CatalogShadeDetail } from "swatchwatch-shared";
import { query } from "../lib/db";

/**
 * GET /api/catalog/search?q=<term>&limit=<n>
 *
 * Trigram search across brand names, shade names, and their aliases.
 * Uses pg_trgm similarity() for ranking. Returns top matches.
 */
async function searchCatalog(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/catalog/search");

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();

  if (!q) {
    return { status: 400, jsonBody: { error: "Query parameter 'q' is required" } };
  }

  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));

  try {
    // Search shades by name similarity + brand name similarity,
    // also checking shade_alias and brand_alias tables.
    // Best match wins — take the highest similarity score per shade.
    const result = await query<{
      shadeId: string;
      brand: string;
      name: string;
      finish: string | null;
      collection: string | null;
      similarity: number;
    }>(
      `SELECT DISTINCT ON (s.shade_id)
         s.shade_id::text              AS "shadeId",
         b.name_canonical              AS brand,
         s.shade_name_canonical        AS name,
         s.finish,
         s.collection,
         GREATEST(
           similarity(s.shade_name_canonical, $1),
           similarity(b.name_canonical, $1),
           COALESCE((SELECT MAX(similarity(sa.alias, $1)) FROM shade_alias sa WHERE sa.shade_id = s.shade_id), 0),
           COALESCE((SELECT MAX(similarity(ba.alias, $1)) FROM brand_alias ba WHERE ba.brand_id = b.brand_id), 0)
         ) AS similarity
       FROM shade s
       JOIN brand b ON s.brand_id = b.brand_id
       WHERE s.status = 'active'
         AND (
           s.shade_name_canonical % $1
           OR b.name_canonical % $1
           OR EXISTS (SELECT 1 FROM shade_alias sa WHERE sa.shade_id = s.shade_id AND sa.alias % $1)
           OR EXISTS (SELECT 1 FROM brand_alias ba WHERE ba.brand_id = b.brand_id AND ba.alias % $1)
         )
       ORDER BY s.shade_id, similarity DESC`,
      [q]
    );

    // Re-sort by similarity descending and apply limit
    const sorted = result.rows
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    const response: CatalogSearchResponse = {
      results: sorted.map((r) => ({
        shadeId: r.shadeId,
        brand: r.brand,
        name: r.name,
        finish: r.finish || undefined,
        collection: r.collection || undefined,
        similarity: Math.round(r.similarity * 1000) / 1000,
      })),
      query: q,
      total: sorted.length,
    };

    return { status: 200, jsonBody: response };
  } catch (error: any) {
    context.error("Error searching catalog:", error);
    return { status: 500, jsonBody: { error: "Failed to search catalog", details: error.message } };
  }
}

/**
 * GET /api/catalog/shade/{id}
 *
 * Returns a single shade with brand info and aliases.
 */
async function getShade(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/catalog/shade");

  const id = request.params.id;
  if (!id) {
    return { status: 400, jsonBody: { error: "Shade id is required" } };
  }

  try {
    const shadeId = parseInt(id, 10);

    const result = await query<{
      shadeId: string;
      brand: string;
      brandId: string;
      name: string;
      finish: string | null;
      collection: string | null;
      releaseYear: number | null;
      status: string;
    }>(
      `SELECT
         s.shade_id::text          AS "shadeId",
         b.name_canonical          AS brand,
         b.brand_id::text          AS "brandId",
         s.shade_name_canonical    AS name,
         s.finish,
         s.collection,
         s.release_year            AS "releaseYear",
         s.status
       FROM shade s
       JOIN brand b ON s.brand_id = b.brand_id
       WHERE s.shade_id = $1`,
      [shadeId]
    );

    if (result.rows.length === 0) {
      return { status: 404, jsonBody: { error: "Shade not found" } };
    }

    const shade = result.rows[0];

    // Fetch aliases
    const aliasResult = await query<{ alias: string }>(
      `SELECT alias FROM shade_alias WHERE shade_id = $1 ORDER BY alias`,
      [shadeId]
    );

    const response: CatalogShadeDetail = {
      shadeId: shade.shadeId,
      brand: shade.brand,
      brandId: shade.brandId,
      name: shade.name,
      finish: shade.finish || undefined,
      collection: shade.collection || undefined,
      releaseYear: shade.releaseYear || undefined,
      status: shade.status,
      aliases: aliasResult.rows.map((r) => r.alias),
    };

    return { status: 200, jsonBody: response };
  } catch (error: any) {
    context.error("Error fetching shade:", error);
    return { status: 500, jsonBody: { error: "Failed to fetch shade", details: error.message } };
  }
}

app.http("catalog-search", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "catalog/search",
  handler: searchCatalog,
});

app.http("catalog-shade", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "catalog/shade/{id}",
  handler: getShade,
});
