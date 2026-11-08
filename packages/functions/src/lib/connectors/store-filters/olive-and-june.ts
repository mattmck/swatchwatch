import { lowerTrim } from "./shared.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * Olive & June (oliveandjune.com) product filter (brand sources plan, Task 11).
 *
 * Most of the store is press-ons, gel, dip powder, systems and sets; its `Nail Polish` type also
 * carries the polish sets and "looks" (a named set such as "Bittersweet Cherry"). Single polishes
 * are tagged `indiv-polish` and single gels `indiv-gel`, which is what the filter keys on. First
 * page on 2026-11-08: Press-On 51, Tab Press-On 30, Nail Polish 28, Pressies 22, Gel Polish 20,
 * Dip Powder 20, Mini Polish 19, Nail Art Stickers 11, Quick Dry Polish 7, System 7, and smaller
 * system, set, sticker, mystery-box and merchandise types.
 *
 * - Kept: `Nail Polish` and `Quick Dry Polish` listings tagged `indiv-polish` (true, so the glow
 *   topper's KIT tag cannot drop it).
 * - `Gel Polish` and `Builder Gel Polish` listings tagged `indiv-gel`: kept only when the source's
 *   `includeGel` is true.
 * - `Care` defers to the generic gate (null).
 * - Dropped: every other listing, including `Mini Polish` (mini sizes of the full-size shades, plus
 *   a few mini-only collab shades, hidden from the store's search), and any title with set, kit,
 *   system, duo, calendar or edit as a word.
 *
 * Fixture: tests/fixtures/olive-and-june-products.json (110 of the 250 first-page products, 2026-11-08).
 */

const LACQUER_TYPES: ReadonlySet<string> = new Set(["nail polish", "quick dry polish"]);
const GEL_TYPES: ReadonlySet<string> = new Set(["gel polish", "builder gel polish"]);
const CARE_TYPE = "care";
const SINGLE_POLISH_TAG = "indiv-polish";
const SINGLE_GEL_TAG = "indiv-gel";
const SET_TITLE_REGEX = /\b(?:sets?|kits?|systems?|duos?|calendars?|edit)\b/i;

function tagSet(tags: unknown): Set<string> {
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  return new Set(list.map(lowerTrim).filter(Boolean));
}

export function isOliveAndJunePolish(
  product: StoreFilterProduct,
  settings: { includeGel: boolean } = { includeGel: false }
): boolean | null {
  const title = typeof product.title === "string" ? product.title : "";
  if (SET_TITLE_REGEX.test(title)) {
    return false;
  }
  const productType = lowerTrim(product.product_type);
  const tags = tagSet(product.tags);
  if (LACQUER_TYPES.has(productType)) {
    return tags.has(SINGLE_POLISH_TAG);
  }
  if (GEL_TYPES.has(productType)) {
    return settings.includeGel && tags.has(SINGLE_GEL_TAG);
  }
  return productType === CARE_TYPE ? null : false;
}
