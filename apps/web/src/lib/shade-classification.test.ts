import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SHADE_FINISHES_MAX, type HexLabelQueueItem } from "swatchwatch-shared";
import {
  applyCategoryResponse,
  applyFinishesResponse,
  applyQueueItemChange,
  finishesChanged,
  makePrimaryFinish,
  toggleFinish,
} from "./shade-classification";

const item: HexLabelQueueItem = {
  shadeId: "5",
  brand: "Brand",
  name: "Shade",
  finishes: ["creme"],
  finishesSource: "rule",
  productCategory: "color",
  productCategorySource: "rule",
  vendorHex: null,
  detectedHex: null,
  nameHex: null,
  hexAgreement: null,
  detectedHexConfidence: null,
  detectedHexMethod: null,
  flagged: false,
  images: [],
  label: null,
  vendorHexSource: null,
  promotedLabelId: null,
  vendorHexPrevious: null,
};

describe("toggleFinish", () => {
  it("appends a new finish and removes a selected one", () => {
    assert.deepEqual(toggleFinish(["creme"], "magnetic"), ["creme", "magnetic"]);
    assert.deepEqual(toggleFinish(["creme", "magnetic"], "creme"), ["magnetic"]);
  });

  it("stops at the maximum", () => {
    const full = Array.from({ length: SHADE_FINISHES_MAX }, (_, i) => `f${i}`);
    assert.deepEqual(toggleFinish(full, "thermal"), full);
  });
});

describe("makePrimaryFinish", () => {
  it("moves a selected finish to the front and ignores unselected ones", () => {
    assert.deepEqual(makePrimaryFinish(["creme", "thermal", "magnetic"], "magnetic"), ["magnetic", "creme", "thermal"]);
    assert.deepEqual(makePrimaryFinish(["creme"], "thermal"), ["creme"]);
  });
});

describe("finishesChanged", () => {
  it("compares order as well as content", () => {
    assert.equal(finishesChanged(["creme", "shimmer"], ["creme", "shimmer"]), false);
    assert.equal(finishesChanged(["creme", "shimmer"], ["shimmer", "creme"]), true);
    assert.equal(finishesChanged(["creme"], []), true);
  });
});

describe("apply responses", () => {
  it("updates the matching item only", () => {
    const finishes = { shadeId: "5", finishes: ["thermal"], finishesSource: "admin" as const, changed: true };
    assert.deepEqual(applyFinishesResponse(item, finishes), { ...item, finishes: ["thermal"], finishesSource: "admin" });
    assert.equal(applyFinishesResponse({ ...item, shadeId: "6" }, finishes).finishes[0], "creme");

    const category = { shadeId: "5", productCategory: "topper" as const, productCategorySource: "admin" as const, status: "active" };
    const updated = applyCategoryResponse(item, category);
    assert.equal(updated.productCategory, "topper");
    assert.equal(updated.productCategorySource, "admin");
  });
});

describe("applyQueueItemChange", () => {
  const queue = (items: HexLabelQueueItem[], index: number) => ({ items, index, total: 10, labeled: 2 });
  const a = { ...item, shadeId: "1" };
  const b = { ...item, shadeId: "2", label: { hex: "#112233" } as unknown as HexLabelQueueItem["label"] };
  const c = { ...item, shadeId: "3" };

  it("replaces a colour item in place", () => {
    const next = { ...b, finishes: ["shimmer"] };
    const result = applyQueueItemChange(queue([a, b, c], 1), next);
    assert.deepEqual(result.items, [a, next, c]);
    assert.equal(result.index, 1);
    assert.equal(result.total, 10);
  });

  it("drops a recategorized item so the next shade takes its place", () => {
    const result = applyQueueItemChange(queue([a, b, c], 1), { ...b, productCategory: "topper" });
    assert.deepEqual(result.items, [a, c]);
    assert.equal(result.index, 1);
    assert.equal(result.total, 9);
    assert.equal(result.labeled, 1);
  });

  it("keeps the labeled count for an unlabeled item and clamps the index at the end", () => {
    const result = applyQueueItemChange(queue([a, b, c], 2), { ...c, productCategory: "accessory" });
    assert.deepEqual(result.items, [a, b]);
    assert.equal(result.index, 1);
    assert.equal(result.labeled, 2);
  });

  it("ignores an item that is not in the queue", () => {
    const state = queue([a], 0);
    assert.equal(applyQueueItemChange(state, { ...c, productCategory: "topper" }), state);
  });
});
