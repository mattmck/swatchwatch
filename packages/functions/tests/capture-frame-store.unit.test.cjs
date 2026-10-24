/**
 * Capture frame retention (Bottle Flow slice A): where frame bytes live while a session is open
 * (a private blob under `{userId}/capture/{captureId}/`), the prefix rule that keeps every other
 * blob in the user-media container (nail photos, mani photos, bottle-eval frames) out of reach,
 * and the terminal-state release. Runs without a database or storage account: the blob helpers
 * are mocked with recorders and SQL goes through an injected fake `query`.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const ACCOUNT = "https://acct.blob.core.windows.net";
const CAPTURE_ID = "11111111-1111-4111-8111-111111111111";
const USER = 7;

let uploads = [];
let uploadImpl;

const mockModules = {};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) return key;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
mockModules["./blob-storage"] = {
  userMediaContainer: () => "nail-photos",
  uploadBytesToBlob: async (params) => {
    uploads.push(params);
    return uploadImpl(params);
  },
  isUserMediaStorageUrl: (url) => String(url).startsWith(`${ACCOUNT}/nail-photos/`),
  storageUrlBlobName: (url) => String(url).replace(`${ACCOUNT}/nail-photos/`, ""),
};
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const store = require("../dist/lib/capture-frame-store");

const blobUrl = (name) => `${ACCOUNT}/nail-photos/${name}`;

beforeEach(() => {
  uploads = [];
  uploadImpl = async (params) => `${ACCOUNT}/${params.containerName}/${params.blobName}`;
});

describe("capture frame names", () => {
  it("builds the blob name and keeps the inline placeholder format", () => {
    assert.equal(store.captureFrameBlobName(7, CAPTURE_ID, "abc", "jpg", "u1"), `7/capture/${CAPTURE_ID}/abc-u1.jpg`);
    assert.equal(store.inlineCaptureFrameUrl(CAPTURE_ID, "abc", "jpg"), `inline://capture/${CAPTURE_ID}/abc.jpg`);
    assert.equal(store.CAPTURE_FRAME_INLINE_PREFIX, "inline://capture/");
  });

  it("isCaptureFrameStorageUrl only accepts the owner's capture prefix in the user-media container", () => {
    assert.equal(store.isCaptureFrameStorageUrl(blobUrl(`7/capture/${CAPTURE_ID}/abc.jpg`), 7), true);
    assert.equal(store.isCaptureFrameStorageUrl(blobUrl(`7/capture/${CAPTURE_ID}/abc.jpg`), "7"), true);
    assert.equal(store.isCaptureFrameStorageUrl(blobUrl("7/bottle-eval/3/abc.jpg"), 7), false);
    assert.equal(store.isCaptureFrameStorageUrl(blobUrl("7/0b0e8d0e-3c0a-4a52-9b1e-5d6f5d4a8c11.jpg"), 7), false, "a nail photo");
    assert.equal(store.isCaptureFrameStorageUrl(blobUrl("7/manicures/4/abc.jpg"), 7), false, "a mani photo");
    assert.equal(store.isCaptureFrameStorageUrl(blobUrl(`8/capture/${CAPTURE_ID}/abc.jpg`), 7), false, "another owner");
    assert.equal(store.isCaptureFrameStorageUrl(blobUrl(`77/capture/${CAPTURE_ID}/abc.jpg`), 7), false, "owner prefix is a whole segment");
    assert.equal(store.isCaptureFrameStorageUrl(`${ACCOUNT}/source-images/7/capture/x/abc.jpg`, 7), false, "catalog container");
    assert.equal(store.isCaptureFrameStorageUrl(`inline://capture/${CAPTURE_ID}/abc.jpg`, 7), false);
    assert.equal(store.isCaptureFrameStorageUrl(null, 7), false);
    assert.equal(store.isCaptureFrameStorageUrl(undefined, 7), false);
  });
});

describe("storeCaptureFrameBytes", () => {
  const input = {
    userId: USER,
    captureId: CAPTURE_ID,
    bytes: Buffer.from("jpeg-bytes"),
    contentType: "image/jpeg",
    checksum: "abc",
    extension: "jpg",
  };

  it("uploads to the user-media container under the capture prefix", async () => {
    const result = await store.storeCaptureFrameBytes(input, { connectionString: "UseDevelopmentStorage=true", uploadId: () => "u1" });
    assert.deepEqual(result, { storageUrl: blobUrl(`7/capture/${CAPTURE_ID}/abc-u1.jpg`), stored: true });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].containerName, "nail-photos");
    assert.equal(uploads[0].blobName, `7/capture/${CAPTURE_ID}/abc-u1.jpg`);
    assert.equal(uploads[0].connectionString, "UseDevelopmentStorage=true");
    assert.equal(uploads[0].contentType, "image/jpeg");
    assert.equal(uploads[0].bytes, input.bytes);
  });

  it("the same bytes uploaded twice (a client retry) get two blobs, so neither attempt can delete the other's", async () => {
    const first = await store.storeCaptureFrameBytes(input, { connectionString: "UseDevelopmentStorage=true" });
    const retry = await store.storeCaptureFrameBytes(input, { connectionString: "UseDevelopmentStorage=true" });
    assert.notEqual(first.storageUrl, retry.storageUrl);
    for (const upload of uploads) {
      assert.match(upload.blobName, new RegExp(`^7/capture/${CAPTURE_ID}/abc-[0-9a-f-]{36}\\.jpg$`));
    }
  });

  it("falls back to the inline placeholder, with no upload, when storage is not configured", async () => {
    for (const connectionString of [undefined, "", "   "]) {
      uploads = [];
      const result = await store.storeCaptureFrameBytes(input, { connectionString });
      assert.deepEqual(result, { storageUrl: `inline://capture/${CAPTURE_ID}/abc.jpg`, stored: false });
      assert.equal(uploads.length, 0);
    }
  });

  it("warns and falls back to the placeholder when the upload throws, never throwing", async () => {
    uploadImpl = async () => {
      throw new Error("storage down");
    };
    const warnings = [];
    const result = await store.storeCaptureFrameBytes(input, {
      connectionString: "UseDevelopmentStorage=true",
      warn: (message, error) => warnings.push([message, error]),
    });
    assert.deepEqual(result, { storageUrl: `inline://capture/${CAPTURE_ID}/abc.jpg`, stored: false });
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][1].message), /storage down/);
  });

  it("uses an injected uploader", async () => {
    const calls = [];
    const result = await store.storeCaptureFrameBytes(input, {
      connectionString: "x",
      upload: async (params) => {
        calls.push(params);
        return "https://example.test/blob";
      },
    });
    assert.deepEqual(result, { storageUrl: "https://example.test/blob", stored: true });
    assert.equal(calls.length, 1);
    assert.equal(uploads.length, 0);
  });
});

describe("releaseCaptureFrames", () => {
  const frame = (imageId, storageUrl, checksum = "abc") => ({ imageId, storageUrl, checksum, captureId: CAPTURE_ID });
  const run = async (rows, deleteBlob) => {
    const calls = [];
    const warnings = [];
    const result = await store.releaseCaptureFrames(
      { sessionId: 42, userId: USER, captureId: CAPTURE_ID },
      {
        query: async (sql, params) => {
          calls.push({ sql: String(sql), params });
          return /^\s*SELECT/i.test(sql) ? { rows } : { rows: [], rowCount: 1 };
        },
        deleteBlob,
        warn: (message, error) => warnings.push([message, error]),
      }
    );
    return { result, calls, warnings };
  };

  it("selects the session's frames scoped to the caller", async () => {
    const { calls } = await run([], async () => true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, [42, USER]);
    assert.match(calls[0].sql, /FROM capture_frame/);
    assert.match(calls[0].sql, /NOT LIKE 'inline:\/\/%'/);
    assert.match(calls[0].sql, /owner_id = \$2/);
    assert.doesNotMatch(calls[0].sql, /quality_json/);
  });

  it("never selects an asset that is also a mani photo, a nail photo or another frame's image", async () => {
    const { calls } = await run([], async () => true);
    const sql = calls[0].sql.replace(/\s+/g, " ");
    assert.match(sql, /AND NOT \( EXISTS \(SELECT 1 FROM manicure m WHERE m\.photo_image_id = ia\.image_id\)/);
    assert.match(sql, /OR EXISTS \(SELECT 1 FROM inventory_nail_photo p WHERE p\.image_id = ia\.image_id\)/);
    assert.match(sql, /FROM capture_frame other WHERE other\.image_id = ia\.image_id AND other\.capture_frame_id <> cf\.capture_frame_id/);
  });

  it("a row without a checksum resets to the placeholder named by the blob's checksum (upload id dropped)", async () => {
    const id = "0b0e8d0e-3c0a-4a52-9b1e-5d6f5d4a8c11";
    const { calls } = await run([frame("10", blobUrl(`7/capture/${CAPTURE_ID}/abc-${id}.webp`), null)], async () => true);
    const resets = calls.filter((c) => /UPDATE image_asset/i.test(c.sql));
    assert.deepEqual(resets[0].params, ["10", `inline://capture/${CAPTURE_ID}/abc.webp`, USER]);
  });

  it("deletes a capture frame blob and resets its row to the placeholder; leaves other blobs alone", async () => {
    const deleted = [];
    const rows = [
      frame("10", blobUrl(`7/capture/${CAPTURE_ID}/abc.jpg`)),
      frame("11", blobUrl("7/0b0e8d0e-3c0a-4a52-9b1e-5d6f5d4a8c11.jpg"), "zzz"),
    ];
    const { result, calls } = await run(rows, async (url) => {
      deleted.push(url);
      return true;
    });
    assert.deepEqual(deleted, [blobUrl(`7/capture/${CAPTURE_ID}/abc.jpg`)]);
    const resets = calls.filter((c) => /UPDATE image_asset/i.test(c.sql));
    assert.equal(resets.length, 1);
    assert.deepEqual(resets[0].params, ["10", `inline://capture/${CAPTURE_ID}/abc.jpg`, USER]);
    assert.match(resets[0].sql, /owner_type = 'user'/);
    assert.match(resets[0].sql, /owner_id = \$3/);
    assert.equal(result.released, 1);
    assert.equal(result.failed, 0);
  });

  it("a missing blob (404) counts as blobMissing and the row is still reset", async () => {
    const { result, calls } = await run([frame("10", blobUrl(`7/capture/${CAPTURE_ID}/abc.png`))], async () => false);
    assert.deepEqual(result, { released: 1, blobMissing: 1, failed: 0 });
    const resets = calls.filter((c) => /UPDATE image_asset/i.test(c.sql));
    assert.deepEqual(resets[0].params, ["10", `inline://capture/${CAPTURE_ID}/abc.png`, USER]);
  });

  it("a throwing delete counts as failed and keeps the row for the sweep", async () => {
    const { result, calls, warnings } = await run([frame("10", blobUrl(`7/capture/${CAPTURE_ID}/abc.jpg`))], async () => {
      throw new Error("boom");
    });
    assert.deepEqual(result, { released: 0, blobMissing: 0, failed: 1 });
    assert.equal(calls.filter((c) => /UPDATE image_asset/i.test(c.sql)).length, 0);
    assert.equal(warnings.length, 1);
  });

  it("never throws when the frame lookup fails", async () => {
    const warnings = [];
    const result = await store.releaseCaptureFrames(
      { sessionId: 42, userId: USER, captureId: CAPTURE_ID },
      {
        query: async () => {
          throw new Error("db down");
        },
        deleteBlob: async () => true,
        warn: (message) => warnings.push(message),
      }
    );
    assert.deepEqual(result, { released: 0, blobMissing: 0, failed: 0 });
    assert.equal(warnings.length, 1);
  });
});
