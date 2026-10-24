import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notifyCollectionChanged, onCollectionChanged } from "./collection-events";

describe("collection-changed signal", () => {
  it("calls every subscriber until it unsubscribes", () => {
    let a = 0;
    let b = 0;
    const offA = onCollectionChanged(() => (a += 1));
    const offB = onCollectionChanged(() => (b += 1));
    notifyCollectionChanged();
    offA();
    notifyCollectionChanged();
    offB();
    notifyCollectionChanged();
    assert.equal(a, 1);
    assert.equal(b, 2);
  });

  it("a throwing subscriber does not stop the others", () => {
    let called = false;
    const offBad = onCollectionChanged(() => {
      throw new Error("boom");
    });
    const offGood = onCollectionChanged(() => (called = true));
    notifyCollectionChanged();
    offBad();
    offGood();
    assert.equal(called, true);
  });
});
