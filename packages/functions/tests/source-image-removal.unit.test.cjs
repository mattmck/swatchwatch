const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { runSourceImageRemovalBatch } = require("../dist/lib/source-image-removal");
const { parseSourceImageRemovalBody } = require("../dist/functions/source-images-admin");

const BLOB = "https://acct.blob.core.windows.net/source-images";

/**
 * In-memory catalog for one disabled source (id 7) and another source (id 8):
 * image 10 labeled (color_training_sample), 11 plain, 12 shares its checksum with source 8's
 * image 90, 13 has a swatch with color_features.
 */
function makeDb({ enabled = false, sourceExists = true } = {}) {
  const state = {
    sources: sourceExists ? [{ data_source_id: 7, name: "Gone Store", enabled }] : [],
    images: [
      { image_id: 10, owner_type: "source", owner_id: 7, storage_url: `${BLOB}/7/a.jpg`, checksum_sha256: "aaa" },
      { image_id: 11, owner_type: "source", owner_id: 7, storage_url: `${BLOB}/7/b.jpg`, checksum_sha256: "bbb" },
      { image_id: 12, owner_type: "source", owner_id: 7, storage_url: `${BLOB}/7/c.jpg`, checksum_sha256: "ccc" },
      { image_id: 13, owner_type: "source", owner_id: 7, storage_url: `${BLOB}/7/d.jpg`, checksum_sha256: "ddd" },
      { image_id: 90, owner_type: "source", owner_id: 8, storage_url: `${BLOB}/8/c.jpg`, checksum_sha256: "ccc" },
    ],
    swatches: [
      { swatch_id: 100, shade_id: 1, image_id_original: 10, image_id_normalized: null, swatch_type: "source_product" },
      { swatch_id: 101, shade_id: 2, image_id_original: 11, image_id_normalized: null, swatch_type: "source_product" },
      { swatch_id: 102, shade_id: 2, image_id_original: 11, image_id_normalized: null, swatch_type: "source_gallery" },
      { swatch_id: 103, shade_id: 3, image_id_original: 12, image_id_normalized: null, swatch_type: "source_gallery" },
      { swatch_id: 104, shade_id: 4, image_id_original: 13, image_id_normalized: null, swatch_type: "source_product" },
      { swatch_id: 105, shade_id: 3, image_id_original: 90, image_id_normalized: null, swatch_type: "source_product" },
    ],
    labels: [{ image_id: 10 }],
    colorFeatures: [{ swatch_id: 104 }],
  };
  const statements = [];

  function flags(image) {
    const swatches = state.swatches.filter(
      (s) => s.image_id_original === image.image_id || s.image_id_normalized === image.image_id
    );
    return {
      imageId: image.image_id,
      storageUrl: image.storage_url,
      labeled: state.labels.some((l) => l.image_id === image.image_id),
      colorFeatures: swatches.some((s) => state.colorFeatures.some((cf) => cf.swatch_id === s.swatch_id)),
      swatchCount: swatches.length,
      sharedBlob: state.images.some(
        (other) =>
          other.image_id !== image.image_id &&
          (other.storage_url === image.storage_url ||
            (image.checksum_sha256 !== null && other.checksum_sha256 === image.checksum_sha256))
      ),
    };
  }

  async function query(sql, params) {
    statements.push(sql);
    if (/FROM data_source/.test(sql) && /data_source_id = \$1/.test(sql)) {
      return { rows: state.sources.filter((s) => s.data_source_id === params[0]).map((s) => ({ enabled: s.enabled })) };
    }
    if (/FROM data_source/.test(sql)) {
      return { rows: state.sources.filter((s) => s.name === params[0]).map((s) => ({ dataSourceId: s.data_source_id, enabled: s.enabled })) };
    }
    if (/DELETE FROM swatch/.test(sql)) {
      const id = params[0];
      if (state.failSwatchDeleteFor === id) {
        throw new Error('update or delete on table "swatch" violates foreign key constraint');
      }
      const removed = state.swatches.filter((s) => s.image_id_original === id || s.image_id_normalized === id);
      state.swatches = state.swatches.filter((s) => !removed.includes(s));
      return { rows: removed.map((s) => ({ swatchId: s.swatch_id })) };
    }
    if (/DELETE FROM image_asset/.test(sql)) {
      const id = params[0];
      const removed = state.images.filter((i) => i.image_id === id);
      state.images = state.images.filter((i) => i.image_id !== id);
      return { rows: removed.map((i) => ({ imageId: i.image_id })) };
    }
    if (/FOR UPDATE/.test(sql)) {
      const [imageId, ownerId] = params;
      const rows = state.images
        .filter((i) => i.image_id === imageId && i.owner_type === "source" && i.owner_id === ownerId)
        .map(flags);
      if (state.afterReRead) state.afterReRead(imageId);
      return { rows };
    }
    if (/FROM image_asset ia/.test(sql)) {
      const [ownerId, after, limit] = params;
      const rows = state.images
        .filter((i) => i.owner_type === "source" && i.owner_id === ownerId && i.image_id > after)
        .sort((a, b) => a.image_id - b.image_id)
        .slice(0, limit)
        .map(flags);
      return { rows };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  const deps = {
    query,
    transaction: async (callback) => callback({ query }),
    deleted: [],
    ownsBlob: (url) => url.startsWith(BLOB),
    deleteBlob: async (url) => {
      deps.deleted.push(url);
      return true;
    },
  };
  return { state, statements, deps };
}

const base = { sourceName: "Gone Store", afterImageId: 0, limit: 100 };

describe("runSourceImageRemovalBatch", () => {
  it("unlinks and deletes unprotected images, keeps labeled / color_features ones and shared blobs", async () => {
    const { state, deps } = makeDb();
    const outcome = await runSourceImageRemovalBatch(deps, { ...base, dryRun: false });
    assert.equal(outcome.status, "ok");
    const result = outcome.result;

    assert.equal(result.dryRun, false);
    assert.equal(result.scanned, 4);
    assert.equal(result.swatchesUnlinked, 3); // 101, 102 (image 11), 103 (image 12)
    assert.equal(result.imagesDeleted, 2); // 11, 12
    assert.equal(result.blobsDeleted, 1); // only image 11's blob; 12's is shared
    assert.deepEqual(result.kept, [
      { imageId: 10, reason: "labeled" },
      { imageId: 12, reason: "shared_blob" },
      { imageId: 13, reason: "color_features" },
    ]);
    assert.deepEqual(result.failures, []);
    assert.equal(result.nextAfterImageId, null);

    // Labeled image: row, swatch and blob untouched.
    assert.ok(state.images.some((i) => i.image_id === 10));
    assert.ok(state.swatches.some((s) => s.swatch_id === 100));
    assert.ok(state.swatches.some((s) => s.swatch_id === 104));
    // Shared checksum: row and swatch gone, other source's row stays.
    assert.ok(!state.images.some((i) => i.image_id === 12));
    assert.ok(state.images.some((i) => i.image_id === 90));
    assert.ok(state.swatches.some((s) => s.swatch_id === 105));

    // Image 11: original blob + 4 variants, nothing else.
    assert.equal(deps.deleted.length, 5);
    assert.ok(deps.deleted.every((url) => url.startsWith(`${BLOB}/7/b.jpg`)));
    assert.ok(deps.deleted.includes(`${BLOB}/7/b.jpg`));
    for (const size of [64, 128, 256, 512]) {
      assert.ok(deps.deleted.some((url) => url.includes(`.w${size}.webp`)), `variant ${size}`);
    }
  });

  it("dry run computes the counts but issues no DELETE and touches no blob", async () => {
    const { state, statements, deps } = makeDb();
    const before = JSON.stringify(state);
    const outcome = await runSourceImageRemovalBatch(deps, { ...base, dryRun: true });
    const result = outcome.result;
    assert.equal(result.dryRun, true);
    assert.equal(result.scanned, 4);
    assert.equal(result.swatchesUnlinked, 3);
    assert.equal(result.imagesDeleted, 2);
    assert.equal(result.blobsDeleted, 1);
    assert.deepEqual(
      result.kept.map((k) => k.reason),
      ["labeled", "shared_blob", "color_features"]
    );
    assert.ok(!statements.some((sql) => /DELETE/.test(sql)));
    assert.equal(deps.deleted.length, 0);
    assert.equal(JSON.stringify(state), before);
  });

  it("refuses an enabled source before any scan, and an unknown source", async () => {
    const enabled = makeDb({ enabled: true });
    const outcome = await runSourceImageRemovalBatch(enabled.deps, { ...base, dryRun: true });
    assert.equal(outcome.status, "source_enabled");
    assert.ok(!enabled.statements.some((sql) => /image_asset/.test(sql)));

    const missing = makeDb({ sourceExists: false });
    assert.equal((await runSourceImageRemovalBatch(missing.deps, { ...base, dryRun: true })).status, "not_found");
  });

  it("pages by image_id: nextAfterImageId on a full page, null on a short one", async () => {
    const { deps } = makeDb();
    const first = (await runSourceImageRemovalBatch(deps, { ...base, limit: 2, dryRun: true })).result;
    assert.equal(first.scanned, 2);
    assert.equal(first.nextAfterImageId, 11);
    const second = (await runSourceImageRemovalBatch(deps, { ...base, afterImageId: 11, limit: 3, dryRun: true })).result;
    assert.equal(second.scanned, 2);
    assert.equal(second.nextAfterImageId, null);
  });

  it("records a blob delete failure without rolling back the row", async () => {
    const { state, deps } = makeDb();
    deps.deleteBlob = async () => {
      throw new Error("boom");
    };
    const result = (await runSourceImageRemovalBatch(deps, { ...base, dryRun: false })).result;
    assert.equal(result.imagesDeleted, 2);
    assert.equal(result.blobsDeleted, 0);
    assert.deepEqual(result.failures, [{ imageId: 11, error: "boom" }]);
    assert.ok(!state.images.some((i) => i.image_id === 11));
  });
});

describe("runSourceImageRemovalBatch guards", () => {
  it("scans and re-reads only the source's own images", async () => {
    const { statements, deps } = makeDb();
    await runSourceImageRemovalBatch(deps, { ...base, dryRun: false });
    const scan = statements.find((sql) => /FROM image_asset ia/.test(sql) && /LIMIT/.test(sql));
    assert.match(scan, /owner_type = 'source'/);
    assert.match(scan, /owner_id = \$1/);
    const reRead = statements.find((sql) => /FOR UPDATE/.test(sql));
    assert.match(reRead, /ia\.owner_type = 'source'/);
    assert.match(reRead, /ia\.owner_id = \$2/);
  });

  it("records an image whose transaction throws and carries on with the batch", async () => {
    const { state, deps } = makeDb();
    state.failSwatchDeleteFor = 11;
    const result = (await runSourceImageRemovalBatch(deps, { ...base, dryRun: false })).result;
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].imageId, 11);
    assert.match(result.failures[0].error, /foreign key/);
    assert.ok(state.images.some((i) => i.image_id === 11), "image 11 kept after its failed transaction");
    assert.ok(!state.images.some((i) => i.image_id === 12), "image 12 still removed");
    assert.equal(result.imagesDeleted, 1);
  });

  it("dry run and real run agree on blobsDeleted for an image kept at its vendor URL (0)", async () => {
    const withVendorImage = () => {
      const db = makeDb();
      db.state.images = [
        { image_id: 20, owner_type: "source", owner_id: 7, storage_url: "https://vendor.example/p.jpg", checksum_sha256: null },
      ];
      db.state.swatches = [];
      db.state.labels = [];
      return db;
    };
    const dry = (await runSourceImageRemovalBatch(withVendorImage().deps, { ...base, dryRun: true })).result;
    const realDb = withVendorImage();
    const real = (await runSourceImageRemovalBatch(realDb.deps, { ...base, dryRun: false })).result;
    assert.equal(dry.blobsDeleted, 0);
    assert.equal(real.blobsDeleted, 0);
    assert.equal(dry.imagesDeleted, 1);
    assert.equal(real.imagesDeleted, 1);
    assert.deepEqual(realDb.deps.deleted, [], "no blob delete for a URL that is not ours");
  });

  it("aborts with source_enabled when the source is re-enabled during the batch", async () => {
    const { state, deps } = makeDb();
    state.afterReRead = () => {
      state.sources[0].enabled = true;
    };
    const outcome = await runSourceImageRemovalBatch(deps, { ...base, dryRun: false });
    assert.equal(outcome.status, "source_enabled");
    // Image 10 (labeled) was re-read before the flip; nothing after it was removed.
    assert.ok(state.images.some((i) => i.image_id === 11));
  });

  it("stops after the time budget and returns the cursor of the last finished image", async () => {
    const { deps } = makeDb();
    let clock = 0;
    const now = () => {
      const value = clock;
      clock += 30_000;
      return value;
    };
    const result = (await runSourceImageRemovalBatch(deps, { ...base, dryRun: true }, { now, timeBudgetMs: 45_000 }))
      .result;
    // start=0; before image 10: first image always runs; before 11: 30s; before 12: 60s >= 45s.
    assert.equal(result.scanned, 2);
    assert.equal(result.nextAfterImageId, 11);
  });
});

describe("parseSourceImageRemovalBody", () => {
  it("takes exactly one source name and applies the defaults", () => {
    assert.deepEqual(parseSourceImageRemovalBody({ sources: ["Gone Store"] }), {
      sourceName: "Gone Store",
      afterImageId: 0,
      limit: 100,
      dryRun: true,
    });
    assert.deepEqual(parseSourceImageRemovalBody({ sources: [" Gone Store "], afterImageId: 5, limit: 500, dryRun: false }), {
      sourceName: "Gone Store",
      afterImageId: 5,
      limit: 500,
      dryRun: false,
    });
  });

  it("rejects missing, several or non-string sources, sourceName, and bad paging", () => {
    for (const body of [
      {},
      { sources: [] },
      { sources: ["a", "b"] },
      { sources: [3] },
      { sources: [" "] },
      { sources: "a" },
      { sourceName: "a" },
      { sources: ["a"], limit: 501 },
      { sources: ["a"], limit: 0 },
      { sources: ["a"], afterImageId: -1 },
      { sources: ["a"], dryRun: "no" },
    ]) {
      assert.equal(typeof parseSourceImageRemovalBody(body), "string", JSON.stringify(body));
    }
  });
});
