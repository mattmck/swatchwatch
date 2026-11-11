import type { StoreFilterProduct } from "./types.js";

/**
 * Potion Polish (potionpolish.com) on Big Cartel: product filter and shade-name parser for the
 * `PotionPolishBigCartel` source, keyed by source name in the Shopify registries
 * (`SHOPIFY_STORE_PRODUCT_FILTERS`, `SHOPIFY_STORE_TITLE_PARSERS`) like the Shopify stores.
 *
 * Measured on 2026-11-10 (35 products): every product is a polish, but the categories are finish
 * and collection names ("Glitter Jellies", "Magnetics", "Shimmers", "Holos", "Autumn 2026",
 * "On Sale", "Mystery Polish"), so the generic gate, which looks for a polish word, keeps none.
 * Mystery listings ("Magnetic Mystery Duo", "Holiday Mystery Trio 2025 Overpour") carry the
 * `Mystery Polish` category.
 *
 * - `Mystery Polish` → dropped;
 * - everything else → kept (the gate still drops sets and mystery titles).
 */

export function isPotionPolishPolish(product: StoreFilterProduct): boolean | null {
  const tags = Array.isArray(product.tags) ? product.tags : [];
  const mystery = [product.product_type, ...tags].some(
    (value) => typeof value === "string" && value.trim().toLowerCase() === "mystery polish"
  );
  return !mystery;
}

/** A " - " (or spaced en / em dash) between title segments. */
const SEGMENT_SEPARATOR = /\s+[-–—]\s+/;
/** A trailing note segment: an edition, the magnetic finish, or a stock note. */
const NOTE_SEGMENT = /^(?:limited edition|magnetic|last chance for now!?|back in stock\b.*)$/i;

/**
 * Potion Polish titles carry trailing " - " notes: "Cinnamon Cider 2.0 - Limited Edition",
 * "Autumn Enthusiast - Magnetic - Limited Edition", "Ruby - Last Chance For Now!",
 * "Heavyweight Witchcraft 2.0 - Back In Stock 11/27 for Black Friday!". Drops note segments from
 * the end until a non-note segment is reached (the first segment is never dropped); "2.0" stays.
 * Returns null (keep the raw title) when nothing was dropped.
 */
export function parsePotionPolishTitle(product: StoreFilterProduct): string | null {
  const title = typeof product.title === "string" ? product.title.trim() : "";
  const segments = title.split(SEGMENT_SEPARATOR).map((segment) => segment.trim());
  let end = segments.length;
  while (end > 1 && NOTE_SEGMENT.test(segments[end - 1])) {
    end -= 1;
  }
  if (end === segments.length) {
    return null;
  }
  const name = segments.slice(0, end).join(" - ").trim();
  return name ? name : null;
}
