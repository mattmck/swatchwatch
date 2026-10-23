import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatBuyPriceLine } from "./buy-price";

describe("formatBuyPriceLine", () => {
  it("formats the price in its currency with the as-of date", () => {
    assert.equal(
      formatBuyPriceLine({ buyPrice: 12.5, buyCurrency: "USD", buyPriceSeenAt: "2026-10-21T12:00:00.000Z" }, "en-US"),
      "$12.50 · as of Oct 21, 2026"
    );
    assert.equal(formatBuyPriceLine({ buyPrice: 12.5, buyCurrency: "USD" }, "en-US"), "$12.50");
  });

  it("shows nothing without a price and a valid currency", () => {
    assert.equal(formatBuyPriceLine({ buyPrice: 12.5 }), null);
    assert.equal(formatBuyPriceLine({ buyPrice: 12.5, buyCurrency: "$" }), null);
    assert.equal(formatBuyPriceLine({ buyCurrency: "USD" }), null);
    assert.equal(formatBuyPriceLine(null), null);
  });
});
