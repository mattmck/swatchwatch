import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  isProductCategory,
  PRODUCT_CATEGORIES,
  type ProductCategory,
  type ProductCategoryBackfillReport,
  type ShadeProductCategoryItem,
  type ShadeProductCategoryListResponse,
  type ShadeProductCategoryUpdateResponse,
} from "swatchwatch-shared";
import { withAdmin } from "../lib/auth";
import { query, transaction } from "../lib/db";
import { internalServerError } from "../lib/errors";
import { withCors } from "../lib/http";
import { invalidateCatalogWideCaches } from "../lib/polish-cache";
import { runProductCategoryBackfill } from "../lib/product-category-backfill";
import { trackEvent } from "../lib/telemetry";

/**
 * Product categories for shades (#349, #347; decision D23). Admin-only (`withAdmin`).
 *
 * POST /api/shades-admin/product-category/backfill — re-classify the catalog; dry run by default
 *                                                    (`ProductCategoryBackfillReport`)
 * GET  /api/shades-admin/product-category          — browse shades by category (`?category=`, `q`)
 * PUT  /api/shades-admin/{id}/product-category     — admin override (`product_category_source = 'admin'`)
 */

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseShadeId(raw: unknown): number | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,18}$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function readJson(request: HttpRequest): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  try {
    const text = await request.text();
    const parsed = text.trim() ? JSON.parse(text) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ok: true, body: parsed as Record<string, unknown> }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function migrationMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42703" || code === "42P01";
}

/** Parse the backfill body; returns an error message for a bad body. */
export function parseBackfillBody(body: Record<string, unknown>): { dryRun: boolean; clearTopperDetectedHex: boolean } | string {
  const dryRun = body.dryRun ?? true;
  const clearTopperDetectedHex = body.clearTopperDetectedHex ?? false;
  if (typeof dryRun !== "boolean") return "dryRun must be a boolean";
  if (typeof clearTopperDetectedHex !== "boolean") return "clearTopperDetectedHex must be a boolean";
  return { dryRun, clearTopperDetectedHex };
}

async function backfill(request: HttpRequest, context: InvocationContext, adminUserId: number): Promise<HttpResponseInit> {
  const json = await readJson(request);
  if (!json.ok) return { status: 400, jsonBody: { error: "Request body must be a JSON object" } };
  const options = parseBackfillBody(json.body);
  if (typeof options === "string") return { status: 400, jsonBody: { error: options } };

  let report: ProductCategoryBackfillReport;
  try {
    report = await runProductCategoryBackfill({ query, transaction }, { ...options, actorUserId: adminUserId });
  } catch (error) {
    if (migrationMissing(error)) {
      return { status: 503, jsonBody: { error: "Product category migration is not applied yet" } };
    }
    return internalServerError(context, error, "Product category backfill failed", "shades-admin.product-category-backfill");
  }

  if (!report.dryRun) {
    await invalidateCatalogWideCaches([]);
  }
  context.log(
    `[product-category-backfill] dryRun=${report.dryRun} scanned=${report.scannedShades} changes=${report.categoryChanges.length} exclude=${report.excluded.length} held=${report.heldAccessories.length} hexCandidates=${report.topperHexCandidates.length} applied=${JSON.stringify(report.applied)} runId=${report.runId ?? "-"}`
  );
  trackEvent("product_category.backfill", {
    dryRun: String(report.dryRun),
    clearTopperDetectedHex: String(report.clearTopperDetectedHex),
    scannedShades: String(report.scannedShades),
    categoryChanges: String(report.categoryChanges.length),
    excluded: String(report.excluded.length),
    heldAccessories: String(report.heldAccessories.length),
    appliedCategory: String(report.applied.category),
    appliedExclude: String(report.applied.exclude),
    appliedClearDetectedHex: String(report.applied.clearDetectedHex),
  });
  return { status: 200, jsonBody: report };
}

