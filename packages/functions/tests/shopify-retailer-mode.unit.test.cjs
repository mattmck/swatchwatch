/**
 * Retailer mode in the generic Shopify connector (brand sources plan, Task 5): a source whose
 * `metadata.kind` is not `brand` resolves each product's vendor through the source's alias map,
 * parses the "Brand Line - Shade size - #CODE" listing title, and drops vendor-less listings and
 * sets in the gate. Brand mode is unchanged: over the same fixture it produces exactly the
 * records the connector produced before retailer mode existed
 * (fixtures/beyond-polish-brand-mode-records.json, captured from the pre-change build).
 *
 * fixtures/beyond-polish-products.json is hand-built in the products.json shape from Beyond Polish
 * listing titles recorded 2026-11-08 (vendors, tags and prices are illustrative).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Deterministic, offline color-name lookups: replace the module before the connector loads.
const detectionPath = require.resolve("../dist/lib/connectors/color-name-detection");
const realDetection = require(detectionPath);
require.cache[detectionPath].exports = {
  ...realDetection,
  detectHexFromColorName: async () => ({ hex: "#112233", provider: "azure-openai" }),
};

const { ShopifyGenericConnector, resolveRetailerVendor } = require("../dist/lib/connectors/shopify-generic");
const { readSourceSettings } = require("../dist/lib/source-settings");
const { products } = require("./fixtures/beyond-polish-products.json");
const brandModeGolden = require("./fixtures/beyond-polish-brand-mode-records.json");

function pull(connector, catalog = products) {
  return connector.pullProducts({
    searchTerm: "",
    page: 1,
    pageSize: 50,
    maxRecords: 50,
    catalogCache: { load: async () => catalog, save: async () => {} },
  });
}

function retailerConnector(source = "BeyondPolishShopify", baseUrl = "https://www.beyondpolish.com") {
  return new ShopifyGenericConnector(source, baseUrl, {
    currency: "USD",
    settings: readSourceSettings({
      kind: "retailer",
      vendorAliases: { ORLY: "Orly", "DND - Daisy Nail Design": "DND" },
    }),
  });
}

describe("ShopifyGenericConnector — retailer mode", () => {
  it("parses brand, shade, line and vendor code, and drops sets and vendor-less listings in the gate", async () => {
    const { records, metadata } = await pull(retailerConnector());

    assert.equal(records.length, 2);
    assert.equal(records[0].normalized.brand, "OPI");
    assert.equal(records[0].normalized.name, "No Room for the Blues");
    assert.equal(records[0].normalized.vendorCode, "NLB83");
    assert.equal(records[0].normalized.productLine, "Nail Lacquer");
    assert.equal(records[0].normalized.discontinued, true);
    assert.deepEqual(records[0].normalized.collections, []);
    assert.deepEqual(records[0].normalized.finishes, []);
    assert.equal(records[0].normalized.listingTitle, "OPI Nail Lacquer - No Room for the Blues 0.5 oz - #NLB83");
    assert.equal(records[0].normalized.kind, "retailer");
    assert.equal(records[0].normalized.productUrl, "https://www.beyondpolish.com/products/opi-nail-lacquer-no-room-for-the-blues");
    assert.equal(records[0].normalized.price, "11.50");
    assert.equal(records[0].normalized.currency, "USD");
    assert.ok(records[0].normalized.tags.includes("Creme"), "store finish words stay in the tags");

    assert.equal(records[1].normalized.brand, "Orly");
    assert.equal(records[1].normalized.name, "Velvet Dreams");
    assert.equal(records[1].normalized.vendorCode, "2000478");
    assert.equal(records[1].normalized.discontinued, false);

    // Sets are dropped before windowing: they never count toward the page.
    assert.equal(metadata.sourceCount, 2);
    assert.equal(metadata.vendorlessSkipped, 1);
  });

  it("strips Hypnotic's leading pipes from tags", async () => {
    const hypnotic = [
      {
        id: 9001,
        title: "KBShimmer - Nail Polish - Mix It Up",
        handle: "kbshimmer-mix-it-up",
        vendor: "KBShimmer",
        product_type: "Nail Polish",
        tags: "| Shimmer, || Top Coat, Purple",
        variants: [{ id: 1, title: "Default Title", option1: "Default Title", price: "12.00" }],
        images: [],
      },
    ];
    const { records } = await pull(retailerConnector("HypnoticPolishShopify", "https://hypnoticpolish.com"), hypnotic);

    assert.equal(records.length, 1);
    assert.equal(records[0].normalized.name, "Mix It Up");
    assert.deepEqual(records[0].normalized.tags, ["Shimmer", "Top Coat", "Purple"]);
  });

  it("brand mode produces exactly the pre-retailer-mode records over the same fixture", async () => {
    const brand = new ShopifyGenericConnector("BeyondPolishShopify", "https://www.beyondpolish.com", {
      currency: "USD",
      settings: readSourceSettings({}),
    });
    const { records, metadata } = await pull(brand);

    assert.deepEqual(JSON.parse(JSON.stringify(records)), brandModeGolden.records);
    assert.deepEqual(metadata, brandModeGolden.metadata);
  });
});

describe("resolveRetailerVendor", () => {
  it("maps aliases on the lower-cased, whitespace-collapsed vendor", () => {
    assert.equal(resolveRetailerVendor("Lippmann", { lippmann: "Deborah Lippmann" }, "Beyond Polish"), "Deborah Lippmann");
    assert.equal(
      resolveRetailerVendor("  DND -  Daisy   Nail Design ", { "dnd - daisy nail design": "DND" }, "Beyond Polish", "retailer"),
      "DND"
    );
    assert.equal(resolveRetailerVendor("Zoya", { orly: "Orly" }, "Beyond Polish", "retailer"), "Zoya");
  });

  it("returns null for a retailer's missing or placeholder vendor; a brand source falls back to its brand", () => {
    assert.equal(resolveRetailerVendor("", {}, "Beyond Polish", "retailer"), null);
    assert.equal(resolveRetailerVendor("vendor-unknown", {}, "Beyond Polish", "feed"), null);
    assert.equal(resolveRetailerVendor(null, {}, "Night Owl Lacquer", "brand"), "Night Owl Lacquer");
  });
});
