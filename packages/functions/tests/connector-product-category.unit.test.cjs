const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { HoloTacoShopifyConnector } = require("../dist/lib/connectors/holo-taco-shopify");
const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");
const { OpenBeautyFactsConnector } = require("../dist/lib/connectors/open-beauty-facts");
const { MakeupApiConnector } = require("../dist/lib/connectors/makeup-api");

/** Real Holo Taco / Mooncat shapes from the local catalog (2026-10-18), trimmed. */
const product = (id, title, productType, tags) => ({
  id,
  title,
  handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  vendor: "Holo Taco",
  product_type: productType,
  tags,
  published_at: "2026-10-01T00:00:00Z",
  variants: [{ id: id * 10, title: "Default Title" }],
  images: [],
});
const SHOPIFY_CATALOG = [
  product(1, "Pier Pressure", "Nail Polish", ["nail-polish", "finish:creme"]),
  product(2, "Quick-Dry Base", "Base Coat", ["base-coat", "nail-polish", "top-and-base-coats"]),
  product(3, "Sticky Base", "Nail Polish", ["base-coat", "nail-polish"]),
  product(4, "Blue Flakie Holo Taco", "Top Coat", ["finish:flakie", "nail-polish", "top-coat", "toppers"]),
  // Top coat without a nail-polish tag: dropped by the old Holo Taco filter, ingested now (D-E).
  product(5, "Glossy Top Coat", "Top Coat", ["top-coat"]),
  product(6, "Magnetic Wand", "Nail Tools", ["magnetic-wand", "nail-tool", "type:nail-tool"]),
  product(7, "Boundary Pusher", "Cuticle Pushers", ["nail-tool"]),
  product(8, "Holo Magnetic Taco", "Nail Polish", ["magnetic-wand", "nail-polish", "toppers"]),
];

function fakeFetch(body) {
  return async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

const pull = { searchTerm: "", page: 1, pageSize: 50, maxRecords: 50 };
const categories = (result) =>
  Object.fromEntries(result.records.map((record) => [record.normalized.name, record.normalized.productCategory]));

describe("connectors classify products and skip accessories (#347, #349)", () => {
  let originalFetch;
  let originalEndpoint;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_ENDPOINT; // keep color-name detection offline
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEndpoint !== undefined) process.env.AZURE_OPENAI_ENDPOINT = originalEndpoint;
  });

  const EXPECTED = {
    "Pier Pressure": "color",
    "Quick-Dry Base": "base_coat",
    "Sticky Base": "base_coat",
    "Blue Flakie Holo Taco": "topper",
    "Glossy Top Coat": "top_coat",
    "Holo Magnetic Taco": "topper",
  };

  it("HoloTacoShopify uses the shared gate", async () => {
    globalThis.fetch = fakeFetch({ products: SHOPIFY_CATALOG });
    const result = await new HoloTacoShopifyConnector("https://www.holotaco.com").pullProducts(pull);
    assert.deepEqual(categories(result), EXPECTED);
  });

  it("generic Shopify uses the same gate", async () => {
    globalThis.fetch = fakeFetch({ products: SHOPIFY_CATALOG });
    const result = await new ShopifyGenericConnector("MooncatShopify", "https://www.mooncat.com").pullProducts(pull);
    assert.deepEqual(categories(result), EXPECTED);
  });

  it("OpenBeautyFacts skips accessories and records the category", async () => {
    globalThis.fetch = fakeFetch({
      count: 3,
      page_count: 1,
      products: [
        { code: "1", product_name: "Ruby Red Nail Polish", brands: "Essie", categories_tags: ["en:nail-polishes"] },
        { code: "2", product_name: "Strengthener", brands: "OPI", categories_tags: ["en:nail-treatments"] },
        { code: "3", product_name: "Acetone Free Polish Remover", brands: "Cutex", categories_tags: ["en:nail-polish-removers"] },
      ],
    });
    const result = await new OpenBeautyFactsConnector().pullProducts({ ...pull, searchTerm: "nail polish" });
    assert.deepEqual(
      result.records.map((record) => [record.normalized.name, record.normalized.productCategory]),
      [["Ruby Red Nail Polish", "color"], ["Strengthener", "treatment"]]
    );
  });

  it("MakeupAPI skips accessories and records the category", async () => {
    globalThis.fetch = fakeFetch([
      { id: 1, brand: "essie", name: "Gel Couture Top Coat", product_type: "nail_polish", tag_list: [], product_colors: [] },
      { id: 2, brand: "essie", name: "Nail File Duo", product_type: "nail_polish", tag_list: [], product_colors: [] },
      { id: 3, brand: "essie", name: "Ballet Slippers", product_type: "nail_polish", tag_list: [], product_colors: [] },
    ]);
    const result = await new MakeupApiConnector().pullProducts(pull);
    assert.deepEqual(
      result.records.map((record) => [record.normalized.name, record.normalized.productCategory]),
      [["Gel Couture Top Coat", "top_coat"], ["Ballet Slippers", "color"]]
    );
  });
});