async function listByCategory(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const rawCategory = request.query.get("category")?.trim() || "";
  const categories = rawCategory ? rawCategory.split(",").map((value) => value.trim()).filter(Boolean) : [];
  const invalid = categories.find((value) => !isProductCategory(value));
  if (invalid) {
    return { status: 400, jsonBody: { error: `Invalid category '${invalid}'. Valid values: ${PRODUCT_CATEGORIES.join(", ")}` } };
  }
  const search = request.query.get("q")?.trim() || "";
  const page = clampInt(request.query.get("page"), 1, 1, 100_000);
  const pageSize = clampInt(request.query.get("pageSize"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

  const conditions = ["s.merged_into_shade_id IS NULL"];
  const params: unknown[] = [];
  if (categories.length > 0) {
    params.push(categories);
    conditions.push(`s.product_category = ANY($${params.length}::text[])`);
  }
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    conditions.push(`(s.shade_name_canonical ILIKE $${params.length} OR b.name_canonical ILIKE $${params.length})`);
  }
  const where = conditions.join(" AND ");

  try {
    const countResult = await query<{ total: string }>(
      `SELECT count(*) AS total FROM shade s JOIN brand b ON b.brand_id = s.brand_id WHERE ${where}`,
      params
    );
    const rows = await query<{
      shadeId: string;
      brand: string;
      name: string;
      status: string;
      productCategory: ProductCategory;
      productCategorySource: "rule" | "admin";
      holders: string;
    }>(
      `SELECT
         s.shade_id::text AS "shadeId",
         b.name_canonical AS brand,
         s.shade_name_canonical AS name,
         s.status,
         s.product_category AS "productCategory",
         s.product_category_source AS "productCategorySource",
         (SELECT count(DISTINCT ui.user_id) FROM user_inventory_item ui WHERE ui.shade_id = s.shade_id)::text AS holders
       FROM shade s
       JOIN brand b ON b.brand_id = s.brand_id
       WHERE ${where}
       ORDER BY b.name_canonical, s.shade_name_canonical, s.shade_id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const items: ShadeProductCategoryItem[] = rows.rows.map((row) => ({
      ...row,
      holders: Number.parseInt(row.holders, 10) || 0,
    }));
    const response: ShadeProductCategoryListResponse = {
      items,
      total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10),
      page,
      pageSize,
    };
    return { status: 200, jsonBody: response };
  } catch (error) {
    if (migrationMissing(error)) {
      return { status: 503, jsonBody: { error: "Product category migration is not applied yet" } };
    }
    return internalServerError(context, error, "Failed to list shades by category", "shades-admin.product-category-list");
  }
}

async function setCategory(request: HttpRequest, context: InvocationContext, adminUserId: number): Promise<HttpResponseInit> {
  const shadeId = parseShadeId(request.params.id);
  if (!shadeId) return { status: 400, jsonBody: { error: "Invalid shade id" } };
  const json = await readJson(request);
  if (!json.ok) return { status: 400, jsonBody: { error: "Request body must be a JSON object" } };
  const productCategory = json.body.productCategory;
  if (!isProductCategory(productCategory)) {
    return { status: 400, jsonBody: { error: `productCategory must be one of: ${PRODUCT_CATEGORIES.join(", ")}` } };
  }

  try {
    const outcome = await transaction(async (client) => {
      const current = await client.query<{ productCategory: string; productCategorySource: string; status: string }>(
        `SELECT product_category AS "productCategory", product_category_source AS "productCategorySource", status
         FROM shade
         WHERE shade_id = $1 AND merged_into_shade_id IS NULL
         FOR UPDATE`,
        [shadeId]
      );
      const before = current.rows[0];
      if (!before) return null;
      // An excluded accessory that is no longer an accessory goes back to the catalog; an active
      // shade made an accessory is excluded right away when nobody holds it (same rule as the backfill).
      let status = before.status;
      if (before.status === "excluded" && productCategory !== "accessory") {
        status = "active";
      } else if (before.status === "active" && productCategory === "accessory") {
        const held = await client.query(
          `SELECT 1 FROM user_inventory_item WHERE shade_id = $1 LIMIT 1`,
          [shadeId]
        );
        if (held.rows.length === 0) status = "excluded";
      }
      await client.query(
        `UPDATE shade
         SET product_category = $2, product_category_source = 'admin', status = $3, updated_at = now()
         WHERE shade_id = $1`,
        [shadeId, productCategory, status]
      );
      await client.query(
        `INSERT INTO shade_category_change (shade_id, action, before, after, source, actor_user_id)
         VALUES ($1, 'category', $2::jsonb, $3::jsonb, 'admin', $4)`,
        [
          shadeId,
          JSON.stringify({ productCategory: before.productCategory, productCategorySource: before.productCategorySource, status: before.status }),
          JSON.stringify({ productCategory, productCategorySource: "admin", status }),
          adminUserId,
        ]
      );
      return { status };
    });
    if (!outcome) return { status: 404, jsonBody: { error: "Shade not found" } };

    await invalidateCatalogWideCaches([shadeId]);
    trackEvent("product_category.admin_set", { productCategory });
    const response: ShadeProductCategoryUpdateResponse = {
      shadeId: String(shadeId),
      productCategory,
      productCategorySource: "admin",
      status: outcome.status,
    };
    return { status: 200, jsonBody: response };
  } catch (error) {
    if (migrationMissing(error)) {
      return { status: 503, jsonBody: { error: "Product category migration is not applied yet" } };
    }
    return internalServerError(context, error, "Failed to set the product category", "shades-admin.product-category-set");
  }
}

app.http("admin-product-category-backfill", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/product-category/backfill",
  handler: withCors(withAdmin(backfill)),
});

app.http("admin-product-category-list", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/product-category",
  handler: withCors(withAdmin(async (request, context) => listByCategory(request, context))),
});

app.http("admin-product-category-set", {
  methods: ["PUT", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/{id}/product-category",
  handler: withCors(withAdmin(setCategory)),
});
