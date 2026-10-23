import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_BACKFILL_LIST_ITEMS, mergeBackfillTotals, parseSourceNames, readBackfillCursor } from "./admin-backfills";

describe("mergeBackfillTotals", () => {
  it("sums counters and count maps, skipping the cursor and flags", () => {
    const skip = ["nextAfterShadeId", "dryRun"];
    let totals = mergeBackfillTotals({}, { dryRun: true, scanned: 2, bySource: { A: 1 }, nextAfterShadeId: 5 }, skip);
    totals = mergeBackfillTotals(totals, { dryRun: true, scanned: 3, bySource: { A: 2, B: 1 }, nextAfterShadeId: null }, skip);
    assert.deepEqual(totals, { scanned: 5, bySource: { A: 3, B: 1 } });
  });

  it("merges non-count objects key by key", () => {
    const totals = mergeBackfillTotals(
      { currencies: { AShopify: { currency: "USD", origin: "stored" } } },
      { currencies: { BShopify: { currency: null, origin: "unknown" } } }
    );
    assert.deepEqual(totals.currencies, {
      AShopify: { currency: "USD", origin: "stored" },
      BShopify: { currency: null, origin: "unknown" },
    });
  });

  it("concatenates lists up to the cap and counts every item", () => {
    const many = Array.from({ length: MAX_BACKFILL_LIST_ITEMS }, (_, i) => ({ imageId: i }));
    let totals = mergeBackfillTotals({}, { failures: many });
    totals = mergeBackfillTotals(totals, { failures: [{ imageId: -1 }] });
    assert.equal((totals.failures as unknown[]).length, MAX_BACKFILL_LIST_ITEMS);
    assert.equal(totals.failuresCount, MAX_BACKFILL_LIST_ITEMS + 1);
  });

  it("does not change its inputs", () => {
    const totals = { scanned: 1, bySource: { A: 1 } };
    mergeBackfillTotals(totals, { scanned: 1, bySource: { A: 1 } });
    assert.deepEqual(totals, { scanned: 1, bySource: { A: 1 } });
  });
});

describe("readBackfillCursor", () => {
  it("returns the next cursor or null", () => {
    assert.equal(readBackfillCursor({ nextAfterImageId: 12 }, "nextAfterImageId"), 12);
    assert.equal(readBackfillCursor({ nextAfterImageId: null }, "nextAfterImageId"), null);
    assert.equal(readBackfillCursor({}, "nextAfterImageId"), null);
    assert.equal(readBackfillCursor({ nextAfterImageId: "12" }, "nextAfterImageId"), null);
  });
});

describe("parseSourceNames", () => {
  it("splits, trims and dedupes; empty means every source", () => {
    assert.deepEqual(parseSourceNames(" MakeupAPI, HoloTacoShopify ,MakeupAPI"), ["MakeupAPI", "HoloTacoShopify"]);
    assert.equal(parseSourceNames(" , "), null);
  });
});
