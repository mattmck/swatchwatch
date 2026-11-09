import { lowerTrim } from "./shared.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * Londontown (londontownusa.com) product filter (brand sources plan, Task 11).
 *
 * Londontown sells its lacquer ("lakur") under `product_type` `Nail Color`, with no polish word in
 * the type and often none in the tags, so the generic gate drops some shades. The same shade names
 * come back as gels under `Gels`. First page on 2026-11-08: Nail Color 68, Gels 65, Sets 39,
 * Nail Care 30, Tools 27, Lip Care 6, Nail Veils 5, Foot Care 4, Concealers 3, GelShift 1,
 * Nail Art 1, PR Bundle 1.
 *
 * - Kept: `Nail Color`, `Nail Veils` (sheer tinted lacquers) and `Concealers` (sheer illuminating
 *   nail concealer lacquers); `Gels` and `GelShift` only when the source's `includeGel` is true.
 * - `Nail Care` defers to the generic gate (null), which keeps the base and top coats, hardeners,
 *   ridge fillers and cuticle oils with their category and drops removers, creams and scrubs.
 * - Dropped: every other type (Sets, Tools, Lip Care, Foot Care, Nail Art, PR Bundle), any title
 *   with set, duo, trio, kit or bundle as a word, and any title ending in " Mini" (the mini size of
 *   a full-size shade, "Pearl Mini" next to "Pearl"; Olive & June drops its minis too).
 *
 * Fixture: tests/fixtures/londontown-products.json (106 of the 250 first-page products, 2026-11-08).
 */

const LACQUER_TYPES: ReadonlySet<string> = new Set(["nail color", "nail veils", "concealers"]);
const GEL_TYPES: ReadonlySet<string> = new Set(["gels", "gelshift"]);
const CARE_TYPE = "nail care";
const SET_TITLE_REGEX = /\b(?:sets?|duos?|trios?|kits?|bundles?)\b/i;
const MINI_TITLE_REGEX = /\sMini$/i;

/** Store filter for Londontown (LondontownShopify): `true` keeps the product, `false` drops it, `null` defers to the generic polish gate. */
export function isLondontownPolish(
  product: StoreFilterProduct,
  settings: { includeGel: boolean } = { includeGel: false }
): boolean | null {
  const title = typeof product.title === "string" ? product.title : "";
  if (SET_TITLE_REGEX.test(title) || MINI_TITLE_REGEX.test(title.trim())) {
    return false;
  }
  const productType = lowerTrim(product.product_type);
  if (LACQUER_TYPES.has(productType)) {
    return true;
  }
  if (GEL_TYPES.has(productType)) {
    return settings.includeGel;
  }
  return productType === CARE_TYPE ? null : false;
}
