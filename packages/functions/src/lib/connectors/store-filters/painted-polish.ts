import type { StoreFilterProduct } from "./types.js";

/**
 * Painted Polish (paintedpolish.com) on Big Cartel: product filter and shade-name parser for the
 * `PaintedPolishBigCartel` source. Big Cartel is not Shopify, but the filter and the parser are
 * keyed by source name in the same registries (`SHOPIFY_STORE_PRODUCT_FILTERS`,
 * `SHOPIFY_STORE_TITLE_PARSERS`), read through `bigCartelStoreFilterProduct` (`product_type` = the
 * first category, `tags` = every category).
 *
 * Measured on 2026-11-10 (287 products): 245 carry the category `Individual Shades`, 38 `Sets`
 * (never both); one listing is titled `Imperfect Label Bottles` (seconds of several shades, no
 * category); three single shades carry neither category ("Stay Wicked").
 *
 * - `Individual Shades` → kept;
 * - `Sets`, or the `Imperfect Label Bottles` listing → dropped;
 * - anything else → `null` (the generic gate decides).
 */

const INDIVIDUAL_SHADES = "individual shades";
const SETS = "sets";
const IMPERFECT_LABEL_TITLE = /^imperfect label bottles$/i;

function categoriesOf(product: StoreFilterProduct): string[] {
  const tags = Array.isArray(product.tags) ? product.tags : [];
  const values = [product.product_type, ...tags];
  return values.flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim().toLowerCase()] : []));
}

export function isPaintedPolishPolish(product: StoreFilterProduct): boolean | null {
  const title = typeof product.title === "string" ? product.title.trim() : "";
  if (IMPERFECT_LABEL_TITLE.test(title)) {
    return false;
  }
  const categories = categoriesOf(product);
  if (categories.includes(SETS)) {
    return false;
  }
  return categories.includes(INDIVIDUAL_SHADES) ? true : null;
}

/** One trailing parenthetical that mentions FINAL: "(FINAL 3 BOTTLES)", "(LOW FINAL STOCK)". */
const TRAILING_FINAL_NOTE = /\s*\(([^()]*)\)\s*$/;

/**
 * Painted Polish titles end in a stock note: "Pumpkin To Talk About (FINAL 3 BOTTLES)",
 * "Pretty Poison (Please Read Listing - FINAL 10 BOTTLES)". Drops ONE trailing parenthetical
 * when it contains "final" (any case); any other note ("(LE)", "(… FB Group Custom)") stays.
 * Returns null (keep the raw title) when there is no such note or nothing would be left.
 */
export function parsePaintedPolishTitle(product: StoreFilterProduct): string | null {
  const title = typeof product.title === "string" ? product.title.trim() : "";
  const match = TRAILING_FINAL_NOTE.exec(title);
  if (!match || !/final/i.test(match[1])) {
    return null;
  }
  const name = title.slice(0, match.index).replace(/\s+/g, " ").trim();
  return name ? name : null;
}
