import type { StoreFilterProduct } from "./types.js";

/**
 * wet n wild (wetnwildbeauty.com) product filter (brand sources plan, Task 11).
 *
 * wet n wild is a cosmetics store with a small polish line ("Fast Dry AF Nail Color | <shade>",
 * Wild Shine). Its primers, setting sprays and lip treatment pass the generic gate as base coats
 * and treatments, so the filter keeps only nail polish: a product whose title or `product_type`
 * names nail color, nail polish or Wild Shine. Everything else is dropped. First page on
 * 2026-11-08: 250 products in 33 cosmetics types, 6 of them typed `Nail Polishes`.
 *
 * Fixture: tests/fixtures/wet-n-wild-products.json (62 of the 250 first-page products, 2026-11-08).
 */

const POLISH_REGEX = /\b(?:nail\s+colou?rs?|nail\s+polish(?:es)?|wild\s+shine)\b/i;

/** Store filter for wet n wild (WetNWildShopify): `true` keeps the product, `false` drops it, `null` defers to the generic polish gate. */
export function isWetNWildPolish(product: StoreFilterProduct): boolean {
  const title = typeof product.title === "string" ? product.title : "";
  const productType = typeof product.product_type === "string" ? product.product_type : "";
  return POLISH_REGEX.test(title) || POLISH_REGEX.test(productType);
}
