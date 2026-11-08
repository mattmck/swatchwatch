import { RETAILER_SET_REGEX } from "../retailer-title.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * Harlow & Co (harlowandco.org) product filter.
 *
 * Harlow & Co is a Canadian multi-brand retailer (metadata.kind = "retailer"). Its polish is
 * typed "Nail Polish" / "Nail Polishes" (ILNP, KBShimmer, Cirque, Color Club, Polished for Days,
 * Emily de Molly, I Scream Nails); the rest of the catalog is other vendors' decals, stamping
 * plates, scrubs, oils, lotions, magnets and apparel.
 *
 * - Non-polish product types and non-polish vendors are dropped.
 * - Set, collection, bundle and similar titles are dropped (the retailer title parser's set
 *   regex), so a multi-polish listing never becomes a shade.
 * - Everything else is deferred (`null`): the generic gate accepts "Nail Polish" /
 *   "Nail Polishes" and the retailer gate then resolves the vendor and parses the title.
 *
 * Fixture: tests/fixtures/harlow-and-co-products.json (102 of 1,537 products, 2026-11-08).
 */

const NON_POLISH_PRODUCT_TYPES: ReadonlySet<string> = new Set([
  "manicure accessories",
  "lotion",
  "stamping plate",
  "apparel & accessories",
  "gift card",
]);

const NON_POLISH_VENDORS: ReadonlySet<string> = new Set([
  "milv",
  "lina nail art supplies",
  "deco beauty",
  "walton wood farm",
  "cutie oils",
  "simply polished",
  "harlow & co.",
]);

function lowerTrim(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isHarlowAndCoPolish(product: StoreFilterProduct): boolean | null {
  if (NON_POLISH_PRODUCT_TYPES.has(lowerTrim(product.product_type))) {
    return false;
  }
  if (NON_POLISH_VENDORS.has(lowerTrim(product.vendor))) {
    return false;
  }
  const title = typeof product.title === "string" ? product.title : "";
  if (RETAILER_SET_REGEX.test(title)) {
    return false;
  }
  return null;
}
