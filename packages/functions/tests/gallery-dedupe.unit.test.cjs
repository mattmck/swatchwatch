const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const {
  computeImageFingerprint,
  compareFingerprints,
  DEFAULT_DEDUPE_THRESHOLDS,
  fingerprintFromColumns,
  fingerprintToColumns,
  getGalleryMaxImagesPerShade,
  INGEST_NEAR_DUPLICATE_THRESHOLDS,
  planProductGalleryLinks,
  planShadeGalleryDedupe,
  runGalleryDedupeBatch,
} = require("../dist/lib/gallery-dedupe");
const nearDuplicateFixture = require("./fixtures/gallery-near-duplicates.json");
const { parseGalleryDedupeBody } = require("../dist/functions/gallery-dedupe-admin");

// ---------------------------------------------------------------------------
// Synthetic product photos: a polish-colored "bottle" or "nails" on a noisy background, so
// re-encodes behave like photos (thresholds were measured on real vendor images, see
// DEFAULT_DEDUPE_THRESHOLDS). Same polish color everywhere: different pictures of one shade
// must not be merged just because they share a color.
// ---------------------------------------------------------------------------

function seededNoise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Raw RGB photo: background gradient + noise, then polish-colored shapes. */
function photo({ width = 480, height = 480, seed, shapes }) {
  const noise = seededNoise(seed);
  const data = Buffer.alloc(width * height * 3);
  const polish = [92, 24, 120];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      let rgb = [225 - (y / height) * 40, 215 - (x / width) * 30, 205];
      for (const s of shapes) {
        const dx = (x / width - s.cx) / s.rx;
        const dy = (y / height - s.cy) / s.ry;
        if (s.kind === "rect" ? Math.abs(dx) <= 1 && Math.abs(dy) <= 1 : dx * dx + dy * dy <= 1) {
          const shade = s.kind === "rect" ? 1 - 0.35 * Math.abs(dx) : 0.75 + 0.25 * (1 - dx * dx - dy * dy);
          rgb = polish.map((c) => c * shade);
        }
      }
      const n = (noise() - 0.5) * 24;
      data[i] = Math.max(0, Math.min(255, rgb[0] + n));
      data[i + 1] = Math.max(0, Math.min(255, rgb[1] + n));
      data[i + 2] = Math.max(0, Math.min(255, rgb[2] + n));
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } });
}

const nails = (offset) =>
  [0.2, 0.4, 0.6, 0.8].map((cx, k) => ({ kind: "ellipse", cx: cx + offset, cy: 0.45 + (k % 2) * 0.08, rx: 0.07, ry: 0.14 }));

const PICTURES = {
  bottle: { seed: 1, shapes: [{ kind: "rect", cx: 0.5, cy: 0.6, rx: 0.18, ry: 0.3 }, { kind: "rect", cx: 0.5, cy: 0.18, rx: 0.06, ry: 0.12 }] },
  nailsLeft: { seed: 2, shapes: nails(-0.05) },
  nailsRight: { seed: 3, shapes: nails(0.08) },
  macro: { seed: 4, shapes: [{ kind: "ellipse", cx: 0.5, cy: 0.5, rx: 0.42, ry: 0.36 }] },
};

/** The same picture as several pipelines could have stored it. */
const ENCODINGS = {
  jpeg: (img) => img.clone().jpeg({ quality: 90 }).toBuffer(),
  jpegLow: (img) => img.clone().resize(320).jpeg({ quality: 60 }).toBuffer(),
  webp: (img) => img.clone().resize(400).webp({ quality: 70 }).toBuffer(),
  png: (img) => img.clone().resize(640).png().toBuffer(),
};

const fp = {};

before(async () => {
  for (const [name, spec] of Object.entries(PICTURES)) {
    fp[name] = {};
    for (const [encoding, encode] of Object.entries(ENCODINGS)) {
      fp[name][encoding] = await computeImageFingerprint(await encode(photo(spec)));
    }
  }
  // A re-crop to another shape is a different image to the vendor gallery.
  fp.bottle.wide = await computeImageFingerprint(
    await photo({ ...PICTURES.bottle, width: 720 }).jpeg({ quality: 90 }).toBuffer()
  );
});

