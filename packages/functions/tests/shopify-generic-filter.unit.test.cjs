const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { isNailPolish } = require("../dist/lib/connectors/shopify-generic");

describe("lib/connectors/shopify-generic — isNailPolish", () => {
  describe("real polishes pass the filter", () => {
    it("accepts product_type 'Nail Polish'", () => {
      assert.equal(isNailPolish("Nail Polish", []), true);
    });

    it("accepts product_type 'Nail Lacquer'", () => {
      assert.equal(isNailPolish("Nail Lacquer", []), true);
    });

    it("accepts a polish identified only by tags", () => {
      assert.equal(isNailPolish(null, ["nail-polish", "creme"]), true);
    });

    it("accepts a lacquer identified only by tags", () => {
      assert.equal(isNailPolish(null, ["lacquer", "shimmer"]), true);
    });

    it("accepts product_type containing 'Nail Enamel'", () => {
      assert.equal(isNailPolish("Nail Enamel", []), true);
    });
  });

  describe("non-polish products are rejected even when 'nail' appears", () => {
    it("rejects nail art stamping plates", () => {
      assert.equal(
        isNailPolish("Nail Art", ["stamping-plate", "nail-art"]),
        false
      );
    });

    it("rejects nail brushes", () => {
      assert.equal(isNailPolish("Nail Tools", ["brush", "nail-art"]), false);
    });

    it("rejects nail files and buffers", () => {
      assert.equal(isNailPolish("Nail Care", ["file", "buffer"]), false);
    });

    it("rejects UV/gel lamps", () => {
      assert.equal(isNailPolish("Nail Equipment", ["lamp", "uv"]), false);
    });

    it("rejects nail decals and stickers", () => {
      assert.equal(isNailPolish("Nail Art", ["decal", "sticker"]), false);
    });

    it("rejects polish removers", () => {
      assert.equal(isNailPolish("Nail Care", ["remover", "wipe"]), false);
    });

    it("rejects cuticle oils and treatments", () => {
      assert.equal(isNailPolish("Nail Care", ["cuticle-oil"]), false);
    });

    it("rejects nail kits", () => {
      assert.equal(isNailPolish("Nail Care", ["nail-kit", "starter-kit"]), false);
    });

    it("rejects dotting tools", () => {
      assert.equal(isNailPolish("Nail Tools", ["dotting-tool"]), false);
    });

    it("rejects items where 'plate' appears in product_type", () => {
      assert.equal(
        isNailPolish("Stamping Plate", ["nail-art", "stamping"]),
        false
      );
    });

    it("rejects when name in tags includes 'stamping plate' even with polish-ish tags", () => {
      // Defensive: if a vendor tags both 'stamping-plate' AND 'nail polish', exclude.
      assert.equal(
        isNailPolish("Nail Art", ["stamping-plate", "nail-polish"]),
        false
      );
    });
  });

  describe("empty / missing inputs", () => {
    it("returns false when both productType and tags are empty", () => {
      assert.equal(isNailPolish(null, []), false);
    });

    it("returns false when only generic 'nail' appears with no polish keyword", () => {
      // Old behavior treated this as a polish — now we require an explicit polish signal.
      assert.equal(isNailPolish(null, ["nail"]), false);
    });
  });
});
