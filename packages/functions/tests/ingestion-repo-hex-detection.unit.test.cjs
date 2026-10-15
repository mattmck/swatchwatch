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

const transactionClient = {
  async query(sql, params) {
    // Yield on every statement so overlapping transactions would actually interleave.
    await new Promise((resolve) => setImmediate(resolve));
    if (sql.includes("lower(shade_name_canonical) = lower($2)") && sql.includes("SELECT shade_id")) {
      committedShadeNames.push(params[1]);
    }
    if (sql.includes("RETURNING brand_id")) return { rows: [{ brandId: 1 }] };
    if (sql.includes("RETURNING shade_id")) return { rows: [{ shadeId: ++idSequence }] };
    if (sql.includes("RETURNING image_id")) return { rows: [{ imageId: ++idSequence }] };
    return { rows: [] };
  },
};

mockDistModule("db.js", {
  query: async (sql, params) => {
    if (sql.includes("WITH input AS")) {
      lookupCalls.push(params);
      return { rows: await lookupHandler(params) };
    }
    return { rows: [] };
  },
  transaction: async (callback) => {
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
let inFlightDetections;
let maxInFlightDetections;

mockDistModule("ai-color-detection.js", {
  detectHexWithAzureOpenAI: async (_imageUrl, options) => {
    const shadeName = options.vendorContext.shadeName;
    detectCalls.push(shadeName);
    inFlightDetections += 1;
    maxInFlightDetections = Math.max(maxInFlightDetections, inFlightDetections);
    // Earlier records answer slowest, so commit order can't just follow completion order.
    const index = Number(shadeName.replace("Shade ", ""));
    await tick((10 - index) * 3);
    inFlightDetections -= 1;
    return {
      hex: "#112233",
      finishes: ["creme"],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
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

const { materializeHoloTacoRecords } = require("../dist/lib/ingestion-repo");

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
    detectCalls = [];
    inFlightDetections = 0;
    maxInFlightDetections = 0;
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

  it("does not look anything up when hex detection is off", async () => {
    await materializeHoloTacoRecords(1, 7, records(2), { detectHexFromImage: false });

    assert.equal(lookupCalls.length, 0);
    assert.equal(detectCalls.length, 0);
  });
});
