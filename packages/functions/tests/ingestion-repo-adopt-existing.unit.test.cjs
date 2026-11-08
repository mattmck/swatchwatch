/**
 * Source kinds (brand sources plan, Task 3): a retailer or feed record adopts the brand's
 * existing shade and only fills empty data; a brand record adopts (and takes over) a shade a
 * retailer created (`catalog_authority = 'retailer'`).
 * Fake `pg` client keyed on SQL text, as in ingestion-repo-swatch-linking.unit.test.cjs.
 */
const { describe, it, beforeEach } = require("node:test");
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function record({ brand = "Orly", name = "Velvet Dreams", finishes = [], collection = null, imageUrls = [], vendorHex = null } = {}) {
  return {
    externalId: "r1",
    raw: {},
    normalized: {
      brand,
      name,
      vendorHex,
      primaryImageUrl: imageUrls[0] ?? null,
      imageUrls,
      tags: finishes,
      collections: collection ? [collection] : [],
      finishes,
    },
  };
}

function logger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (message, data) => lines.info.push({ message, data }),
    warn: (message, data) => lines.warn.push({ message, data }),
    error: (message, data) => lines.error.push({ message, data }),
  };
}

const RETAILER = { sourceKind: "retailer", overwriteDetectedHex: false, storeImages: false, sourceName: "BeyondPolishShopify" };
const BRAND = { sourceKind: "brand", sourceName: "OrlyShopify" };

function materialize(rec, options) {
  return materializeHoloTacoRecords(7, [rec], { detectHexFromImage: false, ...options }, "[Test]");
}

const shadeInserts = () => calls.filter((c) => c.sql.startsWith("INSERT INTO shade "));
const brandInserts = () => calls.filter((c) => c.sql.startsWith("INSERT INTO brand"));
const sourceProductInserts = () => calls.filter((c) => c.sql.startsWith("INSERT INTO shade_source_product"));
const aliasInserts = () => calls.filter((c) => c.sql.startsWith("INSERT INTO shade_alias"));
const catalogUpdates = () => calls.filter((c) => c.sql.startsWith("UPDATE shade SET color_name"));

