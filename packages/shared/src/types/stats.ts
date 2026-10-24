/**
 * Collection stats (issue #271): `GET /api/stats/collection` payload behind the dashboard's
 * spend, untried, worn-vs-waiting, most-worn and cost-per-wear panels.
 *
 * Money is never summed across currencies: every amount lives inside a per-currency group
 * (`currency` is the ISO 4217 code, or `null` for prices saved without a currency).
 */
import type { PolishStatus } from "./inventory";
import type { ListPriceTotals } from "../money/price-totals";

/** Brands listed by name in `CurrencySpend.byBrand`; the rest fold into one "other" entry. */
export const COLLECTION_STATS_TOP_BRANDS = 8;
/** Months in `CollectionSpendStats.months` (the current month and the 11 before it, UTC). */
export const COLLECTION_STATS_MONTHS = 12;
/** Entries in `CollectionStatsResponse.mostWorn`. */
export const COLLECTION_STATS_MOST_WORN = 10;
/** Entries in each of `CostPerWearCurrency.best` / `.worst`. */
export const COLLECTION_STATS_COST_PER_WEAR_LIST = 5;

/**
 * Statuses whose purchase price counts as spend: everything that was bought (`owned`,
 * `destash`, `archived`). A `wishlist` price is a target price, not money spent.
 */
export const SPEND_STATUSES = ["owned", "destash", "archived"] as const satisfies readonly PolishStatus[];

export interface SpendByBrandEntry {
  /** Canonical brand name; for the "other" entry, `"Other"`. */
  brand: string;
  /** True for the single entry that folds every brand below the top N. */
  isOther: boolean;
  /** Number of brands folded into the "other" entry (0 for named brands). */
  brandCount: number;
  total: number;
  itemCount: number;
}

export interface SpendByMonthEntry {
  /** `YYYY-MM` (UTC). */
  month: string;
  total: number;
  itemCount: number;
  /**
   * Items bucketed by the date they were added (`created_at`, UTC) because they have no
   * `purchaseDate`.
   */
  estimatedDateCount: number;
}

export interface CurrencySpend {
  /** ISO 4217 code, or null for prices saved without a currency. */
  currency: string | null;
  /** All-time spend in this currency (every priced, bought item). */
  total: number;
  itemCount: number;
  /** Top `COLLECTION_STATS_TOP_BRANDS` brands by spend, then at most one "other" entry. */
  byBrand: SpendByBrandEntry[];
  /** One entry per month in `CollectionSpendStats.months`, zero-filled, oldest first. */
  byMonth: SpendByMonthEntry[];
}

export interface CollectionSpendStats {
  /** Currency groups, most items first. Empty when nothing has a price. */
  currencies: CurrencySpend[];
  /** The `YYYY-MM` months of the by-month window, oldest first. */
  months: string[];
  /** Bought items (`SPEND_STATUSES`) with a purchase price. */
  pricedCount: number;
  /** Bought items (`SPEND_STATUSES`) without a purchase price (left out of every total). */
  unpricedCount: number;
}

export interface CollectionStatsShade {
  inventoryItemId: string;
  /** Shade id (the same id as `Polish.id`); null for a SKU-only inventory row. */
  shadeId: string | null;
  brand: string;
  name: string;
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
}

export interface MostWornEntry extends CollectionStatsShade {
  status: PolishStatus;
  wearCount: number;
  lastWornAt: string | null;
}

export interface CostPerWearEntry extends CollectionStatsShade {
  price: number;
  wearCount: number;
  /** `price / wearCount`, rounded to 2 decimals. */
  costPerWear: number;
}

export interface CostPerWearCurrency {
  currency: string | null;
  /** Owned items in this currency with a price and at least one wear. */
  wornCount: number;
  /** Owned items in this currency with a price and no wears yet. */
  pricedUnwornCount: number;
  /** Lowest cost per wear first. */
  best: CostPerWearEntry[];
  /** Highest cost per wear first; never repeats an item already in `best`. */
  worst: CostPerWearEntry[];
}

/**
 * What the wishlist adds up to in the brands' list prices (`Polish.buyPrice` / `buyCurrency`),
 * over every wishlist row the polishes list shows (`GET /api/polishes?status=wishlist`).
 */
export interface WishlistValueStats {
  /** Wishlist rows, priced or not (the polishes list `total` for `status=wishlist`). */
  count: number;
  /** Per-currency list-price totals (never converted or summed across currencies). */
  listPrices: ListPriceTotals;
}

export interface CollectionStatsResponse {
  /** ISO timestamp the stats were computed (responses may be cached for up to 60s). */
  generatedAt: string;
  totals: {
    /** Inventory rows per status, every status present (0 when none). */
    byStatus: Record<PolishStatus, number>;
    /** All inventory rows. */
    total: number;
  };
  untried: {
    owned: number;
    /** Owned and never tried (`triedAt` null). */
    untried: number;
    /** `untried / owned * 100`, 1 decimal; null when nothing is owned. */
    percent: number | null;
  };
  /** Owned items worn at least once (`wearCount > 0`) vs never worn. */
  wornVsWaiting: { worn: number; waiting: number };
  spend: CollectionSpendStats;
  /** Most-worn inventory items (any status, `wearCount > 0`), highest first. */
  mostWorn: MostWornEntry[];
  costPerWear: {
    /** Currency groups with at least one priced owned item, most worn items first. */
    currencies: CostPerWearCurrency[];
    /** Owned items with a price and no wears, across currencies (a count, not money). */
    pricedUnwornCount: number;
  };
  wishlist: WishlistValueStats;
}
