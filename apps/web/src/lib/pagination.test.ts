import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPageNumbers, pageRange } from "./pagination";

describe("buildPageNumbers", () => {
  it("lists every page up to 7", () => {
    assert.deepEqual(buildPageNumbers(1, 1), [1]);
    assert.deepEqual(buildPageNumbers(4, 7), [1, 2, 3, 4, 5, 6, 7]);
  });

  it("returns nothing without pages", () => {
    assert.deepEqual(buildPageNumbers(1, 0), []);
  });

  it("keeps 7 slots near the start", () => {
    assert.deepEqual(buildPageNumbers(1, 64), [1, 2, 3, 4, 5, "ellipsis", 64]);
    assert.deepEqual(buildPageNumbers(4, 64), [1, 2, 3, 4, 5, "ellipsis", 64]);
  });

  it("centres the current page in the middle", () => {
    assert.deepEqual(buildPageNumbers(14, 64), [1, "ellipsis", 13, 14, 15, "ellipsis", 64]);
  });

  it("keeps 7 slots near the end", () => {
    assert.deepEqual(buildPageNumbers(64, 64), [1, "ellipsis", 60, 61, 62, 63, 64]);
    assert.deepEqual(buildPageNumbers(61, 64), [1, "ellipsis", 60, 61, 62, 63, 64]);
  });

  it("clamps an out-of-range page", () => {
    assert.deepEqual(buildPageNumbers(99, 10), [1, "ellipsis", 6, 7, 8, 9, 10]);
    assert.deepEqual(buildPageNumbers(0, 10), [1, 2, 3, 4, 5, "ellipsis", 10]);
  });

  it("never exceeds 7 slots", () => {
    for (let total = 1; total <= 40; total++) {
      for (let page = 1; page <= total; page++) {
        const slots = buildPageNumbers(page, total);
        assert.ok(slots.length <= 7, `page ${page} of ${total}`);
        assert.ok(slots.includes(page), `page ${page} of ${total} shows the current page`);
      }
    }
  });
});

describe("pageRange", () => {
  it("gives the item range of a page", () => {
    assert.deepEqual(pageRange(1, 25, 1580), { start: 1, end: 25 });
    assert.deepEqual(pageRange(64, 25, 1580), { start: 1576, end: 1580 });
    assert.deepEqual(pageRange(1, 25, 0), { start: 0, end: 0 });
  });
});
