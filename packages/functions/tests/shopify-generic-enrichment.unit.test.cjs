const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Count AI color-name lookups: replace the module in the require cache before the connector loads.
const detectionPath = require.resolve("../dist/lib/connectors/color-name-detection");
const realDetection = require(detectionPath);
let lookups = 0;
require.cache[detectionPath].exports = {
  ...realDetection,
  detectHexFromColorName: async () => {
    lookups += 1;
    return { hex: "#112233", provider: "azure-openai" };
  },
};

const { ShopifyGenericConnector, gateShopifyProduct } = require("../dist/lib/connectors/shopify-generic");

function makeCatalog(size) {
  const products = [];
  for (let i = 0; i < size; i += 1) {
    const accessory = i % 10 === 0;
    products.push({
      id: 1000 + i,
      title: accessory ? `Rhinestone Charm ${i}` : `Shade ${i}`,
      handle: `shade-${i}`,
      vendor: "Test Brand",
      product_type: accessory ? "Nail Art" : "Nail Polish",
      tags: "nail-polish, color:red",
      published_at: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
      variants: [{ id: i, title: "Default Title" }],
      images: [],
    });
  }
  return products;
}

function pull(connector, products, page) {
  return connector.pullProducts({
    searchTerm: "",
    page,
    pageSize: 250,
    maxRecords: 250,
    catalogCache: { load: async () => products, save: async () => {} },
  });
}

describe("ShopifyGenericConnector — gate first, enrich only the page window", () => {
  it("runs the AI color-name lookup once per returned record, not once per catalog product", async () => {
    const connector = new ShopifyGenericConnector("TestBrandShopify", "https://example.test", { currency: "USD" });
    const products = makeCatalog(600);

    lookups = 0;
    const first = await pull(connector, products, 2);
    assert.ok(first.records.length > 0 && first.records.length <= 250);
    assert.equal(lookups, first.records.length);
    assert.equal(first.metadata.fetchedProductCount, 600);
    assert.equal(first.metadata.sourceCount, 540);

    lookups = 0;
    const second = await pull(connector, products, 2);
    assert.equal(lookups, second.records.length);
    assert.deepEqual(
      second.records.map((r) => r.externalId),
      first.records.map((r) => r.externalId)
    );
  });

  it("gateShopifyProduct rejects accessories and accepts polish with its category", () => {
    const [accessory, polish] = [makeCatalog(1)[0], makeCatalog(2)[1]];
    assert.equal(gateShopifyProduct(accessory, "TestBrandShopify").accept, false);
    const gate = gateShopifyProduct(polish, "TestBrandShopify");
    assert.equal(gate.accept, true);
    assert.equal(gate.category, "color");
  });

  it("matches the search term against the resolved brand as well as the raw vendor", async () => {
    const connector = new ShopifyGenericConnector("NightOwlLacquerShopify", "https://example.test", { currency: "USD" });
    const products = makeCatalog(3).map((product) => ({ ...product, vendor: "vendor-unknown" }));

    const result = await connector.pullProducts({
      searchTerm: "night owl",
      page: 1,
      pageSize: 250,
      maxRecords: 250,
      catalogCache: { load: async () => products, save: async () => {} },
    });

    // Product 0 is an accessory (gated out); the two polishes match through the brand.
    assert.equal(result.records.length, 2);
  });

  it("matches the search term against derived collection and finish values, as the record carries them", async () => {
    const connector = new ShopifyGenericConnector("TestBrandShopify", "https://example.test", { currency: "USD" });
    const products = makeCatalog(3).map((product, i) => ({
      ...product,
      tags: i === 1 ? "nail-polish, collection:  Fall   Drop , finish: Linear Holo" : "nail-polish",
    }));
    const search = (searchTerm) =>
      connector.pullProducts({
        searchTerm,
        page: 1,
        pageSize: 250,
        maxRecords: 250,
        catalogCache: { load: async () => products, save: async () => {} },
      });

    for (const term of ["fall   drop", "linear holo"]) {
      const result = await search(term);
      assert.deepEqual(result.records.map((r) => r.externalId), ["1001"], term);
    }
  });
});

describe("ShopifyGenericConnector — page limit (SHOPIFY_CONNECTOR_MAX_PAGES / settings.maxPages)", () => {
  const { readSourceSettings } = require("../dist/lib/source-settings");
  let originalFetch;
  let pagesRequested;
  let originalDelay;
  beforeEach(() => {
    originalDelay = process.env.SHOPIFY_CONNECTOR_PAGE_DELAY_MS;
    process.env.SHOPIFY_CONNECTOR_PAGE_DELAY_MS = "0";
    originalFetch = globalThis.fetch;
    pagesRequested = [];
    // A store with 35 full pages of 250 products and a short 36th page.
    globalThis.fetch = async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      pagesRequested.push(page);
      const count = page <= 35 ? 250 : 10;
      const products = Array.from({ length: count }, (_, i) => ({
        id: page * 1000 + i,
        title: `Shade ${page}-${i}`,
        vendor: "Test Brand",
        product_type: "Nail Polish",
        tags: "nail-polish",
        variants: [],
        images: [],
      }));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        text: async () => JSON.stringify({ products }),
      };
    };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDelay === undefined) delete process.env.SHOPIFY_CONNECTOR_PAGE_DELAY_MS;
    else process.env.SHOPIFY_CONNECTOR_PAGE_DELAY_MS = originalDelay;
  });

  const pullAll = (settings) =>
    new ShopifyGenericConnector("TestBrandShopify", "https://example.test", { currency: "USD", settings }).pullProducts({
      searchTerm: "",
      page: 1,
      pageSize: 250,
      maxRecords: 250,
    });

  it("stops at the default 30 pages without a per-source limit", async () => {
    const result = await pullAll(undefined);
    assert.equal(pagesRequested.length, 30);
    assert.equal(result.metadata.fetchedProductCount, 30 * 250);
    assert.equal(result.catalog.complete, false, "a truncated read is not a complete catalog");
  });

  it("reads a 35-page store to the end with settings.maxPages 40", async () => {
    const result = await pullAll(readSourceSettings({ kind: "retailer", maxPages: 40 }));
    assert.equal(pagesRequested.length, 36);
    assert.equal(result.metadata.fetchedProductCount, 35 * 250 + 10);
    assert.equal(result.catalog.complete, true);
  });

  it("waits SHOPIFY_CONNECTOR_PAGE_DELAY_MS between consecutive pages, not after the last", async () => {
    process.env.SHOPIFY_CONNECTOR_PAGE_DELAY_MS = "40";
    const stamps = [];
    const inner = globalThis.fetch;
    globalThis.fetch = async (url) => {
      stamps.push(Date.now());
      return inner(url);
    };
    await pullAll(readSourceSettings({ kind: "retailer", maxPages: 3 }));
    assert.equal(stamps.length, 3);
    for (let i = 1; i < stamps.length; i += 1) {
      assert.ok(stamps[i] - stamps[i - 1] >= 38, `gap ${stamps[i] - stamps[i - 1]}ms`);
    }
  });
});
