import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  CatalogSearchResponse,
  CatalogShadeDetail,
  resolveProductCategory,
  type ColorFamily,
  type ProductCategory,
} from "swatchwatch-shared";
import { query } from "../lib/db";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { cacheGetJson, cacheSetJson, hashCacheKey } from "../lib/cache";
import { trackEvent } from "../lib/telemetry";
import { loadBuyUrlsForShades } from "../lib/buy-link";
import { parseColorFamilyFilter } from "../lib/color-family-filter";
import { parseProductCategoryFilter } from "../lib/product-category-filter";

const CATALOG_SEARCH_CACHE_TTL_SECONDS = 120;
const CATALOG_SHADE_CACHE_TTL_SECONDS = 300;

/**
 * GET /api/catalog/search?q=<term>&limit=<n>&family=<family[,family…]>
 *
 * Trigram search across brand names, shade names, and their aliases.
 * Uses pg_trgm similarity() for ranking. Returns top matches. `family` (optional,
 * comma-separated) restricts results to shades in any of those color families
 * (`shade.color_family`, #103) before ranking and the limit are applied. `category` (optional,
 * comma-separated) does the same for `shade.product_category` (#349). Accessories are never
 * returned (D-C), whatever the filter says.
 */
async function searchCatalog(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/catalog/search");

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();

  if (!q) {
    return { status: 400, jsonBody: { error: "Query parameter 'q' is required" } };
  }

  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
  const familyFilter = parseColorFamilyFilter(url.searchParams);
  if (!familyFilter.ok) {
    return { status: 400, jsonBody: { error: familyFilter.error } };
  }
  const families = familyFilter.families;
  const categoryFilter = parseProductCategoryFilter(url.searchParams);
  if (!categoryFilter.ok) {
    return { status: 400, jsonBody: { error: categoryFilter.error } };
  }
  const categories = categoryFilter.categories;
  const normalizedQuery = q.toLowerCase();
  // The family suffix is only added when filtering so existing cache keys are unchanged.
  const familyCachePart = families.length > 0 ? `|family:${families.join(",")}` : "";
  const categoryCachePart = categories.length > 0 ? `|category:${categories.join(",")}` : "";
  const searchCacheKey = `catalog:search:h:${hashCacheKey(`${normalizedQuery}|${limit}${familyCachePart}${categoryCachePart}`)}`;

  try {
    const cachedSearch = await cacheGetJson<CatalogSearchResponse>(searchCacheKey);
    if (cachedSearch) {
      return {
        status: 200,
        jsonBody: {
          ...cachedSearch,
          query: q,
        },
      };
    }

    // Search shades by name similarity + brand name similarity,
    // also checking shade_alias and brand_alias tables.
    // Best match wins — take the highest similarity score per shade.
    const result = await query<{
      shadeId: string;
      brand: string;
      name: string;
      finish: string | null;
      finishes: string[] | null;
      collection: string | null;
      colorFamily: ColorFamily | null;
      productCategory: ProductCategory;
      similarity: number;
    }>(
      `SELECT DISTINCT ON (s.shade_id)
         s.shade_id::text              AS "shadeId",
         b.name_canonical              AS brand,
         s.shade_name_canonical        AS name,
         COALESCE(NULLIF(s.finish, ''), s.finishes[1]) AS finish,
         COALESCE(s.finishes, ARRAY[]::text[]) AS finishes,
         s.collection,
         s.color_family                AS "colorFamily",
         s.product_category            AS "productCategory",
         GREATEST(
           similarity(s.shade_name_canonical, $1),
           similarity(b.name_canonical, $1),
           COALESCE((SELECT MAX(similarity(sa.alias, $1)) FROM shade_alias sa WHERE sa.shade_id = s.shade_id), 0),
           COALESCE((SELECT MAX(similarity(ba.alias, $1)) FROM brand_alias ba WHERE ba.brand_id = b.brand_id), 0)
         ) AS similarity
       FROM shade s
       JOIN brand b ON s.brand_id = b.brand_id
       WHERE s.status = 'active'
         AND s.product_category <> 'accessory'
         AND ($2::text[] IS NULL OR s.color_family = ANY($2::text[]))
         AND ($3::text[] IS NULL OR s.product_category = ANY($3::text[]))
         AND (
           s.shade_name_canonical % $1
           OR b.name_canonical % $1
           OR EXISTS (SELECT 1 FROM shade_alias sa WHERE sa.shade_id = s.shade_id AND sa.alias % $1)
           OR EXISTS (SELECT 1 FROM brand_alias ba WHERE ba.brand_id = b.brand_id AND ba.alias % $1)
         )
       ORDER BY s.shade_id, similarity DESC`,
      [q, families.length > 0 ? families : null, categories.length > 0 ? categories : null]
    );

    // Re-sort by similarity descending and apply limit
    const sorted = result.rows
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    // "Buy from brand" links (#267) for the returned page only.
    const buyUrls = await loadBuyUrlsForShades(sorted.map((r) => r.shadeId));

    const response: CatalogSearchResponse = {
      results: sorted.map((r) => ({
        shadeId: r.shadeId,
        brand: r.brand,
        name: r.name,
        finish: r.finish || undefined,
        finishes: r.finishes ?? [],
        collection: r.collection || undefined,
        colorFamily: r.colorFamily ?? null,
        productCategory: resolveProductCategory(r.productCategory),
        similarity: Math.round(r.similarity * 1000) / 1000,
        buyUrl: buyUrls.get(r.shadeId),
      })),
      query: q,
      total: sorted.length,
    };
    trackEvent("catalog.search", {
      queryLength: q.length,
      resultCount: sorted.length,
      limit,
      familyCount: families.length,
    });

    await cacheSetJson(searchCacheKey, response, CATALOG_SEARCH_CACHE_TTL_SECONDS);

    return { status: 200, jsonBody: response };
  } catch (error: any) {
    return internalServerError(context, error, "Failed to search catalog", "catalog.search");
  }
}

