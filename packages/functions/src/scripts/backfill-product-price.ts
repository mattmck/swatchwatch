#!/usr/bin/env node
/**
 * Backfill `price` / `currency` into `external_product.normalized_json` from `raw_json`, using
 * the same helpers the connectors use (lib/product-price.ts), so the buy link can show the
 * brand's list price for products ingested before prices were stored. The rules and the
 * per-page step live in lib/product-price-backfill.ts (shared with the admin console's Backfills
 * tab); this script loops over every page in one process.
 *
 *   npm run backfill:product-price --workspace=swatchwatch-functions                  # dry run (default)
 *   npm run backfill:product-price --workspace=swatchwatch-functions -- --source HoloTacoShopify,MakeupAPI
 *   npm run backfill:product-price --workspace=swatchwatch-functions -- --write
 *
 * Nothing is written without `--write`. Shopify prices need the store currency, which raw
 * `products.json` data does not carry. Per source it comes from, in order:
 * `data_source.metadata.currency`, the currency newer ingestion runs already stored on that
 * source's products, then the shop's `/meta.json` (one GET per source; skipped with
 * `--no-fetch-currency`). When none answers, the price is stored with `currency: null` and the
 * API shows no price for it. A currency already stored on a row is never cleared.
 *
 * Needs Postgres (PG* vars, loaded from local.settings.json when present).
 */
import { closePool, query } from "../lib/db";
import {
  createStoreCurrencyResolver,
  runProductPriceBatch,
  type FetchStoreCurrency,
  type StoreCurrencyResolver,
} from "../lib/product-price-backfill";
import type { BackfillQueryFn } from "../lib/product-text-backfill";
import { loadLocalSettings } from "../eval/hex/env";

export const USAGE = `Usage: backfill:product-price -- [options]

Recomputes normalized_json.price / currency from raw_json for existing external_product rows.

Options:
  --dry-run              Report only (the default).
  --write                Write the prices.
  --no-fetch-currency    Never ask a Shopify store's /meta.json for its currency.
  --source A,B           Only these data_source names.
  --batch-size N         Rows per keyset page (default 500, 1-5000).
  --limit N              Stop after N external_product rows (default: all).
  --verbose              Print each change.
  --help                 Show this help.`;

export interface BackfillArgs {
  write: boolean;
  fetchCurrency: boolean;
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
    fetchCurrency: true,
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
      case "--no-fetch-currency":
        args.fetchCurrency = false;
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

export { planProductPricePatch, type CurrencyOrigin } from "../lib/product-price-backfill";

export interface BackfillSummary {
  mode: "dry-run" | "write";
  products: {
    scanned: number;
    changed: number;
    written: number;
    /** Rows that end up with both a price and a currency (the API shows those). */
    pricedWithCurrency: number;
    /** Rows that end up with a price but no known currency (not shown). */
    pricedWithoutCurrency: number;
    bySource: Record<string, number>;
  };
  currencies: StoreCurrencyResolver["currencies"];
}

export async function runBackfill(
  args: BackfillArgs,
  deps: { query: BackfillQueryFn; log?: (line: string) => void; fetchCurrency?: FetchStoreCurrency }
): Promise<BackfillSummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const resolver = createStoreCurrencyResolver(deps.query, {
    fetchCurrency: args.fetchCurrency,
    fetchStoreCurrency: deps.fetchCurrency,
  });
  const summary: BackfillSummary = {
    mode: args.write ? "write" : "dry-run",
    products: { scanned: 0, changed: 0, written: 0, pricedWithCurrency: 0, pricedWithoutCurrency: 0, bySource: {} },
    currencies: resolver.currencies,
  };

  let cursor = "0";
  for (;;) {
    const remaining = args.limit === null ? args.batchSize : Math.min(args.batchSize, args.limit - summary.products.scanned);
    if (remaining <= 0) break;
    const batch = await runProductPriceBatch(deps.query, resolver, {
      afterExternalProductId: cursor,
      limit: remaining,
      sources: args.sources,
      write: args.write,
      onChange: args.verbose ? log : undefined,
    });
    summary.products.scanned += batch.scanned;
    summary.products.changed += batch.changed;
    summary.products.written += batch.written;
    summary.products.pricedWithCurrency += batch.pricedWithCurrency;
    summary.products.pricedWithoutCurrency += batch.pricedWithoutCurrency;
    for (const [source, count] of Object.entries(batch.bySource)) {
      summary.products.bySource[source] = (summary.products.bySource[source] ?? 0) + count;
    }
    if (batch.nextAfterExternalProductId === null) break;
    cursor = batch.nextAfterExternalProductId;
  }

  const verb = args.write ? "updated" : "would update";
  log(
    `Products: ${summary.products.scanned} scanned, ${summary.products.changed} ${verb} ${JSON.stringify(summary.products.bySource)}; ` +
      `${summary.products.pricedWithCurrency} priced with a currency, ${summary.products.pricedWithoutCurrency} priced without one`
  );
  log(`Store currencies: ${JSON.stringify(summary.currencies)}`);
  if (!args.write) log("Dry run: nothing written. Re-run with --write to apply.");
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
