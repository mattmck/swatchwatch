/**
 * Capture frame sweep (Bottle Flow slice A): config clamping, the expired-frame scan, and the
 * per-row rules (only the owner's `{ownerId}/capture/` blobs are touched; `quality_json` is never
 * read or written). Runs without a database or storage account: SQL goes through a fake `query`
 * and the blob delete is injected.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const ACCOUNT = "https://acct.blob.core.windows.net";
const CAPTURE_ID = "11111111-1111-4111-8111-111111111111";

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
  uploadBytesToBlob: async () => "",
  isUserMediaStorageUrl: (url) => String(url).startsWith(`${ACCOUNT}/nail-photos/`),
  storageUrlBlobName: (url) => String(url).replace(`${ACCOUNT}/nail-photos/`, ""),
};
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const sweep = require("../dist/lib/capture-frame-sweep");

const url = (name) => `${ACCOUNT}/nail-photos/${name}`;
const row = (imageId, ownerId, storageUrl, checksum = "abc") => ({ imageId, ownerId, storageUrl, checksum, captureId: CAPTURE_ID });

function makeDeps(pages, deleteBlob) {
  const calls = [];
  const deleted = [];
  let page = 0;
  return {
    calls,
    deleted,
    deps: {
      query: async (sql, params) => {
        calls.push({ sql: String(sql), params });
        if (/^\s*SELECT/i.test(sql)) return { rows: pages[page++] ?? [] };
        return { rows: [], rowCount: 1 };
      },
      deleteBlob: async (storageUrl) => {
        deleted.push(storageUrl);
        return deleteBlob ? deleteBlob(storageUrl) : true;
      },
      warn: () => {},
    },
  };
}

describe("capture frame sweep config", () => {
  it("defaults and clamps retention, batch size and max per run", () => {
    assert.deepEqual(sweep.getCaptureFrameSweepConfig({}), { retentionSeconds: 86400, batchSize: 200, maxPerRun: 2000 });
    assert.equal(sweep.getCaptureFrameSweepConfig({ CAPTURE_FRAME_RETENTION_SECONDS: "60" }).retentionSeconds, 3600);
    assert.equal(sweep.getCaptureFrameSweepConfig({ CAPTURE_FRAME_RETENTION_SECONDS: "999999999" }).retentionSeconds, 604800);
    assert.equal(sweep.getCaptureFrameSweepConfig({ CAPTURE_FRAME_RETENTION_SECONDS: "7200" }).retentionSeconds, 7200);
    assert.equal(sweep.getCaptureFrameSweepConfig({ CAPTURE_FRAME_RETENTION_SECONDS: "junk" }).retentionSeconds, 86400);
    assert.equal(sweep.getCaptureFrameSweepConfig({ CAPTURE_FRAME_SWEEP_BATCH_SIZE: "0" }).batchSize, 1);
    assert.equal(sweep.getCaptureFrameSweepConfig({ CAPTURE_FRAME_SWEEP_BATCH_SIZE: "99999" }).batchSize, 1000);
    assert.equal(sweep.getCaptureFrameSweepConfig({ CAPTURE_FRAME_SWEEP_MAX_PER_RUN: "99999999" }).maxPerRun, 20000);
  });

  it("schedule defaults to hourly and reads CAPTURE_FRAME_SWEEP_SCHEDULE", () => {
    assert.equal(sweep.captureFrameSweepSchedule({}), "0 0 * * * *");
    assert.equal(sweep.DEFAULT_CAPTURE_FRAME_SWEEP_SCHEDULE, "0 0 * * * *");
    assert.equal(sweep.captureFrameSweepSchedule({ CAPTURE_FRAME_SWEEP_SCHEDULE: " 0 */30 * * * * " }), "0 */30 * * * *");
  });
});

describe("SELECT_EXPIRED_CAPTURE_FRAMES_SQL", () => {
  it("scans capture frames by age, skips placeholders and never touches quality_json", () => {
    const sql = sweep.SELECT_EXPIRED_CAPTURE_FRAMES_SQL;
    assert.match(sql, /FROM capture_frame/);
    assert.match(sql, /NOT LIKE 'inline:\/\/%'/);
    assert.match(sql, /owner_type = 'user'/);
    assert.match(sql, /ORDER BY ia\.image_id/);
    assert.doesNotMatch(sql, /quality_json/);
  });
});

