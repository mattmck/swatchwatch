const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

delete process.env.AZURE_STORAGE_CONNECTION;
process.env.HEX_DETECTION_DELAY_MS = "0";

function mockDistModule(relativePath, exports) {
  const resolved = path.resolve(__dirname, "../dist/lib", relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ---------------------------------------------------------------------------
// Milestones that reach the job log (progressLogger) during HoloTaco/Shopify
// materialization: phase timings, the per-chunk summary, per-record problems.
// ---------------------------------------------------------------------------

let idSequence;
const transactionClient = {
  async query(sql) {
    if (sql.includes("RETURNING brand_id")) return { rows: [{ brandId: 1 }] };
    if (sql.includes("RETURNING shade_id")) return { rows: [{ shadeId: ++idSequence }] };
    if (sql.includes("RETURNING image_id")) return { rows: [{ imageId: ++idSequence }] };
    return { rows: [] };
  },
};

mockDistModule("db.js", {
  query: async () => ({ rows: [] }),
  transaction: async (callback) => callback(transactionClient),
});

let detectHex;
mockDistModule("ai-color-detection.js", {
  detectHexWithAzureOpenAI: (...args) => detectHex(...args),
});

let failUploadFor;
mockDistModule("blob-storage.js", {
  ensureContainer: async () => {},
  uploadSourceImageToBlob: async ({ sourceImageUrl, externalId }) => {
    if (failUploadFor.has(sourceImageUrl)) {
      throw new Error("403 from CDN");
    }
    return { storageUrl: `https://blob.example/${externalId}.png`, checksumSha256: `sum-${externalId}` };
  },
});

mockDistModule("azure-openai-batch.js", {
  submitVisionHexBatch: async () => {
    throw new Error("batch not expected in these tests");
  },
});

const { materializeHoloTacoRecords, formatMaterializationSummary } = require("../dist/lib/ingestion-repo");

const primaryUrl = (index) => `https://shop.example/p${index}.png`;

function record(index) {
  return {
    externalId: `p${index}`,
    raw: {},
    normalized: {
      brand: "Test Brand",
      name: `Shade ${index}`,
      primaryImageUrl: primaryUrl(index),
      imageUrls: [primaryUrl(index)],
      tags: [],
      collections: [],
      finishes: [],
    },
  };
}

function captureLogger() {
  const entries = [];
  return {
    entries,
    messages: (level) => entries.filter((entry) => !level || entry.level === level).map((entry) => entry.msg),
    progressLogger: {
      info: (msg, data) => entries.push({ level: "info", msg, data }),
      warn: (msg, data) => entries.push({ level: "warn", msg, data }),
      error: (msg, data) => entries.push({ level: "error", msg, data }),
    },
  };
}

describe("materializeHoloTacoRecords job-log milestones", () => {
  beforeEach(() => {
    idSequence = 0;
    failUploadFor = new Set();
    detectHex = async (_url, options) => {
      options?.onLog?.("info", "[ai-color-detection] Config loaded, calling Azure OpenAI");
      return { hex: "#112233", finishes: ["creme"], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    };
  });

  it("logs each phase's start and finish with elapsed time, then one chunk summary", async () => {
    const log = captureLogger();

    await materializeHoloTacoRecords(
      1,
      7,
      [record(0), record(1)],
      { detectHexFromImage: true, progressLogger: log.progressLogger, chunkLabel: "Records 1–2 of 2 on page 1" },
      "[TestShop]"
    );

    const info = log.messages("info");
    assert.deepEqual(
      info.map((msg) => msg.replace(/[\d.]+s\b/g, "Ns")),
      [
        "[TestShop] Image upload started for 2 record(s)",
        "[TestShop] Image upload finished in Ns: 2 uploaded, 0 reused, 0 failed",
        "[TestShop] Hex detection and database writes started for 2 record(s)",
        "[TestShop] Hex detection and database writes finished in Ns",
        "[TestShop] Records 1–2 of 2 on page 1: 2 shades (2 new), 2 hex detected, 0 upload failures, Ns",
      ]
    );

    const finished = log.entries.find((entry) => /Image upload finished/.test(entry.msg));
    assert.equal(typeof finished.data.durationMs, "number");
    const summary = log.entries.at(-1);
    assert.equal(summary.data.hexDetected, 2);
    assert.equal(typeof summary.data.durationMs, "number");
    assert.equal(log.messages("warn").length, 0);
  });

  it("keeps per-record step lines (selection, token usage, success, AI info) out of the job log", async () => {
    const log = captureLogger();

    await materializeHoloTacoRecords(1, 7, [record(0)], {
      detectHexFromImage: true,
      progressLogger: log.progressLogger,
    });

    const all = log.messages();
    assert.ok(!all.some((msg) => /\[image-selection\]|Token usage|\] Success|Config loaded/.test(msg)), all.join("\n"));
    assert.match(all.at(-1), /1 record\(s\): 1 shade \(1 new\), 1 hex detected/);
  });

  it("sends upload and AI failures to the job log as warnings and counts them in the summary", async () => {
    const log = captureLogger();
    failUploadFor = new Set([primaryUrl(0)]);
    detectHex = async (_url, options) => {
      options?.onLog?.("warn", "[ai-color-detection] Rate limited, retrying");
      throw new Error("Exhausted retries");
    };

    await materializeHoloTacoRecords(1, 7, [record(0), record(1)], {
      detectHexFromImage: true,
      progressLogger: log.progressLogger,
      chunkLabel: "Records 1–2",
    });

    const warnings = log.messages("warn");
    assert.ok(warnings.some((msg) => /Primary image upload failed for p0/.test(msg)), warnings.join("\n"));
    assert.ok(warnings.some((msg) => /p1 \[ai-color-detection\] Rate limited/.test(msg)), warnings.join("\n"));
    assert.ok(warnings.some((msg) => /AI hex detection failed for p1/.test(msg)), warnings.join("\n"));
    assert.match(log.messages("info").at(-1), /Records 1–2: .*1 hex detection failures, 1 upload failures/);
  });

  it("warns for records skipped without a shade name", async () => {
    const log = captureLogger();
    const nameless = record(2);
    nameless.normalized.name = null;

    await materializeHoloTacoRecords(1, 7, [record(0), nameless], {
      detectHexFromImage: false,
      progressLogger: log.progressLogger,
    });

    assert.ok(log.messages("warn").some((msg) => /Skipped record p2/.test(msg)));
    assert.match(log.messages("info").at(-1), /1 skipped/);
  });
});

describe("formatMaterializationSummary", () => {
  it("formats the issue's example line", () => {
    assert.equal(
      formatMaterializationSummary(
        "Records 10–19",
        { processed: 10, shadesCreated: 0, hexDetected: 8, imageUploadFailures: 0, skipped: 0 },
        41_000
      ),
      "Records 10–19: 10 shades (0 new), 8 hex detected, 0 upload failures, 41.0s"
    );
  });

  it("mentions batch queueing, detection failures and skips only when present", () => {
    assert.equal(
      formatMaterializationSummary(
        "Records 1–50",
        {
          processed: 49,
          shadesCreated: 3,
          hexDetected: 0,
          imageUploadFailures: 2,
          skipped: 1,
          batchRequestsQueued: 47,
          hexDetectionFailures: 1,
        },
        1234
      ),
      "Records 1–50: 49 shades (3 new), 0 hex detected, 47 queued for batch detection, 1 hex detection failures, 2 upload failures, 1 skipped, 1.2s"
    );
  });
});
