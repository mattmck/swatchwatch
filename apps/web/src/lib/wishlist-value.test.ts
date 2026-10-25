import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wishlistValueView, wishlistValueViewFromTotals } from "./wishlist-value";

describe("wishlistValueView", () => {
  it("totals per currency, counts unpriced rows and carries the newest as-of date", () => {
    const view = wishlistValueView(
      [
        { buyPrice: 10, buyCurrency: "USD", buyPriceSeenAt: "2026-10-01T00:00:00Z" },
        { buyPrice: 12.5, buyCurrency: "USD", buyPriceSeenAt: "2026-10-21T12:00:00Z" },
        { buyPrice: 20, buyCurrency: "EUR" },
        { buyPrice: 5 },
        {},
      ],
      "en-US"
    );
    assert.equal(view.line, "5 polishes · $22.50 (2 priced) + €20.00 (1) · 2 without a price");
    assert.equal(view.summary, "$22.50 (2 priced) + €20.00 (1) · 2 without a price");
    assert.equal(view.asOf, "as of Oct 21, 2026");
    assert.equal(view.hasPrices, true);
  });

  it("never guesses a price", () => {
    const view = wishlistValueView([{}, { buyPrice: 4 }], "en-US");
    assert.equal(view.line, "2 polishes · 2 without a price");
    assert.equal(view.hasPrices, false);
    assert.equal(view.asOf, null);
  });

  it("is quiet for an empty wishlist", () => {
    const view = wishlistValueView([], "en-US");
    assert.equal(view.line, "0 polishes");
    assert.equal(view.summary, null);
  });

  it("renders API-summed totals the same way", () => {
    const view = wishlistValueViewFromTotals(
      3,
      { byCurrency: [{ currency: "USD", total: 22.5, count: 2 }], unpricedCount: 1, latestSeenAt: "2026-10-21T12:00:00Z" },
      "en-US"
    );
    assert.equal(view.line, "3 polishes · $22.50 (2 priced) · 1 without a price");
    assert.equal(view.asOf, "as of Oct 21, 2026");
    assert.equal(view.hasPrices, true);
  });
});