describe("sweepExpiredCaptureFrames", () => {
  const config = { retentionSeconds: 86400, batchSize: 200, maxPerRun: 2000 };

  it("releases capture frames, skips other blobs and counts a gone blob", async () => {
    const rows = [
      row("1", "7", url(`7/capture/${CAPTURE_ID}/abc.jpg`)),
      row("2", "7", url("7/bottle-eval/3/def.jpg"), "def"),
      row("3", "7", url(`7/capture/${CAPTURE_ID}/ghi.jpg`), "ghi"),
    ];
    const { deps, calls, deleted } = makeDeps([rows], async (storageUrl) => !storageUrl.endsWith("ghi.jpg"));
    const result = await sweep.sweepExpiredCaptureFrames(deps, config);
    assert.deepEqual(result, { scanned: 3, released: 2, blobMissing: 1, failed: 0, skipped: 1, truncated: false });
    assert.deepEqual(deleted, [url(`7/capture/${CAPTURE_ID}/abc.jpg`), url(`7/capture/${CAPTURE_ID}/ghi.jpg`)]);
    const resets = calls.filter((c) => /UPDATE image_asset/i.test(c.sql));
    assert.deepEqual(
      resets.map((c) => c.params),
      [
        ["1", `inline://capture/${CAPTURE_ID}/abc.jpg`, "7"],
        ["3", `inline://capture/${CAPTURE_ID}/ghi.jpg`, "7"],
      ]
    );
    assert.equal(calls.some((c) => /quality_json/i.test(c.sql)), false);
    assert.deepEqual(calls[0].params, [86400, "0", 200]);
  });

  it("leaves another owner's capture-looking blob alone", async () => {
    const { deps, deleted } = makeDeps([[row("1", "7", url(`8/capture/${CAPTURE_ID}/abc.jpg`))]]);
    const result = await sweep.sweepExpiredCaptureFrames(deps, config);
    assert.equal(result.skipped, 1);
    assert.equal(deleted.length, 0);
  });

  it("keeps the row when the delete throws (retried next run)", async () => {
    const { deps, calls } = makeDeps([[row("1", "7", url(`7/capture/${CAPTURE_ID}/abc.jpg`))]], async () => {
      throw new Error("boom");
    });
    const result = await sweep.sweepExpiredCaptureFrames(deps, config);
    assert.equal(result.failed, 1);
    assert.equal(result.released, 0);
    assert.equal(calls.filter((c) => /UPDATE image_asset/i.test(c.sql)).length, 0);
  });

  it("stops at maxPerRun and reports truncated", async () => {
    const rows = [1, 2, 3].map((n) => row(String(n), "7", url(`7/capture/${CAPTURE_ID}/f${n}.jpg`), `f${n}`));
    const { deps, deleted } = makeDeps([rows]);
    const result = await sweep.sweepExpiredCaptureFrames(deps, { ...config, maxPerRun: 2 });
    assert.equal(result.truncated, true);
    assert.equal(result.scanned, 2);
    assert.equal(deleted.length, 2);
  });

  it("pages by image id until a short page", async () => {
    const page1 = [row("1", "7", url(`7/capture/${CAPTURE_ID}/a.jpg`), "a"), row("2", "7", url(`7/capture/${CAPTURE_ID}/b.jpg`), "b")];
    const page2 = [row("3", "7", url(`7/capture/${CAPTURE_ID}/c.jpg`), "c")];
    const { deps, calls } = makeDeps([page1, page2]);
    const result = await sweep.sweepExpiredCaptureFrames(deps, { ...config, batchSize: 2 });
    assert.equal(result.scanned, 3);
    assert.equal(result.truncated, false);
    const selects = calls.filter((c) => /^\s*SELECT/i.test(c.sql));
    assert.deepEqual(selects.map((c) => c.params), [[86400, "0", 2], [86400, "2", 2]]);
  });
});
