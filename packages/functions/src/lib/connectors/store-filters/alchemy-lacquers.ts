import type { StoreFilterProduct } from "./types.js";

/**
 * Alchemy Lacquers (alchemylacquers.com) product filter (brand sources plan, Phase C review I2).
 *
 * Alchemy Lacquers sells only its own polish, tools and merchandise, which the generic gate
 * classifies correctly, except for blind listings typed `Nail Lacquer` ("Mystery Overpours"):
 * the filter drops mystery, grab bag, sample and "pick N" listings and defers everything else to
 * the generic gate (null). First page on 2026-11-08: 228 products (Nail Lacquer 198, empty 30).
 *
 * Fixture: tests/fixtures/alchemy-lacquers-products.json (2026-11-08, fixture _note).
 */

const BLIND_LISTING_REGEX = /\b(?:myster(?:y|ies)|grab\s*bags?|samples?|pick\s+(?:any\s+)?\d+|pick\s+(?:two|three|four|five))\b/i;

export function isAlchemyLacquersPolish(product: StoreFilterProduct): boolean | null {
  const title = typeof product.title === "string" ? product.title : "";
  return BLIND_LISTING_REGEX.test(title) ? false : null;
}
