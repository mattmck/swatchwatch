import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HexLabel, HexLabelQueueItem } from "swatchwatch-shared";
import { applyPromotionResponse, vendorHexPromotionState } from "./vendor-hex-promotion";

const label: HexLabel = {
  trainingSampleId: "9",
  shadeId: "5",
  hex: "#ABCDEF",
  unreliable: false,
  imageId: null,
  note: null,
  method: "canvas",
  samplePoint: null,
  labeledByUserId: "1",
  labeledAt: "2026-10-19T00:00:00.000Z",
};

const item: HexLabelQueueItem = {
  shadeId: "5",
  brand: "Brand",
  name: "Shade",
  finishes: [],
  finishesSource: "rule",
  productCategory: "color",
  productCategorySource: "rule",
  vendorHex: "#111111",
  detectedHex: "#121212",
  nameHex: null,
  hexAgreement: 0.2,
  detectedHexConfidence: null,
  detectedHexMethod: null,
  flagged: true,
  images: [],
  label,
  vendorHexSource: "vendor",
  promotedLabelId: null,
  vendorHexPrevious: null,
};

const promoted: HexLabelQueueItem = {
  ...item,
  vendorHex: "#ABCDEF",
  vendorHexSource: "manual_label",
  promotedLabelId: "9",
  vendorHexPrevious: "#111111",
};

describe("vendorHexPromotionState", () => {
  it("offers nothing without a saved approved label", () => {
    assert.equal(vendorHexPromotionState({ ...item, label: null }).kind, "none");
    assert.equal(vendorHexPromotionState({ ...item, label: { ...label, unreliable: true, hex: null } }).kind, "none");
  });

  it("offers a saved approved label", () => {
    assert.deepEqual(vendorHexPromotionState(item), { kind: "available", labelId: "9", hex: "#ABCDEF" });
  });

  it("shows a promoted label with the hex Undo restores", () => {
    assert.deepEqual(vendorHexPromotionState(promoted), {
      kind: "promoted",
      labelId: "9",
      hex: "#ABCDEF",
      previous: "#111111",
    });
  });

  it("flags a promoted label re-saved with another hex as stale", () => {
    const state = vendorHexPromotionState({ ...promoted, label: { ...label, hex: "#FEDCBA" } });
    assert.equal(state.kind, "stale");
  });

  it("treats a promotion whose label was deleted as orphaned (Undo only)", () => {
    assert.equal(vendorHexPromotionState({ ...promoted, label: null, promotedLabelId: null }).kind, "orphaned");
    assert.equal(
      vendorHexPromotionState({ ...promoted, label: { ...label, trainingSampleId: "10" }, promotedLabelId: null }).kind,
      "orphaned"
    );
  });
});

describe("applyPromotionResponse", () => {
  it("merges the new vendor hex state and clears the stale agreement", () => {
    const next = applyPromotionResponse(item, {
      shadeId: "5",
      vendorHex: "#ABCDEF",
      vendorHexSource: "manual_label",
      promotedLabelId: "9",
      vendorHexPrevious: "#111111",
      changed: true,
    });
    assert.equal(vendorHexPromotionState(next).kind, "promoted");
    assert.equal(next.hexAgreement, null);
    assert.equal(next.flagged, false);
  });

  it("ignores a response for another shade", () => {
    const next = applyPromotionResponse(item, { ...promoted, shadeId: "6", changed: true } as never);
    assert.equal(next, item);
  });
});
