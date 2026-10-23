import type { StoreFilterProduct } from "./types.js";

/**
 * Sweet & Sour Lacquer (sweetandsourlacquer.com) product filter (#273).
 *
 * Every Sweet & Sour product has an empty `product_type` and no tags, so the
 * generic gate keeps only the five coats it can read from the title (8 of 169
 * on 2026-10-22, three of them refills). Like Pahlish, the store sells almost
 * only its own polish, so the filter works from the title and the description:
 *
 * - Known non-shade listings are dropped by title: duos, trios, quads, sets,
 *   bundles, the mystery overpour, coat refills (the coat itself is a separate
 *   listing), the gift card, the magnet, the sticker, the can coozies and tab
 *   opener, and the clear watermarbling polish.
 * - Base and top coats are kept (materialization stores their category, D23).
 * - Any other product is a shade when its description names a base, finish or
 *   effect ("neon green crelly with iridescent flakes", "Base : clear Glitter :
 *   …", "Opacity : 2-3 coats", "Each polish is named after …"), or when it has
 *   no description beyond the store's screen-colour disclaimer (several shades
 *   are listed with no text at all). A description that says something else
 *   (merch, a service) is dropped.
 *
 * Fixture: tests/fixtures/sweet-and-sour-products.json (169 products,
 * 2026-10-22; 155 are single shades or coats).
 */

const NON_SHADE_TITLE_REGEX = new RegExp(
  "\\b(?:" +
    [
      // multi-shade listings and grab bags
      "duo",
      "trio",
      "quad",
      "sets?",
      "bundle",
      "myster(?:y|ies)",
      "overpour",
      // care product refills duplicate the coat listing
      "refills?",
      // tools, merch and services
      "gift\\s*cards?",
      "magnets?",
      "stickers?",
      "coozies?",
      "koozies?",
      "tab\\s+openers?",
      // the clear watermarbling polish ("Saucy Marbles"); a shade called "Marble Cake" passes
      "marbles",
      "t-?shirts?",
      "tote(?:\\s+bags?)?",
    ].join("|") +
    ")\\b",
  "i"
);

const CARE_TITLE_REGEX = /\b(?:top\s*coat|base\s*coat|topcoat|basecoat)\b/i;

/** Words a Sweet & Sour listing uses to describe a shade's base, finish or wear. */
const SHADE_DESCRIPTION_REGEX =
  /\b(?:shimmers?|shimmery|(?:micro)?flakes?|flakies|holographic|holo|glitters?|hexes|jelly|cr[eè]mes?|crelly|magnetic|thermal|glow(?:s|ing)?|metallic|iridescent|chrome|duochrome|multichrome|foils?|sparkles?|matte|satin|neon|sheer|shift(?:s|ing)?|topper|coats|polish(?:es)?|lacquers?)\b/i;

/** The store's boilerplate about screen colours, appended to most descriptions. */
const DISCLAIMER_REGEX = /disclaimer\s*:[\s\S]*$/i;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stripHtml(value: unknown): string {
  return typeof value === "string" ? value.replace(/<[^>]*>/g, " ") : "";
}

export function isSweetAndSourPolish(product: StoreFilterProduct): boolean {
  const title = asText(product.title);
  if (NON_SHADE_TITLE_REGEX.test(title)) {
    return false;
  }
  if (CARE_TITLE_REGEX.test(title)) {
    return true;
  }
  const description = stripHtml(product.body_html).replace(DISCLAIMER_REGEX, "").trim();
  if (description === "") {
    return true;
  }
  return SHADE_DESCRIPTION_REGEX.test(description);
}
