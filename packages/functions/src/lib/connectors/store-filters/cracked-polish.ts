import type { StoreFilterProduct } from "./types.js";

/**
 * Cracked Polish (crackedpolish.com): shade-name parser for `CrackedPolishShopify` (no product
 * filter: every stored product is typed Nail Polish and the generic gate handles it).
 *
 * Measured on the first ingest (2026-11-10, 130 stored products): one topper titled "Truly
 * Outrageous Topper" while its bottle sticker says "Truly Outrageous", and box / club exclusives
 * carrying a trailing code like the "PPU" every source already drops ("Guided Light HHC", "Bug
 * Splat LBOH"). The product category is still read from the raw title, so the topper stays a
 * topper. "(old)" and "BCA Box" notes are kept (one listing each, meaning unclear).
 */

const TRAILING_WORD_REGEX = /\s+(?:Topper|HHC|LBOH)$/;

/** Cracked Polish: the title without one trailing " Topper", " HHC" or " LBOH"; null otherwise. */
export function parseCrackedPolishTitle(product: StoreFilterProduct): string | null {
  const title = typeof product.title === "string" ? product.title.trim() : "";
  const match = TRAILING_WORD_REGEX.exec(title);
  if (!match) {
    return null;
  }
  const name = title.slice(0, match.index).trim();
  return name ? name : null;
}
