#!/usr/bin/env node
/**
 * Backfill `descriptionText` / `descriptors` (#352) into `external_product.normalized_json` from
 * `raw_json`, using the same per-connector extractors the connectors use (lib/product-text.ts),
 * and optionally fill empty `shade.finishes` from the products they were materialized from.
 * The rules and the per-page steps live in lib/product-text-backfill.ts (shared with the admin
 * console's Backfills tab); this script loops over every page in one process.
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
import {
  readFinishCoverage,
  runFinishFillBatch,
  runProductTextBatch,
  type BackfillQueryFn,
} from "../lib/product-text-backfill";
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

export { planProductTextPatch, planShadeFinishFill, type ShadeFinishPlan } from "../lib/product-text-backfill";

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

function addCounts(target: Record<string, number>, counts: Record<string, number>): void {
  for (const [key, value] of Object.entries(counts)) target[key] = (target[key] ?? 0) + value;
}

export async function runBackfill(
  args: BackfillArgs,
  deps: { query: BackfillQueryFn; log?: (line: string) => void; catalog?: FinishCatalog }
): Promise<BackfillSummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const catalog = deps.catalog ?? (await loadFinishCatalog());
  const onChange = args.verbose ? log : undefined;
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
    const batch = await runProductTextBatch(deps.query, {
      afterExternalProductId: cursor,
      limit: remaining,
      sources: args.sources,
      write: args.write,
      onChange,
    });
    summary.products.scanned += batch.scanned;
    summary.products.changed += batch.changed;
    summary.products.written += batch.written;
    addCounts(summary.products.bySource, batch.bySource);
    if (batch.nextAfterExternalProductId === null) break;
    cursor = batch.nextAfterExternalProductId;
  }

  // 2. Finish coverage (and fill with --write --fill-finishes).
  const coverage = await readFinishCoverage(deps.query);
  summary.coverage.totalShades = coverage.totalShades;
  summary.coverage.emptyFinishesBefore = coverage.emptyFinishes;
  summary.coverage.emptyFinishesLinked = coverage.emptyFinishesLinked;

  let shadeCursor = "0";
  for (;;) {
    const batch = await runFinishFillBatch(deps.query, catalog, {
      afterShadeId: shadeCursor,
      limit: args.batchSize,
      sources: args.sources,
      write: args.write && args.fillFinishes,
      onChange,
    });
    summary.coverage.fillable += batch.fillable;
    summary.coverage.filled += batch.filled;
    addCounts(summary.coverage.fillableBySource, batch.fillableBySource);
    if (batch.nextAfterShadeId === null) break;
    shadeCursor = batch.nextAfterShadeId;
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
    const summary = await runBackfill(args, { query: query as unknown as BackfillQueryFn });
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