describe("compareFingerprints", () => {
  it("matches the same picture across re-encodes, resizes and formats", () => {
    for (const name of Object.keys(PICTURES)) {
      const encodings = Object.keys(ENCODINGS);
      for (const other of encodings.slice(1)) {
        const comparison = compareFingerprints(fp[name].jpeg, fp[name][other]);
        assert.equal(comparison.duplicate, true, `${name} jpeg vs ${other}: ${JSON.stringify(comparison)}`);
      }
    }
  });

  it("keeps different pictures of the same polish apart", () => {
    const names = Object.keys(PICTURES);
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        for (const encoding of Object.keys(ENCODINGS)) {
          const comparison = compareFingerprints(fp[names[i]].jpeg, fp[names[j]][encoding]);
          assert.equal(comparison.duplicate, false, `${names[i]} vs ${names[j]} ${encoding}: ${JSON.stringify(comparison)}`);
        }
      }
    }
  });

  it("does not match a picture to a crop with another aspect ratio", () => {
    assert.equal(compareFingerprints(fp.bottle.jpeg, fp.bottle.wide).duplicate, false);
  });
});

function image(swatchId, imageId, fingerprint, extra = {}) {
  return {
    swatchId,
    imageId,
    swatchType: "source_gallery",
    hasSourceUrl: false,
    protected: false,
    fingerprint,
    ...extra,
  };
}

describe("planShadeGalleryDedupe", () => {
  it("keeps the product swatch and removes old gallery copies of the same picture", () => {
    const groups = planShadeGalleryDedupe([
      image(1, 10, fp.bottle.jpeg, { swatchType: "source_product", hasSourceUrl: true }),
      image(2, 11, fp.nailsLeft.jpeg, { hasSourceUrl: true }),
      image(3, 5, fp.bottle.webp),
      image(4, 6, fp.nailsLeft.png),
      image(5, 12, fp.nailsRight.jpeg, { hasSourceUrl: true }),
    ]);

    assert.deepEqual(
      groups.map(({ keepSwatchId, removeSwatchIds, keptSwatchIds }) => ({ keepSwatchId, removeSwatchIds, keptSwatchIds })),
      [
        { keepSwatchId: 1, removeSwatchIds: [3], keptSwatchIds: [] },
        { keepSwatchId: 2, removeSwatchIds: [4], keptSwatchIds: [] },
      ]
    );
  });

  it("prefers the copy with a vendor URL, then the newest image", () => {
    const [withUrl] = planShadeGalleryDedupe([
      image(1, 20, fp.macro.jpeg),
      image(2, 21, fp.macro.png, { hasSourceUrl: true }),
      image(3, 22, fp.macro.webp),
    ]);
    assert.equal(withUrl.keepSwatchId, 2);
    assert.deepEqual(withUrl.removeSwatchIds.sort(), [1, 3]);

    const [newest] = planShadeGalleryDedupe([image(1, 20, fp.macro.jpeg), image(2, 30, fp.macro.png)]);
    assert.equal(newest.keepImageId, 30);
    assert.deepEqual(newest.removeImageIds, [20]);
  });

  it("never removes protected swatches, current-pipeline images or unreadable images", () => {
    const groups = planShadeGalleryDedupe([
      image(1, 10, fp.bottle.jpeg, { swatchType: "source_product", hasSourceUrl: true }),
      image(2, 11, fp.bottle.png, { protected: true }),
      image(3, 12, fp.bottle.webp, { hasSourceUrl: true }),
      image(4, 13, null),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].removeSwatchIds, []);
    assert.deepEqual(groups[0].keptSwatchIds.sort(), [2, 3]);
  });

  it("groups two swatches of the same image id without reading it", () => {
    const [group] = planShadeGalleryDedupe([image(1, 10, null), image(2, 10, null)]);
    assert.equal(group.keepSwatchId, 1);
    assert.deepEqual(group.removeSwatchIds, [2]);
  });
});

