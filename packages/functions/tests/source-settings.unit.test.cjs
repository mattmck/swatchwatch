/**
 * Source kinds (brand sources plan, Task 3; Polish Pickup retailer plan, Task 5): `data_source.metadata`
 * → `SourceSettings`, `sourceKindFromMetadata`, the SQL kind helpers and the listing write rules.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  readSourceSettings,
  sourceKindFromMetadata,
  sourceKindSql,
  isBrandSourceSql,
  catalogAuthorityForKind,
  sourceKindRank,
  sourceKindRankSql,
  SOURCE_KIND_RANK,
  planListingWrites,
  planIngestedFinishes,
} = require("../dist/lib/source-settings");

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

  it("does not store images for retailers and feeds unless permitted", () => {
    assert.equal(readSourceSettings({ kind: "retailer" }).imagesPermitted, false);
    assert.equal(readSourceSettings({ kind: "feed" }).imagesPermitted, false);
    assert.equal(readSourceSettings({ kind: "retailer", imagesPermitted: true }).imagesPermitted, true);
    assert.equal(readSourceSettings({ kind: "brand", imagesPermitted: false }).imagesPermitted, false);
  });

  it("reads the kind", () => {
    assert.equal(readSourceSettings({ kind: "retailer" }).kind, "retailer");
    assert.equal(readSourceSettings({ kind: "feed" }).kind, "feed");
    assert.equal(readSourceSettings({ kind: "brand" }).kind, "brand");
    assert.equal(readSourceSettings({ kind: "" }).kind, "brand");
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
  it("normalizes the source kind and refuses an unknown one", () => {
    assert.equal(readSourceSettings({ kind: " Retailer " }).kind, "retailer");
    assert.equal(readSourceSettings({ kind: "FEED" }).kind, "feed");
    assert.equal(readSourceSettings({}).kind, "brand", "a missing kind is a brand source");
    assert.throws(() => readSourceSettings({ kind: "wholesale" }), /Unknown source kind "wholesale"/);
    assert.throws(
      () => readSourceSettings({ kind: "wholesale" }, "BeyondPolishShopify"),
      /Unknown source kind "wholesale" in data_source\.metadata\.kind of BeyondPolishShopify/
    );
    assert.throws(() => readSourceSettings({ kind: 3 }), /Unknown source kind/);
  });

  it("ignores the old sourceKind key (only metadata.kind names the kind)", () => {
    assert.equal(readSourceSettings({ sourceKind: "retailer" }).kind, "brand");
  });
});

describe("sourceKindFromMetadata", () => {
  it("reads metadata.kind like readSourceKind", () => {
    assert.equal(sourceKindFromMetadata({ kind: "retailer" }), "retailer");
    assert.equal(sourceKindFromMetadata({ kind: " RETAILER " }), "retailer");
    assert.equal(sourceKindFromMetadata({ kind: "feed" }), "feed");
  });
  for (const [label, value] of [
    ["empty object", {}],
    ["null", null],
    ["undefined", undefined],
    ["bare string", "retailer"],
    ["explicit brand", { kind: "brand" }],
    ["unknown kind (never throws on a read path)", { kind: "wholesale" }],
    ["non-string kind", { kind: 3 }],
  ]) {
    it(`is brand for ${label}`, () => {
      assert.equal(sourceKindFromMetadata(value), "brand");
    });
  }
});

describe("source kind SQL", () => {
  it("normalizes metadata.kind like sourceKindFromMetadata", () => {
    assert.equal(sourceKindSql("ds.metadata"), "COALESCE(NULLIF(lower(btrim(ds.metadata ->> 'kind')), ''), 'brand')");
    assert.equal(
      isBrandSourceSql("metadata"),
      "COALESCE(NULLIF(lower(btrim(metadata ->> 'kind')), ''), 'brand') NOT IN ('retailer', 'feed')"
    );
  });
  it("ranks brand, then feed, then retailer, in JS and SQL alike (buy links, description text)", () => {
    assert.deepEqual(SOURCE_KIND_RANK, { brand: 0, feed: 1, retailer: 2 });
    assert.equal(sourceKindRank(" Feed "), 1);
    assert.equal(sourceKindRank("retailer"), 2);
    assert.equal(sourceKindRank("wholesale"), 0, "unknown ranks as brand");
    assert.equal(sourceKindRank(null), 0);
    assert.equal(
      sourceKindRankSql("ds.metadata"),
      "CASE COALESCE(NULLIF(lower(btrim(ds.metadata ->> 'kind')), ''), 'brand') WHEN 'retailer' THEN 2 WHEN 'feed' THEN 1 ELSE 0 END"
    );
  });

  it("maps kinds to catalog authorities", () => {
    assert.equal(catalogAuthorityForKind("brand"), "brand_store");
    assert.equal(catalogAuthorityForKind("retailer"), "retailer");
    assert.equal(catalogAuthorityForKind("feed"), "retailer");
  });
});

describe("planListingWrites", () => {
  const sourceKinds = ["brand", "retailer", "feed"];
  const authorities = ["brand_store", "retailer"];
  const bools = [true, false];
  const ALL = { writeCategory: true, linkGallery: true, runDetection: true, fillOnly: false };

  for (const sourceKind of sourceKinds)
    for (const shadeAuthority of authorities)
      for (const shadeHasForeignProductImage of bools)
        for (const shadeHasDetectedHex of bools) {
          const base = { sourceKind, shadeAuthority, shadeHasForeignProductImage, shadeHasDetectedHex };
          const label = JSON.stringify(base);

          it(`shade created by the listing: all writes, authority from the source kind ${label}`, () => {
            assert.deepEqual(planListingWrites({ ...base, shadeCreated: true }), {
              ...ALL,
              takeOver: false,
              setAuthority: sourceKind === "brand" ? "brand_store" : "retailer",
            });
          });

          if (sourceKind === "brand" && shadeAuthority === "retailer") {
            it(`brand store on a retailer shade takes over ${label}`, () => {
              assert.deepEqual(planListingWrites({ ...base, shadeCreated: false }), {
                ...ALL,
                takeOver: true,
                setAuthority: "brand_store",
              });
            });
          } else if (sourceKind === "brand") {
            it(`brand store on a brand_store shade keeps today's behavior ${label}`, () => {
              assert.deepEqual(planListingWrites({ ...base, shadeCreated: false }), {
                ...ALL,
                takeOver: false,
                setAuthority: null,
              });
            });
          } else if (shadeAuthority === "retailer") {
            it(`${sourceKind} on a retailer shade writes like an owner, but never replaces a hex or another source's image ${label}`, () => {
              assert.deepEqual(planListingWrites({ ...base, shadeCreated: false }), {
                writeCategory: true,
                linkGallery: !shadeHasForeignProductImage,
                runDetection: !shadeHasDetectedHex,
                fillOnly: false,
                takeOver: false,
                setAuthority: null,
              });
            });
          } else {
            it(`${sourceKind} on a brand_store shade only fills gaps ${label}`, () => {
              assert.deepEqual(planListingWrites({ ...base, shadeCreated: false }), {
                writeCategory: false,
                linkGallery: !shadeHasForeignProductImage,
                runDetection: !shadeHasDetectedHex,
                fillOnly: true,
                takeOver: false,
                setAuthority: null,
              });
            });
          }
        }
});

describe("planIngestedFinishes", () => {
  const base = { current: ["Cream"], adminSet: false, takeOver: false, restrictedRetailer: false, fromEmpty: ["Shimmer"], merged: ["Cream", "Shimmer"] };
  it("merges for an unrestricted listing", () => {
    assert.deepEqual(planIngestedFinishes(base), ["Cream", "Shimmer"]);
  });
  it("keeps an admin list", () => {
    assert.deepEqual(planIngestedFinishes({ ...base, adminSet: true, takeOver: true }), ["Cream"]);
  });
  it("replaces on takeover, keeping current when nothing resolves", () => {
    assert.deepEqual(planIngestedFinishes({ ...base, takeOver: true }), ["Shimmer"]);
    assert.deepEqual(planIngestedFinishes({ ...base, takeOver: true, fromEmpty: null }), ["Cream"]);
  });
  it("restricted retailer keeps a non-empty list", () => {
    assert.deepEqual(planIngestedFinishes({ ...base, restrictedRetailer: true }), ["Cream"]);
  });
  it("restricted retailer fills an empty list", () => {
    assert.deepEqual(planIngestedFinishes({ ...base, current: [], restrictedRetailer: true }), ["Shimmer"]);
    assert.deepEqual(planIngestedFinishes({ ...base, current: [], restrictedRetailer: true, fromEmpty: null }), []);
  });
});
