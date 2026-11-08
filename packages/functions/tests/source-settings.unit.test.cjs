/**
 * Source kinds (brand sources plan, Task 3): `data_source.metadata` → `SourceSettings`.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { readSourceSettings } = require("../dist/lib/source-settings");

const DEFAULTS = {
  kind: "brand",
  imagesPermitted: true,
  includeGel: false,
  vendorAliases: {},
  currency: null,
  brand: null,
  maxPages: null,
  feedUrl: null,
  feedAuthEnv: null,
  sitemapUrl: null,
  productUrlPrefixes: [],
  subdomain: null,
};

describe("readSourceSettings", () => {
  it("defaults to a brand source that may store images", () => {
    assert.deepEqual(readSourceSettings({}), DEFAULTS);
    assert.deepEqual(readSourceSettings(null), DEFAULTS);
    assert.deepEqual(readSourceSettings(undefined), DEFAULTS);
    assert.deepEqual(readSourceSettings("not an object"), DEFAULTS);
  });

  it("does not store images for resellers and feeds unless permitted", () => {
    assert.equal(readSourceSettings({ sourceKind: "reseller" }).imagesPermitted, false);
    assert.equal(readSourceSettings({ sourceKind: "feed" }).imagesPermitted, false);
    assert.equal(readSourceSettings({ sourceKind: "reseller", imagesPermitted: true }).imagesPermitted, true);
    assert.equal(readSourceSettings({ sourceKind: "brand", imagesPermitted: false }).imagesPermitted, false);
  });

  it("reads the kind, falling back to brand for unknown values", () => {
    assert.equal(readSourceSettings({ sourceKind: "reseller" }).kind, "reseller");
    assert.equal(readSourceSettings({ sourceKind: "feed" }).kind, "feed");
    assert.equal(readSourceSettings({ sourceKind: "marketplace" }).kind, "brand");
    assert.equal(readSourceSettings({ sourceKind: 3 }).kind, "brand");
  });

  it("lower-cases vendor alias keys and drops non-string values", () => {
    assert.deepEqual(readSourceSettings({ vendorAliases: { ORLY: "Orly" } }).vendorAliases, { orly: "Orly" });
    assert.deepEqual(
      readSourceSettings({ vendorAliases: { " Zoya Nail ": "Zoya", Bad: 3, Empty: " " } }).vendorAliases,
      { "zoya nail": "Zoya" }
    );
    assert.deepEqual(readSourceSettings({ vendorAliases: ["ORLY"] }).vendorAliases, {});
  });

  it("reads currency, brand, includeGel and maxPages", () => {
    const settings = readSourceSettings({ currency: "CAD", brand: " Lights Lacquer ", includeGel: true, maxPages: 40 });
    assert.equal(settings.currency, "CAD");
    assert.equal(settings.brand, "Lights Lacquer");
    assert.equal(settings.includeGel, true);
    assert.equal(settings.maxPages, 40);
    assert.equal(readSourceSettings({ includeGel: "true" }).includeGel, false);
    for (const maxPages of [0, -2, 1.5, "10", null]) {
      assert.equal(readSourceSettings({ maxPages }).maxPages, null, `maxPages ${maxPages}`);
    }
  });

  it("reads the connector keys as-is", () => {
    const settings = readSourceSettings({
      feedUrl: "https://feeds.example/products.xml",
      feedAuthEnv: "EXAMPLE_FEED_TOKEN",
      sitemapUrl: "https://shop.example/sitemap.xml",
      productUrlPrefixes: ["https://shop.example/products/", 7],
      subdomain: "example",
    });
    assert.equal(settings.feedUrl, "https://feeds.example/products.xml");
    assert.equal(settings.feedAuthEnv, "EXAMPLE_FEED_TOKEN");
    assert.equal(settings.sitemapUrl, "https://shop.example/sitemap.xml");
    assert.deepEqual(settings.productUrlPrefixes, ["https://shop.example/products/"]);
    assert.equal(settings.subdomain, "example");
  });
});
