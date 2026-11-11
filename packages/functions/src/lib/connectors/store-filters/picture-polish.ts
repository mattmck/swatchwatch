import type { StoreFilterProduct } from "./types.js";

/**
 * Picture Polish (picturepolish.com.au) on WooCommerce: product filter and shade-name parser for
 * the `PicturePolishWooCommerce` source, keyed by source name in the Shopify registries
 * (`SHOPIFY_STORE_PRODUCT_FILTERS`, `SHOPIFY_STORE_TITLE_PARSERS`), read through
 * `wooStoreFilterProduct` (`product_type` = the first category, `tags` = the product tags, then
 * every other category: WordPress lists categories alphabetically, so "Nail Colours" is rarely
 * first).
 *
 * Measured on 2026-11-10 (143 products, all simple): `Nail Colours` 106, `Bundles` 16,
 * `Base & Top Coats` 8, `Nail Care` 7, `Nail Art` 6, plus colour, finish and season names.
 *
 * - `Bundles` → dropped (also under `Nail Colours`);
 * - `Nail Colours` → kept;
 * - anything else → `null` (the generic gate decides: coats are kept with their category, care
 *   and tools are dropped).
 */

function categoriesOf(product: StoreFilterProduct): string[] {
  const tags = Array.isArray(product.tags) ? product.tags : [];
  return [product.product_type, ...tags].flatMap((value) =>
    typeof value === "string" && value.trim() ? [value.trim().toLowerCase()] : []
  );
}

export function isPicturePolishPolish(product: StoreFilterProduct): boolean | null {
  const categories = categoriesOf(product);
  if (categories.includes("bundles")) {
    return false;
  }
  return categories.includes("nail colours") ? true : null;
}

/**
 * Picture Polish names are "<Shade> | <Colour> | <Finish>" ("Camelot | Purple | Flakie",
 * "Supernova | Multi-chrome | Magnetic"): the FIRST " | " segment is the shade (unlike
 * `parseLineAndShadeTitle`, where the first segment is a product line). Null (keep the raw title)
 * when the name has no "|" or the first segment is empty. The title arrives HTML-decoded.
 */
export function parsePicturePolishTitle(product: StoreFilterProduct): string | null {
  const title = typeof product.title === "string" ? product.title.trim() : "";
  if (!title.includes("|")) {
    return null;
  }
  const name = title.split("|")[0].replace(/\s+/g, " ").trim();
  return name ? name : null;
}
