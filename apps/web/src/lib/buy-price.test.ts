import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buyPriceAsOf, buyPriceOf, buyPriceSubtotals, formatBuyPrice } from "./buy-price";

describe("buyPriceOf / formatBuyPrice", () => {
  it("needs both an amount and an ISO currency", () => {
    assert.deepEqual(buyPriceOf({ buyPrice: 12.5, buyCurrency: "USD" }), { amount: 12.5, currency: "USD" });
    assert.equal(buyPriceOf({ buyPrice: 12.5 }), null);
    assert.equal(buyPriceOf({ buyCurrency: "USD" }), null);
    assert.equal(buyPriceOf({ buyPrice: 12.5, buyCurrency: "$" }), null);
    assert.equal(buyPriceOf({ buyPrice: Number.NaN, buyCurrency: "USD" }), null);
    assert.equal(buyPriceOf(null), null);
  });

  it("formats with Intl.NumberFormat in the item's currency", () => {
    assert.match(formatBuyPrice({ buyPrice: 12.5, buyCurrency: "USD" }) ?? "", /12\.50/);
    assert.notEqual(formatBuyPrice({ buyPrice: 12.5, buyCurrency: "USD" }), formatBuyPrice({ buyPrice: 12.5, buyCurrency: "CAD" }));
    assert.equal(formatBuyPrice({}), null);
  });
});

describe("buyPriceAsOf", () => {
  it("formats the fetch date and ignores missing or invalid dates", () => {
    assert.equal(buyPriceAsOf("2026-10-21T12:00:00.000Z", "en-US"), "as of Oct 21, 2026");
    assert.equal(buyPriceAsOf(null), null);
    assert.equal(buyPriceAsOf("not a date"), null);
  });
});

describe("buyPriceSubtotals", () => {
  it("groups by currency, counts unpriced items and never adds currencies together", () => {
    const result = buyPriceSubtotals([
      { buyPrice: 0.1, buyCurrency: "USD" },
      { buyPrice: 0.2, buyCurrency: "USD" },
      { buyPrice: 15, buyCurrency: "CAD" },
      { buyPrice: 5, buyCurrency: "EUR" },
      { buyPrice: 7, buyCurrency: "EUR" },
      { buyPrice: 9 },
      null,
    ]);
    assert.deepEqual(result.subtotals, [
      { currency: "EUR", total: 12, count: 2 },
      { currency: "USD", total: 0.3, count: 2 },
      { currency: "CAD", total: 15, count: 1 },
    ]);
    assert.equal(result.unpricedCount, 2);
  });

  it("rounds each item to the cents it is displayed with (1.005 counts as 1.01)", () => {
    const { subtotals } = buyPriceSubtotals([
      { buyPrice: 1.005, buyCurrency: "USD" },
      { buyPrice: 1.005, buyCurrency: "USD" },
    ]);
    assert.deepEqual(subtotals, [{ currency: "USD", total: 2.02, count: 2 }]);
    assert.equal(formatBuyPrice({ buyPrice: 1.005, buyCurrency: "USD" })?.includes("1.01"), true);
  });

  it("rounds to each currency's own minor unit (KWD has three decimals, JPY none)", () => {
    const { subtotals } = buyPriceSubtotals([
      { buyPrice: 1.001, buyCurrency: "KWD" },
      { buyPrice: 1.001, buyCurrency: "KWD" },
      { buyPrice: 100, buyCurrency: "JPY" },
      { buyPrice: 200.4, buyCurrency: "JPY" },
    ]);
    assert.deepEqual(subtotals, [
      { currency: "JPY", total: 300, count: 2 },
      { currency: "KWD", total: 2.002, count: 2 },
    ]);
  });

  it("is empty for no items", () => {
    assert.deepEqual(buyPriceSubtotals([]), { subtotals: [], unpricedCount: 0 });
  });
});
