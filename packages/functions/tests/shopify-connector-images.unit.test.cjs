const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { HoloTacoShopifyConnector } = require("../dist/lib/connectors/holo-taco-shopify");
const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");

const PRODUCT = {
  id: 7902303944794,
  title: "Pier Pressure",
  handle: "pier-pressure",
  vendor: "Holo Taco",
  product_type: "Nail Polish",
  tags: "nail-polish, finish:creme, color:teal",
  published_at: "2026-06-01T00:00:00Z",
  variants: [{ id: 1, title: "Default Title", barcode: "012345678905" }],
  images: [
    { id: 1, position: 1, alt: "Pier Pressure bottle hero", src: "https://cdn.shopify.com/s/files/1/0050/bottle.jpg?v=1" },
    { id: 2, position: 2, alt: null, src: "//cdn.shopify.com/s/files/1/0050/DSC_1441_hand2_PierPressure_sq.jpg" },
    { id: 3, position: 3, alt: "Swatch on nails", src: "https://cdn.shopify.com/s/files/1/0050/swatch.jpg" },
    { id: 4, position: 4, alt: "dupe", src: "https://cdn.shopify.com/s/files/1/0050/bottle.jpg?v=1" },
  ],
};

function fakeFetch(products) {
  return async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => JSON.stringify({ products }),
  });
}

const EXPECTED_IMAGES = [
  { url: "https://cdn.shopify.com/s/files/1/0050/bottle.jpg?v=1", alt: "Pier Pressure bottle hero", position: 1 },
  { url: "https://cdn.shopify.com/s/files/1/0050/DSC_1441_hand2_PierPressure_sq.jpg", alt: null, position: 2 },
  { url: "https://cdn.shopify.com/s/files/1/0050/swatch.jpg", alt: "Swatch on nails", position: 3 },
];

describe("Shopify connectors keep image metadata on normalized records", () => {
  let originalFetch;
  let originalEndpoint;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_ENDPOINT; // keep color-name detection offline
    globalThis.fetch = fakeFetch([PRODUCT]);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEndpoint !== undefined) process.env.AZURE_OPENAI_ENDPOINT = originalEndpoint;
  });

  const pull = { searchTerm: "", page: 1, pageSize: 50, maxRecords: 50 };

  it("HoloTacoShopify: images carries url/alt/position while imageUrls and primaryImageUrl are unchanged", async () => {
    const result = await new HoloTacoShopifyConnector("https://www.holotaco.com").pullProducts(pull);
    assert.equal(result.records.length, 1);
    const normalized = result.records[0].normalized;
    assert.deepEqual(normalized.images, EXPECTED_IMAGES);
    assert.deepEqual(normalized.imageUrls, EXPECTED_IMAGES.map((i) => i.url));
    assert.equal(normalized.primaryImageUrl, EXPECTED_IMAGES[0].url);
  });

  it("generic Shopify: images carries url/alt/position while imageUrls and primaryImageUrl are unchanged", async () => {
    const result = await new ShopifyGenericConnector("MooncatShopify", "https://www.mooncat.com").pullProducts(pull);
    assert.equal(result.records.length, 1);
    const normalized = result.records[0].normalized;
    assert.deepEqual(normalized.images, EXPECTED_IMAGES);
    assert.deepEqual(normalized.imageUrls, EXPECTED_IMAGES.map((i) => i.url));
    assert.equal(normalized.primaryImageUrl, EXPECTED_IMAGES[0].url);
  });

  it("products without images get empty images/imageUrls and a null primary", async () => {
    globalThis.fetch = fakeFetch([{ ...PRODUCT, images: null }]);
    const result = await new HoloTacoShopifyConnector("https://www.holotaco.com").pullProducts(pull);
    const normalized = result.records[0].normalized;
    assert.deepEqual(normalized.images, []);
    assert.deepEqual(normalized.imageUrls, []);
    assert.equal(normalized.primaryImageUrl, null);
  });
});
