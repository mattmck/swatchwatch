#!/usr/bin/env node
/**
 * Backfill `descriptionText` / `descriptors` (#352) into `external_product.normalized_json` from
 * `raw_json`, using the same per-connector extractors the connectors use (lib/product-text.ts),
 * and optionally fill empty `shade.finishes` from the products they were materialized from.
 *
 *   npm run backfill:product-text --workspace=swatchwatch-functions                  # dry run (default)
 *   npm run backfill:product-text --workspace=swatchwatch-functions -- --source HoloTacoShopify,MakeupAPI
 *   npm run backfill:product-text --workspace=swatchwatch-functions -- --write
 *   npm run backfill:product-text --workspace=swatchwatch-functions -- --write --fill-finishes
 *
 * Nothing is written without `--write`. A dry run reports how many product rows would change
 * and the finish coverage change: shades with empty finishes now vs after a fill, split by the
 * source the finishes would come from (tags, descriptors, description). The coverage figures
 * are always computed; `--fill-finishes` only controls whether `--write` applies them.
 *
 * Finish fill follows ingestion exactly (`resolveNormalizedProductFinishes` +
 * `applyIngestedFinishes`): only shades with no finishes are touched, from the most recently
 * seen linked product (`shade_source_product`); `shade.finish` (legacy identity key) is never
 * changed and merged shades are skipped. Rows are read in keyset pages (`--batch-size`).
 *
 * Needs Postgres (PG* vars, loaded from local.settings.json when present).
 */
import { closePool, query } from "../lib/db";
import { loadFinishCatalog, type FinishCatalog } from "../lib/finishes";
import { applyIngestedFinishes, resolveNormalizedProductFinishes, type IngestedFinishSource } from "../lib/finish-text";
import { normalizeDescriptors, productTextFromRaw, type ProductText } from "../lib/product-text";
import { loadLocalSettings } from "../eval/hex/env";

export const USAGE = `Usage: backfill:product-text -- [options]

Recomputes normalized_json.descriptionText / descriptors from raw_json for existing
external_product rows and reports (or fills) empty shade finishes (#352).

Options:
  --dry-run            Report only (the default).
  --write              Write the product text (and finishes with --fill-finishes).
  --fill-finishes      With --write, also fill empty shade.finishes from the linked product.
  --source A,B         Only these data_source names.
  --batch-size N       Rows per keyset page (default 500, 1-5000).
  --limit N            Stop after N external_product rows (default: all).
  --verbose            Print each change.
  --help               Show this help.`;

export interface BackfillArgs {
  write: boolean;
  fillFinishes: boolean;
  sources: string[] | null;
  batchSize: number;
  limit: number | null;
  verbose: boolean;
  help: boolean;
}

function positiveInt(flag: string, value: string | undefined, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== String(value).trim()) {
    throw new Error(`${flag} needs a positive integer`);
  }
  return Math.min(parsed, max);
}

export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const args: BackfillArgs = {
    write: false,
    fillFinishes: false,
    sources: null,
    batchSize: 500,
    limit: null,
    verbose: false,
    help: false,
  };
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        explicitDryRun = true;
        break;
      case "--write":
        args.write = true;
        break;
      case "--fill-finishes":
        args.fillFinishes = true;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--source": {
        const names = (argv[++i] ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        if (names.length === 0) throw new Error("--source needs one or more data_source names");
        args.sources = names;
        break;
      }
      case "--batch-size":
        args.batchSize = positiveInt(arg, argv[++i], 5000);
        break;
      case "--limit":
        args.limit = positiveInt(arg, argv[++i], Number.MAX_SAFE_INTEGER);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (explicitDryRun && args.write) throw new Error("--dry-run and --write are mutually exclusive");
  return args;
}

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

// ── DB ──────────────────────────────────────────────────────────────────────

type QueryFn = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;

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

export interface BackfillSummary {
  mode: "dry-run" | "write";
  products: { scanned: number; changed: number; written: number; bySource: Record<string, number> };
  coverage: {
    totalShades: number;
    emptyFinishesBefore: number;
    emptyFinishesLinked: number;
    fillable: number;
    fillableBySource: Record<string, number>;
    emptyFinishesAfter: number;
    filled: number;
  };
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

export async function runBackfill(
  args: BackfillArgs,
  deps: { query: QueryFn; log?: (line: string) => void; catalog?: FinishCatalog }
): Promise<BackfillSummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const catalog = deps.catalog ?? (await loadFinishCatalog());
  const summary: BackfillSummary = {
    mode: args.write ? "write" : "dry-run",
    products: { scanned: 0, changed: 0, written: 0, bySource: {} },
    coverage: {
      totalShades: 0,
      emptyFinishesBefore: 0,
      emptyFinishesLinked: 0,
      fillable: 0,
      fillableBySource: {},
      emptyFinishesAfter: 0,
      filled: 0,
    },
  };

