import type { StoreFilterProduct } from "./types.js";

/**
 * Stella Chroma (stellachroma.com) product filter (#273).
 *
 * Stella Chroma types its shades "Nail Polish" / "Nail Polishes", so the generic
 * gate reads most of the catalog correctly (72 of 81 on 2026-10-22). It gets a
 * few listings wrong, because the store uses the polish product type for things
 * that are not a single shade and the June tag blocklist drops its cuticle oil:
 *
 * - "… Complete set" collection sets, the "Base Coat and Top Coat Duo", the
 *   "Mysteries!" grab bag and the "Monthly Mystery Subscription" are dropped.
 * - The cuticle oil (tagged "brush pen", which the blocklist reads as a brush)
 *   is kept; materialization stores it as a treatment (D23).
 * - Everything else defers to the generic gate (`null`), which already keeps the
 *   polishes and coats and drops the shirt, magnets, gift card, "Rush Processing"
 *   and "Shipping Protection".
 *
 * Fixture: tests/fixtures/stella-chroma-products.json (81 products, 2026-10-22).
 */

const NON_SHADE_TITLE_REGEX =
  /\b(?:complete\s+sets?|duo|trio|quad|bundle|myster(?:y|ies)|subscription)\b/i;

const CARE_TITLE_REGEX = /\b(?:cuticle\s+oil)\b/i;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isStellaChromaPolish(product: StoreFilterProduct): boolean | null {
  const title = asText(product.title);
  if (NON_SHADE_TITLE_REGEX.test(title)) {
    return false;
  }
  if (CARE_TITLE_REGEX.test(title)) {
    return true;
  }
  return null;
}
