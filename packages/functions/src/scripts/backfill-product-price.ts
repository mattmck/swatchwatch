#!/usr/bin/env node
/**
 * Backfill `price` / `currency` into `external_product.normalized_json` from `raw_json`, using
 * the same helpers the connectors use (lib/product-price.ts), so the buy link can show the
 * brand's list price for products ingested before prices were stored.
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
  fetchShopifyStoreCurrency,
  normalizeCurrencyCode,
  normalizePriceAmount,
  productPriceFromRaw,
  type ProductPrice,
} from "../lib/product-price";
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

// ── Pure planning ───────────────────────────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The `{price, currency}` patch for one product row, or `null` when the stored values already
 * match (or the source has no prices). A valid stored currency is kept when the store currency
 * is unknown now, so a backfill never undoes what ingestion learned.
 */
export function planProductPricePatch(
  sourceName: string,
  raw: unknown,
  normalized: unknown,
  storeCurrency: string | null
): ProductPrice | null {
  const derived = productPriceFromRaw(sourceName, raw, storeCurrency);
  if (!derived) return null;
  const stored = asObject(normalized);
  const next: ProductPrice = {
    price: derived.price,
    currency: derived.price === null ? null : derived.currency ?? normalizeCurrencyCode(stored.currency),
  };
  // Exact match only: an unnormalized stored value ("10.0", "cad") gets rewritten.
  const same = "price" in stored && "currency" in stored && stored.price === next.price && stored.currency === next.currency;
  return same ? null : next;
}

// ── DB ──────────────────────────────────────────────────────────────────────

type QueryFn = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
type FetchCurrency = (baseUrl: string) => Promise<string | null>;

interface ProductRow {
  externalProductId: string;
  sourceName: string;
  rawJson: unknown;
  normalizedJson: unknown;
}

interface SourceRow {
  name: string;
  baseUrl: string | null;
  configuredCurrency: string | null;
  /** Most common currency newer ingestion runs stored on this source's products. */
  storedCurrency: string | null;
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

const READ_SOURCE_SQL = `SELECT ds.name,
       ds.base_url AS "baseUrl",
       ds.metadata ->> 'currency' AS "configuredCurrency",
       (SELECT ep.normalized_json ->> 'currency'
          FROM external_product ep
         WHERE ep.data_source_id = ds.data_source_id
           AND NULLIF(ep.normalized_json ->> 'currency', '') IS NOT NULL
         GROUP BY 1
         ORDER BY count(*) DESC, 1
         LIMIT 1) AS "storedCurrency"
     FROM data_source ds
     WHERE ds.name = $1
     LIMIT 1`;

const WRITE_PRODUCT_PRICE_SQL = `UPDATE external_product ep
     SET normalized_json = COALESCE(ep.normalized_json, '{}'::jsonb) || v.patch
     FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::jsonb[]) AS patch) v
     WHERE ep.external_product_id = v.id`;

export type CurrencyOrigin = "source_metadata" | "stored" | "shop_meta" | "unknown" | "not_needed";

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
  currencies: Record<string, { currency: string | null; origin: CurrencyOrigin }>;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

export async function runBackfill(
  args: BackfillArgs,
  deps: { query: QueryFn; log?: (line: string) => void; fetchCurrency?: FetchCurrency }
): Promise<BackfillSummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const fetchCurrency = deps.fetchCurrency ?? ((baseUrl: string) => fetchShopifyStoreCurrency(baseUrl));
  const summary: BackfillSummary = {
    mode: args.write ? "write" : "dry-run",
    products: { scanned: 0, changed: 0, written: 0, pricedWithCurrency: 0, pricedWithoutCurrency: 0, bySource: {} },
    currencies: {},
  };

  const currencyBySource = new Map<string, Promise<string | null>>();
  const storeCurrencyFor = (sourceName: string): Promise<string | null> => {
    let pending = currencyBySource.get(sourceName);
    if (!pending) {
      pending = (async () => {
        if (!sourceName.endsWith("Shopify")) {
          summary.currencies[sourceName] = { currency: null, origin: "not_needed" };
          return null;
        }
        const source = (await deps.query<SourceRow>(READ_SOURCE_SQL, [sourceName])).rows[0];
        const configured = normalizeCurrencyCode(source?.configuredCurrency);
        const stored = normalizeCurrencyCode(source?.storedCurrency);
        let origin: CurrencyOrigin = "unknown";
        let currency: string | null = null;
        if (configured) [currency, origin] = [configured, "source_metadata"];
        else if (stored) [currency, origin] = [stored, "stored"];
        else if (args.fetchCurrency && source?.baseUrl) {
          currency = normalizeCurrencyCode(await fetchCurrency(source.baseUrl));
          if (currency) origin = "shop_meta";
        }
        summary.currencies[sourceName] = { currency, origin };
        return currency;
      })();
      currencyBySource.set(sourceName, pending);
    }
    return pending;
  };

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
      const storeCurrency = await storeCurrencyFor(row.sourceName);
      const patch = planProductPricePatch(row.sourceName, row.rawJson, row.normalizedJson, storeCurrency);
      // What the row holds after this run (the patch, or the stored values it already matches).
      const final = patch ?? asObject(row.normalizedJson);
      if (normalizePriceAmount(final.price)) {
        if (normalizeCurrencyCode(final.currency)) summary.products.pricedWithCurrency += 1;
        else summary.products.pricedWithoutCurrency += 1;
      }
      if (!patch) continue;
      summary.products.changed += 1;
      bump(summary.products.bySource, row.sourceName);
      ids.push(row.externalProductId);
      patches.push(JSON.stringify(patch));
      if (args.verbose) {
        log(`  product ${row.externalProductId} (${row.sourceName}): ${patch.price ?? "no price"} ${patch.currency ?? ""}`.trimEnd());
      }
    }
    if (args.write && ids.length > 0) {
      await deps.query(WRITE_PRODUCT_PRICE_SQL, [ids, patches]);
      summary.products.written += ids.length;
    }
    cursor = rows[rows.length - 1].externalProductId;
    if (rows.length < remaining) break;
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
