import { lowerTrim } from "./shared.js";
import type { StoreFilterProduct } from "./types.js";

/**
 * Swamp Gloss (swampgloss.com) product filter.
 *
 * The store (178 products on 2026-11-13) sells its own polish next to body care, wax melts,
 * perfume, stickers, tumblers and a gift card. Most single shades have an empty `product_type`
 * (98), the rest are typed "Nail Polish", "Nail Polishes" or "Cosmetics"; the vendor is either
 * "Swamp Gloss" or "swampgloss.com" (aliased in `metadata.vendorAliases`).
 *
 * - Dropped by title, whatever the type: mystery polishes and overpours ("Lanterns Mystery #4",
 *   "Monthly Overpours", "Charity Mystery Polishes"), oops batches ("Mischievous Scamp Oops"),
 *   duos / trios / quads / sets / bundles, refills (the coat is its own listing), magnets,
 *   stickers, lotion and the gift card.
 * - Dropped by type: the non-polish types (body care, wax melts, hair milk, perfume roller,
 *   cuticle oil, body spray, mango butter, stickers, magnet, tumblers, gift card) and "nail care"
 *   (hair oil and an acetone additive) unless the title names a base or top coat.
 * - Kept: an empty type or a polish type ("Nail Polish(es)", "Cosmetics", "Quick Dry Top Coat");
 *   materialization stores a coat's category (D23).
 * - Any other type defers to the generic gate (null).
 *
 * Fixture: tests/fixtures/swamp-gloss-products.json (all 178 products, 2026-11-13).
 */

const NON_SHADE_TITLE_REGEX = new RegExp(
  "\\b(?:" +
    [
      "myster(?:y|ies)",
      "overpours?",
      "oops(?:ie)?",
      "duo",
      "trio",
      "quad",
      "sets?",
      "bundles?",
      "refills?",
      "magnets?",
      "stickers?",
      "lotion",
      "gift\\s*cards?",
    ].join("|") +
    ")\\b",
  "i"
);

const NON_POLISH_TYPES = new Set([
  "body care",
  "wax melts",
  "hair milk",
  "perfume roller",
  "cuticle oil",
  "body spray",
  "whipped mango buttet",
  "whipped mango butter",
  "decorative stickers",
  "magnet",
  "tumblers",
  "gift card",
]);

const POLISH_TYPES = new Set(["", "nail polish", "nail polishes", "cosmetics", "quick dry top coat"]);

const COAT_TITLE_REGEX = /\b(?:top\s*coat|base\s*coat|topcoat|basecoat)\b/i;

/** Store filter for Swamp Gloss (SwampGlossShopify): `true` keeps, `false` drops, `null` defers to the generic gate. */
export function isSwampGlossPolish(product: StoreFilterProduct): boolean | null {
  const title = typeof product.title === "string" ? product.title : "";
  if (NON_SHADE_TITLE_REGEX.test(title)) {
    return false;
  }
  const type = lowerTrim(product.product_type);
  if (NON_POLISH_TYPES.has(type)) {
    return false;
  }
  if (type === "nail care") {
    return COAT_TITLE_REGEX.test(title);
  }
  if (POLISH_TYPES.has(type)) {
    return true;
  }
  return null;
}

/** A trailing charity note: "Needed (GATE charity polish)". */
const CHARITY_NOTE_REGEX = /\s*\([^()]*\bcharity\b[^()]*\)\s*$/i;

/**
 * Swamp Gloss title → shade name: drops one trailing charity note ("Needed (GATE charity polish)"
 * → "Needed"); null keeps the raw title.
 */
export function parseSwampGlossTitle(product: StoreFilterProduct): string | null {
  const title = typeof product.title === "string" ? product.title.trim() : "";
  if (!CHARITY_NOTE_REGEX.test(title)) {
    return null;
  }
  const name = title.replace(CHARITY_NOTE_REGEX, "").trim();
  return name ? name : null;
}
