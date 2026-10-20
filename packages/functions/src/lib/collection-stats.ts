/**
 * Collection stats (issue #271) behind `GET /api/stats/collection`.
 *
 * Five aggregate queries, every one bound to the caller (`ui.user_id = $1`) and joined only to
 * the shared catalog (`sku` / `shade` / `brand`), then assembled by the pure
 * `buildCollectionStats` (unit-tested without a database).
 *
 * Rules (see `packages/functions/README.md`, "Collection stats"):
 * - Money is grouped by `purchase_currency` and never summed across currencies; a price saved
 *   without a currency is its own `null` group.
 * - Spend counts bought items (`SPEND_STATUSES`: owned, destash, archived) with a price;
 *   `purchase_price` is the price of the inventory row (not multiplied by `quantity`).
 * - The by-month bucket is `purchase_date`, falling back to the UTC date of `created_at` (when
 *   the polish was added) for rows without one; those rows are counted in
 *   `estimatedDateCount`.
 * - Untried / worn-vs-waiting / cost per wear look at `owned` rows only; most-worn looks at
 *   every row with `wear_count > 0`, whatever its status.
 * - Product categories (#349, D-C): spend counts every category except accessories (coats and
 *   treatments are bought too); counts, untried, worn vs waiting, most-worn and cost per wear
 *   look at color polishes and toppers only. A row without a shade counts as `color`.
 * - Queries are plain `SELECT`s (no leading `WITH`) so `lib/db` may retry them on connection
 *   timeouts.
 */
import {
  COLLECTION_STATS_COST_PER_WEAR_LIST,
  COLLECTION_STATS_MONTHS,
  COLLECTION_STATS_MOST_WORN,
  COLLECTION_STATS_TOP_BRANDS,
  POLISH_STATUSES,
  SPEND_STATUSES,
  isPolishStatus,
  type CollectionStatsResponse,
  type CostPerWearCurrency,
  type CostPerWearEntry,
  type CurrencySpend,
  type MostWornEntry,
  type PolishStatus,
  type SpendByBrandEntry,
  type SpendByMonthEntry,
} from "swatchwatch-shared";

/** Redis TTL of a user's cached stats. Writes invalidate earlier (`lib/polish-cache.ts`). */
export const COLLECTION_STATS_CACHE_TTL_SECONDS = 60;

/** Prefix of every user's stats cache key (global invalidation deletes by this prefix). */
export const COLLECTION_STATS_CACHE_PREFIX = "stats:collection:u:";

