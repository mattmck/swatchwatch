import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CollectionStatsResponse } from "swatchwatch-shared";
import {
  barPercent,
  currencyKey,
  currencyLabel,
  currencyOptions,
  findCostPerWear,
  findSpend,
  formatMoney,
  formatMonthLong,
  formatMonthShort,
  formatWornDate,
  isEmptyCollection,
  labelledMonths,
  ringArc,
  sharePercent,
} from "./collection-stats";

function stats(overrides: Partial<CollectionStatsResponse> = {}): CollectionStatsResponse {
  return {
    generatedAt: "2026-10-17T12:00:00.000Z",
    totals: { byStatus: { owned: 0, wishlist: 0, destash: 0, archived: 0 }, total: 0 },
    untried: { owned: 0, untried: 0, percent: null },
    wornVsWaiting: { worn: 0, waiting: 0 },
    spend: { currencies: [], months: [], pricedCount: 0, unpricedCount: 0 },
    mostWorn: [],
    costPerWear: { currencies: [], pricedUnwornCount: 0 },
    ...overrides,
  };
}

const spendGroup = (currency: string | null) => ({
  currency,
  total: 10,
  itemCount: 1,
  byBrand: [],
  byMonth: [],
});
const cpwGroup = (currency: string | null) => ({
  currency,
  wornCount: 1,
  pricedUnwornCount: 0,
  best: [],
  worst: [],
});

describe("currency helpers", () => {
  it("keys and labels the no-currency group", () => {
    assert.equal(currencyKey(null), "");
    assert.equal(currencyKey("USD"), "USD");
    assert.equal(currencyLabel(null), "No currency");
    assert.equal(currencyLabel("EUR"), "EUR");
  });

  it("lists spend currencies first, then cost-per-wear-only ones, without duplicates", () => {
    const s = stats({
      spend: { currencies: [spendGroup("USD"), spendGroup(null)], months: [], pricedCount: 2, unpricedCount: 0 },
      costPerWear: { currencies: [cpwGroup("GBP"), cpwGroup("USD")], pricedUnwornCount: 0 },
    });
    assert.deepEqual(currencyOptions(s), ["USD", null, "GBP"]);
    assert.equal(findSpend(s, "")?.currency, null);
    assert.equal(findSpend(s, "GBP"), undefined);
    assert.equal(findCostPerWear(s, "GBP")?.currency, "GBP");
  });

  it("formats money per currency and never mixes them", () => {
    assert.match(formatMoney(12.5, "USD"), /12\.50/);
    assert.match(formatMoney(12.5, "EUR"), /12\.50/);
    assert.notEqual(formatMoney(12.5, "USD"), formatMoney(12.5, "EUR"));
    assert.equal(formatMoney(3, null), "3.00");
  });
});

describe("chart geometry", () => {
  it("scales bars to the max and keeps small non-zero bars visible", () => {
    assert.equal(barPercent(50, 100), 50);
    assert.equal(barPercent(100, 100), 100);
    assert.equal(barPercent(0.1, 1000), 2);
    assert.equal(barPercent(0, 100), 0);
    assert.equal(barPercent(5, 0), 0);
  });

  it("computes ring arcs and clamps them", () => {
    const half = ringArc(1, 2, 10);
    assert.ok(Math.abs(half.filled - Math.PI * 10) < 1e-9);
    assert.ok(Math.abs(half.filled + half.gap - half.circumference) < 1e-9);
    assert.equal(ringArc(0, 0, 10).filled, 0);
    assert.equal(ringArc(5, 2, 10).gap, 0);
  });

  it("labels only the largest and the latest month with spend", () => {
    const labelled = labelledMonths([
      { month: "2026-08", total: 30 },
      { month: "2026-09", total: 5 },
      { month: "2026-10", total: 0 },
    ]);
    assert.deepEqual([...labelled].sort(), ["2026-08", "2026-09"]);
    assert.equal(labelledMonths([{ month: "2026-10", total: 0 }]).size, 0);
  });
});

describe("formatting", () => {
  it("formats months in UTC", () => {
    assert.equal(formatMonthShort("2026-01"), "Jan");
    assert.equal(formatMonthLong("2026-12"), "December 2026");
    assert.equal(formatMonthShort("bad"), "bad");
  });

  it("formats wear dates in UTC", () => {
    assert.equal(formatWornDate("2026-10-10T00:00:00.000Z"), "Oct 10, 2026");
    assert.equal(formatWornDate(null), "—");
    assert.equal(formatWornDate("nope"), "—");
  });

  it("computes shares", () => {
    assert.equal(sharePercent(2, 3), 67);
    assert.equal(sharePercent(0, 0), null);
  });

  it("detects an empty collection", () => {
    assert.equal(isEmptyCollection(stats()), true);
    assert.equal(
      isEmptyCollection(stats({ totals: { byStatus: { owned: 1, wishlist: 0, destash: 0, archived: 0 }, total: 1 } })),
      false
    );
  });
});
