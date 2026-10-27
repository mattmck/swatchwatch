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
// Image ids with a hex ground-truth label (color_training_sample.image_id).
let labeledImageIds;
// Another product of the same data source maps to the shade (shade_source_product).
let sharedShade;
// Perceptual fingerprint the mocked upload returns per image URL (absent = unknown).
let fingerprints;

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
      images.push({ imageId, ownerId: params[0], checksum: params[2], perceptualHash: params[3] ?? null });
      return { rows: [{ imageId }] };
    }
    if (sql.includes("UPDATE image_asset") && sql.includes("perceptual_hash IS NULL")) {
      const image = images.find((img) => img.imageId === params[0] && !img.perceptualHash);
      if (image) image.perceptualHash = params[1];
      return { rows: image ? [{ image_id: params[0] }] : [] };
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
    if (sql.includes("FROM shade_source_product")) {
      return { rows: sharedShade ? [{ "?column?": 1 }] : [] };
    }
    if (sql.includes("DELETE FROM swatch") && sql.includes("<> ALL($3::bigint[])")) {
      const [shadeId, dataSourceId, keep] = params;
      const removed = swatches.filter((sw) => {
        const image = images.find((img) => img.imageId === sw.imageId);
        return (
          sw.shadeId === shadeId &&
          sw.swatchType === "source_gallery" &&
          image &&
          image.ownerId === dataSourceId &&
          !keep.includes(sw.imageId) &&
          !labeledImageIds.includes(sw.imageId)
        );
      });
      swatches = swatches.filter((sw) => !removed.includes(sw));
      return { rows: removed.map((sw) => ({ swatchId: sw.swatchId })) };
    }
    if (sql.includes("DELETE FROM swatch sw") && sql.includes("sw.image_id_original = $2")) {
      // Unlink a skipped (near-duplicate / over-cap) gallery image, never a protected one.
      assert.match(sql, /color_training_sample/);
      const removed = swatches.filter(
        (sw) =>
          sw.shadeId === params[0] &&
          sw.imageId === params[1] &&
          sw.swatchType === "source_gallery" &&
          !labeledImageIds.includes(sw.imageId)
      );
      swatches = swatches.filter((sw) => !removed.includes(sw));
      return { rows: removed.map((sw) => ({ swatch_id: sw.swatchId })) };
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
// URLs containing "fail" simulate a download error.
mockDistModule("blob-storage.js", {
  ensureContainer: async () => {},
  uploadSourceImageToBlob: async ({ sourceImageUrl }) => {
    if (sourceImageUrl.includes("fail")) throw new Error("download failed");
    return {
      storageUrl: `https://blob.example/${encodeURIComponent(sourceImageUrl)}`,
      checksumSha256: `sum-${sourceImageUrl}`,
      fingerprint: fingerprints[sourceImageUrl] ?? null,
    };
  },
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

function record(imageUrls, images) {
  return {
    externalId: "p1",
    raw: {},
    normalized: {
      brand: "Test Brand",
      name: "Shade 1",
      primaryImageUrl: imageUrls[0],
      imageUrls,
      ...(images ? { images } : {}),
      tags: [],
      collections: [],
      finishes: [],
    },
  };
}

const run = (imageUrls, images) =>
  materializeHoloTacoRecords(7, [record(imageUrls, images)], { detectHexFromImage: false });

const imageIdFor = (url) => images.find((img) => img.checksum === `sum-${url}`).imageId;

function swatchSnapshot() {
  return swatches.map(({ swatchId, imageId, swatchType }) => ({ swatchId, imageId, swatchType }));
}

describe("materializeHoloTacoRecords swatch linking", () => {
  beforeEach(() => {
    images = [];
    swatches = [];
    nextId = 0;
    labeledImageIds = [];
    sharedShade = false;
    fingerprints = {};
    delete process.env.GALLERY_MAX_IMAGES_PER_SHADE;
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
  // An older ingest stored different bytes for the same vendor picture (different checksum), so
  // the shade carries a second image_asset + gallery swatch the current run never references.
  function addStaleGallerySwatch(ownerId = 7) {
    const imageId = ++nextId;
    images.push({ imageId, ownerId, checksum: `old-bytes-${imageId}` });
    swatches.push({ swatchId: ++nextId, shadeId: 1, imageId, swatchType: "source_gallery" });
    return imageId;
  }

  const gallerySnapshot = () =>
    swatches.map(({ imageId, swatchType }) => ({ imageId, swatchType }));

  it("leaves exactly the vendor's current gallery after a re-ingest", async () => {
    await run(urls);
    addStaleGallerySwatch();
    addStaleGallerySwatch();

    const metrics = await run(urls);

    assert.equal(metrics.gallerySwatchesPruned, 2);
    assert.deepEqual(gallerySnapshot(), [
      { imageId: imageIdFor(urls[0]), swatchType: "source_product" },
      { imageId: imageIdFor(urls[1]), swatchType: "source_gallery" },
      { imageId: imageIdFor(urls[2]), swatchType: "source_gallery" },
    ]);
  });

  it("unlinks a gallery image the vendor removed", async () => {
    await run(urls);

    const metrics = await run([urls[0], urls[2]]);

    assert.equal(metrics.gallerySwatchesPruned, 1);
    assert.deepEqual(gallerySnapshot(), [
      { imageId: imageIdFor(urls[0]), swatchType: "source_product" },
      { imageId: imageIdFor(urls[2]), swatchType: "source_gallery" },
    ]);
  });

  it("keeps other data sources' images and hex-labelled images", async () => {
    await run(urls);
    const otherSource = addStaleGallerySwatch(99);
    const labelled = addStaleGallerySwatch();
    labeledImageIds = [labelled];
    const stale = addStaleGallerySwatch();

    const metrics = await run(urls);

    assert.equal(metrics.gallerySwatchesPruned, 1);
    const linked = swatches.map((sw) => sw.imageId);
    assert.ok(linked.includes(otherSource));
    assert.ok(linked.includes(labelled));
    assert.ok(!linked.includes(stale));
  });

  it("prunes nothing when one of the product's images failed to download", async () => {
    await run(urls);
    const stale = addStaleGallerySwatch();

    const metrics = await run([urls[0], urls[1], "https://shop.example/fail.png"]);

    assert.equal(metrics.gallerySwatchesPruned, 0);
    assert.ok(swatches.some((sw) => sw.imageId === stale));
    assert.ok(swatches.some((sw) => sw.imageId === imageIdFor(urls[2])));
  });

  it("prunes nothing when another product of the same source maps to the shade", async () => {
    await run(urls);
    const stale = addStaleGallerySwatch();
    sharedShade = true;

    const metrics = await run(urls);

    assert.equal(metrics.gallerySwatchesPruned, 0);
    assert.ok(swatches.some((sw) => sw.imageId === stale));
  });
});

// Fingerprints in the image_asset column format: a "picture" is a hash/thumbnail pair, and a
// re-crop of it differs by a few hash bits and a small thumbnail shift.
function fakeFingerprint(picture, { flippedBits = 0, thumbShift = 0 } = {}) {
  const bits = Array.from({ length: 256 }, (_, i) => ((i * 7 + picture * 13) % 5 < 2 ? 1 : 0));
  for (let i = 0; i < flippedBits; i += 1) bits[i * 9] ^= 1;
  let dhash = "";
  for (let i = 0; i < 256; i += 4) dhash += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
  const thumb = Buffer.alloc(768, Math.min(255, 40 + picture * 50 + thumbShift)).toString("base64");
  return { dhash, thumb, width: 1200, height: 1600 };
}

describe("materializeHoloTacoRecords gallery near-duplicates and cap", () => {
  beforeEach(() => {
    images = [];
    swatches = [];
    nextId = 0;
    labeledImageIds = [];
    sharedShade = false;
    fingerprints = {};
    delete process.env.GALLERY_MAX_IMAGES_PER_SHADE;
  });

  const primary = "https://shop.example/primary.png";
  const hand = "https://shop.example/hand.png";
  const handRecrop = "https://shop.example/hand-recrop.png";
  const macro = "https://shop.example/macro.png";
  const urls = [primary, hand, handRecrop, macro];
  const withFingerprints = () => {
    fingerprints = {
      [primary]: fakeFingerprint(0),
      [hand]: fakeFingerprint(1),
      // 18 bits / thumbnail 15 away: inside the ingest thresholds (64 / 20), outside the cleanup ones.
      [handRecrop]: fakeFingerprint(1, { flippedBits: 18, thumbShift: 15 }),
      [macro]: fakeFingerprint(3),
    };
  };
  const linked = () => swatches.map(({ imageId, swatchType }) => ({ imageId, swatchType }));

  it("stores a near-duplicate image but does not link it, and stays stable on re-ingest", async () => {
    withFingerprints();
    const metrics = await run(urls);

    assert.equal(metrics.galleryNearDuplicatesSkipped, 1);
    assert.equal(metrics.swatchesLinked, 3);
    assert.deepEqual(linked(), [
      { imageId: imageIdFor(primary), swatchType: "source_product" },
      { imageId: imageIdFor(hand), swatchType: "source_gallery" },
      { imageId: imageIdFor(macro), swatchType: "source_gallery" },
    ]);
    // Every image_asset row carries its fingerprint, the skipped one included.
    assert.equal(images.length, 4);
    assert.ok(images.every((img) => /^[0-9a-f]{64}$/.test(img.perceptualHash)));

    const before = swatchSnapshot();
    const again = await run(urls);
    assert.deepEqual(swatchSnapshot(), before);
    assert.equal(again.swatchesLinked, 0);
    assert.equal(again.gallerySwatchesPruned, 0, "the skipped image stays in the prune keep-set");
    assert.equal(again.galleryNearDuplicatesSkipped, 1);
  });

  it("links every image while fingerprints are unknown, then unlinks the near-duplicate once they are", async () => {
    await run(urls);
    assert.equal(swatches.length, 4);

    withFingerprints();
    const metrics = await run(urls);

    assert.equal(metrics.gallerySwatchesPruned, 1);
    assert.ok(!swatches.some((sw) => sw.imageId === imageIdFor(handRecrop)));
    // Existing rows got their fingerprints filled in.
    assert.ok(images.every((img) => img.perceptualHash));
  });

  it("never unlinks a hex-labelled near-duplicate", async () => {
    await run(urls);
    labeledImageIds = [imageIdFor(handRecrop)];
    withFingerprints();

    const metrics = await run(urls);

    assert.equal(metrics.gallerySwatchesPruned, 0);
    assert.ok(swatches.some((sw) => sw.imageId === imageIdFor(handRecrop)));
  });

  it("never unlinks when another product of the same source maps to the shade", async () => {
    await run(urls);
    sharedShade = true;
    withFingerprints();

    const metrics = await run(urls);

    assert.equal(metrics.galleryNearDuplicatesSkipped, 1);
    assert.equal(metrics.gallerySwatchesPruned, 0);
    assert.ok(swatches.some((sw) => sw.imageId === imageIdFor(handRecrop)));
  });

  it("keeps a different picture of the same hand", async () => {
    withFingerprints();
    fingerprints[handRecrop] = fakeFingerprint(1, { flippedBits: 24, thumbShift: 30 });
    const metrics = await run(urls);
    assert.equal(metrics.galleryNearDuplicatesSkipped, 0);
    assert.equal(swatches.length, 4);
  });

  it("links at most GALLERY_MAX_IMAGES_PER_SHADE gallery images", async () => {
    process.env.GALLERY_MAX_IMAGES_PER_SHADE = "1";
    const distinct = [primary, hand, macro, "https://shop.example/bottle-back.png"];
    const metrics = await run(distinct);

    assert.equal(metrics.galleryOverCapSkipped, 2);
    assert.deepEqual(linked(), [
      { imageId: imageIdFor(distinct[0]), swatchType: "source_product" },
      { imageId: imageIdFor(distinct[1]), swatchType: "source_gallery" },
    ]);
    assert.equal(images.length, 4, "images past the cap are still stored");

    // Raising the cap links them on the next run; lowering it unlinks them again.
    delete process.env.GALLERY_MAX_IMAGES_PER_SHADE;
    await run(distinct);
    assert.equal(swatches.length, 4);
    process.env.GALLERY_MAX_IMAGES_PER_SHADE = "2";
    const lowered = await run(distinct);
    assert.equal(lowered.gallerySwatchesPruned, 1);
    assert.equal(swatches.length, 3);
  });

  it("always links the gallery image AI detection chose, even as a near-duplicate or past the cap", async () => {
    withFingerprints();
    process.env.GALLERY_MAX_IMAGES_PER_SHADE = "1";
    const metrics = await run(urls, [
      { url: primary, alt: "Bottle", position: 1 },
      { url: hand, alt: "Hand", position: 2 },
      { url: handRecrop, alt: "Swatch on nails", position: 3 },
      { url: macro, alt: null, position: 4 },
    ]);

    assert.deepEqual(linked(), [
      { imageId: imageIdFor(primary), swatchType: "source_product" },
      { imageId: imageIdFor(handRecrop), swatchType: "source_gallery" },
    ]);
    assert.equal(metrics.galleryNearDuplicatesSkipped, 1);
    assert.equal(metrics.galleryOverCapSkipped, 1);
  });
});
