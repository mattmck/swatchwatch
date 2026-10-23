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

export interface BuyPriceSubtotal {
  currency: string;
  /** Sum of the priced items in this currency, rounded to cents. */
  total: number;
  /** Number of priced items in this currency. */
  count: number;
}

/**
 * Per-currency subtotals of the priced items, largest group first (then by currency code), plus
 * how many items have no usable price. Amounts in different currencies are never added together.
 */
export function buyPriceSubtotals(items: ReadonlyArray<BuyPriceFields | null | undefined>): {
  subtotals: BuyPriceSubtotal[];
  unpricedCount: number;
} {
  const groups = new Map<string, BuyPriceSubtotal>();
  let unpricedCount = 0;
  for (const item of items) {
    const price = buyPriceOf(item);
    if (!price) {
      unpricedCount += 1;
      continue;
    }
    const group = groups.get(price.currency) ?? { currency: price.currency, total: 0, count: 0 };
    // Sum in cents so 0.1 + 0.2 style float noise never shows up in a subtotal.
    group.total = Math.round(group.total * 100 + price.amount * 100) / 100;
    group.count += 1;
    groups.set(price.currency, group);
  }
  const subtotals = Array.from(groups.values()).sort(
    (a, b) => b.count - a.count || (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)
  );
  return { subtotals, unpricedCount };
}
