import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isOwnedPolish, quantityChangeUpdate, summarizeCollection } from "./inventory-status";

describe("isOwnedPolish", () => {
  it("is driven by status, not quantity", () => {
    assert.equal(isOwnedPolish({ status: "owned" }), true);
    assert.equal(isOwnedPolish({ status: "wishlist" }), false);
    assert.equal(isOwnedPolish({ status: "destash" }), false);
    assert.equal(isOwnedPolish({ status: "archived" }), false);
    assert.equal(isOwnedPolish({ status: null }), false);
    assert.equal(isOwnedPolish({}), false);
  });
});

describe("quantityChangeUpdate", () => {
  it("adding a catalog or wishlist polish makes it owned with one bottle", () => {
    assert.deepEqual(quantityChangeUpdate({}, 1), { quantity: 1, status: "owned" });
    assert.deepEqual(quantityChangeUpdate({ status: "wishlist", quantity: 0 }, 1), { quantity: 1, status: "owned" });
  });

  it("adding an archived polish keeps its bottle count (at least one)", () => {
    assert.deepEqual(quantityChangeUpdate({ status: "archived", quantity: 2 }, 1), { quantity: 2, status: "owned" });
  });

  it("increments and decrements owned polishes", () => {
    assert.deepEqual(quantityChangeUpdate({ status: "owned", quantity: 2 }, 1), { quantity: 3, status: "owned" });
    assert.deepEqual(quantityChangeUpdate({ status: "owned", quantity: 2 }, -1), { quantity: 1, status: "owned" });
  });

  it("decrementing the last bottle archives the polish (used up), not wishlist", () => {
    assert.deepEqual(quantityChangeUpdate({ status: "owned", quantity: 1 }, -1), { quantity: 0, status: "archived" });
    assert.deepEqual(quantityChangeUpdate({ status: "owned", quantity: 0 }, -1), { quantity: 0, status: "archived" });
  });

  it("decrementing a polish that is not owned changes nothing", () => {
    assert.deepEqual(quantityChangeUpdate({ status: "destash", quantity: 1 }, -1), { quantity: 1, status: "destash" });
  });
});

describe("summarizeCollection", () => {
  it("computes untried % of owned and passes the wishlist total through", () => {
    const summary = summarizeCollection(
      [
        { status: "owned", isUntried: true },
        { status: "owned", isUntried: false, triedAt: "2026-01-01T00:00:00.000Z" },
        { status: "owned", isUntried: true },
      ],
      7
    );
    assert.deepEqual(summary, { owned: 3, untried: 2, untriedPercent: 67, wishlist: 7 });
  });

  it("ignores rows that are not owned", () => {
    const summary = summarizeCollection(
      [
        { status: "owned", isUntried: false, triedAt: "2026-01-01T00:00:00.000Z" },
        { status: "wishlist", isUntried: false },
        { status: "destash", isUntried: false },
      ],
      0
    );
    assert.deepEqual(summary, { owned: 1, untried: 0, untriedPercent: 0, wishlist: 0 });
  });

  it("falls back to triedAt when isUntried is missing", () => {
    assert.equal(summarizeCollection([{ status: "owned" }], 0).untried, 1);
    assert.equal(summarizeCollection([{ status: "owned", triedAt: "2026-01-01" }], 0).untried, 0);
  });

  it("has no percentage when nothing is owned and clamps bad totals", () => {
    assert.deepEqual(summarizeCollection([], Number.NaN), { owned: 0, untried: 0, untriedPercent: null, wishlist: 0 });
    assert.equal(summarizeCollection([], -3).wishlist, 0);
  });
});
