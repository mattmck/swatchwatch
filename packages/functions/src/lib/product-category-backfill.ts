/**
 * Product-category backfill (#349, #347; decision D23, plan Phase 3–4).
 *
 * Re-classifies every unmerged shade with `classifyProductCategory` (the audit query's rules) and
 * plans three kinds of change:
 *   - `category`  the rule's category, where it differs and the source is not `admin`;
 *   - `exclude`   `status = 'excluded'` for an `active` accessory nobody holds (held accessories are
 *                 only listed, for admin review);
 *   - `clear_detected_hex`  only with `clearTopperDetectedHex`: clear `detected_hex` and its
 *                 provenance on toppers whose detected hex looks like the base color (audit
 *                 section 5: far from the vendor hex, or saturated with no vendor hex).
 * A dry run returns the report and writes nothing. An applied run makes the same changes in one
 * transaction, records each in `shade_category_change` (before/after values, so it can be undone)
 * under one `runId`, and re-checks `product_category_source <> 'admin'` and "nobody holds it" in
 * the UPDATE itself, so a concurrent admin edit or a new holder is never overwritten.
 *
 * `planProductCategoryBackfill` is pure (unit-tested); `runProductCategoryBackfill` does the I/O.
 */
import { randomUUID } from "node:crypto";
import {
  MEDIUM_CONFIDENCE_MAX_DISTANCE,
  PRODUCT_CATEGORIES,
  resolveProductCategory,
  type ProductCategory,
  type ProductCategoryBackfillReport,
  type ProductCategoryChangeItem,
  type ProductCategorySource,
} from "swatchwatch-shared";
import { classifyProductCategory, type ProductCategorySourceProduct } from "./product-category";

/** Families a clear-based topper's hex can plausibly have (audit section 5). */
const TOPPER_PLAUSIBLE_FAMILIES = new Set(["white", "grey", "nude"]);

/** One shade as the backfill reads it. */
export interface BackfillShadeRow {
  shadeId: number;
  brand: string;
  name: string;
  colorName: string | null;
  status: string;
  finishes: string[] | null;
  detectedFinishes: string[] | null;
  productCategory: string;
  productCategorySource: string;
  vendorHex: string | null;
  detectedHex: string | null;
  detectedHexConfidence: number | string | null;
  detectedHexMethod: string | null;
  detectedHexModel: string | null;
  detectedHexPromptVersion: string | null;
  detectedHexAt: string | null;
  /** `shade_color_family_from_hex(detected_hex)`. */
  detectedHexFamily: string | null;
  /** `hex_oklab_distance(vendor_hex, detected_hex)`. */
  vendorVsDetected: number | string | null;
  holders: number | string;
  products: Array<ProductCategorySourceProduct & { dataSource?: string | null }> | null;
}

export interface ProductCategoryBackfillOptions {
  dryRun: boolean;
  clearTopperDetectedHex: boolean;
}

export interface PlannedCategoryChange {
  shadeId: number;
  from: ProductCategory;
  to: ProductCategory;
}

export interface PlannedHexClear {
  shadeId: number;
  before: Record<string, unknown>;
}

