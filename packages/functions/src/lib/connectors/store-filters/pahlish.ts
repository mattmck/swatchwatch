import type { StoreFilterProduct } from "./types.js";

/**
 * Pahlish (pahlish.com) product filter (#328).
 *
 * Pahlish sells only its own polish, but its products.json carries no polish
 * signal the generic filter can use: `product_type` is empty on every product
 * except the gift card, tags are collection names ("Camelot", "Halloween"), and
 * every variant is "Default Title". Fixture: tests/fixtures/pahlish-products.json
 * (36 products, 2026-10-18; 28 are single shades).
 *
 * A product counts as a polish when its title is not a known non-shade listing
 * (gift card, collection set, mystery batch, base/top coat, empty boxes, merch)
 * and its description reads like a shade description, i.e. names a finish or
 * effect ("faded rust with green/aqua/blue shifting shimmer").
 */

const NON_SHADE_TITLE_REGEX = new RegExp(
  "\\b(?:" +
    [
      // multi-shade listings
      "collection",
      "set",
      "bundle",
      "mystery",
      "mysteries",
      "duo",
      "trio",
      // care products, not shades
      "base\\s*coat",
      "top\\s*coat",
      "basecoat",
      "topcoat",
      "cuticle",
      "remover",
      // tools, packaging and merch (multi-word or unambiguous only: a shade may be
      // called "Pin Up" or "Pandora's Box"; single words like those are left to the
      // shade-description check below)
      "empty\\s+boxes",
      "nail\\s+files?",
      "stickers?",
      "t-?shirts?",
      "hoodies?",
      "sweatshirts?",
      "tote(?:\\s+bags?)?",
      "enamel\\s+pins?",
      "keychains?",
      "gift\\s*cards?",
    ].join("|") +
    ")\\b",
  "i"
);

/** Words a Pahlish shade description uses for its base or effect. */
const SHADE_DESCRIPTION_REGEX =
  /\b(?:shimmers?|(?:micro)?flakes?|holographic|holo|glitters?|pigments?|jelly|cr[eè]me|crelly|magnetic|thermal|glow(?:ing|y)?|metallic|iridescent|chrome|duochrome|multichrome|foils?|sparkles?|matte|satin)\b/i;

function stripHtml(value: unknown): string {
  return typeof value === "string" ? value.replace(/<[^>]*>/g, " ") : "";
}

export function isPahlishPolish(product: StoreFilterProduct): boolean {
  const title = typeof product.title === "string" ? product.title : "";
  const productType = typeof product.product_type === "string" ? product.product_type : "";
  if (/gift\s*card/i.test(productType) || NON_SHADE_TITLE_REGEX.test(title)) {
    return false;
  }
  return SHADE_DESCRIPTION_REGEX.test(stripHtml(product.body_html));
}
