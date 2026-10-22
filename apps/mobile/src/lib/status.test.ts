import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COLLECTION_PRESETS, isOwnedPolish, quickLogRole, statusActionsFor, statusChangePatch } from "./status";

describe("status helpers", () => {
  it("ownership comes from status, never quantity", () => {
    assert.equal(isOwnedPolish({ status: "owned" }), true);
    assert.equal(isOwnedPolish({ status: "wishlist" }), false);
    assert.equal(isOwnedPolish({ status: null }), false);
  });

  it("owned/destash keep at least one bottle; wishlist/archived leave quantity alone", () => {
    assert.deepEqual(statusChangePatch({ quantity: 0 }, "owned"), { status: "owned", quantity: 1 });
    assert.deepEqual(statusChangePatch({ quantity: 3 }, "destash"), { status: "destash", quantity: 3 });
    assert.deepEqual(statusChangePatch({ quantity: 3 }, "wishlist"), { status: "wishlist" });
  });

  it("only an archived polish can be rebought onto the wishlist (D5)", () => {
    const owned = statusActionsFor("owned").map((a) => (a.kind === "status" ? a.status : a.kind));
    assert.ok(!owned.includes("wishlist"));
    const archived = statusActionsFor("archived").map((a) => (a.kind === "status" ? a.status : a.kind));
    assert.ok(archived.includes("wishlist"));
    assert.ok(statusActionsFor("wishlist").some((a) => a.kind === "remove"));
  });

  it("the untried preset filters owned rows only", () => {
    assert.deepEqual(COLLECTION_PRESETS.find((p) => p.key === "untried")?.filters, { status: ["owned"], untried: true });
  });

  it("toppers log as topper", () => {
    assert.equal(quickLogRole(["shimmer", "Topper"]), "topper");
    assert.equal(quickLogRole(["creme"]), "color");
  });
});