beforeEach(() => {
  calls = [];
  brands = { orly: 1, "holo taco": 2 };
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

// ---------------------------------------------------------------------------
// Retailer / feed sources
// ---------------------------------------------------------------------------

describe("materializeHoloTacoRecords — retailer source adopts the brand's shade", () => {
  it("adds the vendor code and the raw listing title as aliases of the shade", async () => {
    shades = [{ shadeId: 11, name: "Big Apple Red", finish: "creme", collection: null, finishes: ["creme"] }];
    const rec = record({ name: "Big Apple Red", finishes: ["creme"] });
    rec.normalized.vendorCode = "NLB83";
    rec.normalized.listingTitle = "OPI - Big Apple Red #NLB83";

    await materialize(rec, RETAILER);

    const aliases = aliasInserts();
    assert.deepEqual(aliases.map((c) => [c.params[0], c.params[1]]), [
      [11, "NLB83"],
      [11, "OPI - Big Apple Red #NLB83"],
    ]);
    assert.ok(aliases.every((c) => c.sql.includes("ON CONFLICT DO NOTHING")));
  });

  it("adds no alias for a record without a code, and never one equal to the shade name", async () => {
    shades = [{ shadeId: 11, name: "Big Apple Red", finish: "creme", collection: null, finishes: ["creme"] }];
    await materialize(record({ name: "Big Apple Red", finishes: ["creme"] }), RETAILER);
    assert.equal(aliasInserts().length, 0);

    const rec = record({ name: "Big Apple Red", finishes: ["creme"] });
    rec.normalized.vendorCode = "  ";
    rec.normalized.listingTitle = " big apple red ";
    await materialize(rec, RETAILER);
    assert.equal(aliasInserts().length, 0);
  });

  it("adopts the one same-name shade and writes fill-only", async () => {
    shades = [{ shadeId: 11, name: "Velvet Dreams", finish: "creme", collection: "Fall 2025", finishes: ["creme"] }];

    const metrics = await materialize(record({ finishes: ["creme"] }), RETAILER);

    assert.equal(shadeInserts().length, 0);
    assert.equal(metrics.shadesCreated, 0);
    assert.equal(sourceProductInserts().length, 1);
    assert.equal(sourceProductInserts()[0].params[0], 11);
    const [update] = catalogUpdates();
    assert.equal(update.params[0], 11);
    assert.equal(update.params[5], false, "overwriteDetectedHex");
  });

  it("disambiguates several same-name shades by finish family", async () => {
    shades = [
      { shadeId: 21, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] },
      { shadeId: 22, name: "Velvet Dreams", finish: "holo", collection: null, finishes: ["holographic"] },
    ];

    await materialize(record({ finishes: ["holographic"] }), RETAILER);

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 22);
  });

  it("skips the record and warns when the finish cannot decide", async () => {
    shades = [
      { shadeId: 21, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] },
      { shadeId: 22, name: "Velvet Dreams", finish: "holo", collection: null, finishes: ["holographic"] },
    ];
    const log = logger();

    const metrics = await materialize(record({ finishes: [] }), { ...RETAILER, progressLogger: log });

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts().length, 0);
    assert.equal(metrics.shadesCreated, 0);
    assert.equal(metrics.skipped, 1);
    assert.equal(metrics.ambiguousShadesSkipped, 1);
    const warning = log.lines.warn.find((line) => Array.isArray(line.data?.candidateShadeIds));
    assert.ok(warning, "expected a warning naming the candidates");
    assert.deepEqual(warning.data.candidateShadeIds, [21, 22]);
    assert.equal(warning.data.brand, "Orly");
    assert.equal(warning.data.name, "Velvet Dreams");
  });

  it("skips the exact-match shortcut: a holographic listing never lands on a same-identity creme shade", async () => {
    // Retailer records carry no legacy finish or collection, like a retailer-created shade.
    shades = [{ shadeId: 51, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"] }];
    const log = logger();

    await materialize(record({ finishes: [] }), { ...RETAILER, progressLogger: log });
    assert.equal(shadeInserts().length, 0, "a record without finishes adopts the one candidate");

    calls = [];
    const retailer = record({ finishes: ["holographic"] });
    retailer.normalized.finishes = [];
    await materialize(retailer, { ...RETAILER, progressLogger: log });

    assert.equal(shadeInserts().length, 1);
    assert.ok(!calls.some((c) => c.sql.includes("coalesce(finish, '') = coalesce($3, '')")), "no exact-match lookup");
    const warning = log.lines.warn.find((line) => Array.isArray(line.data?.candidateShadeIds));
    assert.deepEqual(warning?.data.candidateShadeIds, [51]);
  });

  it("adopts a same-name shade that has no finishes yet", async () => {
    shades = [{ shadeId: 52, name: "Velvet Dreams", finish: null, collection: null, finishes: [] }];
    const retailer = record({ finishes: ["holographic"] });
    retailer.normalized.finishes = [];

    await materialize(retailer, RETAILER);

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 52);
  });

  it("does not penalize a finish without a family", async () => {
    shades = [{ shadeId: 53, name: "Velvet Dreams", finish: null, collection: null, finishes: ["magnetic-flakie"] }];
    const retailer = record({ finishes: ["magnetic-flakie"] });
    retailer.normalized.finishes = [];

    await materialize(retailer, RETAILER);

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 53);
  });

  it("never adopts a private or merged shade", async () => {
    shades = [
      { shadeId: 31, name: "Velvet Dreams", finish: "creme", collection: "Old", finishes: ["creme"], status: "user_submitted" },
      { shadeId: 32, name: "Velvet Dreams", finish: "jelly", collection: "Old", finishes: ["creme"], mergedInto: 5 },
    ];

    await materialize(record({ finishes: ["creme"] }), RETAILER);

    assert.equal(shadeInserts().length, 1);
  });

  it("adopts an admin-excluded shade instead of duplicating it", async () => {
    shades = [{ shadeId: 33, name: "Velvet Dreams", finish: "creme", collection: "Old", finishes: ["creme"], status: "excluded" }];

    await materialize(record({ finishes: ["creme"] }), RETAILER);

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 33);
  });

  it("leaves the brand's images alone on an adopted shade that already has a product swatch", async () => {
    shades = [{ shadeId: 11, name: "Velvet Dreams", finish: "creme", collection: "Fall 2025", finishes: ["creme"] }];
    // The product image is the brand store's (data source 3); this run is data source 7.
    productSwatches = { 11: { swatchId: 900, imageId: 901, ownerId: 3 } };

    await materialize(record({ finishes: ["creme"], imageUrls: ["https://retailer.example/a.png"] }), {
      ...RETAILER,
      storeImages: true,
    });

    assert.ok(!calls.some((c) => c.sql.startsWith("INSERT INTO swatch")), "no swatch inserted");
    assert.ok(!calls.some((c) => c.sql.startsWith("UPDATE swatch")), "no swatch repointed");
    assert.ok(!calls.some((c) => c.sql.startsWith("INSERT INTO image_asset")), "no image asset linked");
  });

  it("lets a retailer refresh a product image it stored itself", async () => {
    shades = [{ shadeId: 11, name: "Velvet Dreams", finish: "creme", collection: "Fall 2025", finishes: ["creme"] }];
    productSwatches = { 11: { swatchId: 900, imageId: 901, ownerId: 7 } };

    await materialize(record({ finishes: ["creme"], imageUrls: ["https://retailer.example/new.png"] }), {
      ...RETAILER,
      storeImages: true,
    });

    const swatchUpdate = calls.find((c) => c.sql.startsWith("UPDATE swatch"));
    assert.ok(swatchUpdate, "expected the product swatch to be repointed");
    assert.deepEqual(swatchUpdate.params, [900, 700]);
  });

  it("links a permitted retailer's image when the shade has none yet", async () => {
    shades = [{ shadeId: 11, name: "Velvet Dreams", finish: "creme", collection: "Fall 2025", finishes: ["creme"] }];

    await materialize(record({ finishes: ["creme"], imageUrls: ["https://retailer.example/a.png"] }), {
      ...RETAILER,
      storeImages: true,
    });

    const swatchInsert = calls.find((c) => c.sql.startsWith("INSERT INTO swatch"));
    assert.ok(swatchInsert, "expected a product swatch");
    assert.equal(swatchInsert.params[0], 11);
  });
});