/**
 * GET /api/catalog/shade/{id}
 *
 * Returns a single shade with brand info and aliases. Anonymous and globally cached, so
 * private `user_submitted` shades are excluded (same 404 as a missing shade).
 */
async function getShade(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/catalog/shade");

  const id = request.params.id;
  if (!id) {
    return { status: 400, jsonBody: { error: "Shade id is required" } };
  }

  try {
    const shadeId = parseInt(id, 10);
    if (Number.isNaN(shadeId) || shadeId <= 0) {
      return { status: 400, jsonBody: { error: "Shade id must be a positive integer" } };
    }
    const shadeCacheKey = `catalog:shade:id:${shadeId}`;
    const cachedShade = await cacheGetJson<CatalogShadeDetail>(shadeCacheKey);
    if (cachedShade) {
      return { status: 200, jsonBody: cachedShade };
    }

    const result = await query<{
      shadeId: string;
      brand: string;
      brandId: string;
      name: string;
      finish: string | null;
      finishes: string[] | null;
      collection: string | null;
      releaseYear: number | null;
      status: string;
      productCategory: string;
    }>(
      `SELECT
         s.shade_id::text          AS "shadeId",
         b.name_canonical          AS brand,
         b.brand_id::text          AS "brandId",
         s.shade_name_canonical    AS name,
         COALESCE(NULLIF(s.finish, ''), s.finishes[1]) AS finish,
         COALESCE(s.finishes, ARRAY[]::text[]) AS finishes,
         s.collection,
         s.release_year            AS "releaseYear",
         s.status,
         s.product_category        AS "productCategory"
       FROM shade s
       JOIN brand b ON s.brand_id = b.brand_id
       WHERE s.shade_id = $1
         AND s.status <> 'user_submitted'
         AND s.status <> 'excluded'`,
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

    const buyUrls = await loadBuyUrlsForShades([shade.shadeId]);

    const response: CatalogShadeDetail = {
      shadeId: shade.shadeId,
      brand: shade.brand,
      brandId: shade.brandId,
      name: shade.name,
      finish: shade.finish || undefined,
      finishes: shade.finishes ?? [],
      collection: shade.collection || undefined,
      releaseYear: shade.releaseYear || undefined,
      status: shade.status,
      productCategory: resolveProductCategory(shade.productCategory),
      aliases: aliasResult.rows.map((r) => r.alias),
      buyUrl: buyUrls.get(shade.shadeId),
    };

    await cacheSetJson(shadeCacheKey, response, CATALOG_SHADE_CACHE_TTL_SECONDS);

    return { status: 200, jsonBody: response };
  } catch (error: any) {
    return internalServerError(context, error, "Failed to fetch shade", "catalog.shade");
  }
}

app.http("catalog-search", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "catalog/search",
  handler: withCors(searchCatalog),
});

app.http("catalog-shade", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "catalog/shade/{id}",
  handler: withCors(getShade),
});
