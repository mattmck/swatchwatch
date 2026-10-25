import { isCirqueColorsPolish } from "./cirque-colors.js";
import { isLemmingLacquerPolish } from "./lemming-lacquer.js";
import { isPahlishPolish } from "./pahlish.js";
import { isStellaChromaPolish } from "./stella-chroma.js";
import { isSweetAndSourPolish } from "./sweet-and-sour.js";
import type { StoreFilterProduct, StoreProductFilter } from "./types.js";

export type { StoreFilterProduct, StoreProductFilter } from "./types.js";

/**
 * Per-source product filters for stores whose products.json the generic
 * Shopify polish filter cannot classify (#328, #273). The generic connector asks
 * this map first; a source without an entry, or a filter that returns null,
 * falls through to the generic filter. Bundle exclusion still applies after.
 */
export const SHOPIFY_STORE_PRODUCT_FILTERS: Readonly<Record<string, StoreProductFilter>> = {
  PahlishShopify: isPahlishPolish,
  CirqueColorsShopify: isCirqueColorsPolish,
  StellaChromaShopify: isStellaChromaPolish,
  LemmingLacquerShopify: isLemmingLacquerPolish,
  SweetAndSourLacquerShopify: isSweetAndSourPolish,
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
