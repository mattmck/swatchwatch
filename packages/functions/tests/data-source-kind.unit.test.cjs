const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { sourceKindFromMetadata } = require("../dist/lib/data-source-kind");

describe("sourceKindFromMetadata", () => {
  it("is retailer only for the exact value", () => {
    assert.equal(sourceKindFromMetadata({ kind: "retailer" }), "retailer");
  });
  for (const [label, value] of [
    ["empty object", {}],
    ["null", null],
    ["undefined", undefined],
    ["upper case", { kind: "RETAILER" }],
    ["bare string", "retailer"],
    ["other kind", { kind: "brand" }],
  ]) {
    it(`is brand_store for ${label}`, () => {
      assert.equal(sourceKindFromMetadata(value), "brand_store");
    });
  }
});