describe("materializeHoloTacoRecords — storeImages: false", () => {
  it("neither uploads nor detects, and links no image", async () => {
    const metrics = await materializeHoloTacoRecords(
      7,
      [record({ finishes: ["creme"], imageUrls: ["https://retailer.example/a.png", "https://retailer.example/b.png"] })],
      { ...RETAILER, detectHexFromImage: true },
      "[Test]"
    );

    assert.deepEqual(blobCalls, []);
    assert.equal(aiCalls, 0);
    assert.equal(metrics.imageUploads, 0);
    assert.equal(metrics.hexDetected, 0);
    assert.ok(!calls.some((c) => c.sql.startsWith("INSERT INTO image_asset")));
    assert.ok(!calls.some((c) => c.sql.startsWith("INSERT INTO swatch")));
  });
});

// ---------------------------------------------------------------------------
// Brand sources
// ---------------------------------------------------------------------------

describe("materializeHoloTacoRecords — brand source", () => {
  it("adopts a shade a retailer created (no legacy finish, no collection) and keeps the overwrite flag", async () => {
    shades = [{ shadeId: 41, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"], authority: "retailer" }];

    await materialize(record({ finishes: ["creme"], collection: "Fall 2025" }), { ...BRAND, overwriteDetectedHex: true });

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 41);
    assert.equal(catalogUpdates()[0].params[5], true, "overwriteDetectedHex");
  });

  it("does not adopt a same-name shade that has a legacy finish", async () => {
    shades = [{ shadeId: 42, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] }];

    await materialize(record({ finishes: ["holographic"] }), BRAND);

    assert.equal(shadeInserts().length, 1);
  });

  it("still matches the exact identity first", async () => {
    shades = [
      { shadeId: 43, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] },
      { shadeId: 44, name: "Velvet Dreams", finish: null, collection: null, finishes: [] },
    ];

    await materialize(record({ finishes: ["creme"] }), BRAND);

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 43);
  });
});

// ---------------------------------------------------------------------------
// Records without a brand
// ---------------------------------------------------------------------------

describe("materializeHoloTacoRecords — records without a brand", () => {
  it("skips the record with a warning for any source but Holo Taco", async () => {
    const log = logger();

    const metrics = await materialize(record({ brand: "" }), { sourceName: "MooncatShopify", progressLogger: log });

    assert.equal(metrics.skipped, 1);
    assert.equal(brandInserts().length, 0);
    assert.equal(shadeInserts().length, 0);
    assert.ok(log.lines.warn.some((line) => line.data?.externalId === "r1"));
  });

  it("falls back to Holo Taco for the Holo Taco store and when no source is named", async () => {
    for (const options of [{ sourceName: "HoloTacoShopify" }, {}]) {
      calls = [];
      const metrics = await materialize(record({ brand: "" }), options);
      assert.equal(metrics.skipped, 0);
      const brandLookup = calls.find((c) => c.sql.includes("FROM brand"));
      assert.equal(brandLookup.params[0], "Holo Taco");
    }
  });
});