describe("runGalleryDedupeBatch", () => {
  // Shade 294-like fixture: the vendor's 4 pictures stored by the current pipeline (with URLs)
  // plus the same 4 stored again by an older ingest; shade 300 has 2 distinct pictures; shade
  // 301 only one image (never read).
  function fixture(storedFingerprints = {}) {
    const blobs = {
      "cur-bottle": ["bottle", "jpeg"],
      "cur-left": ["nailsLeft", "jpeg"],
      "cur-right": ["nailsRight", "jpeg"],
      "cur-macro": ["macro", "jpeg"],
      "old-bottle": ["bottle", "png"],
      "old-left": ["nailsLeft", "webp"],
      "old-right": ["nailsRight", "jpegLow"],
      "old-macro": ["macro", "webp"],
    };
    const rows = [
      [294, 1, 101, "source_product", "cur-bottle", true],
      [294, 2, 102, "source_gallery", "cur-left", true],
      [294, 3, 103, "source_gallery", "cur-right", true],
      [294, 4, 104, "source_gallery", "cur-macro", true],
      [294, 5, 51, "source_gallery", "old-bottle", false],
      [294, 6, 52, "source_gallery", "old-left", false],
      [294, 7, 53, "source_gallery", "old-right", false],
      [294, 8, 54, "source_gallery", "old-macro", false],
      [300, 9, 201, "source_product", "cur-bottle", true],
      [300, 10, 202, "source_gallery", "cur-left", true],
      [301, 11, 301, "source_gallery", "cur-macro", true],
    ].map(([shadeId, swatchId, imageId, swatchType, storageUrl, hasSourceUrl]) => ({
      shadeId: String(shadeId),
      swatchId: String(swatchId),
      imageId: String(imageId),
      swatchType,
      storageUrl,
      hasSourceUrl,
      protected: false,
      // node-postgres shape of the image_asset fingerprint columns (all null = not computed yet).
      ...(storedFingerprints[storageUrl] ?? fingerprintToColumns(null)),
    }));
    const deletes = [];
    const reads = [];
    const fingerprintWrites = [];
    const query = async (sql, params) => {
      if (sql.includes("SELECT DISTINCT sw.shade_id")) {
        const [after, limit, only] = params;
        const ids = [...new Set(rows.map((r) => Number(r.shadeId)))]
          .filter((id) => id > after && (!only || only.includes(id)))
          .sort((a, b) => a - b)
          .slice(0, limit);
        return { rows: ids.map((shadeId) => ({ shadeId: String(shadeId) })) };
      }
      if (sql.includes("FROM swatch sw") && sql.includes("ANY($1::bigint[])")) {
        return { rows: rows.filter((r) => params[0].includes(Number(r.shadeId))) };
      }
      if (sql.includes("UPDATE image_asset") && sql.includes("perceptual_hash IS NULL")) {
        fingerprintWrites.push({ imageId: params[0], perceptualHash: params[1], thumbBytes: params[2].length, width: params[3] });
        return { rows: [{ image_id: params[0] }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    const deps = {
      query,
      transaction: async (callback) =>
        callback({
          query: async (sql, params) => {
            assert.match(sql, /DELETE FROM swatch/);
            deletes.push({ swatchIds: params[0], shadeId: params[1], keepSwatchId: params[2] });
            return { rows: params[0].map((id) => ({ swatch_id: id })) };
          },
        }),
      readImage: async (storageUrl) => {
        reads.push(storageUrl);
        const [name, encoding] = blobs[storageUrl];
        return ENCODINGS[encoding](photo(PICTURES[name]));
      },
    };
    return { deps, deletes, reads, fingerprintWrites };
  }

  it("dry run reports the old copies of shade 294 and deletes nothing", async () => {
    const { deps, deletes, reads } = fixture();
    const result = await runGalleryDedupeBatch(deps, { afterShadeId: 0, limit: 25, dryRun: true });

    assert.equal(result.scannedShades, 3);
    assert.equal(result.shadesWithDuplicates, 1);
    assert.equal(result.duplicateGroups, 4);
    assert.equal(result.swatchesRemoved, 4);
    assert.equal(result.duplicatesKept, 0);
    assert.equal(result.unreadableImages, 0);
    assert.equal(result.nextAfterShadeId, null);
    assert.deepEqual(
      result.groups.map((g) => [g.shadeId, g.keepImageId, g.removeImageIds]),
      [
        [294, 101, [51]],
        [294, 102, [52]],
        [294, 103, [53]],
        [294, 104, [54]],
      ]
    );
    assert.deepEqual(deletes, []);
    // Each blob is read once even when an image is on several shades; shade 301 is never read.
    assert.equal(reads.length, new Set(reads).size);
    assert.equal(result.imagesFingerprinted, 8);
    assert.equal(result.storedFingerprintsUsed, 0);
  });

  it("saves the fingerprints it computes (also in a dry run), one per image row", async () => {
    const { deps, fingerprintWrites } = fixture();
    const result = await runGalleryDedupeBatch(deps, { afterShadeId: 0, limit: 25, dryRun: true });

    // 8 blobs read; shade 300's images 201/202 share blobs with 101/102 and get the same fingerprint.
    assert.equal(result.imagesFingerprinted, 8);
    assert.equal(result.fingerprintsStored, 10);
    assert.deepEqual(
      fingerprintWrites.map((w) => w.imageId).sort((a, b) => a - b),
      [51, 52, 53, 54, 101, 102, 103, 104, 201, 202]
    );
    for (const write of fingerprintWrites) {
      assert.match(write.perceptualHash, /^[0-9a-f]{64}$/);
      assert.equal(write.thumbBytes, 768);
      assert.ok(write.width > 0);
    }
  });

  it("is read-only with storeFingerprints: false", async () => {
    const { deps, fingerprintWrites } = fixture();
    const result = await runGalleryDedupeBatch(deps, { afterShadeId: 0, limit: 25, dryRun: true, storeFingerprints: false });
    assert.equal(result.fingerprintsStored, 0);
    assert.deepEqual(fingerprintWrites, []);
    assert.equal(result.swatchesRemoved, 4);
  });

  it("uses stored fingerprints instead of reading those blobs", async () => {
    const stored = {
      "old-bottle": fingerprintToColumns(fp.bottle.png),
      "old-left": fingerprintToColumns(fp.nailsLeft.webp),
      "cur-macro": fingerprintToColumns(fp.macro.jpeg),
    };
    const { deps, reads, fingerprintWrites } = fixture(stored);
    const result = await runGalleryDedupeBatch(deps, { afterShadeId: 0, limit: 25, dryRun: true });

    assert.ok(!reads.includes("old-bottle") && !reads.includes("old-left") && !reads.includes("cur-macro"));
    assert.equal(result.storedFingerprintsUsed, 3);
    assert.equal(result.imagesFingerprinted, 5);
    assert.ok(!fingerprintWrites.some((w) => [51, 52, 104].includes(w.imageId)));
    // Same duplicate groups as when every blob is read.
    assert.deepEqual(
      result.groups.map((g) => [g.keepImageId, g.removeImageIds]),
      [[101, [51]], [102, [52]], [103, [53]], [104, [54]]]
    );
  });

  it("deletes the planned swatches in one transaction when dryRun is false", async () => {
    const { deps, deletes } = fixture();
    const result = await runGalleryDedupeBatch(deps, { afterShadeId: 0, limit: 25, dryRun: false });

    assert.equal(result.swatchesRemoved, 4);
    assert.deepEqual(deletes, [
      { swatchIds: [5], shadeId: 294, keepSwatchId: 1 },
      { swatchIds: [6], shadeId: 294, keepSwatchId: 2 },
      { swatchIds: [7], shadeId: 294, keepSwatchId: 3 },
      { swatchIds: [8], shadeId: 294, keepSwatchId: 4 },
    ]);
  });

  it("pages by shade id and honours shadeIds", async () => {
    const { deps } = fixture();
    const first = await runGalleryDedupeBatch(deps, { afterShadeId: 0, limit: 2, dryRun: true });
    assert.equal(first.nextAfterShadeId, 300);
    const second = await runGalleryDedupeBatch(deps, { afterShadeId: 300, limit: 2, dryRun: true });
    assert.equal(second.scannedShades, 1);
    assert.equal(second.nextAfterShadeId, null);

    const only = await runGalleryDedupeBatch(deps, { afterShadeId: 0, limit: 25, dryRun: true, shadeIds: [300] });
    assert.equal(only.scannedShades, 1);
    assert.equal(only.swatchesRemoved, 0);
  });

  it("counts unreadable images and never removes them", async () => {
    const { deps } = fixture();
    const readImage = deps.readImage;
    deps.readImage = async (url) => {
      if (url === "old-left") throw new Error("blob missing");
      return readImage(url);
    };
    const result = await runGalleryDedupeBatch(deps, { afterShadeId: 0, limit: 25, dryRun: true, shadeIds: [294] });
    assert.equal(result.unreadableImages, 1);
    assert.equal(result.swatchesRemoved, 3);
    assert.deepEqual(result.failures, [{ imageId: 52, error: "blob missing" }]);
  });
});

describe("parseGalleryDedupeBody", () => {
  it("defaults to a dry run of 25 shades", () => {
    assert.deepEqual(parseGalleryDedupeBody({}), {
      afterShadeId: 0,
      limit: 25,
      dryRun: true,
      storeFingerprints: true,
      shadeIds: undefined,
    });
  });

  it("rejects bad input", () => {
    assert.match(parseGalleryDedupeBody({ limit: 0 }), /limit/);
    assert.match(parseGalleryDedupeBody({ afterShadeId: -1 }), /afterShadeId/);
    assert.match(parseGalleryDedupeBody({ dryRun: "no" }), /dryRun/);
    assert.match(parseGalleryDedupeBody({ storeFingerprints: 1 }), /storeFingerprints/);
    assert.match(parseGalleryDedupeBody({ shadeIds: [0] }), /shadeIds/);
    assert.match(parseGalleryDedupeBody({ shadeIds: [] }), /shadeIds/);
  });

  it("accepts a write run for specific shades", () => {
    assert.deepEqual(parseGalleryDedupeBody({ dryRun: false, shadeIds: [294], limit: 10, storeFingerprints: false }), {
      afterShadeId: 0,
      limit: 10,
      dryRun: false,
      storeFingerprints: false,
      shadeIds: [294],
    });
  });
});

describe("stored fingerprint columns", () => {
  it("round-trips a fingerprint through the image_asset columns", () => {
    const columns = fingerprintToColumns(fp.bottle.jpeg);
    assert.match(columns.perceptualHash, /^[0-9a-f]{64}$/);
    assert.ok(Buffer.isBuffer(columns.thumbFingerprint));
    assert.equal(columns.thumbFingerprint.length, 768);
    assert.deepEqual(fingerprintFromColumns(columns), fp.bottle.jpeg);
  });

  it("stores nothing for a missing or malformed fingerprint (all-or-nothing CHECK)", () => {
    const none = { perceptualHash: null, thumbFingerprint: null, imageWidth: null, imageHeight: null };
    assert.deepEqual(fingerprintToColumns(null), none);
    assert.deepEqual(fingerprintToColumns({ ...fp.bottle.jpeg, width: 0 }), none);
    assert.deepEqual(fingerprintToColumns({ ...fp.bottle.jpeg, dhash: "abc" }), none);
    assert.deepEqual(fingerprintToColumns({ ...fp.bottle.jpeg, thumb: Buffer.alloc(10).toString("base64") }), none);
    assert.equal(fingerprintFromColumns(none), null);
    assert.equal(fingerprintFromColumns({ ...fingerprintToColumns(fp.bottle.jpeg), imageHeight: null }), null);
  });
});

describe("INGEST_NEAR_DUPLICATE_THRESHOLDS on real Cracked Polish images", () => {
  // Fingerprints measured on the vendor originals (tests/fixtures/gallery-near-duplicates.json).
  for (const pair of nearDuplicateFixture.pairs) {
    const label = `${pair.product} ${pair.images.join("/")} (${pair.note})`;
    it(`${pair.nearDuplicate ? "skips" : "keeps"} ${label}`, () => {
      const comparison = compareFingerprints(pair.a, pair.b, INGEST_NEAR_DUPLICATE_THRESHOLDS);
      assert.equal(comparison.duplicate, pair.nearDuplicate, JSON.stringify(comparison));
    });
  }

  it("is looser than the exact-duplicate cleanup thresholds", () => {
    const nearPairs = nearDuplicateFixture.pairs.filter((pair) => pair.nearDuplicate);
    assert.ok(nearPairs.length > 0);
    for (const pair of nearPairs) {
      assert.equal(compareFingerprints(pair.a, pair.b, DEFAULT_DEDUPE_THRESHOLDS).duplicate, false);
    }
  });

  it("catches a slight vendor re-crop that the cleanup thresholds miss", async () => {
    const source = photo(PICTURES.nailsLeft);
    const original = await computeImageFingerprint(await source.clone().jpeg({ quality: 90 }).toBuffer());
    // 4% trimmed off every edge (same aspect), re-exported as WebP.
    const recrop = await computeImageFingerprint(
      await source.clone().extract({ left: 10, top: 10, width: 460, height: 460 }).webp({ quality: 75 }).toBuffer()
    );
    assert.equal(compareFingerprints(original, recrop, INGEST_NEAR_DUPLICATE_THRESHOLDS).duplicate, true);
    for (const name of ["bottle", "nailsRight", "macro"]) {
      assert.equal(compareFingerprints(recrop, fp[name].jpeg, INGEST_NEAR_DUPLICATE_THRESHOLDS).duplicate, false, name);
    }
  });
});

describe("planProductGalleryLinks", () => {
  const candidate = (key, fingerprint, pinned) => ({ key, fingerprint, ...(pinned ? { pinned } : {}) });
  const decide = (additional, extra = {}) =>
    planProductGalleryLinks({ primary: { key: "p", fingerprint: fp.bottle.jpeg }, additional, ...extra }).map(
      ({ key, link, reason, duplicateOfKey }) => [key, link, reason, duplicateOfKey ?? null]
    );

  it("links distinct images and skips near-duplicates of an image already linked", () => {
    assert.deepEqual(
      decide([
        candidate("left", fp.nailsLeft.jpeg),
        candidate("left-again", fp.nailsLeft.webp),
        candidate("bottle-again", fp.bottle.png),
        candidate("macro", fp.macro.jpeg),
      ]),
      [
        ["left", true, "linked", null],
        ["left-again", false, "near_duplicate", "left"],
        ["bottle-again", false, "near_duplicate", "p"],
        ["macro", true, "linked", null],
      ]
    );
  });

  it("treats the primary's own image as already linked and never matches an unknown fingerprint", () => {
    assert.deepEqual(decide([candidate("p", fp.bottle.jpeg), candidate("unknown", null), candidate("unknown-2", null)]), [
      ["p", false, "same_image", "p"],
      ["unknown", true, "linked", null],
      ["unknown-2", true, "linked", null],
    ]);
  });

  it("stops at the gallery cap, counting only linked gallery images", () => {
    assert.deepEqual(
      decide(
        [
          candidate("left", fp.nailsLeft.jpeg),
          candidate("left-again", fp.nailsLeft.png),
          candidate("right", fp.nailsRight.jpeg),
          candidate("macro", fp.macro.jpeg),
        ],
        { maxGalleryImages: 2 }
      ),
      [
        ["left", true, "linked", null],
        ["left-again", false, "near_duplicate", "left"],
        ["right", true, "linked", null],
        ["macro", false, "over_cap", null],
      ]
    );
  });

  it("always links the pinned detection image, first, even past the cap", () => {
    assert.deepEqual(
      decide(
        [
          candidate("left", fp.nailsLeft.jpeg),
          candidate("right", fp.nailsRight.jpeg),
          candidate("left-detect", fp.nailsLeft.png, true),
        ],
        { maxGalleryImages: 1 }
      ),
      [
        ["left", false, "near_duplicate", "left-detect"],
        ["right", false, "over_cap", null],
        ["left-detect", true, "pinned", null],
      ]
    );
    assert.deepEqual(decide([candidate("bottle-detect", fp.bottle.webp, true)], { maxGalleryImages: 1 }), [
      ["bottle-detect", true, "pinned", null],
    ]);
  });

  it("gives the same decisions on every run", () => {
    const additional = [
      candidate("left", fp.nailsLeft.jpeg),
      candidate("left-again", fp.nailsLeft.webp),
      candidate("right", fp.nailsRight.jpeg),
    ];
    assert.deepEqual(decide(additional, { maxGalleryImages: 1 }), decide([...additional], { maxGalleryImages: 1 }));
  });
});

describe("getGalleryMaxImagesPerShade", () => {
  it("is unlimited unless set to a positive integer", () => {
    assert.equal(getGalleryMaxImagesPerShade({}), null);
    assert.equal(getGalleryMaxImagesPerShade({ GALLERY_MAX_IMAGES_PER_SHADE: "" }), null);
    assert.equal(getGalleryMaxImagesPerShade({ GALLERY_MAX_IMAGES_PER_SHADE: "0" }), null);
    assert.equal(getGalleryMaxImagesPerShade({ GALLERY_MAX_IMAGES_PER_SHADE: "-3" }), null);
    assert.equal(getGalleryMaxImagesPerShade({ GALLERY_MAX_IMAGES_PER_SHADE: "2.5" }), null);
    assert.equal(getGalleryMaxImagesPerShade({ GALLERY_MAX_IMAGES_PER_SHADE: "twelve" }), null);
    assert.equal(getGalleryMaxImagesPerShade({ GALLERY_MAX_IMAGES_PER_SHADE: " 12 " }), 12);
  });
});
