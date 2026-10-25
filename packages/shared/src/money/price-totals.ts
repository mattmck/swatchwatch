/**
 * Brand list-price totals (`buyPrice` / `buyCurrency` / `buyPriceSeenAt` from the API). These are
 * what a brand's store listed when SwatchWatch last fetched the product, never what the user paid.
 * Amounts in different currencies are never converted or added together (same rule as the
 * collection stats, D6); rows without a usable price are counted, never guessed.
 */

export interface ListPriceFields {
  buyPrice?: number | null;
  buyCurrency?: string | null;
  buyPriceSeenAt?: string | null;
}

export interface ListPrice {
  amount: number;
  currency: string;
}

export interface ListPriceSubtotal {
  currency: string;
  /** Sum of the priced rows in this currency, rounded to the currency's minor unit. */
  total: number;
  /** Number of priced rows in this currency. */
  count: number;
}

export interface ListPriceTotals {
  /** One subtotal per currency, largest group first (then by currency code). */
  byCurrency: ListPriceSubtotal[];
  /** Rows with no usable price (missing amount or currency). */
  unpricedCount: number;
  /** The most recent `buyPriceSeenAt` among the priced rows (ISO 8601), or null. */
  latestSeenAt: string | null;
}

/** A usable price: finite non-negative amount + ISO 4217-shaped currency, else null. */
export function listPriceOf(fields: ListPriceFields | null | undefined): ListPrice | null {
  const amount = fields?.buyPrice;
  const currency = fields?.buyCurrency;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amount, currency };
}

const minorUnitScales = new Map<string, number>();
/**
 * Minor units per major unit (100 for USD, 1000 for KWD, 1 for JPY) from `Intl.NumberFormat`'s
 * fraction digits, so totals round the way the prices display. Unknown codes get two digits.
 */
function minorUnitScale(currency: string): number {
  let scale = minorUnitScales.get(currency);
  if (scale === undefined) {
    let digits = 2;
    try {
      digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      // Not a currency code Intl accepts: keep the two-digit default.
    }
    scale = 10 ** digits;
    minorUnitScales.set(currency, scale);
  }
  return scale;
}

/** Whole minor units, rounded half away from zero (`1.005` USD -> 101); drops binary error first. */
function toMinorUnits(amount: number, scale: number): number {
  return Math.round(Number((amount * scale).toPrecision(12)));
}

/**
 * Per-currency totals of the priced rows plus how many rows have no usable price. Sums whole
 * minor units so float noise (0.1 + 0.2) never shows up.
 */
export function sumListPrices(rows: ReadonlyArray<ListPriceFields | null | undefined>): ListPriceTotals {
  const minor = new Map<string, { sum: number; count: number }>();
  let unpricedCount = 0;
  let latest = 0;
  let latestSeenAt: string | null = null;
  for (const row of rows) {
    const price = listPriceOf(row);
    if (!price) {
      unpricedCount += 1;
      continue;
    }
    const group = minor.get(price.currency) ?? { sum: 0, count: 0 };
    group.sum += toMinorUnits(price.amount, minorUnitScale(price.currency));
    group.count += 1;
    minor.set(price.currency, group);
    const seen = row?.buyPriceSeenAt;
    if (seen) {
      const time = new Date(seen).getTime();
      if (Number.isFinite(time) && time > latest) {
        latest = time;
        latestSeenAt = seen;
      }
    }
  }
  const byCurrency = Array.from(minor, ([currency, g]) => ({
    currency,
    total: g.sum / minorUnitScale(currency),
    count: g.count,
  })).sort((a, b) => b.count - a.count || (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
  return { byCurrency, unpricedCount, latestSeenAt };
}

/** `$12.50` in the given currency; falls back to `12.50 USD` when Intl rejects the code. */
export function formatListAmount(amount: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** "as of Oct 21, 2026" for a fetch date, or null when missing/invalid. */
export function formatListPriceAsOf(seenAt: string | null | undefined, locale?: string): string | null {
  if (!seenAt) return null;
  const date = new Date(seenAt);
  if (Number.isNaN(date.getTime())) return null;
  return `as of ${date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" })}`;
}

/**
 * "$148.00 (9 priced) + EUR20.00 (2)": one amount per currency, never added together; the counts
 * are priced rows. Null when nothing is priced.
 */
export function formatListPriceTotals(totals: ListPriceTotals, locale?: string): string | null {
  if (totals.byCurrency.length === 0) return null;
  return totals.byCurrency
    .map((g, i) => `${formatListAmount(g.total, g.currency, locale)} (${g.count}${i === 0 ? " priced" : ""})`)
    .join(" + ");
}

/**
 * "$148.00 (9 priced) + EUR20.00 (2) · 1 without a price": the amounts plus the unpriced count.
 * Null when there are no priced and no unpriced rows (an empty list).
 */
export function formatListPriceSummary(totals: ListPriceTotals, locale?: string): string | null {
  const parts: string[] = [];
  const amounts = formatListPriceTotals(totals, locale);
  if (amounts) parts.push(amounts);
  if (totals.unpricedCount > 0) parts.push(`${totals.unpricedCount} without a price`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Wishlist header line: "12 polishes · $148.00 (9 priced) + EUR20.00 (2) · 1 without a price".
 * `count` is the number of wishlisted rows (priced or not).
 */
export function formatWishlistValueLine(count: number, totals: ListPriceTotals, locale?: string): string {
  const head = `${count} ${count === 1 ? "polish" : "polishes"}`;
  const summary = formatListPriceSummary(totals, locale);
  return summary ? `${head} · ${summary}` : head;
}
