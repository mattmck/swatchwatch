import { sumListPrices, type ListPriceSubtotal } from "swatchwatch-shared";
import { formatPurchasePrice } from "./inventory-status";

/**
 * Brand list prices next to "Buy from brand" links (`buyPrice` / `buyCurrency` /
 * `buyPriceSeenAt` from the API). These are what the brand's store listed when SwatchWatch last
 * fetched the product, never what the user paid, and are never converted or summed across
 * currencies (same rule as the collection stats).
 */

export interface BuyPriceFields {
  buyPrice?: number | null;
  buyCurrency?: string | null;
  buyPriceSeenAt?: string | null;
}

/** A displayable price: amount + ISO currency, or null when either is missing. */
export function buyPriceOf(fields: BuyPriceFields | null | undefined): { amount: number; currency: string } | null {
  const amount = fields?.buyPrice;
  const currency = fields?.buyCurrency;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amount, currency };
}

/** e.g. `$12.50`; null when the polish has no price with a currency. */
export function formatBuyPrice(fields: BuyPriceFields | null | undefined): string | null {
  const price = buyPriceOf(fields);
  return price ? formatPurchasePrice(price.amount, price.currency) : null;
}

/** "as of Oct 21, 2026" for the price's fetch date, or null when unknown/invalid. */
export function buyPriceAsOf(seenAt: string | null | undefined, locale?: string): string | null {
  if (!seenAt) return null;
  const date = new Date(seenAt);
  if (Number.isNaN(date.getTime())) return null;
  return `as of ${date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" })}`;
}

export type BuyPriceSubtotal = ListPriceSubtotal;

/**
 * Per-currency subtotals of the priced items, largest group first (then by currency code), plus
 * how many items have no usable price. Amounts in different currencies are never added together.
 * Thin wrapper over the shared `sumListPrices` (also used by the wishlist value lines).
 */
export function buyPriceSubtotals(items: ReadonlyArray<BuyPriceFields | null | undefined>): {
  subtotals: BuyPriceSubtotal[];
  unpricedCount: number;
} {
  const { byCurrency, unpricedCount } = sumListPrices(items);
  return { subtotals: byCurrency, unpricedCount };
}
