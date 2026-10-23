/**
 * Vendor list prices for connector products (#267 follow-up: prices on the buy link).
 *
 * Every connector that knows a product's price stores it in
 * `external_product.normalized_json` as `price` (a decimal string in major units, e.g.
 * `"12.50"`) and `currency` (ISO 4217, e.g. `"USD"`, or null when the store currency is
 * unknown). Prices are what the brand lists, never what a user paid (`purchase_price`), and
 * are never converted between currencies.
 *
 * Shopify-style stores (`products.json`) list a price per variant as a string, in the shop's
 * base currency, which `products.json` does not include: the connector learns it from the
 * source's `data_source.metadata.currency` (set by hand), else the shop's `/meta.json`, and
 * leaves it null when neither answers. We never assume USD.
 */

/** Largest price we accept; anything above is junk data (or a gift-card style product). */
export const MAX_PRODUCT_PRICE = 100_000;

/** Price + currency as written into `normalized_json`. */
export interface ProductPrice {
  price: string | null;
  currency: string | null;
}

let supportedCurrencies: Set<string> | null | undefined;

function knownCurrencies(): Set<string> | null {
  if (supportedCurrencies !== undefined) return supportedCurrencies;
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("currency");
    supportedCurrencies = Array.isArray(list) && list.length > 0 ? new Set(list) : null;
  } catch {
    supportedCurrencies = null;
  }
  return supportedCurrencies;
}

/**
 * Returns an upper-case ISO 4217 code, or null. Accepts any case and surrounding whitespace;
 * rejects anything that is not three letters or (when the runtime knows the list) not a
 * currency Intl supports.
 */
export function normalizeCurrencyCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  const known = knownCurrencies();
  return known && !known.has(code) ? null : code;
}

/**
 * Normalizes a price in major units to a plain decimal string (`"12.5"` → `"12.50"`,
 * `"8"` → `"8.00"`, `12` → `"12.00"`), or null for missing, non-numeric, negative, zero or
 * absurd values. Up to 4 decimals are kept when the input has them (`"0.1234"`).
 */
export function normalizePriceAmount(value: unknown): string | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return null;
  }
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_PRODUCT_PRICE) return null;
  const decimals = text.includes(".") ? text.split(".")[1].length : 0;
  return amount.toFixed(Math.max(2, decimals));
}

/** Minimal Shopify variant fields the price picker reads (`variants[].price` is a string). */
export interface ShopifyPriceVariant {
  price?: unknown;
  available?: unknown;
}

/**
 * The price for a Shopify product: the lowest price among available variants; when every
 * variant is sold out (or none says), the lowest price among all variants. Null when no
 * variant has a valid price.
 */
export function pickShopifyVariantPrice(variants: readonly ShopifyPriceVariant[] | null | undefined): string | null {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const lowest = (list: readonly ShopifyPriceVariant[]): string | null => {
    let best: string | null = null;
    for (const variant of list) {
      const price = normalizePriceAmount(variant?.price);
      if (price !== null && (best === null || Number(price) < Number(best))) best = price;
    }
    return best;
  };
  return lowest(variants.filter((variant) => variant?.available === true)) ?? lowest(variants);
}

/** `{ price, currency }` for a Shopify product; currency only when the price is known. */
export function shopifyProductPrice(
  variants: readonly ShopifyPriceVariant[] | null | undefined,
  currency: string | null | undefined
): ProductPrice {
  const price = pickShopifyVariantPrice(variants);
  return { price, currency: price === null ? null : normalizeCurrencyCode(currency) };
}

/** Store currency configured by hand on a source: `data_source.metadata.currency`. */
export function currencyFromSourceMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return normalizeCurrencyCode((metadata as Record<string, unknown>).currency);
}

/** The shop currency from a Shopify `/meta.json` body (`{ "currency": "USD", ... }`). */
export function currencyFromShopifyMeta(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return normalizeCurrencyCode((body as Record<string, unknown>).currency);
}

/** Timeout for the one `/meta.json` request per connector run. */
export const SHOPIFY_META_TIMEOUT_MS = 10_000;

const META_USER_AGENT = "SwatchWatch/connector-ingestion (+https://github.com/mattmck/swatchwatch)";

/** Where a Shopify store's currency came from (job metrics only). */
export type StoreCurrencySource = "source_metadata" | "shop_meta" | "unknown";

export interface StoreCurrency {
  currency: string | null;
  source: StoreCurrencySource;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status?: number;
  text: () => Promise<string>;
}>;

/**
 * Asks a Shopify store for its base currency (`GET {baseUrl}/meta.json`, one attempt, short
 * timeout). Returns null on any failure or an answer without a valid ISO code; never throws,
 * because a missing currency only means prices are stored without one.
 */
export async function fetchShopifyStoreCurrency(
  baseUrl: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  timeoutMs = SHOPIFY_META_TIMEOUT_MS
): Promise<string | null> {
  if (!baseUrl || typeof fetchImpl !== "function") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/meta.json`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": META_USER_AGENT },
    });
    if (!response?.ok) return null;
    return currencyFromShopifyMeta(JSON.parse(await response.text()));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The store currency for a Shopify connector run: the source's configured
 * `data_source.metadata.currency` first, else the shop's `/meta.json`, else unknown.
 */
export async function resolveShopifyStoreCurrency(
  configured: unknown,
  baseUrl: string,
  fetchImpl?: FetchLike
): Promise<StoreCurrency> {
  const fromSource = normalizeCurrencyCode(configured);
  if (fromSource) return { currency: fromSource, source: "source_metadata" };
  const fromShop = await fetchShopifyStoreCurrency(baseUrl, fetchImpl);
  return fromShop ? { currency: fromShop, source: "shop_meta" } : { currency: null, source: "unknown" };
}

/**
 * MakeupAPI lists `price` (e.g. `"10.0"`) and sometimes `currency` (`"CAD"`); its `price_sign`
 * (`"$"`) is ambiguous and never turned into a currency.
 */
export function makeupApiProductPrice(product: { price?: unknown; currency?: unknown } | null | undefined): ProductPrice {
  const price = normalizePriceAmount(product?.price);
  return { price, currency: price === null ? null : normalizeCurrencyCode(product?.currency) };
}

/**
 * Re-derives `{ price, currency }` from a stored `external_product.raw_json` (the backfill
 * uses this, the connectors call the same helpers). `storeCurrency` is the Shopify store's
 * currency, when known. Null for sources whose data has no prices (OpenBeautyFacts).
 */
export function productPriceFromRaw(
  sourceName: string,
  raw: unknown,
  storeCurrency: string | null
): ProductPrice | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const product = raw as Record<string, unknown>;
  if (sourceName.endsWith("Shopify")) {
    return shopifyProductPrice(Array.isArray(product.variants) ? (product.variants as ShopifyPriceVariant[]) : null, storeCurrency);
  }
  if (sourceName === "MakeupAPI") return makeupApiProductPrice(product);
  return null;
}
