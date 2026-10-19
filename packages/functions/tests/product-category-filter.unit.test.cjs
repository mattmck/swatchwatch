const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { parseProductCategoryFilter } = require("../dist/lib/product-category-filter");

const parse = (query) => parseProductCategoryFilter(new URLSearchParams(query));

describe("lib/product-category-filter — parseProductCategoryFilter", () => {
  it("returns an empty list when absent or blank", () => {
    assert.deepEqual(parse(""), { ok: true, categories: [] });
    assert.deepEqual(parse("category=%20"), { ok: true, categories: [] });
  });

  it("accepts comma lists, repeats and spelling variants, in PRODUCT_CATEGORIES order", () => {
    assert.deepEqual(parse("category=treatment,Top-Coat&category=color&category=topcoat"), {
      ok: true,
      categories: ["color", "top_coat", "treatment"],
    });
    assert.deepEqual(parse("category=base coat,toppers").categories, ["topper", "base_coat"]);
  });

  it("rejects unknown values", () => {
    const result = parse("category=color,glitter");
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, ["glitter"]);
  });
});
