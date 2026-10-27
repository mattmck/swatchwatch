const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

delete process.env.AZURE_STORAGE_CONNECTION;
process.env.HEX_DETECTION_DELAY_MS = "0";

function mockDistModule(relativePath, exports) {
  const resolved = path.resolve(__dirname, "../dist/lib", relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// The unchanged-image lookup is the only pooled query whose SQL mentions detected_hex.
let unchangedLookups;
let unchangedExternalIds;
mockDistModule("db.js", {
  query: async (sql, params) => {
    if (sql.includes("detected_hex IS NOT NULL")) {
      unchangedLookups.push({ sql, checksums: params[6] });
      return { rows: unchangedExternalIds.map((externalId) => ({ externalId })) };
    }
    return { rows: [] };
  },
  transaction: async (callback) => callback({ query: async () => ({ rows: [{ brandId: 1, shadeId: 1, imageId: 1 }] }) }),
});

mockDistModule("blob-storage.js", {
  ensureContainer: async () => {},
  uploadSourceImageToBlob: async ({ sourceImageUrl }) => ({
    storageUrl: `https://blob.example/${encodeURIComponent(sourceImageUrl)}`,
    checksumSha256: `sum-${sourceImageUrl}`,
  }),
});

let detectedOn;
mockDistModule("ai-color-detection.js", {
  detectHexWithAzureOpenAI: async (imageUrl) => {
    detectedOn.push(imageUrl);
    return { hex: "#112233", confidence: 0.9, finishes: ["creme"], usage: null, provider: "azure-openai" };
  },
});
mockDistModule("azure-openai-batch.js", {
  submitVisionHexBatch: async () => {
    throw new Error("batch not expected in these tests");
  },
});

const { materializeHoloTacoRecords } = require("../dist/lib/ingestion-repo");

const PRIMARY = "https://shop.example/bottle.png";
const HAND = "https://shop.example/hand.png";

function record(images) {
  return {
    externalId: "p1",
    raw: {},
    normalized: {
      brand: "Test Brand",
      name: "Shade 1",
      primaryImageUrl: PRIMARY,
      imageUrls: [PRIMARY, HAND],
      images,
      tags: [],
      collections: [],
      finishes: [],
    },
  };
}

const run = (images) => materializeHoloTacoRecords(7, [record(images)], { detectHexFromImage: true });

describe("ingestion AI detection uses the selected image", () => {
  beforeEach(() => {
    unchangedLookups = [];
    unchangedExternalIds = [];
    detectedOn = [];
  });

  it("runs detection on the alt-text swatch and keys the unchanged-image skip to its checksum", async () => {
    await run([
      { url: PRIMARY, alt: "Bottle hero", position: 1 },
      { url: HAND, alt: "Swatch on nails", position: 2 },
    ]);
    assert.deepEqual(detectedOn, [`https://blob.example/${encodeURIComponent(HAND)}`]);
    assert.equal(unchangedLookups.length, 1);
    assert.deepEqual(unchangedLookups[0].checksums, [`sum-${HAND}`]);
    assert.match(unchangedLookups[0].sql, /source_gallery/, "a gallery image chosen for detection can match its gallery swatch");
  });

  it("keys the skip to the primary checksum when falling back to the primary image", async () => {
    await run([
      { url: PRIMARY, alt: null, position: 1 },
      { url: HAND, alt: null, position: 2 },
    ]);
    assert.deepEqual(detectedOn, [`https://blob.example/${encodeURIComponent(PRIMARY)}`]);
    assert.deepEqual(unchangedLookups[0].checksums, [`sum-${PRIMARY}`]);
  });

  it("skips detection when the lookup reports the selected image unchanged", async () => {
    unchangedExternalIds = ["p1"];
    await run([
      { url: PRIMARY, alt: "Bottle hero", position: 1 },
      { url: HAND, alt: "Swatch on nails", position: 2 },
    ]);
    assert.deepEqual(detectedOn, []);
  });
});
