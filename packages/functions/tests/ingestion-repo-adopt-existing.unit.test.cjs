/**
 * Source kinds (brand sources plan, Task 3): a reseller or feed record adopts the brand's
 * existing shade and only fills empty data; a brand record adopts a shade a reseller created.
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
// Shades of brand 1: { shadeId, name, finish, collection, finishes, status, mergedInto }.
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
      // Lookup step 0: the product's own listings.
      assert.deepEqual(params, [7, "r1"]);
      return { rows: listings.map((shadeId) => ({ shadeId })) };
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
    if (sql.includes("FROM shade") && sql.includes("merged_into_shade_id IS NULL") && sql.includes("status = 'active'")) {
      // Same-name candidates; honour the brand-source filter when the SQL carries it.
      const brandOnly = sql.includes("finish IS NULL AND collection IS NULL");
      const rows = shades
        .filter((s) => s.name.toLowerCase() === String(params[1]).toLowerCase())
        .filter((s) => (s.status ?? "active") === "active" && !s.mergedInto)
        .filter((s) => !brandOnly || (s.finish === null && s.collection === null))
        .map((s) => ({ shadeId: s.shadeId, finishes: s.finishes }));
      return { rows };
    }
    if (sql.startsWith("INSERT INTO shade ")) {
      return { rows: [{ shadeId: nextShadeId++ }] };
    }
    if (sql.includes("FROM shade WHERE shade_id = $1 FOR UPDATE")) {
      const shade = shades.find((s) => s.shadeId === params[0]);
      return { rows: [{ finishes: shade?.finishes ?? [], finishesSource: null }] };
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
    if (sql.includes("product_category_source = 'admin'")) {
      assert.equal(params[5], 7, "data source id");
      return { rows: sql.includes("FROM shade_source_product ssp") ? adminCategoryRows : [] };
    }
    if (sql.includes("WHERE sh.detected_hex IS NOT NULL")) {
      assert.equal(params[0], 7, "data source id");
      return { rows: sql.includes("FROM shade_source_product ssp") ? unchangedRows : [] };
    }
    return { rows: [] };
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
mockDistModule("ai-color-detection.js", {
  detectHexWithAzureOpenAI: async () => {
    aiCalls += 1;
    return { hex: "#112233", finishes: [], confidence: 0.9 };
  },
});

mockDistModule("azure-openai-batch.js", {
  submitVisionHexBatch: async () => {
    throw new Error("batch not expected in these tests");
  },
});

const { materializeHoloTacoRecords } = require("../dist/lib/ingestion-repo");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function record({ brand = "Orly", name = "Velvet Dreams", finishes = [], collection = null, imageUrls = [] } = {}) {
  return {
    externalId: "r1",
    raw: {},
    normalized: {
      brand,
      name,
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

const RESELLER = { adoptExistingShades: true, overwriteDetectedHex: false, storeImages: false, sourceName: "BeyondPolishShopify" };
const BRAND = { adoptExistingShades: false, sourceName: "OrlyShopify" };

function materialize(rec, options) {
  return materializeHoloTacoRecords(7, [rec], { detectHexFromImage: false, ...options }, "[Test]");
}

const shadeInserts = () => calls.filter((c) => c.sql.startsWith("INSERT INTO shade "));
const brandInserts = () => calls.filter((c) => c.sql.startsWith("INSERT INTO brand"));
const sourceProductInserts = () => calls.filter((c) => c.sql.startsWith("INSERT INTO shade_source_product"));
const catalogUpdates = () => calls.filter((c) => c.sql.startsWith("UPDATE shade SET color_name"));

beforeEach(() => {
  calls = [];
  brands = { orly: 1, "holo taco": 2 };
  shades = [];
  productSwatches = {};
  blobCalls = [];
  aiCalls = 0;
  nextShadeId = 100;
  listings = [];
  adminCategoryRows = [];
  unchangedRows = [];
});

// ---------------------------------------------------------------------------
// Reseller / feed sources
// ---------------------------------------------------------------------------

describe("materializeHoloTacoRecords — reseller source adopts the brand's shade", () => {
  it("adopts the one same-name shade and writes fill-only", async () => {
    shades = [{ shadeId: 11, name: "Velvet Dreams", finish: "creme", collection: "Fall 2025", finishes: ["creme"] }];

    const metrics = await materialize(record({ finishes: ["creme"] }), RESELLER);

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

    await materialize(record({ finishes: ["holographic"] }), RESELLER);

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 22);
  });

  it("skips the record and warns when the finish cannot decide", async () => {
    shades = [
      { shadeId: 21, name: "Velvet Dreams", finish: "creme", collection: null, finishes: ["creme"] },
      { shadeId: 22, name: "Velvet Dreams", finish: "holo", collection: null, finishes: ["holographic"] },
    ];
    const log = logger();

    const metrics = await materialize(record({ finishes: [] }), { ...RESELLER, progressLogger: log });

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
    // Reseller records carry no legacy finish or collection, like a reseller-created shade.
    shades = [{ shadeId: 51, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"] }];
    const log = logger();

    await materialize(record({ finishes: [] }), { ...RESELLER, progressLogger: log });
    assert.equal(shadeInserts().length, 0, "a record without finishes adopts the one candidate");

    calls = [];
    const reseller = record({ finishes: ["holographic"] });
    reseller.normalized.finishes = [];
    await materialize(reseller, { ...RESELLER, progressLogger: log });

    assert.equal(shadeInserts().length, 1);
    assert.ok(!calls.some((c) => c.sql.includes("coalesce(finish, '') = coalesce($3, '')")), "no exact-match lookup");
    const warning = log.lines.warn.find((line) => Array.isArray(line.data?.candidateShadeIds));
    assert.deepEqual(warning?.data.candidateShadeIds, [51]);
  });

  it("adopts a same-name shade that has no finishes yet", async () => {
    shades = [{ shadeId: 52, name: "Velvet Dreams", finish: null, collection: null, finishes: [] }];
    const reseller = record({ finishes: ["holographic"] });
    reseller.normalized.finishes = [];

    await materialize(reseller, RESELLER);

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 52);
  });

  it("does not penalize a finish without a family", async () => {
    shades = [{ shadeId: 53, name: "Velvet Dreams", finish: null, collection: null, finishes: ["magnetic-flakie"] }];
    const reseller = record({ finishes: ["magnetic-flakie"] });
    reseller.normalized.finishes = [];

    await materialize(reseller, RESELLER);

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts()[0].params[0], 53);
  });

  it("never adopts an inactive or merged shade", async () => {
    shades = [
      { shadeId: 31, name: "Velvet Dreams", finish: "creme", collection: "Old", finishes: ["creme"], status: "excluded" },
      { shadeId: 32, name: "Velvet Dreams", finish: "jelly", collection: "Old", finishes: ["creme"], mergedInto: 5 },
    ];

    await materialize(record({ finishes: ["creme"] }), RESELLER);

    assert.equal(shadeInserts().length, 1);
  });

  it("leaves the brand's images alone on an adopted shade that already has a product swatch", async () => {
    shades = [{ shadeId: 11, name: "Velvet Dreams", finish: "creme", collection: "Fall 2025", finishes: ["creme"] }];
    // The product image is the brand store's (data source 3); this run is data source 7.
    productSwatches = { 11: { swatchId: 900, imageId: 901, ownerId: 3 } };

    await materialize(record({ finishes: ["creme"], imageUrls: ["https://reseller.example/a.png"] }), {
      ...RESELLER,
      storeImages: true,
    });

    assert.ok(!calls.some((c) => c.sql.startsWith("INSERT INTO swatch")), "no swatch inserted");
    assert.ok(!calls.some((c) => c.sql.startsWith("UPDATE swatch")), "no swatch repointed");
    assert.ok(!calls.some((c) => c.sql.startsWith("INSERT INTO image_asset")), "no image asset linked");
  });

  it("lets a reseller refresh a product image it stored itself", async () => {
    shades = [{ shadeId: 11, name: "Velvet Dreams", finish: "creme", collection: "Fall 2025", finishes: ["creme"] }];
    productSwatches = { 11: { swatchId: 900, imageId: 901, ownerId: 7 } };

    await materialize(record({ finishes: ["creme"], imageUrls: ["https://reseller.example/new.png"] }), {
      ...RESELLER,
      storeImages: true,
    });

    const swatchUpdate = calls.find((c) => c.sql.startsWith("UPDATE swatch"));
    assert.ok(swatchUpdate, "expected the product swatch to be repointed");
    assert.deepEqual(swatchUpdate.params, [900, 700]);
  });

  it("links a permitted reseller's image when the shade has none yet", async () => {
    shades = [{ shadeId: 11, name: "Velvet Dreams", finish: "creme", collection: "Fall 2025", finishes: ["creme"] }];

    await materialize(record({ finishes: ["creme"], imageUrls: ["https://reseller.example/a.png"] }), {
      ...RESELLER,
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
      [record({ finishes: ["creme"], imageUrls: ["https://reseller.example/a.png", "https://reseller.example/b.png"] })],
      { ...RESELLER, detectHexFromImage: true },
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
  it("adopts a shade a reseller created (no legacy finish, no collection) and keeps the overwrite flag", async () => {
    shades = [{ shadeId: 41, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"] }];

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

    const metrics = await materialize(record({ finishes: ["creme"] }), { ...RESELLER, progressLogger: log });

    assert.equal(shadeInserts().length, 0);
    assert.equal(sourceProductInserts().length, 0);
    assert.equal(metrics.skipped, 1);
    assert.equal(metrics.ambiguousShadesSkipped, 1);
    const warning = log.lines.warn.find((line) => Array.isArray(line.data?.candidateShadeIds));
    assert.deepEqual(warning?.data.candidateShadeIds, [41, 42]);
  });

  it("gates hex detection on the admin category of the listed (adopted) shade", async () => {
    shades = [{ shadeId: 41, name: "Velvet Dreams", finish: null, collection: null, finishes: ["creme"] }];
    listings = [41];
    adminCategoryRows = [{ externalId: "r1", productCategory: "topper" }];

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
