import { SHADE_DESCRIPTION_REGEX, stripHtml } from "./shared.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * Noodles Nail Polish (noodlesnailpolish.com) product filter (brand sources plan, Task 11).
 *
 * Noodles sells only its own polish, with an empty `product_type` and no tags on every product
 * (57 on 2026-11-08: 56 shades and the gift card), so the generic gate keeps nothing. Like
 * Pahlish and Sweet & Sour, the filter works from the title and the description:
 *
 * - Known non-shade listings are dropped by title: sets, bundles, duos, trios, mystery boxes / bags / polishes / packs (a shade named "Mystery" stays),
 *   gift cards, stickers, magnets and apparel.
 * - Any other product is a shade when its description names a polish, finish or effect ("A dusty
 *   purple crelly with metallic rose gold … glitters", "A clear based topper with …").
 *
 * Fixture: tests/fixtures/noodles-products.json (all 57 products, 2026-11-08).
 */

const NON_SHADE_TITLE_REGEX = new RegExp(
  "\\b(?:" +
    [
      "sets?",
      "bundles?",
      "duos?",
      "trios?",
      "myster(?:y|ies)\\s+(?:box(?:es)?|bags?|polish(?:es)?|packs?)",
      "gift\\s*cards?",
      "stickers?",
      "magnets?",
      "t-?shirts?",
      "hoodies?",
      "tote(?:\\s+bags?)?",
    ].join("|") +
    ")\\b",
  "i"
);

/** Store filter for Noodles Nail Polish (NoodlesNailPolishShopify): `true` keeps the product, `false` drops it, `null` defers to the generic polish gate. */
export function isNoodlesPolish(product: StoreFilterProduct): boolean {
  const title = typeof product.title === "string" ? product.title : "";
  if (NON_SHADE_TITLE_REGEX.test(title)) {
    return false;
  }
  return SHADE_DESCRIPTION_REGEX.test(stripHtml(product.body_html));
}
