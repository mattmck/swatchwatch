import { SHADE_DESCRIPTION_REGEX, stripHtml } from "./shared.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * Penélope Luz (penelopeluz.com) product filter (brand sources plan, Task 11).
 *
 * Penélope Luz sells only its own polish, with an empty `product_type` and no tags on every
 * product (216 on 2026-11-08), so the generic gate keeps nothing. Like Pahlish and Sweet & Sour,
 * the filter works from the title and the description:
 *
 * - Known non-shade listings are dropped by title: sets, bundles, duos, trios, mystery boxes,
 *   bags and polishes (a shade is called "Mystery", so the word alone is not dropped), gift cards,
 *   stickers, magnets and apparel.
 * - Any other product is a shade when its description, after the store's "PRODUCT:" boilerplate
 *   (which says "nail polishes" on every listing), names a polish, finish or effect ("Magnetic
 *   silver with orange/gold shimmer", "The nail polish … is part of the … Collection"). The
 *   cuticle oil (Oilplux) says neither and is dropped.
 *
 * Fixture: tests/fixtures/penelope-luz-products.json (78 of the 216 products, 2026-11-08).
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

/** The store's boilerplate opening paragraph, up to the "DESCRIPTION:" heading. */
const BOILERPLATE_REGEX = /^[\s\S]*?\bdescription\s*:/i;

export function isPenelopeLuzPolish(product: StoreFilterProduct): boolean {
  const title = typeof product.title === "string" ? product.title : "";
  if (NON_SHADE_TITLE_REGEX.test(title)) {
    return false;
  }
  const description = stripHtml(product.body_html).replace(BOILERPLATE_REGEX, "");
  return SHADE_DESCRIPTION_REGEX.test(description);
}