export function collectionStatsCacheKey(userId: number): string {
  return `${COLLECTION_STATS_CACHE_PREFIX}${userId}`;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Catalog joins for an inventory row: the shade comes from `shade_id`, or from the SKU for a
 * SKU-only row; the brand from the shade, else the SKU.
 */
const CATALOG_JOINS = `
  LEFT JOIN sku k ON k.sku_id = ui.sku_id
  LEFT JOIN shade s ON s.shade_id = COALESCE(ui.shade_id, k.shade_id)
  LEFT JOIN brand b ON b.brand_id = COALESCE(s.brand_id, k.brand_id)`;

/** Rows that count toward spend: everything but accessories (#349, D-C). */
const SPEND_CATEGORY_SQL = `COALESCE(s.product_category, 'color') <> 'accessory'`;

/** Rows that count toward counts, untried, wear and cost per wear: color polishes and toppers. */
const WEAR_CATEGORY_SQL = `COALESCE(s.product_category, 'color') IN ('color', 'topper')`;

const SHADE_COLUMNS = `
  ui.inventory_item_id::text                          AS "inventoryItemId",
  COALESCE(ui.shade_id, k.shade_id)::text             AS "shadeId",
  COALESCE(b.name_canonical, 'Unknown brand')         AS brand,
  COALESCE(s.shade_name_canonical, k.product_name, 'Unknown shade') AS name,
  s.vendor_hex                                        AS "vendorHex",
  s.detected_hex                                      AS "detectedHex",
  s.name_hex                                          AS "nameHex"`;

/** `$1` user. Row counts per status × currency (counts only, never money). */
export const STATS_COUNTS_SQL = `
SELECT ui.status,
       ui.purchase_currency                                                         AS currency,
       COUNT(*)::int                                                                AS items,
       COUNT(*) FILTER (WHERE ui.tried_at IS NULL)::int                             AS untried,
       COUNT(*) FILTER (WHERE ui.wear_count > 0)::int                               AS worn,
       COUNT(*) FILTER (WHERE ui.purchase_price IS NOT NULL)::int                   AS priced,
       COUNT(*) FILTER (WHERE ui.purchase_price IS NOT NULL AND ui.wear_count > 0)::int AS "pricedWorn",
       COUNT(*) FILTER (WHERE ui.purchase_price IS NOT NULL AND ui.wear_count = 0)::int AS "pricedUnworn"
FROM user_inventory_item ui
${CATALOG_JOINS}
WHERE ui.user_id = $1
  AND ${WEAR_CATEGORY_SQL}
GROUP BY ui.status, ui.purchase_currency`;

/**
 * `$1` user, `$2` spend statuses, `$3` top-N. All-time spend per currency × brand; brands
 * ranked below `$3` within their currency fold into one `isOther` row.
 */
export const STATS_SPEND_BY_BRAND_SQL = `
SELECT ranked.currency,
       (ranked.rn > $3)                                    AS "isOther",
       CASE WHEN ranked.rn > $3 THEN NULL ELSE ranked.brand END AS brand,
       COUNT(*)::int                                       AS "brandCount",
       SUM(ranked.total)::text                             AS total,
       SUM(ranked.items)::int                              AS "itemCount",
       MIN(ranked.rn)::int                                 AS rank
FROM (
  SELECT spend.*,
         row_number() OVER (PARTITION BY spend.currency ORDER BY spend.total DESC, spend.brand) AS rn
  FROM (
    SELECT ui.purchase_currency                        AS currency,
           COALESCE(b.name_canonical, 'Unknown brand') AS brand,
           SUM(ui.purchase_price)                      AS total,
           COUNT(*)                                    AS items
    FROM user_inventory_item ui
    ${CATALOG_JOINS}
    WHERE ui.user_id = $1
      AND ui.status = ANY($2::text[])
      AND ui.purchase_price IS NOT NULL
      AND ${SPEND_CATEGORY_SQL}
    GROUP BY 1, 2
  ) spend
) ranked
GROUP BY ranked.currency, (ranked.rn > $3), CASE WHEN ranked.rn > $3 THEN NULL ELSE ranked.brand END
ORDER BY ranked.currency NULLS LAST, rank`;

const MONTH_BUCKET_SQL = `COALESCE(ui.purchase_date, (ui.created_at AT TIME ZONE 'UTC')::date)`;

/**
 * `$1` user, `$2` spend statuses, `$3` window start (inclusive date), `$4` window end
 * (exclusive date). Spend per currency × month; `purchase_date`, else the UTC `created_at` date.
 */
export const STATS_SPEND_BY_MONTH_SQL = `
SELECT ui.purchase_currency                                     AS currency,
       to_char(${MONTH_BUCKET_SQL}, 'YYYY-MM')                  AS month,
       SUM(ui.purchase_price)::text                             AS total,
       COUNT(*)::int                                            AS "itemCount",
       COUNT(*) FILTER (WHERE ui.purchase_date IS NULL)::int    AS "estimatedDateCount"
FROM user_inventory_item ui
${CATALOG_JOINS}
WHERE ui.user_id = $1
  AND ui.status = ANY($2::text[])
  AND ui.purchase_price IS NOT NULL
  AND ${SPEND_CATEGORY_SQL}
  AND ${MONTH_BUCKET_SQL} >= $3::date
  AND ${MONTH_BUCKET_SQL} < $4::date
GROUP BY 1, 2
ORDER BY 1 NULLS LAST, 2`;

/** `$1` user, `$2` limit. Most-worn inventory rows of any status. */
export const STATS_MOST_WORN_SQL = `
SELECT ${SHADE_COLUMNS},
       ui.status,
       ui.wear_count   AS "wearCount",
       ui.last_worn_at AS "lastWornAt"
FROM user_inventory_item ui
${CATALOG_JOINS}
WHERE ui.user_id = $1
  AND ui.wear_count > 0
  AND ${WEAR_CATEGORY_SQL}
ORDER BY ui.wear_count DESC, ui.last_worn_at DESC NULLS LAST, ui.inventory_item_id
LIMIT $2`;

/**
 * `$1` user, `$2` list size. Owned, priced, worn rows ranked by cost per wear within their
 * currency; returns the `$2` cheapest and the `$2` dearest per currency (overlap returned once).
 */
export const STATS_COST_PER_WEAR_SQL = `
SELECT ranked."inventoryItemId", ranked."shadeId", ranked.brand, ranked.name,
       ranked."vendorHex", ranked."detectedHex", ranked."nameHex",
       ranked.currency,
       ranked.price::text                 AS price,
       ranked."wearCount",
       round(ranked.cpw, 2)::text         AS "costPerWear",
       ranked.best_rank::int              AS "bestRank",
       ranked.n::int                      AS "currencyCount"
FROM (
  SELECT worn.*,
         row_number() OVER (
           PARTITION BY worn.currency
           ORDER BY worn.cpw ASC, worn."wearCount" DESC, worn.item_id ASC
         ) AS best_rank,
         count(*) OVER (PARTITION BY worn.currency) AS n
  FROM (
    SELECT ${SHADE_COLUMNS},
           ui.inventory_item_id                    AS item_id,
           ui.purchase_currency                    AS currency,
           ui.purchase_price                       AS price,
           ui.wear_count                           AS "wearCount",
           ui.purchase_price / ui.wear_count       AS cpw
    FROM user_inventory_item ui
    ${CATALOG_JOINS}
    WHERE ui.user_id = $1
      AND ui.status = 'owned'
      AND ui.purchase_price IS NOT NULL
      AND ui.wear_count > 0
      AND ${WEAR_CATEGORY_SQL}
  ) worn
) ranked
WHERE ranked.best_rank <= $2 OR ranked.best_rank > ranked.n - $2
ORDER BY ranked.currency NULLS LAST, ranked.best_rank`;

// ---------------------------------------------------------------------------
// Row shapes (as returned by `pg`; numerics arrive as text)
// ---------------------------------------------------------------------------

export interface StatsCountsRow {
  status: string;
  currency: string | null;
  items: number | string;
  untried: number | string;
  worn: number | string;
  priced: number | string;
  pricedWorn: number | string;
  pricedUnworn: number | string;
}

export interface SpendByBrandRow {
  currency: string | null;
  isOther: boolean;
  brand: string | null;
  brandCount: number | string;
  total: string | number;
  itemCount: number | string;
  rank: number | string;
}

export interface SpendByMonthRow {
  currency: string | null;
  month: string;
  total: string | number;
  itemCount: number | string;
  estimatedDateCount: number | string;
}

interface ShadeRow {
  inventoryItemId: string;
  shadeId: string | null;
  brand: string;
  name: string;
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
}

export interface MostWornRow extends ShadeRow {
  status: string;
  wearCount: number | string;
  lastWornAt: Date | string | null;
}

export interface CostPerWearRow extends ShadeRow {
  currency: string | null;
  price: string | number;
  wearCount: number | string;
  costPerWear: string | number;
  bestRank: number | string;
  currencyCount: number | string;
}

export interface CollectionStatsRows {
  counts: StatsCountsRow[];
  spendByBrand: SpendByBrandRow[];
  spendByMonth: SpendByMonthRow[];
  mostWorn: MostWornRow[];
  costPerWear: CostPerWearRow[];
}

// ---------------------------------------------------------------------------
// Assembly (pure)
// ---------------------------------------------------------------------------

export interface MonthWindow {
  /** `YYYY-MM` months, oldest first. */
  months: string[];
  /** First day of the oldest month, `YYYY-MM-DD` (inclusive). */
  start: string;
  /** First day of the month after the current one, `YYYY-MM-DD` (exclusive). */
  end: string;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** The `COLLECTION_STATS_MONTHS` UTC months ending with the month of `now`. */
export function monthWindow(now: Date, count: number = COLLECTION_STATS_MONTHS): MonthWindow {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const months: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(year, month - offset, 1));
    months.push(`${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`);
  }
  const startDate = new Date(Date.UTC(year, month - (count - 1), 1));
  const endDate = new Date(Date.UTC(year, month + 1, 1));
  return {
    months,
    start: startDate.toISOString().slice(0, 10),
    end: endDate.toISOString().slice(0, 10),
  };
}

