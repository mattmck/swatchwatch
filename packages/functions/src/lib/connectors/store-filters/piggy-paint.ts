import { lowerTrim, stripHtml } from "./shared.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * Piggy Paint (piggypaint.com) product filter (brand sources plan, Task 11).
 *
 * Piggy Paint sells kids' polish (and its grown-up SOPHi line) next to toys, hair accessories,
 * bath products and wholesale displays, most of them with an empty `product_type`. Its SOPHi shade
 * sets ("Core Collection - SOPHi - Non-toxic Nail Polish") are typed `Nail Polishes` like the
 * single shades, so the generic gate keeps them. First page on 2026-11-08: empty 110, Nail Art
 * Kits & Accessories 92, Nail Polishes 24, Wholesale 12, Gift Sets 7, Nail Care 4 (press-on
 * nails), Decorative Stickers 1.
 *
 * - `Nail Polishes` and empty types: a polish is kept when its title is not a set, kit, gift,
 *   bundle, pack, collection, duo or trio listing and its description does not list several
 *   shades ("Featuring …", "Colors: …", "4 Polishes", "this airy quartet", "this flirty lineup"; not
 *   "set", which a single shade's description uses). An empty-type product must also say
 *   "polish" in its title (the polish pens do; toys and hair clips do not).
 * - Every other type is dropped (Wholesale, Gift Sets, Nail Art Kits & Accessories, Nail Care,
 *   Decorative Stickers).
 *
 * Fixture: tests/fixtures/piggy-paint-products.json (82 of the 250 first-page products, 2026-11-08).
 */

const POLISH_TYPE = "nail polishes";
const SET_TITLE_REGEX = /\b(?:sets?|kits?|gifts?|bundles?|packs?|collections?|duos?|trios?|wholesale)\b/i;
const POLISH_TITLE_REGEX = /\bpolish(?:es)?\b/i;
/** A description that lists the shades of a multi-polish listing. */
const MULTI_SHADE_DESCRIPTION_REGEX =
  /\bcolors\s*:|\bfeaturing\b|\b\d+\s+polishes\b|\b(?:trio|quartet|line-?up|collection|bundle)\b/i;

export function isPiggyPaintPolish(product: StoreFilterProduct): boolean {
  const title = typeof product.title === "string" ? product.title : "";
  const productType = lowerTrim(product.product_type);
  if (productType !== POLISH_TYPE && productType !== "") {
    return false;
  }
  if (SET_TITLE_REGEX.test(title) || (productType === "" && !POLISH_TITLE_REGEX.test(title))) {
    return false;
  }
  return !MULTI_SHADE_DESCRIPTION_REGEX.test(stripHtml(product.body_html));
}
