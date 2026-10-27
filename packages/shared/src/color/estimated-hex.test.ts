import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colorSearchConfidence, compareColorSearchRank, isEstimatedDisplayHex } from "./estimated-hex";

describe("isEstimatedDisplayHex", () => {
  it("is true only when the name hex is the display hex", () => {
    assert.equal(isEstimatedDisplayHex({ nameHex: "#6A5ACD" }), true);
    assert.equal(isEstimatedDisplayHex({ vendorHex: "#0063DC", nameHex: "#6A5ACD" }), false);
    assert.equal(isEstimatedDisplayHex({ detectedHex: "#0063DC", nameHex: "#6A5ACD" }), false);
    assert.equal(isEstimatedDisplayHex({ vendorHex: "", detectedHex: "", nameHex: "#6A5ACD" }), true);
    assert.equal(isEstimatedDisplayHex({}), false);
  });
});

describe("colorSearchConfidence", () => {
  it("grades measured hexes by distance and caps estimated ones at low", () => {
    assert.equal(colorSearchConfidence(0.03, false), "high");
    assert.equal(colorSearchConfidence(0.09, false), "medium");
    assert.equal(colorSearchConfidence(0.03, true), "low");
    assert.equal(colorSearchConfidence(0.09, true), "low");
  });
});

describe("compareColorSearchRank", () => {
  it("ranks every measured row before estimated rows, nearest first within each", () => {
    const rows = [
      { id: "est-near", distance: 0.09, estimated: true },
      { id: "measured-far", distance: 0.13, estimated: false },
      { id: "measured-near", distance: 0.12, estimated: false },
      { id: "est-far", distance: 0.2, estimated: true },
    ];
    assert.deepEqual(
      [...rows].sort(compareColorSearchRank).map((r) => r.id),
      ["measured-near", "measured-far", "est-near", "est-far"],
    );
  });
});
