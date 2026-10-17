/**
 * Pure helpers for the dashboard's collection stats panels (issue #271). The panels live in
 * `components/stats/`; data comes from `GET /api/stats/collection` (`getCollectionStats`).
 */
import type {
  CollectionStatsResponse,
  CostPerWearCurrency,
  CurrencySpend,
} from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { formatPurchasePrice } from "./inventory-status";

/** Stable key for a currency group; `null` (no currency recorded) becomes `""`. */
export function currencyKey(currency: string | null): string {
  return currency ?? "";
}

/** Label for a currency group in controls and captions. */
export function currencyLabel(currency: string | null): string {
  return currency ?? "No currency";
}

/** Money in one currency, e.g. `$12.50`; prices without a currency print as plain `12.50`. */
export function formatMoney(amount: number, currency: string | null): string {
  return formatPurchasePrice(amount, currency) ?? "—";
}

/**
 * Currency groups across the spend and cost-per-wear sections, in API order (spend first),
 * without duplicates. Every money panel shows one currency at a time.
 */
export function currencyOptions(stats: CollectionStatsResponse): Array<string | null> {
  const seen = new Set<string>();
  const out: Array<string | null> = [];
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

export function findSpend(stats: CollectionStatsResponse, key: string): CurrencySpend | undefined {
  return stats.spend.currencies.find((group) => currencyKey(group.currency) === key);
}

export function findCostPerWear(
  stats: CollectionStatsResponse,
  key: string
): CostPerWearCurrency | undefined {
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

const MONTH_FORMAT_SHORT = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const MONTH_FORMAT_LONG = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function monthDate(month: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}

/** `2026-10` → `Oct` (axis label). */
export function formatMonthShort(month: string): string {
  const date = monthDate(month);
  return date ? MONTH_FORMAT_SHORT.format(date) : month;
}

/** `2026-10` → `October 2026` (tooltips and the table view). */
export function formatMonthLong(month: string): string {
  const date = monthDate(month);
  return date ? MONTH_FORMAT_LONG.format(date) : month;
}

/** ISO timestamp → `Oct 10, 2026` (UTC, since wear dates are stored as midnight UTC). */
export function formatWornDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Whole-number share, e.g. 2 of 3 → 67; null when the total is 0. */
export function sharePercent(part: number, total: number): number | null {
  if (!(total > 0)) return null;
  return Math.round((part / total) * 100);
}

export interface RingArc {
  /** Stroke length of the filled ("worn") arc. */
  filled: number;
  /** Remaining circumference (the track). */
  gap: number;
  circumference: number;
}

/**
 * Stroke-dash values for a one-value ring (meter) of radius `r`. The filled arc is clamped to
 * the circumference, so rounding never draws past the start.
 */
export function ringArc(part: number, total: number, r: number): RingArc {
  const circumference = 2 * Math.PI * r;
  const fraction = total > 0 ? Math.min(1, Math.max(0, part / total)) : 0;
  const filled = circumference * fraction;
  return { filled, gap: circumference - filled, circumference };
}

/** Months worth labelling directly: the largest one and the latest one with spend. */
export function labelledMonths(entries: Array<{ month: string; total: number }>): Set<string> {
  const labelled = new Set<string>();
  let max: { month: string; total: number } | null = null;
  let latest: string | null = null;
  for (const entry of entries) {
    if (entry.total <= 0) continue;
    if (!max || entry.total > max.total) max = entry;
    latest = entry.month;
  }
  if (max) labelled.add(max.month);
  if (latest) labelled.add(latest);
  return labelled;
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

/** True when the collection has no inventory rows at all. */
export function isEmptyCollection(stats: CollectionStatsResponse): boolean {
  return stats.totals.total === 0;
}
