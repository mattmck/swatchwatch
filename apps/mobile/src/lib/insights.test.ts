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
  formatMonthShort,
  formatMonthYear,
  formatWornDate,
  nothingBought,
  polishCount,
  resolveCurrencyKey,
  sharePercent,
  statsDisplayHex,
} from "./insights";

function stats(overrides: Partial<CollectionStatsResponse> = {}): CollectionStatsResponse {
  return {
    generatedAt: "2026-10-23T00:00:00.000Z",
    totals: { byStatus: { owned: 0, wishlist: 0, destash: 0, archived: 0 }, total: 0 },
    untried: { owned: 0, untried: 0, percent: null },
    wornVsWaiting: { worn: 0, waiting: 0 },
    spend: { currencies: [], months: [], pricedCount: 0, unpricedCount: 0 },
    mostWorn: [],
    costPerWear: { currencies: [], pricedUnwornCount: 0 },
    wishlist: { count: 0, listPrices: { byCurrency: [], unpricedCount: 0, latestSeenAt: null } },
    ...overrides,
  };
}

const spendGroup = (currency: string | null, total: number) => ({
  currency,
  total,
  itemCount: 1,
  byBrand: [],
  byMonth: [],
});

const cpwGroup = (currency: string | null) => ({ currency, wornCount: 1, pricedUnwornCount: 0, best: [], worst: [] });

describe("formatMoney", () => {
  it("formats an ISO currency with its symbol", () => {
    assert.equal(formatMoney(12.5, "USD", "en-US"), "$12.50");
    assert.equal(formatMoney(1234, "EUR", "en-US"), "€1,234.00");
  });

  it("prints a price without a currency as a plain amount", () => {
    assert.equal(formatMoney(12.5, null), "12.50");
  });

  it("falls back to amount + code for a code that is not ISO-shaped", () => {
    assert.equal(formatMoney(3, "usd"), "3.00 usd");
  });

  it("shows a dash for a non-finite amount", () => {
    assert.equal(formatMoney(Number.NaN, "USD"), "—");
  });
});

describe("currency groups", () => {
  it("lists spend currencies first, then cost-per-wear ones, without duplicates", () => {
    const s = stats({
      spend: { currencies: [spendGroup("USD", 10), spendGroup(null, 5)], months: [], pricedCount: 2, unpricedCount: 0 },
      costPerWear: { currencies: [cpwGroup("EUR"), cpwGroup("USD")], pricedUnwornCount: 0 },
    });
    assert.deepEqual(currencyOptions(s), ["USD", null, "EUR"]);
    assert.equal(findSpend(s, currencyKey(null))?.total, 5);
    assert.equal(findSpend(s, "EUR"), undefined);
    assert.equal(findCostPerWear(s, "EUR")?.currency, "EUR");
  });

  it("keeps a selected currency only while it exists", () => {
    assert.equal(resolveCurrencyKey(["USD", "EUR"], "EUR"), "EUR");
    assert.equal(resolveCurrencyKey(["USD", "EUR"], "GBP"), "USD");
    assert.equal(resolveCurrencyKey(["USD"], null), "USD");
    assert.equal(resolveCurrencyKey([], null), "");
    assert.equal(currencyLabel(null), "No currency");
  });
});

describe("barPercent", () => {
  it("scales to the largest value", () => {
    assert.equal(barPercent(50, 200), 25);
    assert.equal(barPercent(200, 200), 100);
  });

  it("keeps small non-zero values visible and zero at zero", () => {
    assert.equal(barPercent(1, 1000), 2);
    assert.equal(barPercent(1, 1000, 5), 5);
    assert.equal(barPercent(0, 100), 0);
    assert.equal(barPercent(5, 0), 0);
    assert.equal(barPercent(Number.NaN, 10), 0);
  });

  it("never exceeds 100", () => {
    assert.equal(barPercent(300, 200), 100);
  });
});

describe("sharePercent", () => {
  it("rounds to a whole percent and is null for an empty total", () => {
    assert.equal(sharePercent(2, 3), 67);
    assert.equal(sharePercent(0, 3), 0);
    assert.equal(sharePercent(1, 0), null);
  });
});

describe("dates", () => {
  it("formats months", () => {
    assert.equal(formatMonthShort("2026-10"), "Oct");
    assert.equal(formatMonthShort("2026-01"), "Jan");
    assert.equal(formatMonthShort("bad"), "bad");
    assert.equal(formatMonthShort("2026-13"), "2026-13");
    assert.equal(formatMonthYear("2026-03"), "Mar 2026");
    assert.equal(formatMonthYear("bad"), "bad");
  });

  it("formats wear dates in UTC", () => {
    assert.equal(formatWornDate("2026-10-10T00:00:00.000Z"), "Oct 10, 2026");
    assert.equal(formatWornDate(null), "—");
    assert.equal(formatWornDate("nope"), "—");
  });
});

describe("misc", () => {
  it("picks the display hex vendor > detected > name", () => {
    assert.equal(statsDisplayHex({ vendorHex: "#111111", detectedHex: "#222222", nameHex: null }), "#111111");
    assert.equal(statsDisplayHex({ vendorHex: null, detectedHex: null, nameHex: "#333333" }), "#333333");
    assert.equal(statsDisplayHex({ vendorHex: null, detectedHex: null, nameHex: null }), undefined);
  });

  it("detects a collection with nothing bought (wishlist only)", () => {
    assert.equal(nothingBought(stats()), true);
    assert.equal(
      nothingBought(stats({ totals: { byStatus: { owned: 0, wishlist: 4, destash: 0, archived: 0 }, total: 4 } })),
      true,
    );
    assert.equal(
      nothingBought(stats({ totals: { byStatus: { owned: 0, wishlist: 0, destash: 0, archived: 1 }, total: 1 } })),
      false,
    );
  });

  it("pluralizes polish counts", () => {
    assert.equal(polishCount(1), "1 polish");
    assert.equal(polishCount(0), "0 polishes");
  });
});
