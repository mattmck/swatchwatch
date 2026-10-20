import type { StoreFilterProduct } from "./types.js";

/**
 * Cirque Colors (cirquecolors.com) product filter (#273).
 *
 * Cirque's `product_type` holds the finish or line of a shade ("Jelly", "Magnetic",
 * "Crème", "Shimmergraphic™", "Retired Colors", ...) and never says "polish", so
 * the generic gate accepts only 10 of its 415 products. Fixture:
 * tests/fixtures/cirque-colors-products.json (415 products, 2026-10-19).
 *
 * - Sets, duos, trios, bundles, nail art kits, tools, charms, gift cards, free
 *   gifts and the creator profile pages (empty `product_type`, no finish tag) are
 *   dropped.
 * - Top/base coats, strengtheners and cuticle oils are kept: materialization
 *   stores them with their category (D23). The generic gate would drop them,
 *   because Cirque tags its coats with nail-art tutorial names ("Abstract Dry
 *   Brush") that hit the June tag blocklist; the same tags are on some shades.
 * - Any other product whose `product_type` (or, when that is empty, a tag) names a
 *   finish or line is a single shade.
 */

/** product_type values that are never a single shade. */
const NON_SHADE_PRODUCT_TYPES: ReadonlySet<string> = new Set([
  "sets",
  "duo",
  "nail art sets",
  "collection set",
  "nail art",
  "tools",
  "gift card",
  // A typo'd product_type on one duo listing.
  "dfddf",
]);

/** Care product types: only the coats and oils matched by title above are kept. */
const CARE_PRODUCT_TYPES: ReadonlySet<string> = new Set(["nail care", "base coat"]);

const MULTI_ITEM_TITLE_REGEX =
  /\b(?:sets?|duo|trio|quad|bundle|collection|kit|gift\s*cards?)\b/i;

const NON_POLISH_TITLE_REGEX =
  /\b(?:charms?|brush(?:es)?|files?|wipes?|magnet|wand|dotting|tools?|pickup|stickers?|remover)\b/i;

const CARE_TITLE_REGEX =
  /\b(?:top\s*coat|base\s*coat|topcoat|basecoat|strengthener|cuticle\s+oil|nail\s*&\s*cuticle\s+oil)\b/i;

/** Finish / line words Cirque uses as product_type or tags on its shades. */
const SHADE_LINE_REGEX =
  /\b(?:cr[eè]me|jelly|crelly|topper|neon|shimmers?|shimmergraphic|magnetic|thermal|glitter|retired\s+colors|sheer|hint\s+tint|metallic|holographic|iridescent|bring\s+back)\b/i;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((tag): tag is string => typeof tag === "string");
  }
  return typeof value === "string" ? value.split(",").map((tag) => tag.trim()) : [];
}

export function isCirqueColorsPolish(product: StoreFilterProduct): boolean {
  const title = asText(product.title);
  const productType = asText(product.product_type);
  const tags = asTags(product.tags);
  const normalizedType = productType.toLowerCase();

  // Free gifts with purchase ("🎁 Superfreak (100% off)") duplicate a real listing.
  if (/\(\s*100%\s*off\s*\)/i.test(title) || tags.some((tag) => tag.toLowerCase() === "bogos-gift")) {
    return false;
  }
  if (NON_SHADE_PRODUCT_TYPES.has(normalizedType) || MULTI_ITEM_TITLE_REGEX.test(title)) {
    return false;
  }
  if (CARE_TITLE_REGEX.test(title)) {
    return true;
  }
  if (CARE_PRODUCT_TYPES.has(normalizedType) || NON_POLISH_TITLE_REGEX.test(title)) {
    return false;
  }
  if (productType) {
    return SHADE_LINE_REGEX.test(productType);
  }
  return tags.some((tag) => SHADE_LINE_REGEX.test(tag));
}