  // 1. Product text.
  let cursor = "0";
  for (;;) {
    const remaining = args.limit === null ? args.batchSize : Math.min(args.batchSize, args.limit - summary.products.scanned);
    if (remaining <= 0) break;
    const { rows } = await deps.query<ProductRow>(READ_PRODUCTS_SQL, [cursor, args.sources, remaining]);
    if (rows.length === 0) break;
    const ids: string[] = [];
    const patches: string[] = [];
    for (const row of rows) {
      summary.products.scanned += 1;
      const patch = planProductTextPatch(row.sourceName, row.rawJson, row.normalizedJson);
      if (!patch) continue;
      summary.products.changed += 1;
      bump(summary.products.bySource, row.sourceName);
      ids.push(row.externalProductId);
      patches.push(JSON.stringify(patch));
      if (args.verbose) {
        log(
          `  product ${row.externalProductId} (${row.sourceName}): ${patch.descriptors.length} descriptors, description ${
            patch.descriptionText ? `${patch.descriptionText.length} chars` : "none"
          }`
        );
      }
    }
    if (args.write && ids.length > 0) {
      await deps.query(WRITE_PRODUCT_TEXT_SQL, [ids, patches]);
      summary.products.written += ids.length;
    }
    cursor = rows[rows.length - 1].externalProductId;
    if (rows.length < remaining) break;
  }

  // 2. Finish coverage (and fill with --write --fill-finishes).
  const coverage = (await deps.query<{ totalShades: number; emptyFinishes: number; emptyFinishesLinked: number }>(COVERAGE_SQL))
    .rows[0];
  summary.coverage.totalShades = Number(coverage?.totalShades ?? 0);
  summary.coverage.emptyFinishesBefore = Number(coverage?.emptyFinishes ?? 0);
  summary.coverage.emptyFinishesLinked = Number(coverage?.emptyFinishesLinked ?? 0);

  let shadeCursor = "0";
  for (;;) {
    const { rows } = await deps.query<ShadeRow>(READ_EMPTY_FINISH_SHADES_SQL, [shadeCursor, args.sources, args.batchSize]);
    if (rows.length === 0) break;
    const ids: string[] = [];
    const lists: string[] = [];
    for (const row of rows) {
      const plan = planShadeFinishFill(row.finishes, row.sourceName, row.rawJson, row.normalizedJson, catalog);
      if (!plan) continue;
      summary.coverage.fillable += 1;
      bump(summary.coverage.fillableBySource, plan.source);
      ids.push(row.shadeId);
      lists.push(JSON.stringify(plan.finishes));
      if (args.verbose) log(`  shade ${row.shadeId}: ${plan.finishes.join(", ")} (from ${plan.source})`);
    }
    if (args.write && args.fillFinishes && ids.length > 0) {
      await deps.query(FILL_FINISHES_SQL, [ids, lists]);
      summary.coverage.filled += ids.length;
    }
    shadeCursor = rows[rows.length - 1].shadeId;
    if (rows.length < args.batchSize) break;
  }
  summary.coverage.emptyFinishesAfter = summary.coverage.emptyFinishesBefore - summary.coverage.fillable;

  const verb = args.write ? "updated" : "would update";
  log(
    `Products: ${summary.products.scanned} scanned, ${summary.products.changed} ${verb} ${JSON.stringify(summary.products.bySource)}`
  );
  log(
    `Finish coverage: ${summary.coverage.emptyFinishesBefore} of ${summary.coverage.totalShades} shades have no finishes ` +
      `(${summary.coverage.emptyFinishesLinked} linked to a product); ${summary.coverage.fillable} ` +
      `${args.write && args.fillFinishes ? "filled" : "fillable"} ${JSON.stringify(summary.coverage.fillableBySource)} → ` +
      `${summary.coverage.emptyFinishesAfter} without finishes after a fill`
  );
  if (!args.write) log("Dry run: nothing written. Re-run with --write (and --fill-finishes) to apply.");
  else if (!args.fillFinishes) log("Finishes not written (pass --fill-finishes to fill them).");
  return summary;
}

export async function main(argv: string[]): Promise<number> {
  let args: BackfillArgs;
  try {
    args = parseBackfillArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  loadLocalSettings();
  if (!process.env.PGHOST) {
    console.error("Postgres is not configured (PGHOST missing; copy local.settings.json.example to local.settings.json).");
    return 1;
  }

  try {
    const summary = await runBackfill(args, { query: query as unknown as QueryFn });
    console.log(JSON.stringify(summary));
    return 0;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    }
  );
}
