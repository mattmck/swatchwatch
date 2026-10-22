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
// DB mock: top-level query() serves the stored-image and unchanged-hex lookups;
// the transaction client records the source_image_url writes.
// ---------------------------------------------------------------------------

let storedImageHandler;
let storedImageCalls;
let unchangedLookupCalls;
let sourceUrlWrites;
let idSequence;

const transactionClient = {
  async query(sql, params) {
    if (sql.includes("INSERT INTO source_image_url")) {
      sourceUrlWrites.push({ dataSourceId: params[0], sourceUrl: params[1], imageId: params[2] });
      return { rows: [] };
    }
    if (sql.includes("RETURNING brand_id")) return { rows: [{ brandId: 1 }] };
    if (sql.includes("RETURNING shade_id")) return { rows: [{ shadeId: ++idSequence }] };
    if (sql.includes("RETURNING image_id")) return { rows: [{ imageId: ++idSequence }] };
    return { rows: [] };
  },
};

mockDistModule("db.js", {
  query: async (sql, params) => {
    if (sql.includes("FROM source_image_url")) {
      storedImageCalls.push(params);
      return { rows: await storedImageHandler(params) };
    }
    if (sql.includes("product_category_source = 'admin'")) return { rows: [] };
    if (sql.includes("WITH input AS")) {
      unchangedLookupCalls.push(params);
      return { rows: [] };
    }
    return { rows: [] };
  },
  transaction: async (callback) => callback(transactionClient),
});

let uploadCalls;

mockDistModule("ai-color-detection.js", {
  detectHexWithAzureOpenAI: async () => ({
    hex: "#112233",
    finishes: ["creme"],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }),
});

mockDistModule("blob-storage.js", {
  ensureContainer: async () => {},
  uploadSourceImageToBlob: async ({ sourceImageUrl, externalId }) => {
    uploadCalls.push(sourceImageUrl);
    return {
      storageUrl: `https://blob.example/${externalId}.png`,
      checksumSha256: `fresh-${externalId}`,
    };
  },
});

mockDistModule("azure-openai-batch.js", {
  submitVisionHexBatch: async () => {
    throw new Error("batch not expected in these tests");
  },
});

const { materializeHoloTacoRecords } = require("../dist/lib/ingestion-repo");

const primaryUrl = (index) => `https://shop.example/p${index}.png?v=1`;
const galleryUrl = (index) => `https://shop.example/p${index}-alt.png?v=1`;

function record(index) {
  return {
    externalId: `p${index}`,
    raw: {},
    normalized: {
      brand: "Test Brand",
      name: `Shade ${index}`,
      primaryImageUrl: primaryUrl(index),
      imageUrls: [primaryUrl(index), galleryUrl(index)],
      tags: [],
      collections: [],
      finishes: [],
    },
  };
}

const stored = (sourceUrl) => ({
  sourceUrl,
  storageUrl: `https://blob.example/stored/${encodeURIComponent(sourceUrl)}`,
  checksumSha256: `stored-${sourceUrl}`,
});

describe("materializeHoloTacoRecords source image reuse", () => {
  beforeEach(() => {
    storedImageHandler = async () => [];
    storedImageCalls = [];
    unchangedLookupCalls = [];
    sourceUrlWrites = [];
    uploadCalls = [];
    idSequence = 0;
  });

  it("looks up every primary and gallery URL for the data source in one query", async () => {
    await materializeHoloTacoRecords(1, 7, [record(0), record(1)], { detectHexFromImage: false });

    assert.equal(storedImageCalls.length, 1);
    const [dataSourceId, urls] = storedImageCalls[0];
    assert.equal(dataSourceId, 7);
    assert.deepEqual(
      [...urls].sort(),
      [primaryUrl(0), galleryUrl(0), primaryUrl(1), galleryUrl(1)].sort()
    );
  });

  it("skips the download for URLs that already have a stored image", async () => {
    storedImageHandler = async () => [stored(primaryUrl(0)), stored(galleryUrl(0))];

    const metrics = await materializeHoloTacoRecords(1, 7, [record(0)], { detectHexFromImage: true });

    assert.deepEqual(uploadCalls, []);
    assert.equal(metrics.imagesReused, 2);
    assert.equal(metrics.imageUploads, 0);
    assert.equal(metrics.additionalImagesUploaded, 0);
    assert.equal(metrics.imageUploadFailures, 0);
    // The unchanged-hex check sees the stored checksum, so reruns still skip AI.
    assert.deepEqual(unchangedLookupCalls[0][6], [`stored-${primaryUrl(0)}`]);
  });

  it("downloads only the URLs that are not stored yet", async () => {
    storedImageHandler = async () => [stored(primaryUrl(0))];

    const metrics = await materializeHoloTacoRecords(1, 7, [record(0)], { detectHexFromImage: false });

    assert.deepEqual(uploadCalls, [galleryUrl(0)]);
    assert.equal(metrics.imagesReused, 1);
    assert.equal(metrics.imageUploads, 0);
    assert.equal(metrics.additionalImagesUploaded, 1);
  });

  it("records the source URL of every stored image", async () => {
    storedImageHandler = async () => [stored(primaryUrl(0))];

    await materializeHoloTacoRecords(1, 7, [record(0)], { detectHexFromImage: false });

    assert.deepEqual(
      sourceUrlWrites.map(({ dataSourceId, sourceUrl }) => ({ dataSourceId, sourceUrl })),
      [
        { dataSourceId: 7, sourceUrl: primaryUrl(0) },
        { dataSourceId: 7, sourceUrl: galleryUrl(0) },
      ]
    );
    assert.ok(sourceUrlWrites.every((write) => Number.isInteger(write.imageId)));
  });

  it("downloads everything when the stored-image lookup fails", async () => {
    storedImageHandler = async () => {
      throw new Error("relation \"source_image_url\" does not exist");
    };

    const metrics = await materializeHoloTacoRecords(1, 7, [record(0)], { detectHexFromImage: false });

    assert.deepEqual(uploadCalls.sort(), [primaryUrl(0), galleryUrl(0)].sort());
    assert.equal(metrics.imagesReused, 0);
    assert.equal(metrics.imageUploads, 1);
  });
});
