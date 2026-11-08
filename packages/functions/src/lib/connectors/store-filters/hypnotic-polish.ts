import type { StoreFilterProduct } from "./types.js";

/**
 * Hypnotic Polish (hypnoticpolish.com) product filter.
 *
 * Hypnotic Polish is an EU multi-brand retailer (metadata.kind = "retailer", EUR, 998 products
 * from 16 vendors on 2026-11-08). Its `product_type` is "Nail Polish" on polishes and "Top Coat",
 * "Base Coat", "Topper" or "Treatment" on the coats, which the generic gate classifies with
 * their category. This filter only removes what the generic gate would let through:
 *
 * - `Cuticle Treatment` and `Accessories` product types (cuticle care, magnets, brushes);
 * - grab bag and mystery listings (a random item, not a shade).
 *
 * Everything else returns `null` and goes through the generic gate; the retailer gate then
 * resolves the vendor to a brand and parses the "Brand - Shade" title (pre-order prefix and
 * trailing finish note dropped).
 *
 * Fixture: tests/fixtures/hypnotic-polish-products.json (101 of 998 products, 2026-11-08).
 */

const DROPPED_TYPES: ReadonlySet<string> = new Set(["cuticle treatment", "accessories"]);
const DROPPED_TITLE = /grab bag|mystery/i;

export function isHypnoticPolishPolish(product: StoreFilterProduct): boolean | null {
  const productType = typeof product.product_type === "string" ? product.product_type.trim().toLowerCase() : "";
  if (DROPPED_TYPES.has(productType)) {
    return false;
  }
  const title = typeof product.title === "string" ? product.title : "";
  return DROPPED_TITLE.test(title) ? false : null;
}
