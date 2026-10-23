import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatListPriceAsOf,
  formatListPriceTotals,
  formatWishlistValueLine,
  listPriceOf,
  sumListPrices,
} from "./price-totals";

describe("listPriceOf", () => {
  it("needs a finite non-negative amount and an ISO currency", () => {
    assert.deepEqual(listPriceOf({ buyPrice: 12.5, buyCurrency: "USD" }), { amount: 12.5, currency: "USD" });
    assert.equal(listPriceOf({ buyPrice: 12.5 }), null);
    assert.equal(listPriceOf({ buyPrice: -1, buyCurrency: "USD" }), null);
    assert.equal(listPriceOf({ buyPrice: 1, buyCurrency: "$" }), null);
    assert.equal(listPriceOf(null), null);
  });
});

describe("sumListPrices", () => {
  it("groups by currency, counts unpriced rows and never adds currencies", () => {
    const result = sumListPrices([
      { buyPrice: 0.1, buyCurrency: "USD", buyPriceSeenAt: "2026-10-01T00:00:00Z" },
      { buyPrice: 0.2, buyCurrency: "USD", buyPriceSeenAt: "2026-10-20T00:00:00Z" },
      { buyPrice: 15, buyCurrency: "CAD" },
      { buyPrice: 5, buyCurrency: "EUR" },
      { buyPrice: 7, buyCurrency: "EUR" },
      { buyPrice: 9 },
      null,
    ]);
    assert.deepEqual(result.byCurrency, [
      { currency: "EUR", total: 12, count: 2 },
      { currency: "USD", total: 0.3, count: 2 },
      { currency: "CAD", total: 15, count: 1 },
    ]);
    assert.equal(result.unpricedCount, 2);
    assert.equal(result.latestSeenAt, "2026-10-20T00:00:00Z");
  });

  it("rounds per row to the currency's minor unit", () => {
    assert.deepEqual(
      sumListPrices([
        { buyPrice: 1.005, buyCurrency: "USD" },
        { buyPrice: 1.005, buyCurrency: "USD" },
        { buyPrice: 1.001, buyCurrency: "KWD" },
        { buyPrice: 1.001, buyCurrency: "KWD" },
        { buyPrice: 100, buyCurrency: "JPY" },
        { buyPrice: 200.4, buyCurrency: "JPY" },
      ]).byCurrency,
      [
        { currency: "JPY", total: 300, count: 2 },
        { currency: "KWD", total: 2.002, count: 2 },
        { currency: "USD", total: 2.02, count: 2 },
      ]
    );
  });

  it("is empty for no rows", () => {
    assert.deepEqual(sumListPrices([]), { byCurrency: [], unpricedCount: 0, latestSeenAt: null });
  });
});

describe("formatting", () => {
  const totals = sumListPrices([
    { buyPrice: 100, buyCurrency: "USD" },
    { buyPrice: 48, buyCurrency: "USD" },
    { buyPrice: 20, buyCurrency: "EUR" },
    {},
  ]);

  it("formats per-currency totals", () => {
    assert.equal(formatListPriceTotals(totals, "en-US"), "$148.00 (2 priced) + €20.00 (1)");
    assert.equal(formatListPriceTotals(sumListPrices([{}]), "en-US"), null);
  });

  it("builds the wishlist header line", () => {
    assert.equal(formatWishlistValueLine(4, totals, "en-US"), "4 polishes · $148.00 (2 priced) + €20.00 (1) · 1 without a price");
    assert.equal(formatWishlistValueLine(1, sumListPrices([{}]), "en-US"), "1 polish · 1 without a price");
    assert.equal(formatWishlistValueLine(0, sumListPrices([]), "en-US"), "0 polishes");
  });

  it("formats the as-of date", () => {
    assert.equal(formatListPriceAsOf("2026-10-21T12:00:00.000Z", "en-US"), "as of Oct 21, 2026");
    assert.equal(formatListPriceAsOf("nope"), null);
  });
});
