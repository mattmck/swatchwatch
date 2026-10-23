/**
 * Product text backfill (#352): recompute `descriptionText` / `descriptors` in
 * `external_product.normalized_json` from `raw_json` with the connectors' own extractors
 * (lib/product-text.ts), and fill empty `shade.finishes` from the products they were
 * materialized from.
 *
 * Each step is one keyset page so both callers can drive it: `npm run backfill:product-text`
 * (src/scripts/backfill-product-text.ts) loops over every page in one process, and the admin
 * endpoints (functions/product-data-admin.ts) run one page per request for the admin console.
 *
 * Finish fill follows ingestion exactly (`resolveNormalizedProductFinishes` +
 * `applyIngestedFinishes`): only shades with no finishes are touched, from the most recently
 * seen linked product (`shade_source_product`); `shade.finish` (legacy identity key) is never
 * changed and merged shades are skipped.
 */
import type { FinishCatalog } from "./finishes";
import { applyIngestedFinishes, resolveNormalizedProductFinishes, type IngestedFinishSource } from "./finish-text";
import { normalizeDescriptors, productTextFromRaw, type ProductText } from "./product-text";

export type BackfillQueryFn = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;

// ── Pure planning ───────────────────────────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The `{descriptionText, descriptors}` patch for one product row, or `null` when the stored
 * values already match (or the source has no extractor).
 */
export function planProductTextPatch(sourceName: string, raw: unknown, normalized: unknown): ProductText | null {
  const text = productTextFromRaw(sourceName, raw);
  if (!text) return null;
  const stored = asObject(normalized);
  const storedDescription = typeof stored.descriptionText === "string" ? stored.descriptionText : null;
  const hasDescriptors = Array.isArray(stored.descriptors);
  const storedDescriptors = hasDescriptors ? normalizeDescriptors(stored.descriptors as unknown[]) : [];
  const same =
    "descriptionText" in stored &&
    hasDescriptors &&
    storedDescription === text.descriptionText &&
    JSON.stringify(storedDescriptors) === JSON.stringify(text.descriptors);
  return same ? null : text;
}

export interface ShadeFinishPlan {
  finishes: string[];
  source: IngestedFinishSource;
}

/**
 * What ingestion would write to an empty-finish shade from its linked product with recomputed
 * product text, or `null` when nothing would change.
 */
export function planShadeFinishFill(
  currentFinishes: readonly string[] | null,
  sourceName: string,
  raw: unknown,
  normalized: unknown,
  catalog?: FinishCatalog
): ShadeFinishPlan | null {
  const text = productTextFromRaw(sourceName, raw);
  const merged = { ...asObject(normalized), ...(text ?? {}) };
  const resolution = resolveNormalizedProductFinishes(merged, catalog);
  const next = applyIngestedFinishes(currentFinishes ?? [], resolution, catalog);
  if (!next || next.length === 0 || (currentFinishes ?? []).length > 0) return null;
  return { finishes: next, source: resolution.source };
}

// ── SQL ─────────────────────────────────────────────────────────────────────

interface ProductRow {
  externalProductId: string;
  sourceName: string;
  rawJson: unknown;
  normalizedJson: unknown;
}

const READ_PRODUCTS_SQL = `SELECT ep.external_product_id::text AS "externalProductId",
       ds.name AS "sourceName",
       ep.raw_json AS "rawJson",
       ep.normalized_json AS "normalizedJson"
     FROM external_product ep
     JOIN data_source ds ON ds.data_source_id = ep.data_source_id
     WHERE ep.external_product_id > $1::bigint
       AND ($2::text[] IS NULL OR ds.name = ANY($2::text[]))
     ORDER BY ep.external_product_id
     LIMIT $3`;

const WRITE_PRODUCT_TEXT_SQL = `UPDATE external_product ep
     SET normalized_json = COALESCE(ep.normalized_json, '{}'::jsonb) || v.patch
     FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::jsonb[]) AS patch) v
     WHERE ep.external_product_id = v.id`;

interface ShadeRow {
  shadeId: string;
  finishes: string[] | null;
  sourceName: string;
  rawJson: unknown;
  normalizedJson: unknown;
}

/** Non-merged shades with no finishes, each with its most recently seen linked product. */
const READ_EMPTY_FINISH_SHADES_SQL = `SELECT s.shade_id::text AS "shadeId",
       s.finishes,
       lp."sourceName",
       lp."rawJson",
       lp."normalizedJson"
     FROM shade s
     JOIN LATERAL (
       SELECT ds.name AS "sourceName", ep.raw_json AS "rawJson", ep.normalized_json AS "normalizedJson"
       FROM shade_source_product ssp
       JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
       JOIN data_source ds ON ds.data_source_id = ep.data_source_id
       WHERE ssp.shade_id = s.shade_id
         AND ($2::text[] IS NULL OR ds.name = ANY($2::text[]))
       ORDER BY ssp.last_seen_at DESC, ep.fetched_at DESC, ep.external_product_id DESC
       LIMIT 1
     ) lp ON true
     WHERE s.shade_id > $1::bigint
       AND COALESCE(cardinality(s.finishes), 0) = 0
       AND s.merged_into_shade_id IS NULL
     ORDER BY s.shade_id
     LIMIT $3`;

const COVERAGE_SQL = `SELECT count(*)::int AS "totalShades",
       count(*) FILTER (WHERE COALESCE(cardinality(s.finishes), 0) = 0)::int AS "emptyFinishes",
       count(*) FILTER (
         WHERE COALESCE(cardinality(s.finishes), 0) = 0
           AND EXISTS (SELECT 1 FROM shade_source_product ssp WHERE ssp.shade_id = s.shade_id)
       )::int AS "emptyFinishesLinked"
     FROM shade s
     WHERE s.merged_into_shade_id IS NULL`;

