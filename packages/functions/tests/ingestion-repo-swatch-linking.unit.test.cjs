const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

delete process.env.AZURE_STORAGE_CONNECTION;

function mockDistModule(relativePath, exports) {
  const resolved = path.resolve(__dirname, "../dist/lib", relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ---------------------------------------------------------------------------
// Stateful DB mock: brand/shade always resolve to id 1; image_asset and swatch are kept
// in memory so re-running the same records shows what the materializer does to swatch rows.
// ---------------------------------------------------------------------------

let images;
let swatches;
let nextId;

function swatchTypeFilter(sql) {
  const match = sql.match(/swatch_type = '([a-z_]+)'/);
  return match ? match[1] : null;
}

const transactionClient = {
  async query(sql, params) {
    if (sql.includes("FROM brand")) return { rows: [{ brandId: 1 }] };
    if (sql.includes("FROM shade") && sql.includes("SELECT shade_id")) return { rows: [{ shadeId: 1 }] };

    if (sql.includes("FROM image_asset") && sql.includes("checksum_sha256 = $2")) {
      const found = images.find((img) => img.ownerId === params[0] && img.checksum === params[1]);
      return { rows: found ? [{ imageId: found.imageId }] : [] };
    }
    if (sql.includes("INSERT INTO image_asset")) {
      const imageId = ++nextId;
      images.push({ imageId, ownerId: params[0], checksum: params[2] });
      return { rows: [{ imageId }] };
    }

    if (sql.includes("INSERT INTO swatch")) {
      const swatchType = sql.match(/'(source_[a-z]+)'/)[1];
      swatches.push({ swatchId: ++nextId, shadeId: params[0], imageId: params[1], swatchType });
      return { rows: [] };
    }
    if (sql.includes("UPDATE swatch")) {
      const type = swatchTypeFilter(sql);
      const target = swatches.find(
        (sw) => sw.swatchId === params[0] && (!type || sw.swatchType === type)
      );
      if (target) target.imageId = params[1];
      return { rows: [] };
    }
    if (sql.includes("DELETE FROM swatch")) {
      const type = swatchTypeFilter(sql);
      swatches = swatches.filter(
        (sw) => !(sw.shadeId === params[0] && sw.imageId === params[1] && sw.swatchType === type)
      );
      return { rows: [] };
    }
    if (sql.includes("FROM swatch") && sql.includes("image_id_original = $2")) {
      const found = swatches.find((sw) => sw.shadeId === params[0] && sw.imageId === params[1]);
      return { rows: found ? [{ swatchId: found.swatchId }] : [] };
    }
    if (sql.includes("FROM swatch") && sql.includes("ORDER BY swatch_id DESC")) {
      const type = swatchTypeFilter(sql);
      const [latest] = swatches
        .filter((sw) => sw.shadeId === params[0] && (!type || sw.swatchType === type))
        .sort((a, b) => b.swatchId - a.swatchId);
      return { rows: latest ? [{ swatchId: latest.swatchId, imageIdOriginal: latest.imageId }] : [] };
    }

    return { rows: [] };
  },
};

mockDistModule("db.js", {
  query: async () => ({ rows: [] }),
  transaction: async (callback) => callback(transactionClient),
});

// Each upload's checksum is derived from its URL, so changing a URL changes the image.
mockDistModule("blob-storage.js", {
  ensureContainer: async () => {},
  uploadSourceImageToBlob: async ({ sourceImageUrl }) => ({
    storageUrl: `https://blob.example/${encodeURIComponent(sourceImageUrl)}`,
    checksumSha256: `sum-${sourceImageUrl}`,
  }),
});

mockDistModule("ai-color-detection.js", {
  detectHexWithAzureOpenAI: async () => {
    throw new Error("AI not expected in these tests");
  },
});

mockDistModule("azure-openai-batch.js", {
  submitVisionHexBatch: async () => {
    throw new Error("batch not expected in these tests");
  },
});

const { materializeHoloTacoRecords } = require("../dist/lib/ingestion-repo");

function record(imageUrls) {
  return {
    externalId: "p1",
    raw: {},
    normalized: {
      brand: "Test Brand",
      name: "Shade 1",
      primaryImageUrl: imageUrls[0],
      imageUrls,
      tags: [],
      collections: [],
      finishes: [],
    },
  };
}

const run = (imageUrls) =>
  materializeHoloTacoRecords(1, 7, [record(imageUrls)], { detectHexFromImage: false });

const imageIdFor = (url) => images.find((img) => img.checksum === `sum-${url}`).imageId;

function swatchSnapshot() {
  return swatches.map(({ swatchId, imageId, swatchType }) => ({ swatchId, imageId, swatchType }));
}

describe("materializeHoloTacoRecords swatch linking", () => {
  beforeEach(() => {
    images = [];
    swatches = [];
    nextId = 0;
  });

  const urls = [
    "https://shop.example/primary.png",
    "https://shop.example/gallery-1.png",
    "https://shop.example/gallery-2.png",
  ];

  it("links one product swatch and one gallery swatch per additional image", async () => {
    const metrics = await run(urls);

    assert.equal(metrics.swatchesLinked, 3);
    assert.deepEqual(
      swatches.map(({ imageId, swatchType }) => ({ imageId, swatchType })),
      [
        { imageId: imageIdFor(urls[0]), swatchType: "source_product" },
        { imageId: imageIdFor(urls[1]), swatchType: "source_gallery" },
        { imageId: imageIdFor(urls[2]), swatchType: "source_gallery" },
      ]
    );
  });

  it("leaves swatches untouched when the same record is ingested again", async () => {
    await run(urls);
    const afterFirstRun = swatchSnapshot();

    const metrics = await run(urls);

    assert.deepEqual(swatchSnapshot(), afterFirstRun);
    assert.equal(metrics.swatchesLinked, 0);
  });

  it("repoints only the product swatch when the primary image changes", async () => {
    await run(urls);
    const [productSwatch, ...gallerySwatches] = swatchSnapshot();

    const newPrimary = "https://shop.example/primary-v2.png";
    const metrics = await run([newPrimary, urls[1], urls[2]]);

    assert.equal(metrics.swatchesLinked, 1);
    assert.deepEqual(swatchSnapshot(), [
      { ...productSwatch, imageId: imageIdFor(newPrimary) },
      ...gallerySwatches,
    ]);
  });

  it("swaps roles when the shop promotes a gallery image to primary", async () => {
    await run(urls);
    const [productSwatch, , gallery2] = swatchSnapshot();

    await run([urls[1], urls[0], urls[2]]);

    const after = swatchSnapshot();
    assert.deepEqual(after.slice(0, 2), [
      { ...productSwatch, imageId: imageIdFor(urls[1]) },
      gallery2,
    ]);
    assert.equal(after.length, 3);
    assert.deepEqual(
      { imageId: after[2].imageId, swatchType: after[2].swatchType },
      { imageId: imageIdFor(urls[0]), swatchType: "source_gallery" }
    );
  });

  it("drops gallery swatches a previous run pointed at the primary image", async () => {
    await run(urls);
    const [productSwatch, gallery1, gallery2] = swatchSnapshot();
    // State left by the old lookup: newest gallery swatch repointed at the primary, plus its replacement.
    swatches[2].imageId = productSwatch.imageId;
    swatches.push({ swatchId: ++nextId, shadeId: 1, imageId: gallery2.imageId, swatchType: "source_gallery" });

    await run(urls);

    assert.deepEqual(
      swatchSnapshot().map(({ imageId, swatchType }) => ({ imageId, swatchType })),
      [productSwatch, gallery1, gallery2].map(({ imageId, swatchType }) => ({ imageId, swatchType }))
    );
  });
});