// ---------------------------------------------------------------------------
// Lookup step 0: the product's own listing
// ---------------------------------------------------------------------------

describe("materializeHoloTacoRecords — existing listing", () => {
  it("uses the shade the listing links, before the exact match", async () => {
    shades = [
      { shadeId: 40, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] },
      { shadeId: 41, name: "Velvet Dreams", finish: "holographic", collection: null, finishes: ["holographic"] },
    ];
    listings = [41];

    await materialize(record({ finishes: ["creme"] }), BRAND);

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 41);
    assert.ok(!calls.some((c) => c.sql.includes("coalesce(finish, '') = coalesce($3, '')")), "no exact-match lookup");
  });

  it("skips the record when several active shades are linked", async () => {
    listings = [41, 42];
    const log = logger();

    const metrics = await materialize(record({ finishes: ["creme"] }), { ...RETAILER, progressLogger: log });

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts().length, 0);
    assert.equal(metrics.skipped, 1);
    assert.equal(metrics.ambiguousShadesSkipped, 1);
    const warning = log.lines.warn.find((line) => Array.isArray(line.data?.candidateShadeIds));
    assert.deepEqual(warning?.data.candidateShadeIds, [41, 42]);
  });

  it("gates hex detection on the admin category of the listed (adopted) shade", async () => {
    shades = [{ shadeId: 41, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"], adminCategory: "topper" }];
    listings = [41];

    const metrics = await materializeHoloTacoRecords(
      7,
      [record({ finishes: ["creme"], collection: "Fall 2025", imageUrls: ["https://brand.example/a.png"] })],
      { ...BRAND, detectHexFromImage: true, overwriteDetectedHex: true },
      "[Test]"
    );

    assert.equal(aiCalls, 0, "no vision call for an admin topper");
    assert.equal(metrics.hexDetectionSkippedCategory, 1);
  });

  it("skips AI for the listed shade's unchanged image", async () => {
    shades = [{ shadeId: 41, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"] }];
    listings = [41];
    unchangedRows = [{ externalId: "r1" }];

    const metrics = await materializeHoloTacoRecords(
      7,
      [record({ finishes: ["creme"], collection: "Fall 2025", imageUrls: ["https://brand.example/a.png"] })],
      { ...BRAND, detectHexFromImage: true },
      "[Test]"
    );

    assert.equal(aiCalls, 0);
    assert.equal(metrics.hexDetectionSkippedUnchanged, 1);
  });
});

// ---------------------------------------------------------------------------
// Fix wave: strict fill-only adoption, brand regressions, resolution before detection
// ---------------------------------------------------------------------------

const categoryUpdates = () => calls.filter((c) => c.sql.startsWith("UPDATE shade SET product_category"));

describe("materializeHoloTacoRecords — adopting sources are strictly fill-only", () => {
  it("keeps the brand shade's finishes when the retailer tags another finish", async () => {
    shades = [{ shadeId: 11, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] }];
    listings = [11];

    await materialize(record({ finishes: ["shimmer"] }), RETAILER);

    const [update] = catalogUpdates();
    assert.equal(update.params[0], 11);
    assert.deepEqual(update.params[7], ["creme"], "finishes unchanged");
  });

  it("fills the finishes of a brand shade that has none", async () => {
    shades = [{ shadeId: 12, name: "Velvet Dreams", finish: null, collection: null, finishes: [] }];

    await materialize(record({ finishes: ["shimmer"] }), RETAILER);

    const [update] = catalogUpdates();
    assert.equal(update.params[0], 12);
    assert.deepEqual(update.params[7], ["shimmer"]);
  });

  it("leaves detected_finishes alone when the shade has them", async () => {
    shades = [{ shadeId: 13, name: "Velvet Dreams", finish: null, collection: null, finishes: [], detectedFinishes: ["shimmer"] }];
    aiFinishes = ["glitter"];

    await materializeHoloTacoRecords(
      7,
      [record({ finishes: [], imageUrls: ["https://retailer.example/a.png"] })],
      { ...RETAILER, storeImages: true, detectHexFromImage: true },
      "[Test]"
    );

    assert.equal(aiCalls, 1);
    const [update] = catalogUpdates();
    assert.equal(update.params[4], null, "no detected finishes sent for a shade that has some");
  });

  it("fills detected_finishes on a shade that has none", async () => {
    shades = [{ shadeId: 14, name: "Velvet Dreams", finish: null, collection: null, finishes: [] }];
    aiFinishes = ["glitter"];

    await materializeHoloTacoRecords(
      7,
      [record({ finishes: [], imageUrls: ["https://retailer.example/a.png"] })],
      { ...RETAILER, storeImages: true, detectHexFromImage: true },
      "[Test]"
    );

    const [update] = catalogUpdates();
    assert.deepEqual(update.params[4], ["glitter"]);
  });

  it("never re-classifies an adopted shade's product category", async () => {
    shades = [{ shadeId: 15, name: "Velvet Dreams Top Coat", finish: "creme", collection: null, finishes: ["creme"] }];

    await materialize(record({ name: "Velvet Dreams Top Coat", finishes: ["creme"] }), RETAILER);

    assert.equal(catalogUpdates()[0].params[0], 15);
    assert.equal(categoryUpdates().length, 0);
  });

  it("keeps the shade's existing vendor hex", async () => {
    shades = [{ shadeId: 16, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"], vendorHex: "#111111" }];

    await materialize(record({ finishes: ["creme"], vendorHex: "#222222" }), RETAILER);

    const [update] = catalogUpdates();
    assert.equal(update.params[2], "#111111", "planned vendor_hex keeps the existing value");
  });

  it("a brand source takes a retailer-created shade over: its own finishes, category and authority", async () => {
    shades = [{ shadeId: 17, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"], authority: "retailer" }];
    listings = [17];

    await materialize(record({ finishes: ["shimmer"] }), BRAND);

    const [update] = catalogUpdates();
    assert.equal(update.params[0], 17);
    // Takeover (planListingWrites): the brand's own resolution replaces the retailer's finishes.
    assert.deepEqual([...update.params[7]], ["shimmer"]);
    assert.equal(categoryUpdates().length, 1);
    assert.equal(update.params[15], "brand_store", "catalog_authority flips (no detection pending)");
    assert.equal(shades[0].authority, "brand_store");
  });

  it("a brand source still merges finishes on a shade it owns", async () => {
    shades = [{ shadeId: 18, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"] }];
    listings = [18];

    await materialize(record({ finishes: ["shimmer"] }), BRAND);

    const [update] = catalogUpdates();
    assert.equal(update.params[0], 18);
    assert.deepEqual([...update.params[7]].sort(), ["creme", "shimmer"]);
    assert.equal(update.params[15], null, "authority unchanged");
    assert.equal(categoryUpdates().length, 1);
  });
});

describe("materializeHoloTacoRecords — no regression for brand sources", () => {
  it("a brand source with several listings falls back to the exact identity", async () => {
    shades = [
      { shadeId: 43, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] },
      { shadeId: 44, name: "Velvet Dreams", finish: "jelly", collection: null, finishes: ["jelly"] },
    ];
    listings = [43, 44];

    const metrics = await materialize(record({ finishes: ["creme"] }), BRAND);

    assert.equal(metrics.skipped, 0);
    assert.equal(metrics.ambiguousShadesSkipped, 0);
    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 43);
  });

  it("a brand source with several listings skips the record when its exact identity is not one of them", async () => {
    shades = [
      { shadeId: 43, name: "Velvet Dreams", finish: "jelly", collection: null, finishes: ["jelly"] },
      { shadeId: 44, name: "Velvet Dreams", finish: "crelly", collection: null, finishes: ["crelly"] },
      // The exact identity match, but not linked to this product.
      { shadeId: 49, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] },
    ];
    listings = [43, 44];
    const log = logger();

    const metrics = await materialize(record({ finishes: ["creme"] }), { ...BRAND, progressLogger: log });

    assert.equal(metrics.skipped, 1);
    assert.equal(metrics.ambiguousShadesSkipped, 1);
    assert.equal(shadeInserts().length, 0, "no new shade");
    assert.equal(sourceProductInserts().length, 0, "never a third link");
    assert.equal(catalogUpdates().length, 0);
    const warning = log.lines.warn.find((line) => /Skipped record r1/.test(line.message));
    assert.ok(warning, "expected the ambiguity warning");
    assert.deepEqual(warning.data.candidateShadeIds, [43, 44]);
  });

  it("a brand source with several listings and no exact identity match skips the record (never step 2)", async () => {
    shades = [
      { shadeId: 43, name: "Velvet Dreams", finish: "jelly", collection: null, finishes: ["jelly"] },
      { shadeId: 44, name: "Velvet Dreams", finish: "crelly", collection: null, finishes: ["crelly"] },
      { shadeId: 50, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"], authority: "retailer" },
    ];
    listings = [43, 44];

    const metrics = await materialize(record({ finishes: ["creme"], collection: "Fall 2025" }), BRAND);

    assert.equal(metrics.ambiguousShadesSkipped, 1);
    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts().length, 0);
  });

  it("a retailer source with several listings still skips", async () => {
    shades = [{ shadeId: 43, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] }];
    listings = [43, 44];

    const metrics = await materialize(record({ finishes: ["creme"] }), RETAILER);

    assert.equal(metrics.ambiguousShadesSkipped, 1);
    assert.equal(sourceProductInserts().length, 0);
  });

  it("a brand source does not adopt a same-name shade only another brand source lists", async () => {
    shades = [{ shadeId: 45, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"], authority: "brand_store" }];

    await materialize(record({ finishes: ["creme"], collection: "Fall 2025" }), BRAND);

    assert.equal(shadeInserts().length, 1);
  });

  it("a brand source does not adopt a same-name shade with no listings", async () => {
    shades = [{ shadeId: 46, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"] }];

    await materialize(record({ finishes: ["creme"], collection: "Fall 2025" }), BRAND);

    assert.equal(shadeInserts().length, 1);
  });

  it("a brand source adopts a same-name shade only a retailer lists", async () => {
    shades = [{ shadeId: 47, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"], authority: "retailer" }];

    await materialize(record({ finishes: ["creme"], collection: "Fall 2025" }), BRAND);

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 47);
  });

  it("step 0 reuses an admin-excluded listed shade", async () => {
    shades = [{ shadeId: 48, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"], status: "excluded" }];
    listings = [48];

    await materialize(record({ finishes: ["creme"], collection: "Other" }), BRAND);

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 48);
  });
});

describe("materializeHoloTacoRecords — resolution before detection", () => {
  it("gates detection on the admin category of a shade adopted on the first run", async () => {
    // No listing yet: the shade is found through the candidate flow.
    shades = [{ shadeId: 61, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"], adminCategory: "topper" }];

    const metrics = await materializeHoloTacoRecords(
      7,
      [record({ finishes: ["creme"], imageUrls: ["https://retailer.example/a.png"] })],
      { ...RETAILER, storeImages: true, detectHexFromImage: true },
      "[Test]"
    );

    assert.equal(aiCalls, 0);
    assert.equal(metrics.hexDetectionSkippedCategory, 1);
    assert.equal(sourceProductInserts()[0].params[0], 61);
  });

  it("an ambiguous record gets no upload, no detection and no batch entry", async () => {
    shades = [
      { shadeId: 21, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] },
      { shadeId: 22, name: "Velvet Dreams", finish: "holo", collection: null, finishes: ["holographic"] },
    ];
    const other = record({ name: "Other Shade", imageUrls: ["https://retailer.example/b.png"] });
    other.externalId = "r2";
    const records = [record({ finishes: [], imageUrls: ["https://retailer.example/a.png"] }), other];

    // Sync detection.
    let metrics = await materializeHoloTacoRecords(7, records, { ...RETAILER, storeImages: true, detectHexFromImage: true }, "[Test]");
    assert.equal(metrics.ambiguousShadesSkipped, 1);
    assert.equal(aiCalls, 1, "only the unambiguous record is detected");
    assert.ok(!blobCalls.some((c) => c.sourceImageUrl === "https://retailer.example/a.png"), "no upload");

    // Batch detection.
    calls = [];
    blobCalls = [];
    aiCalls = 0;
    metrics = await materializeHoloTacoRecords(
      7,
      records,
      { ...RETAILER, storeImages: true, detectHexFromImage: true, useBatchForHexDetection: true, batchMinImages: 1 },
      "[Test]"
    );
    assert.equal(aiCalls, 0);
    assert.equal(batchSubmissions.length, 1);
    assert.deepEqual(batchSubmissions[0].map((r) => r.customId), ["r2"]);
  });

  it("a retailer skips upload and detection for a shade with another source's product image", async () => {
    shades = [{ shadeId: 62, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] }];
    productSwatches = { 62: { swatchId: 900, imageId: 901, ownerId: 3 } };

    await materializeHoloTacoRecords(
      7,
      [record({ finishes: ["creme"], imageUrls: ["https://retailer.example/a.png"] })],
      { ...RETAILER, storeImages: true, detectHexFromImage: true },
      "[Test]"
    );

    assert.equal(blobCalls.filter((c) => c.fn === "uploadSourceImageToBlob").length, 0);
    assert.equal(aiCalls, 0);
    assert.equal(sourceProductInserts()[0].params[0], 62);
  });

  it("a brand source still uploads for a shade with another source's product image", async () => {
    shades = [{ shadeId: 63, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] }];
    productSwatches = { 63: { swatchId: 900, imageId: 901, ownerId: 3 } };
    await materializeHoloTacoRecords(
      7,
      [record({ finishes: ["creme"], imageUrls: ["https://brand.example/a.png"] })],
      { ...BRAND, detectHexFromImage: true },
      "[Test]"
    );

    assert.equal(blobCalls.filter((c) => c.fn === "uploadSourceImageToBlob").length, 1);
    assert.equal(aiCalls, 1);
  });

  it("re-runs the lookup when the pre-resolved shade has disappeared", async () => {
    shades = [{ shadeId: 64, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] }];
    // Merged between resolution and materialization: the existence check sees it merged.
    const originalQuery = transactionClient.query;
    transactionClient.query = async (text, params) => {
      const sql = sqlOf(text);
      if (sql.startsWith("SELECT 1 FROM shade WHERE shade_id = $1 AND merged_into_shade_id IS NULL")) {
        calls.push({ sql, params });
        shades[0].mergedInto = 99;
        return { rows: [] };
      }
      return originalQuery.call(transactionClient, text, params);
    };
    try {
      await materialize(record({ finishes: ["creme"] }), RETAILER);
    } finally {
      transactionClient.query = originalQuery;
    }

    assert.equal(shadeInserts().length, 1, "the merged shade is not used; a fresh lookup creates one");
  });
});

describe("materializeHoloTacoRecords — brand pre-resolution is re-checked in the transaction", () => {
  it("two same-name brand records in one chunk: A adopts the retailer shade, B gets a new shade", async () => {
    shades = [{ shadeId: 70, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"], authority: "retailer" }];
    // Record A takes shade 70 over (catalog_authority flips to brand_store), so record B's
    // in-transaction lookup no longer finds it as a retailer-created candidate.
    const a = record({ finishes: ["creme"], collection: "Fall 2025" });
    const b = record({ finishes: ["creme"], collection: "Winter 2025" });
    b.externalId = "r2";
    await materializeHoloTacoRecords(7, [a, b], { ...BRAND, detectHexFromImage: false }, "[Test]");

    const linked = sourceProductInserts().map((c) => c.params[0]);
    assert.equal(linked[0], 70, "A adopts the retailer-created shade");
    assert.equal(shadeInserts().length, 1, "B creates its own shade");
    assert.equal(linked[1], 100);
  });
});

describe("materializeHoloTacoRecords — brand step 2 while a takeover waits for its hex", () => {
  it("B gets its own shade although A's takeover has not flipped catalog_authority yet (batch detection pending)", async () => {
    shades = [{ shadeId: 70, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"], authority: "retailer" }];
    const a = record({ finishes: ["creme"], collection: "Fall 2025", imageUrls: ["https://brand.example/a.png"] });
    const b = record({ finishes: ["creme"], collection: "Winter 2025", imageUrls: ["https://brand.example/b.png"] });
    b.externalId = "r2";

    await materializeHoloTacoRecords(
      7,
      [a, b],
      { ...BRAND, storeImages: true, detectHexFromImage: true, useBatchForHexDetection: true, batchMinImages: 1 },
      "[Test]"
    );

    assert.equal(batchSubmissions.length, 1, "detection is pending in a batch");
    assert.equal(shades[0].authority, "retailer", "the flip waits for the brand's detected hex");
    const linked = sourceProductInserts().map((c) => c.params[0]);
    assert.equal(linked[0], 70, "A adopts (takes over) the retailer-created shade");
    assert.equal(shadeInserts().length, 1, "B creates its own shade");
    assert.equal(linked[1], 100);
  });

  it("never adopts a retailer-authority shade a brand listing already points at", async () => {
    shades = [{ shadeId: 71, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"], authority: "retailer", brandListed: true }];

    await materialize(record({ finishes: ["creme"], collection: "Fall 2025" }), BRAND);

    assert.equal(shadeInserts().length, 1);
    const candidateSql = calls.find((c) => c.sql.includes("status IN ('active', 'excluded')") && c.sql.includes("catalog_authority = 'retailer'"));
    assert.match(candidateSql.sql, /NOT EXISTS \( SELECT 1 FROM shade_source_product kssp .* NOT IN \('retailer', 'feed'\) \)/);
  });
});

describe("materializeHoloTacoRecords — catalog authority (one write-rule implementation)", () => {
  it("a shade a retailer or feed creates gets catalog_authority 'retailer'; a brand's gets 'brand_store'", async () => {
    for (const [options, authority] of [
      [RETAILER, "retailer"],
      [{ ...RETAILER, sourceKind: "feed" }, "retailer"],
      [BRAND, "brand_store"],
    ]) {
      calls = [];
      shades = [];
      await materialize(record({ name: "Brand New", finishes: ["creme"] }), options);
      const [insert] = shadeInserts();
      assert.ok(insert, `expected a shade insert for ${options.sourceKind}`);
      assert.equal(insert.params[5], authority, options.sourceKind);
    }
  });

  it("a feed adopts like a retailer: fill-only on a brand-store shade", async () => {
    shades = [{ shadeId: 31, name: "Velvet Dreams", finish: "Creme", collection: "Core", finishes: ["creme"] }];

    // Shares "creme", so it fits; a merge would add "holographic".
    await materialize(record({ finishes: ["creme", "holographic"] }), { ...RETAILER, sourceKind: "feed" });

    assert.equal(shadeInserts().length, 0);
    const [update] = catalogUpdates();
    assert.equal(update.params[0], 31);
    assert.deepEqual([...update.params[7]], ["creme"], "finishes kept");
    assert.equal(categoryUpdates().length, 0, "category never re-classified");
  });

  it("a retailer on a shade a retailer created writes like an owner (finish merge, category)", async () => {
    shades = [{ shadeId: 32, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"], authority: "retailer" }];
    listings = [32];

    await materialize(record({ finishes: ["shimmer"] }), RETAILER);

    const [update] = catalogUpdates();
    assert.equal(update.params[0], 32);
    assert.deepEqual([...update.params[7]].sort(), ["creme", "shimmer"]);
    assert.equal(categoryUpdates().length, 1);
    assert.equal(update.params[15], null, "a retailer never changes the authority");
    assert.equal(update.params[5], false, "never overwrites colors");
  });

  it("a retailer never replaces another source's product image, even on a retailer-created shade", async () => {
    shades = [{ shadeId: 33, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"], authority: "retailer" }];
    listings = [33];
    productSwatches = { 33: { swatchId: 5, imageId: 500, ownerId: 3 } };

    await materialize(record({ finishes: ["creme"], imageUrls: ["https://retailer.example/a.png"] }), {
      ...RETAILER,
      storeImages: true,
    });

    assert.ok(!blobCalls.some((c) => c.fn === "uploadSourceImageToBlob"), "no upload");
    assert.equal(calls.filter((c) => c.sql.startsWith("UPDATE swatch") || c.sql.startsWith("INSERT INTO swatch")).length, 0);
  });

  it("a retailer skips the AI call for a resolved shade that already has a detected hex", async () => {
    shades = [{ shadeId: 34, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"], detectedHex: "#445566" }];
    listings = [34];

    const metrics = await materializeHoloTacoRecords(
      7,
      [record({ finishes: ["creme"], imageUrls: ["https://retailer.example/a.png"] })],
      { ...RETAILER, storeImages: true, detectHexFromImage: true },
      "[Test]"
    );

    assert.equal(aiCalls, 0);
    assert.equal(metrics.hexDetectionSkippedUnchanged, 1);
  });
});

// ---------------------------------------------------------------------------
// Retailer-mode connector record → shade (brand sources plan, Task 5)
// ---------------------------------------------------------------------------

describe("materializeHoloTacoRecords — a retailer-mode Shopify record", () => {
  it("creates the shade with no legacy finish key and its finishes from the store tags", async () => {
    const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");
    const { readSourceSettings } = require("../dist/lib/source-settings");
    const { products } = require("./fixtures/beyond-polish-products.json");
    const opiListing = products.find((product) => product.id === 7001);
    const connector = new ShopifyGenericConnector("FixtureRetailerShopify", "https://www.beyondpolish.com", {
      currency: "USD",
      settings: readSourceSettings({ kind: "retailer" }),
    });
    const { records } = await connector.pullProducts({
      searchTerm: "",
      page: 1,
      pageSize: 50,
      maxRecords: 50,
      catalogCache: { load: async () => [opiListing], save: async () => {} },
    });
    assert.equal(records.length, 1);
    brands = { opi: 1 };

    const metrics = await materialize({ ...records[0], externalId: "r1" }, RETAILER);

    assert.equal(metrics.shadesCreated, 1);
    const [insert] = shadeInserts();
    assert.equal(insert.params[1], "No Room for the Blues");
    assert.equal(insert.params[2], null, "legacy shade.finish identity key");
    assert.equal(insert.params[3], null, "collection");
    assert.deepEqual([...insert.params[4]], ["creme"]);
  });
});