export interface ProductCategoryBackfillPlan {
  report: ProductCategoryBackfillReport;
  categoryChanges: PlannedCategoryChange[];
  exclusions: number[];
  hexClears: PlannedHexClear[];
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asSource(value: string): ProductCategorySource {
  return value === "admin" ? "admin" : "rule";
}

/** Pure planner: the report and the changes an applied run would make. */
export function planProductCategoryBackfill(
  rows: readonly BackfillShadeRow[],
  options: ProductCategoryBackfillOptions
): ProductCategoryBackfillPlan {
  const byCategory = Object.fromEntries(
    PRODUCT_CATEGORIES.map((category) => [category, { shades: 0, active: 0, held: 0 }])
  ) as ProductCategoryBackfillReport["byCategory"];
  const byCategorySource = new Map<string, { category: ProductCategory; source: ProductCategorySource; shades: number }>();
  const byDataSource = new Map<string, { dataSource: string; category: ProductCategory; shades: number }>();
  const transitions = new Map<string, { from: ProductCategory; to: ProductCategory; shades: number }>();
  const report: ProductCategoryBackfillReport = {
    dryRun: options.dryRun,
    clearTopperDetectedHex: options.clearTopperDetectedHex,
    runId: null,
    scannedShades: rows.length,
    byCategory,
    byCategorySource: [],
    byDataSource: [],
    transitions: [],
    categoryChanges: [],
    adminDisagreements: [],
    excluded: [],
    heldAccessories: [],
    topperByTagOnly: [],
    topperHexCandidates: [],
    applied: { category: 0, exclude: 0, clearDetectedHex: 0 },
  };
  const categoryChanges: PlannedCategoryChange[] = [];
  const exclusions: number[] = [];
  const hexClears: PlannedHexClear[] = [];

  for (const row of rows) {
    const current = resolveProductCategory(row.productCategory);
    const source = asSource(row.productCategorySource);
    const products = row.products ?? [];
    const rule = classifyProductCategory({
      shadeName: row.name,
      colorName: row.colorName,
      finishes: row.finishes,
      detectedFinishes: row.detectedFinishes,
      products,
    });
    const holders = toNumber(row.holders) ?? 0;
    const final = source === "admin" ? current : rule.category;
    const shade = { shadeId: String(row.shadeId), brand: row.brand, name: row.name, status: row.status };

    if (rule.category !== current) {
      const change: ProductCategoryChangeItem = { ...shade, from: current, to: rule.category, evidence: rule.evidence };
      if (source === "admin") {
        report.adminDisagreements.push(change);
      } else {
        report.categoryChanges.push(change);
        categoryChanges.push({ shadeId: row.shadeId, from: current, to: rule.category });
        const key = `${current}>${rule.category}`;
        const transition = transitions.get(key) ?? { from: current, to: rule.category, shades: 0 };
        transition.shades += 1;
        transitions.set(key, transition);
      }
    }

    const finalStatus = final === "accessory" && holders === 0 && row.status === "active" ? "excluded" : row.status;
    byCategory[final].shades += 1;
    if (finalStatus === "active") byCategory[final].active += 1;
    if (holders > 0) byCategory[final].held += 1;
    const sourceKey = `${final}|${source}`;
    const sourceBucket = byCategorySource.get(sourceKey) ?? { category: final, source, shades: 0 };
    sourceBucket.shades += 1;
    byCategorySource.set(sourceKey, sourceBucket);
    if (final !== "color") {
      const names = new Set(products.map((product) => product.dataSource || "(unknown source)"));
      if (names.size === 0) names.add("(no source product)");
      for (const dataSource of names) {
        const key = `${dataSource}|${final}`;
        const bucket = byDataSource.get(key) ?? { dataSource, category: final, shades: 0 };
        bucket.shades += 1;
        byDataSource.set(key, bucket);
      }
    }

    if (final === "accessory") {
      if (holders > 0) {
        report.heldAccessories.push({ ...shade, holders, productCategorySource: source });
      } else if (row.status === "active") {
        report.excluded.push(shade);
        exclusions.push(row.shadeId);
      }
    }

    if (final === "topper" && source === "rule" && rule.evidence === "tag") {
      report.topperByTagOnly.push(shade);
    }

    if (final === "topper" && row.detectedHex) {
      const distance = toNumber(row.vendorVsDetected);
      const suspicious =
        (distance !== null && distance > MEDIUM_CONFIDENCE_MAX_DISTANCE) ||
        (!row.vendorHex && !TOPPER_PLAUSIBLE_FAMILIES.has(row.detectedHexFamily ?? ""));
      if (suspicious) {
        report.topperHexCandidates.push({
          ...shade,
          vendorHex: row.vendorHex,
          detectedHex: row.detectedHex,
          vendorVsDetected: distance,
          detectedHexMethod: row.detectedHexMethod,
        });
        if (options.clearTopperDetectedHex) {
          hexClears.push({
            shadeId: row.shadeId,
            before: {
              detectedHex: row.detectedHex,
              detectedHexConfidence: toNumber(row.detectedHexConfidence),
              detectedHexMethod: row.detectedHexMethod,
              detectedHexModel: row.detectedHexModel,
              detectedHexPromptVersion: row.detectedHexPromptVersion,
              detectedHexAt: row.detectedHexAt,
            },
          });
        }
      }
    }
  }

  report.byCategorySource = [...byCategorySource.values()].sort(
    (a, b) => b.shades - a.shades || a.category.localeCompare(b.category)
  );
  report.byDataSource = [...byDataSource.values()].sort(
    (a, b) => b.shades - a.shades || a.dataSource.localeCompare(b.dataSource)
  );
  report.transitions = [...transitions.values()].sort((a, b) => b.shades - a.shades);
  return { report, categoryChanges, exclusions, hexClears };
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export interface ProductCategoryBackfillDeps {
  query: Queryable["query"];
  transaction: <T>(work: (client: Queryable) => Promise<T>) => Promise<T>;
}

const LOAD_SQL = `
  SELECT
    s.shade_id AS "shadeId",
    b.name_canonical AS brand,
    s.shade_name_canonical AS name,
    s.color_name AS "colorName",
    s.status,
    s.finishes,
    s.detected_finishes AS "detectedFinishes",
    s.product_category AS "productCategory",
    s.product_category_source AS "productCategorySource",
    s.vendor_hex AS "vendorHex",
    s.detected_hex AS "detectedHex",
    s.detected_hex_confidence AS "detectedHexConfidence",
    s.detected_hex_method AS "detectedHexMethod",
    s.detected_hex_model AS "detectedHexModel",
    s.detected_hex_prompt_version AS "detectedHexPromptVersion",
    s.detected_hex_at::text AS "detectedHexAt",
    shade_color_family_from_hex(s.detected_hex) AS "detectedHexFamily",
    hex_oklab_distance(s.vendor_hex, s.detected_hex) AS "vendorVsDetected",
    (SELECT count(DISTINCT ui.user_id) FROM user_inventory_item ui WHERE ui.shade_id = s.shade_id) AS holders,
    COALESCE((
      SELECT json_agg(json_build_object(
        'dataSource', ds.name,
        'title', e.raw_json ->> 'title',
        -- Same text as the audit query: raw and normalized product types.
        'productType', concat_ws(' ', e.raw_json ->> 'product_type', e.normalized_json ->> 'productType'),
        'tags', CASE jsonb_typeof(e.raw_json -> 'tags')
                  WHEN 'array' THEN e.raw_json -> 'tags'
                  WHEN 'string' THEN to_jsonb(string_to_array(e.raw_json ->> 'tags', ','))
                  ELSE '[]'::jsonb
                END
      ) ORDER BY e.external_product_id)
      FROM shade_source_product ssp
      JOIN external_product e ON e.external_product_id = ssp.external_product_id
      JOIN data_source ds ON ds.data_source_id = e.data_source_id
      WHERE ssp.shade_id = s.shade_id
    ), '[]'::json) AS products
  FROM shade s
  JOIN brand b ON b.brand_id = s.brand_id
  WHERE s.merged_into_shade_id IS NULL
  ORDER BY s.shade_id`;

/** Load every unmerged shade, plan, and (unless a dry run) apply. Returns the report. */
export async function runProductCategoryBackfill(
  deps: ProductCategoryBackfillDeps,
  options: ProductCategoryBackfillOptions & { actorUserId: number | null }
): Promise<ProductCategoryBackfillReport> {
  const rows = (await deps.query(LOAD_SQL)).rows as BackfillShadeRow[];
  const plan = planProductCategoryBackfill(rows, options);
  if (options.dryRun) return plan.report;

  const runId = randomUUID();
  const applied = await deps.transaction(async (client) => {
    const counts = { category: 0, exclude: 0, clearDetectedHex: 0 };
    for (const change of plan.categoryChanges) {
      const updated = await client.query(
        `UPDATE shade
         SET product_category = $2, updated_at = now()
         WHERE shade_id = $1 AND product_category_source <> 'admin' AND product_category = $3`,
        [change.shadeId, change.to, change.from]
      );
      if ((updated.rowCount ?? 0) === 0) continue;
      counts.category += 1;
      await client.query(
        `INSERT INTO shade_category_change (shade_id, action, before, after, source, actor_user_id, backfill_run_id)
         VALUES ($1, 'category', $2::jsonb, $3::jsonb, 'backfill', $4, $5)`,
        [change.shadeId, JSON.stringify({ productCategory: change.from }), JSON.stringify({ productCategory: change.to }), options.actorUserId, runId]
      );
    }
    for (const shadeId of plan.exclusions) {
      const updated = await client.query(
        `UPDATE shade s
         SET status = 'excluded', updated_at = now()
         WHERE s.shade_id = $1
           AND s.status = 'active'
           AND s.product_category = 'accessory'
           AND NOT EXISTS (SELECT 1 FROM user_inventory_item ui WHERE ui.shade_id = s.shade_id)`,
        [shadeId]
      );
      if ((updated.rowCount ?? 0) === 0) continue;
      counts.exclude += 1;
      await client.query(
        `INSERT INTO shade_category_change (shade_id, action, before, after, source, actor_user_id, backfill_run_id)
         VALUES ($1, 'exclude', '{"status":"active"}'::jsonb, '{"status":"excluded"}'::jsonb, 'backfill', $2, $3)`,
        [shadeId, options.actorUserId, runId]
      );
    }
    for (const clear of plan.hexClears) {
      const updated = await client.query(
        `UPDATE shade
         SET detected_hex = NULL,
             detected_hex_confidence = NULL,
             detected_hex_method = NULL,
             detected_hex_model = NULL,
             detected_hex_prompt_version = NULL,
             detected_hex_at = NULL,
             updated_at = now()
         WHERE shade_id = $1 AND product_category = 'topper' AND detected_hex = $2`,
        [clear.shadeId, clear.before.detectedHex]
      );
      if ((updated.rowCount ?? 0) === 0) continue;
      counts.clearDetectedHex += 1;
      await client.query(
        `INSERT INTO shade_category_change (shade_id, action, before, after, source, actor_user_id, backfill_run_id)
         VALUES ($1, 'clear_detected_hex', $2::jsonb, '{"detectedHex":null}'::jsonb, 'backfill', $3, $4)`,
        [clear.shadeId, JSON.stringify(clear.before), options.actorUserId, runId]
      );
    }
    return counts;
  });

  return { ...plan.report, runId, applied };
}
