/**
 * Product price backfill: recompute `price` / `currency` in `external_product.normalized_json`
 * from `raw_json` with the connectors' own helpers (lib/product-price.ts), so the buy link can
 * show the brand's list price for products ingested before prices were stored.
 *
 * One keyset page per call, so both callers can drive it: `npm run backfill:product-price`
 * (src/scripts/backfill-product-price.ts) loops over every page in one process, and the admin
 * endpoint (functions/product-data-admin.ts) runs one page per request for the admin console.
 *
 * Shopify prices need the store currency, which raw `products.json` data does not carry. Per
 * source it comes from, in order: `data_source.metadata.currency`, the currency newer ingestion
 * runs already stored on that source's products, then the shop's `/meta.json` (one GET per
 * source per resolver, skipped when fetching is off). When none answers, the price is stored
 * with `currency: null` and the API shows no price for it. A currency already stored on a row
 * is never cleared.
 */
import {
  fetchShopifyStoreCurrency,
  normalizeCurrencyCode,
  normalizePriceAmount,
  productPriceFromRaw,
  type ProductPrice,
} from "./product-price";
import type { BackfillQueryFn } from "./product-text-backfill";

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

// ── SQL ─────────────────────────────────────────────────────────────────────

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

// ── Store currencies ────────────────────────────────────────────────────────

export type CurrencyOrigin = "source_metadata" | "stored" | "shop_meta" | "unknown" | "not_needed";
export type FetchStoreCurrency = (baseUrl: string) => Promise<string | null>;

export interface StoreCurrencyResolver {
  /** The store currency for a source, looked up once per resolver. */
  resolve(sourceName: string): Promise<string | null>;
  /** Every source resolved so far, with where its currency came from. */
  readonly currencies: Record<string, { currency: string | null; origin: CurrencyOrigin }>;
}

export function createStoreCurrencyResolver(
  query: BackfillQueryFn,
  options: { fetchCurrency: boolean; fetchStoreCurrency?: FetchStoreCurrency }
): StoreCurrencyResolver {
  const fetchStoreCurrency = options.fetchStoreCurrency ?? ((baseUrl: string) => fetchShopifyStoreCurrency(baseUrl));
  const currencies: StoreCurrencyResolver["currencies"] = {};
  const pendingBySource = new Map<string, Promise<string | null>>();
  return {
    currencies,
    resolve(sourceName) {
      let pending = pendingBySource.get(sourceName);
      if (!pending) {
        pending = (async () => {
          if (!sourceName.endsWith("Shopify")) {
            currencies[sourceName] = { currency: null, origin: "not_needed" };
            return null;
          }
          const source = (await query<SourceRow>(READ_SOURCE_SQL, [sourceName])).rows[0];
          const configured = normalizeCurrencyCode(source?.configuredCurrency);
          const stored = normalizeCurrencyCode(source?.storedCurrency);
          let origin: CurrencyOrigin = "unknown";
          let currency: string | null = null;
          if (configured) [currency, origin] = [configured, "source_metadata"];
          else if (stored) [currency, origin] = [stored, "stored"];
          else if (options.fetchCurrency && source?.baseUrl) {
            currency = normalizeCurrencyCode(await fetchStoreCurrency(source.baseUrl));
            if (currency) origin = "shop_meta";
          }
          currencies[sourceName] = { currency, origin };
          return currency;
        })();
        pendingBySource.set(sourceName, pending);
      }
      return pending;
    },
  };
}

// ── One page ────────────────────────────────────────────────────────────────

export interface ProductPriceBatchOptions {
  /** Keyset cursor: `external_product_id` to start after (0 = from the beginning). */
  afterExternalProductId: string | number;
  limit: number;
  /** Only these `data_source` names; null = every source. */
  sources: string[] | null;
  write: boolean;
  /** Called for each changed product (the script's `--verbose`). */
  onChange?: (line: string) => void;
}

export interface ProductPriceBatchResult {
  scanned: number;
  changed: number;
  written: number;
  /** Rows that end up with both a price and a currency (the API shows those). */
  pricedWithCurrency: number;
  /** Rows that end up with a price but no known currency (not shown). */
  pricedWithoutCurrency: number;
  bySource: Record<string, number>;
  /** Pass as `afterExternalProductId` for the next page; null when the scan is finished. */
  nextAfterExternalProductId: string | null;
}

export async function runProductPriceBatch(
  query: BackfillQueryFn,
  currencies: StoreCurrencyResolver,
  options: ProductPriceBatchOptions
): Promise<ProductPriceBatchResult> {
  const result: ProductPriceBatchResult = {
    scanned: 0,
    changed: 0,
    written: 0,
    pricedWithCurrency: 0,
    pricedWithoutCurrency: 0,
    bySource: {},
    nextAfterExternalProductId: null,
  };
  const { rows } = await query<ProductRow>(READ_PRODUCTS_SQL, [String(options.afterExternalProductId), options.sources, options.limit]);
  const ids: string[] = [];
  const patches: string[] = [];
  for (const row of rows) {
    result.scanned += 1;
    const storeCurrency = await currencies.resolve(row.sourceName);
    const patch = planProductPricePatch(row.sourceName, row.rawJson, row.normalizedJson, storeCurrency);
    // What the row holds after this run (the patch, or the stored values it already matches).
    const final = patch ?? asObject(row.normalizedJson);
    if (normalizePriceAmount(final.price)) {
      if (normalizeCurrencyCode(final.currency)) result.pricedWithCurrency += 1;
      else result.pricedWithoutCurrency += 1;
    }
    if (!patch) continue;
    result.changed += 1;
    result.bySource[row.sourceName] = (result.bySource[row.sourceName] ?? 0) + 1;
    ids.push(row.externalProductId);
    patches.push(JSON.stringify(patch));
    options.onChange?.(
      `  product ${row.externalProductId} (${row.sourceName}): ${patch.price ?? "no price"} ${patch.currency ?? ""}`.trimEnd()
    );
  }
  if (options.write && ids.length > 0) {
    await query(WRITE_PRODUCT_PRICE_SQL, [ids, patches]);
    result.written = ids.length;
  }
  if (rows.length === options.limit) result.nextAfterExternalProductId = rows[rows.length - 1].externalProductId;
  return result;
}
