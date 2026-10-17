const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  isNailPolish,
  isBundle,
  ShopifyGenericConnector,
} = require("../dist/lib/connectors/shopify-generic");

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

    it("accepts a polish identified by underscore-separated tags", () => {
      assert.equal(isNailPolish(null, ["nail_polish", "creme"]), true);
    });

    it("accepts a polish identified by concatenated tags", () => {
      assert.equal(isNailPolish(null, ["nailpolish", "creme"]), true);
    });

    it("accepts a lacquer identified only by tags", () => {
      assert.equal(isNailPolish(null, ["lacquer", "shimmer"]), true);
    });

    it("accepts product_type containing 'Nail Enamel'", () => {
      assert.equal(isNailPolish("Nail Enamel", []), true);
    });
  });

  describe("plural product types and tags pass the filter (#292)", () => {
    it("accepts Mooncat's product_type 'Nail Polishes'", () => {
      // Real Mooncat single shade: product_type "Nail Polishes", tags carry no polish signal.
      assert.equal(
        isNailPolish("Nail Polishes", [
          "collection:everything",
          "collection:holographic",
          "collection:planet-nyarr",
          "color:pink",
          "finish:glitter",
          "finish:holographic",
        ]),
        true
      );
    });

    it("accepts a bare 'Polishes' product_type", () => {
      assert.equal(isNailPolish("Polishes", []), true);
    });

    it("accepts plural lacquer/enamel/varnish forms", () => {
      assert.equal(isNailPolish("Nail Lacquers", []), true);
      assert.equal(isNailPolish("Enamels", []), true);
      assert.equal(isNailPolish("Nail Varnishes", []), true);
    });

    it("accepts plural tags with separators", () => {
      assert.equal(isNailPolish(null, ["nail-polishes", "shimmer"]), true);
      assert.equal(isNailPolish(null, ["nail_polishes"]), true);
      assert.equal(isNailPolish(null, ["nailpolishes"]), true);
    });

    it("does not treat the adjective 'polished' as a polish signal", () => {
      assert.equal(isNailPolish("Polished Accessories", []), false);
    });

    it("does not match polish words embedded in other words", () => {
      assert.equal(isNailPolish("Polishers", []), false);
      assert.equal(isNailPolish(null, ["enamelware"]), false);
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

  describe("plural signals do not let non-polish products through", () => {
    it("rejects nail polish removers with a plural product_type", () => {
      assert.equal(isNailPolish("Nail Polishes", ["polish-remover"]), false);
      assert.equal(isNailPolish("Nail Polish Removers", []), false);
    });

    it("rejects cuticle oils listed under 'Nail Polishes'", () => {
      assert.equal(isNailPolish("Nail Polishes", ["cuticle-oil"]), false);
    });

    it("rejects tools listed under 'Nail Polishes'", () => {
      // Mooncat's "Nail Elixir" treatment: product_type "Nail Polishes" but tagged as a nail tool.
      assert.equal(
        isNailPolish("Nail Polishes", [
          "collection:nail-tool",
          "nail-tool",
          "type:nail-polish",
          "type:nail-tool",
        ]),
        false
      );
    });

    it("rejects stamping plates for polishes", () => {
      assert.equal(isNailPolish("Stamping Plates", ["polishes"]), false);
    });

    it("rejects decorative stickers and Mooncat's non-nail product types", () => {
      assert.equal(isNailPolish("Decorative Stickers", []), false);
      assert.equal(isNailPolish("Baggu Bag", []), false);
      assert.equal(isNailPolish("Free Gift", ["product-bundle"]), false);
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

describe("lib/connectors/shopify-generic — isBundle", () => {
  it("keeps recognizing the existing bundle tags", () => {
    assert.equal(isBundle(["bundle"]), true);
    assert.equal(isBundle(["bundle:product"]), true);
    assert.equal(isBundle(["product-bundle"]), true);
  });

  it("treats Mooncat's 'collection-set' tag as a bundle (#292)", () => {
    // Real Mooncat set tagged only collection-set (no bundle:* tag), product_type "Nail Polishes".
    const tags = ["collection-set", "lunar-sale"];
    assert.equal(isNailPolish("Nail Polishes", tags), true);
    assert.equal(isBundle(tags), true);
  });

  it("treats 'gift-set' as a bundle", () => {
    assert.equal(isBundle(["gift-set"]), true);
  });

  it("matches bundle tags case-insensitively and across separators", () => {
    assert.equal(isBundle(["Collection-Set"]), true);
    assert.equal(isBundle(["collection_set"]), true);
    assert.equal(isBundle([" Collection Set "]), true);
    assert.equal(isBundle(["Product_Bundle"]), true);
  });

  it("does not treat per-shade collection tags that name a set as bundles", () => {
    // Mooncat single shades from a set carry collection:<name>-set; those are real shades.
    assert.equal(
      isBundle([
        "collection:lost-in-a-folktale-set",
        "collection:a-tale-of-5-lacquers-set",
        "finish:shimmer",
      ]),
      false
    );
  });

  it("does not treat tags that merely contain 'set' or 'bundle' as bundles", () => {
    assert.equal(isBundle(["sunset", "jet-set", "set-in-stone", "bundled-shipping"]), false);
  });

  it("returns false for an untagged product", () => {
    assert.equal(isBundle([]), false);
  });
});

describe("ShopifyGenericConnector — Mooncat-shaped catalog (#292)", () => {
  // Trimmed from https://mooncat.com/products.json (2026-10-17): product types and tags as published.
  const product = (id, title, productType, tags) => ({
    id,
    title,
    handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    vendor: "Mooncat",
    product_type: productType,
    tags,
    published_at: "2026-10-01T00:00:00Z",
    variants: [{ id: id * 10, title: "Default Title" }],
    images: [],
  });
  const CATALOG = [
    product(1, "Litterbox", "Nail Polishes", ["collection:planet-nyarr", "color:pink", "finish:glitter"]),
    product(2, "Mermessage", "Nail Polishes", ["collection:mermaid-tales-set", "finish:flakie"]),
    product(3, "Shapeshifter", "nail polish", ["nail-polish", "finish:magnetic"]),
    product(4, "Sundog Set", "Nail Polishes", ["collection-set"]),
    product(5, "Night Owl Set", "Nail Polishes", ["bundle:product", "collection-set", "product-bundle"]),
    product(6, "Nail Elixir", "Nail Polishes", ["nail-tool", "type:nail-polish", "type:nail-tool"]),
    product(7, "Mooncat Sticker", "Decorative Stickers", []),
    product(8, "Magnetic Wand FREE", "Free Gift", ["product-bundle"]),
  ];

  let originalFetch;
  let originalEndpoint;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_ENDPOINT; // keep color-name detection offline
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      text: async () => JSON.stringify({ products: CATALOG }),
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEndpoint !== undefined) process.env.AZURE_OPENAI_ENDPOINT = originalEndpoint;
  });

  it("keeps 'Nail Polishes' single shades and drops sets, tools and merch", async () => {
    const result = await new ShopifyGenericConnector(
      "MooncatShopify",
      "https://mooncat.com"
    ).pullProducts({ searchTerm: "", page: 1, pageSize: 50, maxRecords: 50 });
    assert.deepEqual(
      result.records.map((record) => record.externalId).sort(),
      ["1", "2", "3"]
    );
  });
});
