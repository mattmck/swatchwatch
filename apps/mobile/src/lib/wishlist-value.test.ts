import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Polish } from "swatchwatch-shared";
import { isInventoryCacheKey } from "./api-cache";
import { slimWishlistRows, WISHLIST_VALUE_CACHE_KEY, wishlistValueView } from "./wishlist-value";

describe("wishlistValueView", () => {
  it("totals per currency, counts unpriced rows and never adds currencies", () => {
    const view = wishlistValueView(
      [
        { buyPrice: 10, buyCurrency: "USD", buyPriceSeenAt: "2026-10-21T12:00:00Z" },
        { buyPrice: 12.5, buyCurrency: "USD" },
        { buyPrice: 20, buyCurrency: "EUR" },
        {},
      ],
      "en-US",
    );
    assert.equal(view.line, "4 polishes · $22.50 (2 priced) + €20.00 (1) · 1 without a price");
    assert.equal(view.asOf, "as of Oct 21, 2026");
    assert.equal(view.hasPrices, true);
  });

  it("counts, never guesses, a polish without a price", () => {
    const view = wishlistValueView([{ buyPrice: 4 }], "en-US");
    assert.equal(view.line, "1 polish · 1 without a price");
    assert.equal(view.hasPrices, false);
  });

  it("is quiet for an empty wishlist", () => {
    const view = wishlistValueView([], "en-US");
    assert.equal(view.line, "0 polishes");
    assert.equal(view.summary, null);
  });
});

describe("slimWishlistRows", () => {
  it("keeps only the price fields", () => {
    const rows = [{ id: "1", brand: "A", name: "B", buyPrice: 9, buyCurrency: "USD", buyPriceSeenAt: "2026-10-21T00:00:00Z" }] as unknown as Polish[];
    assert.deepEqual(slimWishlistRows(rows), [{ buyPrice: 9, buyCurrency: "USD", buyPriceSeenAt: "2026-10-21T00:00:00Z" }]);
  });

  it("is dropped with the other inventory caches", () => {
    assert.equal(isInventoryCacheKey(WISHLIST_VALUE_CACHE_KEY), true);
  });
});
