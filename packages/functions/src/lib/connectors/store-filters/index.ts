import { isPahlishPolish } from "./pahlish.js";
import type { StoreFilterProduct, StoreProductFilter } from "./types.js";

export type { StoreFilterProduct, StoreProductFilter } from "./types.js";

/**
 * Per-source product filters for stores whose products.json the generic
 * Shopify polish filter cannot classify (#328). The generic connector asks
 * this map first; a source without an entry, or a filter that returns null,
 * falls through to the generic filter. Bundle exclusion still applies after.
 */
export const SHOPIFY_STORE_PRODUCT_FILTERS: Readonly<Record<string, StoreProductFilter>> = {
  PahlishShopify: isPahlishPolish,
};

/** The store filter's verdict for `product`, or null when `source` has none. */
export function shopifyStoreProductVerdict(
  source: string,
  product: StoreFilterProduct
): boolean | null {
  const filter = Object.prototype.hasOwnProperty.call(SHOPIFY_STORE_PRODUCT_FILTERS, source)
    ? SHOPIFY_STORE_PRODUCT_FILTERS[source]
    : undefined;
  return filter ? filter(product) : null;
}