const toInt = (value: number | string | null | undefined): number => {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Exact cents for a NUMERIC(…,2) value, so per-currency sums never drift. */
const toCents = (value: string | number | null | undefined): number => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

const fromCents = (cents: number): number => cents / 100;

const currencyKey = (currency: string | null): string => currency ?? "";

function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function shadeOf(row: ShadeRow) {
  return {
    inventoryItemId: String(row.inventoryItemId),
    shadeId: row.shadeId === null || row.shadeId === undefined ? null : String(row.shadeId),
    brand: row.brand,
    name: row.name,
    vendorHex: row.vendorHex ?? null,
    detectedHex: row.detectedHex ?? null,
    nameHex: row.nameHex ?? null,
  };
}

/** Currency groups ordered by item count (desc), then code, with `null` last. */
function compareCurrencyGroups(
  a: { currency: string | null; count: number },
  b: { currency: string | null; count: number }
): number {
  if (b.count !== a.count) return b.count - a.count;
  if (a.currency === null) return b.currency === null ? 0 : 1;
  if (b.currency === null) return -1;
  return a.currency.localeCompare(b.currency);
}

/**
 * Assemble the response from the five query results. Pure: `now` only names the month window
 * and `generatedAt`.
 */
export function buildCollectionStats(rows: CollectionStatsRows, now: Date): CollectionStatsResponse {
  const window = monthWindow(now);
  const spendStatuses = new Set<string>(SPEND_STATUSES);

  // --- Counts -------------------------------------------------------------
  const byStatus = Object.fromEntries(POLISH_STATUSES.map((status) => [status, 0])) as Record<
    PolishStatus,
    number
  >;
  let total = 0;
  let ownedUntried = 0;
  let ownedWorn = 0;
  let pricedCount = 0;
  let unpricedCount = 0;
  const ownedPricedByCurrency = new Map<string, { currency: string | null; worn: number; unworn: number }>();

  for (const row of rows.counts) {
    const items = toInt(row.items);
    total += items;
    if (isPolishStatus(row.status)) byStatus[row.status] += items;
    if (spendStatuses.has(row.status)) {
      pricedCount += toInt(row.priced);
      unpricedCount += items - toInt(row.priced);
    }
    if (row.status === "owned") {
      ownedUntried += toInt(row.untried);
      ownedWorn += toInt(row.worn);
      const pricedWorn = toInt(row.pricedWorn);
      const pricedUnworn = toInt(row.pricedUnworn);
      if (pricedWorn + pricedUnworn > 0) {
        const key = currencyKey(row.currency);
        const group = ownedPricedByCurrency.get(key) ?? { currency: row.currency ?? null, worn: 0, unworn: 0 };
        group.worn += pricedWorn;
        group.unworn += pricedUnworn;
        ownedPricedByCurrency.set(key, group);
      }
    }
  }
  const owned = byStatus.owned;

  // --- Spend --------------------------------------------------------------
  const spendGroups = new Map<
    string,
    { currency: string | null; cents: number; itemCount: number; byBrand: SpendByBrandEntry[] }
  >();
  const sortedBrandRows = [...rows.spendByBrand].sort(
    (a, b) => Number(a.isOther) - Number(b.isOther) || toInt(a.rank) - toInt(b.rank)
  );
  for (const row of sortedBrandRows) {
    const key = currencyKey(row.currency);
    const group =
      spendGroups.get(key) ?? { currency: row.currency ?? null, cents: 0, itemCount: 0, byBrand: [] };
    const cents = toCents(row.total);
    const itemCount = toInt(row.itemCount);
    group.cents += cents;
    group.itemCount += itemCount;
    group.byBrand.push({
      brand: row.isOther ? "Other" : row.brand ?? "Unknown brand",
      isOther: Boolean(row.isOther),
      brandCount: row.isOther ? toInt(row.brandCount) : 0,
      total: fromCents(cents),
      itemCount,
    });
    spendGroups.set(key, group);
  }

  const monthIndex = new Map(window.months.map((month, index) => [month, index]));
  const monthsByCurrency = new Map<string, SpendByMonthEntry[]>();
  const emptyMonths = (): SpendByMonthEntry[] =>
    window.months.map((month) => ({ month, total: 0, itemCount: 0, estimatedDateCount: 0 }));
  for (const row of rows.spendByMonth) {
    const index = monthIndex.get(row.month);
    if (index === undefined) continue; // outside the window (defensive; SQL already bounds it)
    const key = currencyKey(row.currency);
    const entries = monthsByCurrency.get(key) ?? emptyMonths();
    const entry = entries[index];
    entry.total = fromCents(toCents(entry.total) + toCents(row.total));
    entry.itemCount += toInt(row.itemCount);
    entry.estimatedDateCount += toInt(row.estimatedDateCount);
    monthsByCurrency.set(key, entries);
  }

  const currencies: CurrencySpend[] = [...spendGroups.entries()]
    .map(([key, group]) => ({
      currency: group.currency,
      total: fromCents(group.cents),
      itemCount: group.itemCount,
      byBrand: group.byBrand,
      byMonth: monthsByCurrency.get(key) ?? emptyMonths(),
    }))
    .sort((a, b) => compareCurrencyGroups({ ...a, count: a.itemCount }, { ...b, count: b.itemCount }));

  // --- Most worn ----------------------------------------------------------
  const mostWorn: MostWornEntry[] = rows.mostWorn
    .filter((row) => isPolishStatus(row.status))
    .slice(0, COLLECTION_STATS_MOST_WORN)
    .map((row) => ({
      ...shadeOf(row),
      status: row.status as PolishStatus,
      wearCount: toInt(row.wearCount),
      lastWornAt: toIsoOrNull(row.lastWornAt),
    }));

  // --- Cost per wear ------------------------------------------------------
  const listSize = COLLECTION_STATS_COST_PER_WEAR_LIST;
  const cpwLists = new Map<string, { best: CostPerWearEntry[]; worstAsc: CostPerWearEntry[] }>();
  const sortedCpwRows = [...rows.costPerWear].sort((a, b) => toInt(a.bestRank) - toInt(b.bestRank));
  for (const row of sortedCpwRows) {
    const key = currencyKey(row.currency);
    const lists = cpwLists.get(key) ?? { best: [], worstAsc: [] };
    const entry: CostPerWearEntry = {
      ...shadeOf(row),
      price: fromCents(toCents(row.price)),
      wearCount: toInt(row.wearCount),
      costPerWear: fromCents(toCents(row.costPerWear)),
    };
    const rank = toInt(row.bestRank);
    if (rank <= listSize) {
      lists.best.push(entry);
    } else if (rank > toInt(row.currencyCount) - listSize) {
      lists.worstAsc.push(entry);
    }
    cpwLists.set(key, lists);
  }
  const cpwCurrencies: CostPerWearCurrency[] = [...ownedPricedByCurrency.entries()]
    .map(([key, group]) => {
      const lists = cpwLists.get(key) ?? { best: [], worstAsc: [] };
      return {
        currency: group.currency,
        wornCount: group.worn,
        pricedUnwornCount: group.unworn,
        best: lists.best.slice(0, listSize),
        worst: [...lists.worstAsc].reverse().slice(0, listSize),
      };
    })
    .sort(
      (a, b) =>
        b.wornCount - a.wornCount ||
        compareCurrencyGroups(
          { currency: a.currency, count: a.pricedUnwornCount },
          { currency: b.currency, count: b.pricedUnwornCount }
        )
    );
  const pricedUnwornCount = cpwCurrencies.reduce((sum, group) => sum + group.pricedUnwornCount, 0);

  return {
    generatedAt: now.toISOString(),
    totals: { byStatus, total },
    untried: {
      owned,
      untried: ownedUntried,
      percent: owned > 0 ? Math.round((ownedUntried / owned) * 1000) / 10 : null,
    },
    wornVsWaiting: { worn: ownedWorn, waiting: owned - ownedWorn },
    spend: {
      currencies,
      months: window.months,
      pricedCount,
      unpricedCount,
    },
    mostWorn,
    costPerWear: { currencies: cpwCurrencies, pricedUnwornCount },
  };
}

type QueryFn = <T extends object>(text: string, params: unknown[]) => Promise<{ rows: T[] }>;

/**
 * Run the five aggregate queries for `userId` (in parallel) and assemble the response.
 * Every statement binds `userId` as `$1` and filters `ui.user_id = $1`.
 */
export async function loadCollectionStats(
  runQuery: QueryFn,
  userId: number,
  now: Date = new Date()
): Promise<CollectionStatsResponse> {
  const window = monthWindow(now);
  const spendStatuses = [...SPEND_STATUSES];
  const [counts, spendByBrand, spendByMonth, mostWorn, costPerWear] = await Promise.all([
    runQuery<StatsCountsRow>(STATS_COUNTS_SQL, [userId]),
    runQuery<SpendByBrandRow>(STATS_SPEND_BY_BRAND_SQL, [userId, spendStatuses, COLLECTION_STATS_TOP_BRANDS]),
    runQuery<SpendByMonthRow>(STATS_SPEND_BY_MONTH_SQL, [userId, spendStatuses, window.start, window.end]),
    runQuery<MostWornRow>(STATS_MOST_WORN_SQL, [userId, COLLECTION_STATS_MOST_WORN]),
    runQuery<CostPerWearRow>(STATS_COST_PER_WEAR_SQL, [userId, COLLECTION_STATS_COST_PER_WEAR_LIST]),
  ]);
  return buildCollectionStats(
    {
      counts: counts.rows,
      spendByBrand: spendByBrand.rows,
      spendByMonth: spendByMonth.rows,
      mostWorn: mostWorn.rows,
      costPerWear: costPerWear.rows,
    },
    now
  );
}
