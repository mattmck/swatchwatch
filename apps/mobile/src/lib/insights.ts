/**
 * Pure helpers for the Insights screen (`app/(app)/insights.tsx`), mirroring the web's
 * `apps/web/src/lib/collection-stats.ts`. Data comes from `GET /api/stats/collection`.
 * Money is shown one currency group at a time and never summed or converted (D6).
 */
import {
  resolveDisplayHex,
  type CollectionStatsResponse,
  type CostPerWearCurrency,
  type CurrencySpend,
} from "swatchwatch-shared";

/** Stable key for a currency group; `null` (no currency recorded) becomes `""`. */
export function currencyKey(currency: string | null): string {
  return currency ?? "";
}

/** Label for a currency group on chips and captions. */
export function currencyLabel(currency: string | null): string {
  return currency ?? "No currency";
}

/**
 * Money in one currency, e.g. `$12.50`; an unknown code prints as `12.50 XYZ` and a price saved
 * without a currency as plain `12.50` (web: `formatPurchasePrice`).
 */
export function formatMoney(amount: number, currency: string | null, locale?: string): string {
  if (!Number.isFinite(amount)) return "—";
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
    } catch {
      // Unknown ISO code: fall through to the plain format.
    }
  }
  return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
}

/**
 * Currency groups across the spend and cost-per-wear sections, in API order (spend first),
 * without duplicates. Every money panel shows the one selected currency.
 */
export function currencyOptions(stats: CollectionStatsResponse): (string | null)[] {
  const seen = new Set<string>();
  const out: (string | null)[] = [];
  for (const currency of [
    ...stats.spend.currencies.map((group) => group.currency),
    ...stats.costPerWear.currencies.map((group) => group.currency),
  ]) {
    const key = currencyKey(currency);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(currency);
  }
  return out;
}

/** The selected currency key when it still exists, else the first group's (or `""`). */
export function resolveCurrencyKey(options: (string | null)[], selected: string | null): string {
  if (selected !== null && options.some((c) => currencyKey(c) === selected)) return selected;
  return currencyKey(options[0] ?? null);
}

export function findSpend(stats: CollectionStatsResponse, key: string): CurrencySpend | undefined {
  return stats.spend.currencies.find((group) => currencyKey(group.currency) === key);
}

export function findCostPerWear(stats: CollectionStatsResponse, key: string): CostPerWearCurrency | undefined {
  return stats.costPerWear.currencies.find((group) => currencyKey(group.currency) === key);
}

/**
 * Bar length as a percentage of the largest value. A non-zero value never renders thinner than
 * `minPercent` so small amounts stay visible; zero stays zero.
 */
export function barPercent(value: number, max: number, minPercent = 2): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(100, Math.max(minPercent, (value / max) * 100));
}

/** Whole-number share, e.g. 2 of 3 → 67; null when the total is 0. */
export function sharePercent(part: number, total: number): number | null {
  if (!(total > 0)) return null;
  return Math.round((part / total) * 100);
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10` → `Oct` (bar label); anything else is returned as is. */
export function formatMonthShort(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const index = match ? Number(match[2]) - 1 : -1;
  return MONTHS_SHORT[index] ?? month;
}

/** `2026-10` → `Oct 2026`. */
export function formatMonthYear(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const short = formatMonthShort(month);
  return match && short !== month ? `${short} ${match[1]}` : month;
}

/** ISO timestamp → `Oct 10, 2026` (UTC, since wear dates are stored as midnight UTC). */
export function formatWornDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** Swatch color for a stats entry (vendor > detected > name, like `resolveDisplayHex`). */
export function statsDisplayHex(entry: {
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
}): string | undefined {
  return resolveDisplayHex({
    vendorHex: entry.vendorHex ?? undefined,
    detectedHex: entry.detectedHex ?? undefined,
    nameHex: entry.nameHex ?? undefined,
  });
}

/** Nothing bought yet (no owned, destash or archived rows): one empty state instead of five. */
export function nothingBought(stats: CollectionStatsResponse): boolean {
  const { owned, destash, archived } = stats.totals.byStatus;
  return owned + destash + archived === 0;
}

/** `1 polish` / `3 polishes`. */
export function polishCount(count: number): string {
  return `${count} ${count === 1 ? "polish" : "polishes"}`;
}
