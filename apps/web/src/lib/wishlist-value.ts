import {
  formatListPriceAsOf,
  formatListPriceSummary,
  formatWishlistValueLine,
  sumListPrices,
  type ListPriceFields,
} from "swatchwatch-shared";

/**
 * What the wishlist adds up to, from the brands' list prices (`buyPrice` / `buyCurrency`): one
 * total per currency, never converted or summed across currencies; polishes without a known price
 * are counted, never guessed. Computed from every wishlist row (not the visible page).
 */
export interface WishlistValueView {
  /** "12 polishes · $148.00 (9 priced) + €20.00 (2) · 1 without a price". */
  line: string;
  /** "$148.00 (9 priced) + €20.00 (2) · 1 without a price", or null for an empty wishlist. */
  summary: string | null;
  /** "as of Oct 21, 2026" for the newest price, or null when no row carries a fetch date. */
  asOf: string | null;
  /** True when at least one row has a price. */
  hasPrices: boolean;
}

export function wishlistValueView(rows: ReadonlyArray<ListPriceFields>, locale?: string): WishlistValueView {
  const totals = sumListPrices(rows);
  return {
    line: formatWishlistValueLine(rows.length, totals, locale),
    summary: formatListPriceSummary(totals, locale),
    asOf: formatListPriceAsOf(totals.latestSeenAt, locale),
    hasPrices: totals.byCurrency.length > 0,
  };
}
