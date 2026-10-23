import {
  formatListPriceAsOf,
  formatListPriceSummary,
  formatWishlistValueLine,
  sumListPrices,
  type ListPriceFields,
  type Polish,
} from "swatchwatch-shared";

/**
 * What the wishlist adds up to in the brands' list prices (web: `lib/wishlist-value.ts`): one
 * total per currency, never converted or summed across currencies; polishes without a known
 * price are counted, never guessed. Not what the user paid.
 */
export interface WishlistValueView {
  /** "12 polishes · $148.00 (9 priced) + €20.00 (2) · 1 without a price". */
  line: string;
  /** "$148.00 (9 priced) + €20.00 (2) · 1 without a price", or null for an empty wishlist. */
  summary: string | null;
  /** "as of Oct 21, 2026" for the newest price, or null when no row carries a fetch date. */
  asOf: string | null;
  hasPrices: boolean;
}

export function wishlistValueView(rows: readonly ListPriceFields[], locale?: string): WishlistValueView {
  const totals = sumListPrices(rows);
  return {
    line: formatWishlistValueLine(rows.length, totals, locale),
    summary: formatListPriceSummary(totals, locale),
    asOf: formatListPriceAsOf(totals.latestSeenAt, locale),
    hasPrices: totals.byCurrency.length > 0,
  };
}

/** Only the price fields of each wishlist row: a small payload for the persisted cache. */
export function slimWishlistRows(rows: readonly Polish[]): ListPriceFields[] {
  return rows.map((row) => ({
    buyPrice: row.buyPrice ?? null,
    buyCurrency: row.buyCurrency ?? null,
    buyPriceSeenAt: row.buyPriceSeenAt ?? null,
  }));
}

/** api-cache key for the slim wishlist rows (per user, an inventory cache key). */
export const WISHLIST_VALUE_CACHE_KEY = "wishlist-value";
