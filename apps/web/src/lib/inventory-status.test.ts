import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  archiveReasonUpdate,
  canRebuy,
  formStatusForSave,
  isArchivingChange,
  isOwnedPolish,
  quantityChangeUpdate,
  rebuyUpdate,
  summarizeCollection,
  undoArchiveUpdate,
} from "./inventory-status";

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

  it("decrementing the last bottle archives the polish, never wishlists it (D5c)", () => {
    assert.deepEqual(quantityChangeUpdate({ status: "owned", quantity: 1 }, -1), { quantity: 0, status: "archived" });
    assert.deepEqual(quantityChangeUpdate({ status: "owned", quantity: 0 }, -1), { quantity: 0, status: "archived" });
  });

  it("decrementing a polish that is not owned changes nothing", () => {
    assert.deepEqual(quantityChangeUpdate({ status: "destash", quantity: 1 }, -1), { quantity: 1, status: "destash" });
  });
});

describe("archive flow (D5c)", () => {
  it("detects an owned polish being archived", () => {
    assert.equal(isArchivingChange({ status: "owned" }, quantityChangeUpdate({ status: "owned", quantity: 1 }, -1)), true);
    assert.equal(isArchivingChange({ status: "owned" }, { status: "owned" }), false);
    assert.equal(isArchivingChange({ status: "wishlist" }, { status: "archived" }), false);
    assert.equal(isArchivingChange({ status: "archived" }, { status: "archived" }), false);
  });

  it("archives an owned polish saved from the edit form with 0 bottles", () => {
    assert.equal(formStatusForSave("owned", 0), "archived");
    assert.equal(formStatusForSave("owned", 2), "owned");
    assert.equal(formStatusForSave("wishlist", 0), "wishlist");
    assert.equal(formStatusForSave("destash", 0), "destash");
  });

  it("builds the reason, undo and rebuy request bodies", () => {
    assert.deepEqual(archiveReasonUpdate("decluttered"), { status: "archived", archiveReason: "decluttered" });
    assert.deepEqual(undoArchiveUpdate(), { status: "owned", quantity: 1, undoArchive: true });
    assert.deepEqual(rebuyUpdate(), { status: "wishlist" });
  });

  it("offers Rebuy only on archived polishes", () => {
    assert.equal(canRebuy({ status: "archived" }), true);
    for (const status of ["owned", "wishlist", "destash", null] as const) {
      assert.equal(canRebuy({ status }), false);
    }
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
