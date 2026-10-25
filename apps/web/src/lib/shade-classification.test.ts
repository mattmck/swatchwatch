import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SHADE_FINISHES_MAX, type HexLabelQueueItem } from "swatchwatch-shared";
import {
  applyCategoryResponse,
  applyFinishesResponse,
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
