const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Storage must be unset before the repo loads so AI receives the upload URL directly.
delete process.env.AZURE_STORAGE_CONNECTION;
process.env.HEX_DETECTION_DELAY_MS = "0";

function mockDistModule(relativePath, exports) {
  const resolved = path.resolve(__dirname, "../dist/lib", relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// DB mock: top-level query() serves the unchanged-image lookup; transaction() tracks
// overlap and the order records commit in.
// ---------------------------------------------------------------------------

let lookupHandler;
let lookupCalls;
let activeTransactions;
let maxActiveTransactions;
let committedShadeNames;
let idSequence;
let transactionCount;
let failTransactionAt;
let shadeColorUpdates = [];
let categoryWrites = [];
let adminLookups = [];
let adminCategoryRows = [];

const transactionClient = {
  async query(sql, params) {
    // Yield on every statement so overlapping transactions would actually interleave.
    await new Promise((resolve) => setImmediate(resolve));
    if (sql.includes("lower(shade_name_canonical) = lower($2)") && sql.includes("SELECT shade_id")) {
      committedShadeNames.push(params[1]);
    }
    if (sql.includes("detected_hex_method = CASE") && sql.includes("WHERE shade_id = $1")) {
      // [shadeId, name, vendorHex, detectedHex, finishes, overwrite, nameHex, mergedFinishes, confidence, method, model, promptVersion]
      shadeColorUpdates.push({ detectedHex: params[3], confidence: params[8], method: params[9], promptVersion: params[11] });
    }
    if (sql.includes("SET product_category = $2")) {
      categoryWrites.push({ sql, shadeId: params[0], category: params[1] });
    }
    if (sql.includes("RETURNING brand_id")) return { rows: [{ brandId: 1 }] };
    if (sql.includes("RETURNING shade_id")) return { rows: [{ shadeId: ++idSequence }] };
    if (sql.includes("RETURNING image_id")) return { rows: [{ imageId: ++idSequence }] };
    return { rows: [] };
  },
};

mockDistModule("db.js", {
  query: async (sql, params) => {
    if (sql.includes("product_category_source = 'admin'")) {
      adminLookups.push(params);
      return { rows: adminCategoryRows };
    }
    if (sql.includes("WITH input AS")) {
      lookupCalls.push(params);
      return { rows: await lookupHandler(params) };
    }
    return { rows: [] };
  },
  transaction: async (callback) => {
    transactionCount += 1;
    if (transactionCount === failTransactionAt) {
      throw new Error("commit failed");
    }
    activeTransactions += 1;
    maxActiveTransactions = Math.max(maxActiveTransactions, activeTransactions);
    try {
      return await callback(transactionClient);
    } finally {
      activeTransactions -= 1;
    }
  },
});

// ---------------------------------------------------------------------------
// AI + blob mocks
// ---------------------------------------------------------------------------

let detectCalls;
let detectContexts = [];
let inFlightDetections;
let maxInFlightDetections;

mockDistModule("ai-color-detection.js", {
  detectHexWithAzureOpenAI: async (_imageUrl, options) => {
    const shadeName = options.vendorContext.shadeName;
    detectCalls.push(shadeName);
    detectContexts.push(options.vendorContext);
    inFlightDetections += 1;
    maxInFlightDetections = Math.max(maxInFlightDetections, inFlightDetections);
    // Earlier records answer slowest, so commit order can't just follow completion order.
    const index = Number(shadeName.replace("Shade ", ""));
    await tick((10 - index) * 3);
    inFlightDetections -= 1;
    return {
      hex: "#112233",
      confidence: 0.8,
      finishes: ["creme"],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      provider: "azure-openai",
      method: "vision-direct",
      model: "gpt-4o-mini",
      promptVersion: "vision-direct/test",
    };
  },
});

mockDistModule("blob-storage.js", {
  ensureContainer: async () => {},
  uploadSourceImageToBlob: async ({ externalId }) => ({
    storageUrl: `https://img.example/${externalId}.png`,
    checksumSha256: `sum-${externalId}`,
  }),
});

mockDistModule("azure-openai-batch.js", {
  submitVisionHexBatch: async () => {
    throw new Error("batch not expected in these tests");
  },
});

// Image the snap step re-reads (HEX_DETECTION_SNAP_ENABLED); records which URL it was asked for.
let imageLoader = async () => {
  throw new Error("image loader not configured");
};
let loadedImageUrls = [];
mockDistModule("detection-image.js", {
  loadDetectionImageBytes: async (url) => {
    loadedImageUrls.push(url);
    return imageLoader(url);
  },
});

const { materializeHoloTacoRecords } = require("../dist/lib/ingestion-repo");
const sharp = require("sharp");

function record(index) {
  return {
    externalId: `p${index}`,
    raw: {},
    normalized: {
      brand: "Test Brand",
      name: `Shade ${index}`,
      primaryImageUrl: `https://shop.example/p${index}.png`,
      imageUrls: [`https://shop.example/p${index}.png`],
      tags: [],
      collections: [],
      finishes: [],
    },
  };
}

const records = (count) => Array.from({ length: count }, (_, index) => record(index));

describe("materializeHoloTacoRecords hex detection", () => {
  beforeEach(() => {
    lookupHandler = async () => [];
    lookupCalls = [];
    activeTransactions = 0;
    maxActiveTransactions = 0;
    committedShadeNames = [];
    idSequence = 0;
    transactionCount = 0;
    failTransactionAt = null;
    detectCalls = [];
    detectContexts = [];
    inFlightDetections = 0;
    maxInFlightDetections = 0;
    loadedImageUrls = [];
    shadeColorUpdates = [];
    categoryWrites = [];
    adminLookups = [];
    adminCategoryRows = [];
    delete process.env.HEX_DETECTION_SNAP_ENABLED;
    process.env.HEX_DETECTION_CONCURRENCY = "3";
  });

  it("runs detections concurrently up to the limit but commits one at a time in record order", async () => {
    const metrics = await materializeHoloTacoRecords(1, 7, records(7), { detectHexFromImage: true });

    assert.equal(maxInFlightDetections, 3);
    assert.equal(detectCalls.length, 7);
    assert.equal(maxActiveTransactions, 1);
    assert.deepEqual(
      committedShadeNames,
      records(7).map((r) => r.normalized.name)
    );
    assert.equal(metrics.hexDetected, 7);
    assert.equal(metrics.hexDetectionTotalTokens, 84);
  });

  it("skips hex detection for toppers and coats and writes each record's category (#349)", async () => {
    const topper = record(1);
    topper.normalized.tags = ["toppers", "nail-polish"];
    topper.normalized.productType = "Top Coat";
    const base = record(2);
    base.normalized.name = "Sticky Base";
    base.normalized.tags = ["base-coat", "nail-polish"];

    const metrics = await materializeHoloTacoRecords(1, 7, [record(0), topper, base], { detectHexFromImage: true });

    assert.deepEqual(detectCalls, ["Shade 0"]);
    assert.equal(metrics.hexDetected, 1);
    assert.equal(metrics.hexDetectionSkippedCategory, 2);
    assert.deepEqual(
      categoryWrites.map((write) => write.category),
      ["color", "topper", "base_coat"]
    );
    assert.ok(
      categoryWrites.every((write) => write.sql.includes("product_category_source <> 'admin'")),
      "an admin-set category is never overwritten"
    );
    // The unchanged-image lookup is only asked about color polishes.
    assert.deepEqual(lookupCalls[0][1], ["p0"]);
  });

  it("gates detection on an admin-set category, not the connector's rule category (CodeRabbit, #349)", async () => {
    // The connector sees two plain color polishes; an admin made p1 a topper and p2 an accessory.
    adminCategoryRows = [
      { externalId: "p1", productCategory: "topper" },
      { externalId: "p2", productCategory: "accessory" },
    ];
    const metrics = await materializeHoloTacoRecords(1, 7, records(3), { detectHexFromImage: true });

    assert.deepEqual(detectCalls, ["Shade 0"], "no vision call for admin-categorized shades");
    assert.equal(metrics.hexDetected, 1);
    assert.equal(metrics.hexDetectionSkippedCategory, 2);
    assert.equal(adminLookups.length, 1);
    assert.deepEqual(adminLookups[0][0], ["p0", "p1", "p2"]);
    assert.deepEqual(lookupCalls[0][1], ["p0"], "unchanged-image lookup only asks about detectable shades");
  });

  it("skips the admin lookup when hex detection is off", async () => {
    await materializeHoloTacoRecords(1, 7, records(2), { detectHexFromImage: false });
    assert.equal(adminLookups.length, 0);
  });

  it("falls back to the default concurrency for invalid values", async () => {
    process.env.HEX_DETECTION_CONCURRENCY = "0";
    await materializeHoloTacoRecords(1, 7, records(6), { detectHexFromImage: true });
    assert.equal(maxInFlightDetections, 4);
  });

  it("skips AI for records whose image is unchanged and whose shade already has a hex", async () => {
    lookupHandler = async () => [{ externalId: "p1" }];

    const metrics = await materializeHoloTacoRecords(1, 7, records(3), { detectHexFromImage: true });

    assert.deepEqual(detectCalls.sort(), ["Shade 0", "Shade 2"]);
    assert.equal(metrics.hexDetectionSkippedUnchanged, 1);
    assert.equal(metrics.hexDetectionSkipped, 1);
    assert.equal(metrics.hexDetected, 2);
    // The skipped record is still materialized.
    assert.deepEqual(committedShadeNames, ["Shade 0", "Shade 1", "Shade 2"]);

    const [params] = lookupCalls;
    assert.equal(params[0], 7);
    assert.deepEqual(params[1], ["p0", "p1", "p2"]);
    assert.deepEqual(params[2], ["Test Brand", "Test Brand", "Test Brand"]);
    assert.deepEqual(params[6], ["sum-p0", "sum-p1", "sum-p2"]);
  });

  it("re-detects everything when overwriteDetectedHex is set", async () => {
    lookupHandler = async () => [{ externalId: "p1" }];

    const metrics = await materializeHoloTacoRecords(1, 7, records(3), {
      detectHexFromImage: true,
      overwriteDetectedHex: true,
    });

    assert.equal(lookupCalls.length, 0);
    assert.equal(detectCalls.length, 3);
    assert.equal(metrics.hexDetectionSkippedUnchanged, 0);
  });

  it("runs detection for every candidate when the lookup fails", async () => {
    lookupHandler = async () => {
      throw new Error("connection reset");
    };

    const metrics = await materializeHoloTacoRecords(1, 7, records(3), { detectHexFromImage: true });

    assert.equal(detectCalls.length, 3);
    assert.equal(metrics.hexDetected, 3);
    assert.equal(metrics.hexDetectionSkippedUnchanged, 0);
  });

  it("stops queued detections when a record's DB commit fails", async () => {
    process.env.HEX_DETECTION_CONCURRENCY = "1";
    failTransactionAt = 1;

    await assert.rejects(
      materializeHoloTacoRecords(1, 7, records(6), { detectHexFromImage: true }),
      /commit failed/
    );
    // Give any detections that escaped the queue time to run before counting.
    await tick(200);

    // Record 0's detection, plus at most record 1's, which starts as soon as 0 resolves.
    assert.ok(detectCalls.length <= 2, `expected <= 2 detections, got ${detectCalls.length}`);
  });

  it("does not look anything up when hex detection is off", async () => {
    await materializeHoloTacoRecords(1, 7, records(2), { detectHexFromImage: false });

    assert.equal(lookupCalls.length, 0);
    assert.equal(detectCalls.length, 0);
  });

  it("forwards the stored description and descriptors (#352) to the vision prompt", async () => {
    const withText = record(0);
    withText.normalized.collections = ["Space"];
    withText.normalized.descriptionText = "A linear holo with gold shimmer.";
    withText.normalized.descriptors = ["Nail Polish", "Linear Holo"];

    await materializeHoloTacoRecords(1, 7, [withText], { detectHexFromImage: true });

    assert.equal(detectContexts.length, 1);
    const context = detectContexts[0];
    assert.equal(context.descriptionText, "A linear holo with gold shimmer.");
    assert.deepEqual(context.descriptors, ["Nail Polish", "Linear Holo"]);
    assert.equal(context.description, undefined, "the collection is no longer sent as the description");
    assert.equal(context.vendorJson.collection, "Space");
  });
});

describe("materializeHoloTacoRecords hex snapping (HEX_DETECTION_SNAP_ENABLED)", () => {
  const solidPng = (r, g, b) =>
    sharp({ create: { width: 24, height: 24, channels: 3, background: { r, g, b } } }).png().toBuffer();

  beforeEach(() => {
    lookupHandler = async () => [];
    lookupCalls = [];
    activeTransactions = 0;
    maxActiveTransactions = 0;
    committedShadeNames = [];
    idSequence = 0;
    transactionCount = 0;
    failTransactionAt = null;
    detectCalls = [];
    detectContexts = [];
    inFlightDetections = 0;
    maxInFlightDetections = 0;
    loadedImageUrls = [];
    shadeColorUpdates = [];
    delete process.env.HEX_DETECTION_SNAP_ENABLED;
    process.env.HEX_DETECTION_CONCURRENCY = "3";
  });

  it("writes the model hex as vision-direct and never loads the image while the flag is off", async () => {
    imageLoader = () => solidPng(0x10, 0x20, 0x30);
    const metrics = await materializeHoloTacoRecords(1, 7, records(2), { detectHexFromImage: true });

    assert.equal(metrics.hexSnapped, 0);
    assert.deepEqual(loadedImageUrls, []);
    assert.equal(shadeColorUpdates.length, 2);
    for (const update of shadeColorUpdates) {
      assert.equal(update.detectedHex, "#112233");
      assert.equal(update.method, "vision-direct");
    }
  });

  it("snaps the model hex to the image sent to the model and records vision-snap provenance", async () => {
    process.env.HEX_DETECTION_SNAP_ENABLED = "true";
    imageLoader = () => solidPng(0x10, 0x20, 0x30);
    const metrics = await materializeHoloTacoRecords(1, 7, records(2), { detectHexFromImage: true });

    assert.equal(metrics.hexDetected, 2);
    assert.equal(metrics.hexSnapped, 2);
    // Storage is unset in this file, so the model was sent the upload URL itself; the snap re-reads that same URL.
    assert.deepEqual(loadedImageUrls.sort(), ["https://img.example/p0.png", "https://img.example/p1.png"]);
    assert.equal(shadeColorUpdates.length, 2);
    for (const update of shadeColorUpdates) {
      assert.equal(update.detectedHex, "#102030");
      assert.equal(update.method, "vision-snap");
      assert.equal(update.confidence, 0.8, "confidence is untouched");
      assert.equal(update.promptVersion, "vision-direct/test", "the prompt did not change, so neither does its version");
    }
  });

  it("keeps the model hex (vision-direct) when the image cannot be read or no chip is close", async () => {
    process.env.HEX_DETECTION_SNAP_ENABLED = "true";
    let call = 0;
    imageLoader = async () => {
      call += 1;
      if (call === 1) throw new Error("fetch failed");
      return solidPng(0xf4, 0xf4, 0xf4);
    };
    const metrics = await materializeHoloTacoRecords(1, 7, records(2), { detectHexFromImage: true });

    assert.equal(metrics.hexDetected, 2, "a snap problem never drops the detection");
    assert.equal(metrics.hexDetectionFailures, 0);
    assert.equal(metrics.hexSnapped, 0);
    for (const update of shadeColorUpdates) {
      assert.equal(update.detectedHex, "#112233");
      assert.equal(update.method, "vision-direct");
    }
  });
});