/** Fill only shades that still have no finishes (guards against a concurrent ingestion run). */
const FILL_FINISHES_SQL = `UPDATE shade s
     SET finishes = ARRAY(SELECT jsonb_array_elements_text(v.list)), updated_at = now()
     FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::jsonb[]) AS list) v
     WHERE s.shade_id = v.id
       AND COALESCE(cardinality(s.finishes), 0) = 0`;

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

// ── One page each ───────────────────────────────────────────────────────────

export interface ProductTextBatchOptions {
  /** Keyset cursor: `external_product_id` to start after (0 = from the beginning). */
  afterExternalProductId: string | number;
  limit: number;
  /** Only these `data_source` names; null = every source. */
  sources: string[] | null;
  write: boolean;
  /** Called for each changed product (the script's `--verbose`). */
  onChange?: (line: string) => void;
}

export interface ProductTextBatchResult {
  scanned: number;
  changed: number;
  written: number;
  bySource: Record<string, number>;
  /** Pass as `afterExternalProductId` for the next page; null when the scan is finished. */
  nextAfterExternalProductId: string | null;
}

export async function runProductTextBatch(
  query: BackfillQueryFn,
  options: ProductTextBatchOptions
): Promise<ProductTextBatchResult> {
  const result: ProductTextBatchResult = { scanned: 0, changed: 0, written: 0, bySource: {}, nextAfterExternalProductId: null };
  const { rows } = await query<ProductRow>(READ_PRODUCTS_SQL, [String(options.afterExternalProductId), options.sources, options.limit]);
  const ids: string[] = [];
  const patches: string[] = [];
  for (const row of rows) {
    result.scanned += 1;
    const patch = planProductTextPatch(row.sourceName, row.rawJson, row.normalizedJson);
    if (!patch) continue;
    result.changed += 1;
    bump(result.bySource, row.sourceName);
    ids.push(row.externalProductId);
    patches.push(JSON.stringify(patch));
    options.onChange?.(
      `  product ${row.externalProductId} (${row.sourceName}): ${patch.descriptors.length} descriptors, description ${
        patch.descriptionText ? `${patch.descriptionText.length} chars` : "none"
      }`
    );
  }
  if (options.write && ids.length > 0) {
    await query(WRITE_PRODUCT_TEXT_SQL, [ids, patches]);
    result.written = ids.length;
  }
  if (rows.length === options.limit) result.nextAfterExternalProductId = rows[rows.length - 1].externalProductId;
  return result;
}

export interface FinishCoverage {
  totalShades: number;
  /** Non-merged shades with no finishes. */
  emptyFinishes: number;
  /** …of which have a linked connector product (the only ones a fill can reach). */
  emptyFinishesLinked: number;
}

export async function readFinishCoverage(query: BackfillQueryFn): Promise<FinishCoverage> {
  const row = (await query<{ totalShades: number; emptyFinishes: number; emptyFinishesLinked: number }>(COVERAGE_SQL)).rows[0];
  return {
    totalShades: Number(row?.totalShades ?? 0),
    emptyFinishes: Number(row?.emptyFinishes ?? 0),
    emptyFinishesLinked: Number(row?.emptyFinishesLinked ?? 0),
  };
}

export interface FinishFillBatchOptions {
  /** Keyset cursor: `shade_id` to start after (0 = from the beginning). */
  afterShadeId: string | number;
  limit: number;
  sources: string[] | null;
  write: boolean;
  onChange?: (line: string) => void;
}

export interface FinishFillBatchResult {
  /** Empty-finish shades with a linked product read in this page. */
  scanned: number;
  fillable: number;
  filled: number;
  /** Where the fillable finishes come from: tags, descriptors or description. */
  fillableBySource: Record<string, number>;
  /** Shades this page wrote (empty in a dry run). */
  filledShadeIds: string[];
  /** Pass as `afterShadeId` for the next page; null when the scan is finished. */
  nextAfterShadeId: string | null;
}

export async function runFinishFillBatch(
  query: BackfillQueryFn,
  catalog: FinishCatalog,
  options: FinishFillBatchOptions
): Promise<FinishFillBatchResult> {
  const result: FinishFillBatchResult = {
    scanned: 0,
    fillable: 0,
    filled: 0,
    fillableBySource: {},
    filledShadeIds: [],
    nextAfterShadeId: null,
  };
  const { rows } = await query<ShadeRow>(READ_EMPTY_FINISH_SHADES_SQL, [String(options.afterShadeId), options.sources, options.limit]);
  const ids: string[] = [];
  const lists: string[] = [];
  for (const row of rows) {
    result.scanned += 1;
    const plan = planShadeFinishFill(row.finishes, row.sourceName, row.rawJson, row.normalizedJson, catalog);
    if (!plan) continue;
    result.fillable += 1;
    bump(result.fillableBySource, plan.source);
    ids.push(row.shadeId);
    lists.push(JSON.stringify(plan.finishes));
    options.onChange?.(`  shade ${row.shadeId}: ${plan.finishes.join(", ")} (from ${plan.source})`);
  }
  if (options.write && ids.length > 0) {
    await query(FILL_FINISHES_SQL, [ids, lists]);
    result.filled = ids.length;
    result.filledShadeIds = ids;
  }
  if (rows.length === options.limit) result.nextAfterShadeId = rows[rows.length - 1].shadeId;
  return result;
}
