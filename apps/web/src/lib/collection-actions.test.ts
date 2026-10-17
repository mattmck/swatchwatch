import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish } from "swatchwatch-shared";
import {
  applyInventoryPatch,
  applyOptimistic,
  canMarkTried,
  collectionActionRequest,
  commitOptimistic,
  isValidTriedDate,
  localIsoDate,
  optimisticPolish,
  rollbackOptimistic,
  statusChangeEvent,
  statusChangePatch,
} from "./collection-actions";

function polish(overrides: Partial<Polish> = {}): Polish {
  return {
    id: "1",
    shadeId: "1",
    userId: "1",
    brand: "Zoya",
    name: "Pixie",
    color: "Pink",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("localIsoDate / isValidTriedDate", () => {
  it("formats the local date", () => {
    assert.equal(localIsoDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  });

  it("accepts real past dates and today, rejects future or malformed ones", () => {
    assert.equal(isValidTriedDate("2026-10-17", "2026-10-17"), true);
    assert.equal(isValidTriedDate("2025-02-28", "2026-10-17"), true);
    assert.equal(isValidTriedDate("2026-10-18", "2026-10-17"), false);
    assert.equal(isValidTriedDate("2026-02-30", "2026-10-17"), false);
    assert.equal(isValidTriedDate("17/10/2026", "2026-10-17"), false);
    assert.equal(isValidTriedDate("", "2026-10-17"), false);
  });
});

describe("statusChangePatch", () => {
  it("owning or destashing keeps at least one bottle", () => {
    assert.deepEqual(statusChangePatch({ quantity: 0 }, "owned"), { status: "owned", quantity: 1 });
    assert.deepEqual(statusChangePatch({}, "owned"), { status: "owned", quantity: 1 });
    assert.deepEqual(statusChangePatch({ quantity: 3 }, "destash"), { status: "destash", quantity: 3 });
  });

  it("wishlist and archive leave the bottle count alone", () => {
    assert.deepEqual(statusChangePatch({ quantity: 2 }, "wishlist"), { status: "wishlist" });
    assert.deepEqual(statusChangePatch({ quantity: 2 }, "archived"), { status: "archived" });
  });
});

describe("collectionActionRequest", () => {
  it("builds PUT bodies for status changes and skips no-ops", () => {
    assert.deepEqual(collectionActionRequest({ status: null }, { kind: "set-status", status: "wishlist" }), {
      method: "update",
      body: { status: "wishlist" },
    });
    assert.deepEqual(collectionActionRequest({ status: "wishlist", quantity: 0 }, { kind: "set-status", status: "owned" }), {
      method: "update",
      body: { status: "owned", quantity: 1 },
    });
    assert.equal(collectionActionRequest({ status: "owned" }, { kind: "set-status", status: "owned" }), null);
  });

  it("removing from the wishlist deletes the inventory row, only for wishlist rows", () => {
    assert.deepEqual(collectionActionRequest({ status: "wishlist" }, { kind: "remove-from-wishlist" }), { method: "delete" });
    assert.equal(collectionActionRequest({ status: "owned" }, { kind: "remove-from-wishlist" }), null);
    assert.equal(collectionActionRequest({ status: null }, { kind: "remove-from-wishlist" }), null);
  });

  it("mark tried sends triedAt for bottles you have or had", () => {
    assert.deepEqual(collectionActionRequest({ status: "owned" }, { kind: "set-tried", date: "2026-01-02" }), {
      method: "update",
      body: { triedAt: "2026-01-02" },
    });
    assert.deepEqual(collectionActionRequest({ status: "archived" }, { kind: "set-tried", date: null }), {
      method: "update",
      body: { triedAt: null },
    });
    assert.equal(collectionActionRequest({ status: "wishlist" }, { kind: "set-tried", date: "2026-01-02" }), null);
    assert.equal(collectionActionRequest({ status: null }, { kind: "set-tried", date: "2026-01-02" }), null);
    assert.equal(collectionActionRequest({ status: "owned" }, { kind: "set-tried", date: "2999-01-01" }), null);
  });

  it("canMarkTried covers owned, destash and archived", () => {
    assert.deepEqual(
      [null, "owned", "wishlist", "destash", "archived"].map((status) => canMarkTried({ status: status as Polish["status"] })),
      [false, true, false, true, true]
    );
  });
});

describe("optimisticPolish", () => {
  it("owning a wishlist polish makes it owned, untried, with a bottle", () => {
    const next = optimisticPolish(polish({ status: "wishlist", quantity: 0 }), { kind: "set-status", status: "owned" });
    assert.equal(next.status, "owned");
    assert.equal(next.quantity, 1);
    assert.equal(next.isUntried, true);
  });

  it("owning a tried polish is not untried", () => {
    const next = optimisticPolish(polish({ status: "archived", triedAt: "2026-01-01T00:00:00.000Z" }), {
      kind: "set-status",
      status: "owned",
    });
    assert.equal(next.isUntried, false);
  });

  it("destash and archive clear the untried badge (it only applies to owned)", () => {
    const owned = polish({ status: "owned", quantity: 1, isUntried: true });
    assert.equal(optimisticPolish(owned, { kind: "set-status", status: "destash" }).isUntried, false);
    assert.equal(optimisticPolish(owned, { kind: "set-status", status: "archived" }).isUntried, false);
  });

  it("mark tried stores a UTC midnight timestamp and clears untried; null restores it", () => {
    const owned = polish({ status: "owned", isUntried: true });
    const tried = optimisticPolish(owned, { kind: "set-tried", date: "2026-03-04" });
    assert.equal(tried.triedAt, "2026-03-04T00:00:00.000Z");
    assert.equal(tried.isUntried, false);
    const untried = optimisticPolish(tried, { kind: "set-tried", date: null });
    assert.equal(untried.triedAt, null);
    assert.equal(untried.isUntried, true);
  });

  it("removing from the wishlist returns a catalog-only row", () => {
    const next = optimisticPolish(polish({ status: "wishlist", inventoryItemId: "9", quantity: 0 }), {
      kind: "remove-from-wishlist",
    });
    assert.equal(next.status, null);
    assert.equal(next.inventoryItemId, undefined);
    assert.equal(next.isUntried, false);
  });

  it("does not mutate the input", () => {
    const original = polish({ status: "wishlist" });
    optimisticPolish(original, { kind: "set-status", status: "owned" });
    assert.equal(original.status, "wishlist");
  });
});

describe("applyInventoryPatch", () => {
  it("recomputes isUntried from status and triedAt", () => {
    assert.equal(applyInventoryPatch(polish({ status: "archived" }), { status: "owned", quantity: 1 }).isUntried, true);
    assert.equal(applyInventoryPatch(polish({ status: "owned", isUntried: true }), { quantity: 0, status: "archived" }).isUntried, false);
  });
});

describe("optimistic list reducers", () => {
  const a = polish({ id: "a", status: "wishlist" });
  const b = polish({ id: "b", status: "owned" });

  it("apply replaces only the target row", () => {
    const optimistic = optimisticPolish(a, { kind: "set-status", status: "owned" });
    const list = applyOptimistic([a, b], "a", optimistic);
    assert.equal(list[0], optimistic);
    assert.equal(list[1], b);
  });

  it("apply is a no-op for an unknown id", () => {
    const list = [a, b];
    assert.equal(applyOptimistic(list, "zzz", a), list);
  });

  it("commit swaps in the server row", () => {
    const optimistic = optimisticPolish(a, { kind: "set-status", status: "owned" });
    const server = { ...optimistic, quantity: 1, updatedAt: "2026-10-17T00:00:00.000Z" };
    const list = commitOptimistic(applyOptimistic([a, b], "a", optimistic), "a", optimistic, server);
    assert.equal(list[0], server);
  });

  it("rollback restores the original row", () => {
    const optimistic = optimisticPolish(a, { kind: "set-status", status: "owned" });
    const list = rollbackOptimistic(applyOptimistic([a, b], "a", optimistic), "a", optimistic, a);
    assert.equal(list[0], a);
    assert.equal(list[1], b);
  });

  it("an older request never overwrites a newer optimistic change", () => {
    const first = optimisticPolish(a, { kind: "set-status", status: "owned" });
    const second = optimisticPolish(first, { kind: "set-status", status: "destash" });
    let list = applyOptimistic([a, b], "a", first);
    list = applyOptimistic(list, "a", second);

    // First request fails: rollback must not clobber the newer change.
    const afterRollback = rollbackOptimistic(list, "a", first, a);
    assert.equal(afterRollback, list);
    assert.equal(afterRollback[0], second);

    // First request succeeds late: its server row must not clobber the newer change either.
    const afterCommit = commitOptimistic(list, "a", first, { ...first, quantity: 1 });
    assert.equal(afterCommit[0], second);

    // The newest request settles normally.
    const settled = commitOptimistic(list, "a", second, { ...second, quantity: 1 });
    assert.equal(settled[0].status, "destash");
    assert.notEqual(settled[0], second);
  });

  it("does nothing once the row left the list (page changed)", () => {
    const optimistic = optimisticPolish(a, { kind: "set-status", status: "owned" });
    const list = [b];
    assert.equal(rollbackOptimistic(list, "a", optimistic, a), list);
    assert.equal(commitOptimistic(list, "a", optimistic, a), list);
  });
});

describe("statusChangeEvent", () => {
  it("names catalog-only rows 'none'", () => {
    assert.deepEqual(statusChangeEvent(null, "wishlist", "quick-action"), { from: "none", to: "wishlist", via: "quick-action" });
    assert.deepEqual(statusChangeEvent("wishlist", null, "quick-action"), { from: "wishlist", to: "none", via: "quick-action" });
    assert.deepEqual(statusChangeEvent("owned", "archived", "stepper"), { from: "owned", to: "archived", via: "stepper" });
  });
});
