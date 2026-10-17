import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isOwnedPolish, quantityChangeUpdate } from "./inventory-status";

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

  it("decrementing the last bottle moves the polish to the wishlist", () => {
    assert.deepEqual(quantityChangeUpdate({ status: "owned", quantity: 1 }, -1), { quantity: 0, status: "wishlist" });
    assert.deepEqual(quantityChangeUpdate({ status: "owned", quantity: 0 }, -1), { quantity: 0, status: "wishlist" });
  });

  it("decrementing a polish that is not owned changes nothing", () => {
    assert.deepEqual(quantityChangeUpdate({ status: "destash", quantity: 1 }, -1), { quantity: 1, status: "destash" });
  });
});
