/**
 * Beyond Polish (brand sources plan, Task 7): the retailer connector run over a trimmed
 * beyondpolish.com/products.json (fetched 2026-11-08, 247 of 17,508 products) and then through the
 * materializer with a fake database (as in ingestion-repo-adopt-existing.unit.test.cjs): a retailer
 * source with images off stores no image, writes no inventory, and on a second run over a shade a
 * brand store owns keeps its vendor hex, finishes and category.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

delete process.env.AZURE_STORAGE_CONNECTION;

function mockDistModule(relativePath, exports) {
  const resolved = path.resolve(__dirname, "../dist/lib", relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ---------------------------------------------------------------------------
// Fake database
// ---------------------------------------------------------------------------

let calls;
// Brands that exist (lower-cased name → id); a missing brand is inserted.
let brands;
// Shades of brand 1: { shadeId, name, finish, collection, finishes, status, mergedInto,
// authority (`catalog_authority`, default brand_store), brandListed (a brand-source listing points
// at it; set when a run writes a listing), adminCategory, vendorHex, detectedHex, detectedFinishes }.
let shades;
// Existing source_product swatches by shade id: { swatchId, imageId, ownerId } (ownerId = the
// data source whose image_asset it is).
let productSwatches;
let blobCalls;
let nextShadeId;
// Active, unmerged shades this (data source, external id) is already linked to (shade_source_product).
let listings;
// Rows of the pre-detection lookups (admin category, unchanged image) when they resolve the shade
// through the listing.
let adminCategoryRows;
let unchangedRows;

function sqlOf(text) {
  return text.replace(/\s+/g, " ").trim();
}

const transactionClient = {
  async query(text, params = []) {
    const sql = sqlOf(text);
    calls.push({ sql, params });

    if (sql.startsWith("SELECT DISTINCT ssp.shade_id")) {
      // Lookup step 0: the product's own listings (honour a status filter when the SQL has one).
      assert.equal(params[0], 7, "data source id");
      if (params[1] !== "r1") return { rows: [] };
      const activeOnly = sql.includes("sh.status = 'active'");
      return {
        rows: listings
          .filter((shadeId) => !activeOnly || (shades.find((s) => s.shadeId === shadeId)?.status ?? "active") === "active")
          .map((shadeId) => ({ shadeId })),
      };
    }
    if (sql.startsWith("SELECT 1 FROM shade WHERE shade_id = $1 AND merged_into_shade_id IS NULL")) {
      // The materializer re-checks a pre-resolved shade.
      const shade = shades.find((s) => s.shadeId === params[0]);
      const exists = shade ? !shade.mergedInto : listings.includes(params[0]);
      return { rows: exists ? [{ "?column?": 1 }] : [] };
    }
    if (sql.includes("shade_id = ANY($1::bigint[])") && sql.includes("product_category_source = 'admin'")) {
      // Admin categories of pre-resolved shades.
      const rows = shades
        .filter((s) => params[0].map(Number).includes(s.shadeId) && s.adminCategory)
        .map((s) => ({ shadeId: s.shadeId, productCategory: s.adminCategory }));
      return { rows };
    }
    if (sql.includes("FROM brand")) {
      const id = brands[String(params[0]).toLowerCase()];
      return { rows: id ? [{ brandId: id }] : [] };
    }
    if (sql.startsWith("INSERT INTO brand")) {
      return { rows: [{ brandId: 50 }] };
    }
    if (sql.includes("FROM shade") && sql.includes("coalesce(finish, '') = coalesce($3, '')")) {
      // Exact identity match: brand + name + legacy finish + collection.
      const found = shades.find(
        (s) =>
          s.name.toLowerCase() === String(params[1]).toLowerCase() &&
          (s.finish ?? "") === (params[2] ?? "") &&
          (s.collection ?? "") === (params[3] ?? "")
      );
      return { rows: found ? [{ shadeId: found.shadeId }] : [] };
    }
    if (sql.includes("FROM shade") && sql.includes("merged_into_shade_id IS NULL") && sql.includes("status IN ('active', 'excluded')")) {
      // Same-name candidates; honour the brand-source filters when the SQL carries them.
      const brandOnly = sql.includes("finish IS NULL AND collection IS NULL");
      const retailerOnly = sql.includes("catalog_authority = 'retailer'");
      const rows = shades
        .filter((s) => s.name.toLowerCase() === String(params[1]).toLowerCase())
        .filter((s) => ["active", "excluded"].includes(s.status ?? "active") && !s.mergedInto)
        .filter((s) => !brandOnly || (s.finish === null && s.collection === null))
        .filter((s) => !retailerOnly || s.authority === "retailer")
        // Brand step 2 also requires that no brand listing points at the shade.
        .filter((s) => !sql.includes("kssp.shade_id = shade.shade_id") || !s.brandListed)
        .map((s) => ({ shadeId: s.shadeId, finishes: s.finishes }));
      return { rows };
    }
    if (sql.startsWith("INSERT INTO shade ")) {
      return { rows: [{ shadeId: nextShadeId++ }] };
    }
    if (sql.startsWith("INSERT INTO shade_source_product")) {
      // Every listing a test writes comes from the run's source; only brand runs read this flag.
      const shade = shades.find((s) => s.shadeId === params[0]);
      if (shade) shade.brandListed = true;
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE shade SET color_name")) {
      // $16: the catalog_authority this write sets (a brand takeover flips it to brand_store).
      const shade = shades.find((s) => s.shadeId === params[0]);
      if (shade && params[15]) shade.authority = params[15];
      return { rows: [] };
    }
    if (sql.includes("WHERE sh.shade_id = ANY($1::bigint[]) AND sh.detected_hex IS NOT NULL")) {
      // Retailer/feed AI skip: resolved shades that already have a detected hex.
      const ids = params[0].map(Number);
      return { rows: shades.filter((s) => ids.includes(s.shadeId) && s.detectedHex).map((s) => ({ shadeId: s.shadeId })) };
    }
    if (sql.includes("FROM shade WHERE shade_id = $1 FOR UPDATE")) {
      const shade = shades.find((s) => s.shadeId === params[0]);
      return {
        rows: [
          {
            finishes: shade?.finishes ?? [],
            finishesSource: null,
            vendorHex: shade?.vendorHex ?? null,
            vendorHexSource: shade?.vendorHex ? "vendor" : null,
            vendorHexPrevious: null,
            detectedHex: shade?.detectedHex ?? null,
            detectedFinishes: shade?.detectedFinishes ?? null,
            catalogAuthority: shade?.authority ?? "brand_store",
          },
        ],
      };
    }
    if (sql.includes("FROM swatch sw") && sql.includes("JOIN image_asset ia") && sql.includes("'source_product'")) {
      // Source-kind gate: whose image is the shade's product swatch?
      const swatch = productSwatches[params[0]];
      return { rows: swatch ? [{ ownImage: swatch.ownerId === params[1] }] : [] };
    }
    if (sql.includes("FROM swatch") && sql.includes("swatch_type = 'source_product'")) {
      const swatch = productSwatches[params[0]];
      return { rows: swatch ? [{ swatchId: swatch.swatchId, imageIdOriginal: swatch.imageId }] : [] };
    }
    if (sql.includes("FROM image_asset") && sql.includes("checksum_sha256 = $2")) {
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO image_asset")) {
      return { rows: [{ imageId: 700 }] };
    }
    return { rows: [] };
  },
};

// Finish catalog: the built-ins with their families, plus a finish that has no family.
const { CANONICAL_FINISHES, DUPE_FINISH_FAMILIES } = require("swatchwatch-shared");
const finishTypeRows = [
  ...CANONICAL_FINISHES.map((name) => ({ kind: "type", sourceValue: name, normalizedFinishName: name, family: DUPE_FINISH_FAMILIES[name] ?? null })),
  { kind: "type", sourceValue: "magnetic-flakie", normalizedFinishName: "magnetic-flakie", family: null },
];

mockDistModule("db.js", {
  query: async (text, params) => {
    const sql = sqlOf(text);
    if (sql.includes("FROM finish_type")) return { rows: finishTypeRows };
    // The pre-detection lookups must resolve the shade through the listing first.
    if (sql.includes("product_category_source = 'admin'") && sql.includes("unnest(")) {
      assert.equal(params[5], 7, "data source id");
      return { rows: sql.includes("FROM shade_source_product ssp") ? adminCategoryRows : [] };
    }
    if (sql.includes("WHERE sh.detected_hex IS NOT NULL")) {
      assert.equal(params[0], 7, "data source id");
      return { rows: sql.includes("FROM shade_source_product ssp") ? unchangedRows : [] };
    }
    // Resolution before detection runs the materializer's lookups outside the transaction.
    return transactionClient.query(text, params);
  },
  transaction: async (callback) => callback(transactionClient),
});

mockDistModule("blob-storage.js", {
  ensureContainer: async (...args) => {
    blobCalls.push({ fn: "ensureContainer", args });
  },
  uploadSourceImageToBlob: async ({ sourceImageUrl }) => {
    blobCalls.push({ fn: "uploadSourceImageToBlob", sourceImageUrl });
    return { storageUrl: `https://blob.example/${encodeURIComponent(sourceImageUrl)}`, checksumSha256: `sum-${sourceImageUrl}` };
  },
});

let aiCalls;
let aiFinishes;
mockDistModule("ai-color-detection.js", {
  detectHexWithAzureOpenAI: async () => {
    aiCalls += 1;
    return { hex: "#112233", finishes: aiFinishes, confidence: 0.9 };
  },
});

let batchSubmissions;
mockDistModule("azure-openai-batch.js", {
  submitVisionHexBatch: async (requests) => {
    batchSubmissions.push(requests);
    return { batchId: "b1", inputFileId: "f1", requestCount: requests.length, submittedAt: "now", deployment: "d", promptVersion: "p" };
  },
});

const { materializeHoloTacoRecords } = require("../dist/lib/ingestion-repo");
const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");
const { readSourceSettings } = require("../dist/lib/source-settings");


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BEYOND = require("./fixtures/beyond-polish-pull-products.json").products;
const METADATA = {
  kind: "retailer",
  currency: "USD",
  includeGel: false,
  maxPages: 100,
  vendorAliases: {
    ORLY: "Orly",
    Lippmann: "Deborah Lippmann",
    "Sunday Studio": "Sundays",
    "DND - Daisy Nail Design": "DND",
    Harmony: "Gelish",
    "ella+mila": "Ella+Mila",
    "butter LONDON": "butter LONDON",
  },
};

async function pullFixture(metadata) {
  const settings = readSourceSettings(metadata, "BeyondPolishShopify");
  const connector = new ShopifyGenericConnector("BeyondPolishShopify", "https://www.beyondpolish.com", {
    currency: "USD",
    settings,
  });
  return connector.pullProducts({
    searchTerm: "",
    page: 1,
    pageSize: 1000,
    maxRecords: 1000,
    catalogCache: { load: async () => BEYOND, save: async () => {} },
  });
}

// Options as ingestion.ts derives them from the source settings (imagesPermitted is unset, so false).
function jobOptions(settings) {
  return {
    sourceKind: settings.kind,
    sourceName: "BeyondPolishShopify",
    storeImages: settings.imagesPermitted,
    overwriteDetectedHex: false,
    detectHexFromImage: true,
  };
}

const shadeInserts = () => calls.filter((c) => c.sql.startsWith("INSERT INTO shade "));
const catalogUpdates = () => calls.filter((c) => c.sql.startsWith("UPDATE shade SET color_name"));
const categoryUpdates = () => calls.filter((c) => c.sql.startsWith("UPDATE shade SET product_category"));
const uploads = () => blobCalls.filter((c) => c.fn === "uploadSourceImageToBlob");

let originalFetch;
let originalEndpoint;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_ENDPOINT; // keep color-name detection offline
  calls = [];
  brands = { orly: 1, "deborah lippmann": 2 };
  shades = [];
  productSwatches = {};
  blobCalls = [];
  aiCalls = 0;
  aiFinishes = [];
  batchSubmissions = [];
  nextShadeId = 100;
  listings = [];
  adminCategoryRows = [];
  unchangedRows = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEndpoint !== undefined) process.env.AZURE_OPENAI_ENDPOINT = originalEndpoint;
  else delete process.env.AZURE_OPENAI_ENDPOINT;
});

describe("BeyondPolishShopify — connector over the fixture", () => {
  it("reads 159 single-shade lacquers under their brands, with the alias map applied", async () => {
    const result = await pullFixture(METADATA);
    assert.equal(result.metadata.fetchedProductCount, 247);
    assert.equal(result.records.length, 159);
    const byBrand = {};
    for (const r of result.records) byBrand[r.normalized.brand] = (byBrand[r.normalized.brand] ?? 0) + 1;
    // ORLY -> Orly, Sunday Studio -> Sundays, Lippmann and Deborah Lippmann -> one brand,
    // ella+mila -> Ella+Mila; the rest keep their vendor spelling.
    assert.deepEqual(byBrand, {
      OPI: 8, Zoya: 8, Orly: 8, "Cirque Colors": 8, KBShimmer: 8, "Morgan Taylor": 8, CND: 8,
      "Ella+Mila": 8, Londontown: 8, Essie: 8, "China Glaze": 8, "Color Club": 8, "butter LONDON": 8,
      "Loud Lacquer": 8, Sundays: 8, "Cracked Polish": 8, "Deborah Lippmann": 15, "Static Nails": 8,
      Peacci: 8,
    });
  });

  it("parses the shade names out of the titles (no brand, line, size or code left in)", async () => {
    const { records } = await pullFixture(METADATA);
    const shadeOf = (title) => records.find((r) => r.normalized.rawTitle === title)?.normalized.name;
    assert.equal(shadeOf("Zoya - Laurie .5 oz. - #ZP433"), "Laurie");
    assert.equal(shadeOf("Londontown - Lakur Enhanced Colour - Pecan Pie 0.4 oz"), "Pecan Pie");
    assert.equal(shadeOf("butter LONDON - Patent Shine - Garden Party - 10X Nail Lacquer"), "Garden Party");
    assert.equal(shadeOf("Sundays - Nail Polish - No. 49"), "No. 49");
    assert.equal(shadeOf("Lippmann - Modern Love"), "Modern Love");
    for (const r of records) {
      const name = r.normalized.name;
      assert.ok(name && !/ - /.test(name) && !/\b\d*\.?\d+\s*oz\b/i.test(name) && !/#[A-Z0-9]+$/.test(name), name);
    }
  });

  it("reads the same 159 records twice and skips the Beyond Polish house vendor", async () => {
    const first = await pullFixture(METADATA);
    const second = await pullFixture(METADATA);
    assert.deepEqual(second.records.map((r) => r.externalId), first.records.map((r) => r.externalId));
    assert.ok(first.records.every((r) => r.normalized.brand !== "Beyond Polish"));
  });

  it("takes the 5 plain Gel Polish listings only with includeGel", async () => {
    const withGel = await pullFixture({ ...METADATA, includeGel: true });
    assert.equal(withGel.records.length, 164);
  });
});

describe("BeyondPolishShopify — materialization with images off", () => {
  it("creates brand and shade rows, stores no image, runs no AI and writes no inventory", async () => {
    const { records } = await pullFixture(METADATA);
    assert.ok(records.some((r) => r.normalized.imageUrls.length > 0), "the fixture has product images");

    const metrics = await materializeHoloTacoRecords(7, records, jobOptions(readSourceSettings(METADATA)), "[Test]");

    assert.equal(uploads().length, 0, "no image uploads");
    assert.equal(blobCalls.length, 0, "no storage calls at all");
    assert.equal(aiCalls, 0, "no AI hex detection without stored images");
    assert.equal(batchSubmissions.length, 0);
    assert.equal(calls.filter((c) => /user_inventory_item|inventory_event/.test(c.sql)).length, 0, "ingestion never writes inventory");
    assert.equal(calls.filter((c) => c.sql.includes("INSERT INTO image_asset") || c.sql.startsWith("INSERT INTO swatch")).length, 0);
    assert.equal(metrics.shadesCreated, shadeInserts().length);
    assert.equal(shadeInserts().length, 159);
  });

  it("keeps an adopted brand shade's vendor hex, finishes and category on the first and the second run", async () => {
    const { records } = await pullFixture(METADATA);
    const orly = records.find((r) => r.normalized.brand === "Orly");
    assert.ok(orly);
    orly.normalized.vendorHex = "#222222";
    orly.externalId = "r1";
    const options = jobOptions(readSourceSettings(METADATA));
    // A brand store's shade: legacy finish identity, a collection, a vendor hex, creme finishes.
    shades = [{ shadeId: 11, name: orly.normalized.name, finish: "creme", collection: "Fall 2025", finishes: ["creme"], vendorHex: "#111111" }];

    // First run: adopted by name and finish family (the retailer tags creme too; a retailer's finishes come from its tags).
    orly.normalized.tags = ["creme"];
    await materializeHoloTacoRecords(7, [orly], options, "[Test]");
    // Second run: the listing exists now and the retailer tags another finish.
    listings = [11];
    orly.normalized.tags = ["shimmer"];
    await materializeHoloTacoRecords(7, [orly], options, "[Test]");

    assert.equal(shadeInserts().length, 0, "no new shade row on either run");
    const updates = catalogUpdates();
    assert.equal(updates.length, 2);
    for (const update of updates) {
      assert.equal(update.params[0], 11);
      assert.equal(update.params[2], "#111111", "vendor_hex unchanged");
      assert.deepEqual(update.params[7], ["creme"], "finishes unchanged");
    }
    assert.equal(categoryUpdates().length, 0, "category never re-classified");
    assert.equal(uploads().length, 0);
  });
});
