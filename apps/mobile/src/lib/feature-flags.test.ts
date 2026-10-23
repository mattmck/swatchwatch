import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_FLAGS, parseFlags } from "./feature-flags";

describe("parseFlags", () => {
  it("keeps known flags, drops unknown keys and defaults the rest to false", () => {
    assert.deepEqual(parseFlags({ bottleCapture: true, nope: true }), {
      shareableWishlist: false,
      shareableLooks: false,
      bottleCapture: true,
    });
  });

  it("treats non-boolean values as false", () => {
    assert.equal(parseFlags({ bottleCapture: "true" }).bottleCapture, false);
    assert.equal(parseFlags({ bottleCapture: 1 }).bottleCapture, false);
  });

  it("returns the all-off defaults for anything that is not an object", () => {
    assert.deepEqual(parseFlags(null), DEFAULT_FLAGS);
    assert.deepEqual(parseFlags("x"), DEFAULT_FLAGS);
    assert.deepEqual(parseFlags([true]), DEFAULT_FLAGS);
    assert.ok(Object.values(DEFAULT_FLAGS).every((v) => v === false));
  });
});
