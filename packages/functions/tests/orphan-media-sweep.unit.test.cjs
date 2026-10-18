/**
 * Orphaned private media sweep (#319, decision D9): config parsing, the catalog-driven reference
 * check, which blobs may be deleted, the per-asset lock / re-check / blob-then-row order, paging,
 * and the timer's telemetry. Runs without a database or storage account: SQL is routed by
 * statement text to an in-memory fake and blob deletes are recorded.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// Module mocks (timer only; the lib is loaded unmocked apart from its injected deps)
// ---------------------------------------------------------------------------
const registeredTimers = {};
let queryMock = async () => ({ rows: [] });
let transactionMock = async (cb) => cb({ query: (...args) => queryMock(...args) });
const telemetry = { events: [], metrics: [], exceptions: [] };

const mockModules = {};
function registerMock(id, exports) {
  mockModules[id] = exports;
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) return key;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
registerMock("@azure/functions", {
  app: {
    http: () => {},
    timer: (name, opts) => {
      registeredTimers[name] = opts;
    },
  },
});
const dbMock = {
  query: (...args) => queryMock(...args),
  transaction: (...args) => transactionMock(...args),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
registerMock("../lib/telemetry", {
  trackEvent: (name, properties) => telemetry.events.push({ name, properties }),
  trackMetric: (name, value) => telemetry.metrics.push({ name, value }),
  trackException: (error, properties) => telemetry.exceptions.push({ error, properties }),
});
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const blobStorage = require("../dist/lib/blob-storage");
const sweep = require("../dist/lib/orphan-media-sweep");
const realDeleteBlob = blobStorage.deleteBlobFromStorageUrl;
require("../dist/functions/orphan-media-sweep");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ACCOUNT = "https://swatchwatchacct.blob.core.windows.net";
const mediaUrl = (path) => `${ACCOUNT}/nail-photos/${path}`;
const catalogUrl = (path) => `${ACCOUNT}/swatches/${path}`;

const REFERENCES = [
  { schema: "public", table: "inventory_nail_photo", columns: ["image_id"], referencedColumns: ["image_id"], constraintName: "inp_fk" },
  { schema: "public", table: "manicure", columns: ["photo_image_id"], referencedColumns: ["image_id"], constraintName: "m_fk" },
  { schema: "public", table: "capture_frame", columns: ["image_id"], referencedColumns: ["image_id"], constraintName: "cf_fk" },
];

const CONFIG = { graceSeconds: 86_400, batchSize: 100, maxPerRun: 2_000 };

/**
 * In-memory image_asset table. Each asset: { ownerType, ownerId, storageUrl, thumbUrl, old, refs }.
 * `old` stands for "captured_at past the grace period"; `refs` counts referencing rows.
 */
function createFakeDb(assets, options = {}) {
  const state = {
    assets: new Map(Object.entries(assets).map(([id, a]) => [Number(id), { ownerType: "user", thumbUrl: null, old: true, refs: 0, ...a }])),
    locked: new Set(options.locked || []),
    log: [],
    candidateCalls: [],
    failRowDelete: new Set(options.failRowDelete || []),
    onLock: options.onLock || (() => {}),
    references: options.references || REFERENCES,
  };
  const eligible = (a) => a && a.ownerType === "user" && a.old;

  async function query(text, values = []) {
    if (text.includes("pg_constraint")) return { rows: state.references };
    if (text.includes("LIMIT $3")) {
      const [grace, cursor, limit, pattern] = values;
      state.candidateCalls.push({ grace, cursor, limit, pattern });
      assert.equal(pattern, "%/nail-photos/");
      const rows = [...state.assets.entries()]
        .filter(([id, a]) => id > Number(cursor) && eligible(a) && a.refs === 0 && a.storageUrl.includes(`/nail-photos/${a.ownerId}/`))
        .sort(([a], [b]) => a - b)
        .slice(0, limit)
        .map(([id]) => ({ imageId: String(id) }));
      return { rows };
    }
    if (text.includes("FOR UPDATE SKIP LOCKED")) {
      const id = Number(values[0]);
      state.log.push(`lock:${id}`);
      const asset = state.assets.get(id);
      if (state.locked.has(id) || !eligible(asset)) return { rows: [] };
      state.onLock(id, state);
      return { rows: [{ ownerId: String(asset.ownerId), storageUrl: asset.storageUrl, thumbUrl: asset.thumbUrl }] };
    }
    if (text.includes('AS "orphan"')) {
      assert.match(text, /o\.image_id <> ia\.image_id/);
      const id = Number(values[0]);
      const asset = state.assets.get(id);
      const urls = [asset?.storageUrl, asset?.thumbUrl].filter(Boolean);
      const shared = [...state.assets.entries()].some(
        ([otherId, o]) => otherId !== id && (urls.includes(o.storageUrl) || urls.includes(o.thumbUrl))
      );
      return { rows: asset ? [{ orphan: asset.refs === 0 && !shared }] : [] };
    }
    if (/^\s*DELETE FROM image_asset/.test(text)) {
      const id = Number(values[0]);
      if (state.failRowDelete.has(id)) throw new Error("db down");
      state.log.push(`row:${id}`);
      state.assets.delete(id);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${text}`);
  }

  return {
    state,
    query,
    transaction: async (cb) => {
      const result = await cb({ query });
      state.log.push("commit");
      return result;
    },
  };
}

function createDeps(db, blobs = {}) {
  const deleted = [];
  return {
    deleted,
    deps: {
      query: db.query,
      transaction: db.transaction,
      deleteBlob: async (url) => {
        db.state.log.push(`blob:${url}`);
        if (blobs.fail && blobs.fail.includes(url)) throw new Error("storage down");
        deleted.push(url);
        return !(blobs.missing && blobs.missing.includes(url));
      },
      warn: () => {},
    },
  };
}

const ENV_KEYS = [
  "AZURE_STORAGE_CONNECTION",
  "SOURCE_IMAGE_CONTAINER",
  "USER_MEDIA_CONTAINER",
  "ORPHAN_MEDIA_SWEEP_SCHEDULE",
  "ORPHAN_MEDIA_SWEEP_GRACE_SECONDS",
  "ORPHAN_MEDIA_SWEEP_BATCH_SIZE",
  "ORPHAN_MEDIA_SWEEP_MAX_PER_RUN",
];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SOURCE_IMAGE_CONTAINER = "swatches";
  process.env.USER_MEDIA_CONTAINER = "nail-photos";
  telemetry.events = [];
  telemetry.metrics = [];
  telemetry.exceptions = [];
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  blobStorage.deleteBlobFromStorageUrl = realDeleteBlob;
  queryMock = async () => ({ rows: [] });
  transactionMock = async (cb) => cb({ query: (...args) => queryMock(...args) });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
describe("orphan media sweep config", () => {
  it("defaults to a daily schedule, 24h grace, batches of 100 and 2000 per run", () => {
    assert.equal(sweep.orphanMediaSweepSchedule({}), "0 17 3 * * *");
    assert.deepEqual(sweep.getOrphanMediaSweepConfig({}), { graceSeconds: 86400, batchSize: 100, maxPerRun: 2000 });
  });

  it("reads overrides and clamps them", () => {
    assert.equal(sweep.orphanMediaSweepSchedule({ ORPHAN_MEDIA_SWEEP_SCHEDULE: " 0 0 * * * * " }), "0 0 * * * *");
    assert.deepEqual(
      sweep.getOrphanMediaSweepConfig({
        ORPHAN_MEDIA_SWEEP_GRACE_SECONDS: "60",
        ORPHAN_MEDIA_SWEEP_BATCH_SIZE: "5000",
        ORPHAN_MEDIA_SWEEP_MAX_PER_RUN: "0",
      }),
      { graceSeconds: 3600, batchSize: 1000, maxPerRun: 1 }
    );
    assert.deepEqual(
      sweep.getOrphanMediaSweepConfig({ ORPHAN_MEDIA_SWEEP_GRACE_SECONDS: "999999999", ORPHAN_MEDIA_SWEEP_BATCH_SIZE: "abc" }),
      { graceSeconds: 2592000, batchSize: 100, maxPerRun: 2000 }
    );
  });
});

// ---------------------------------------------------------------------------
// Reference discovery + SQL
// ---------------------------------------------------------------------------
describe("image_asset reference discovery", () => {
  it("maps every single-column foreign key into image_asset", async () => {
    const refs = await sweep.loadImageAssetReferences({ query: async () => ({ rows: REFERENCES }) });
    assert.deepEqual(refs, [
      { schema: "public", table: "inventory_nail_photo", column: "image_id" },
      { schema: "public", table: "manicure", column: "photo_image_id" },
      { schema: "public", table: "capture_frame", column: "image_id" },
    ]);
  });

  it("fails closed on a multi-column key or one not targeting image_id", async () => {
    for (const bad of [
      { ...REFERENCES[0], columns: ["a", "b"], referencedColumns: ["image_id", "owner_id"] },
      { ...REFERENCES[0], referencedColumns: ["owner_id"] },
      { ...REFERENCES[0], columns: null },
    ]) {
      await assert.rejects(
        sweep.loadImageAssetReferences({ query: async () => ({ rows: [bad] }) }),
        sweep.OrphanMediaSweepError
      );
    }
  });

  it("checks every reference, scoped to user rows past the grace period", () => {
    const sql = sweep.buildCandidateSql([
      { schema: "public", table: "manicure", column: "photo_image_id" },
      { schema: "public", table: 'we"ird', column: "image_id" },
    ]);
    assert.match(sql, /ia\.owner_type = 'user'/);
    assert.match(sql, /ia\.captured_at IS NOT NULL/);
    assert.match(sql, /ia\.captured_at < now\(\) - make_interval\(secs => \$1\)/);
    assert.match(sql, /ia\.image_id > \$2/);
    assert.match(sql, /ia\.storage_url ILIKE \(\$4 \|\| ia\.owner_id::text \|\| '\/%'\)/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "public"\."manicure" r WHERE r\."photo_image_id" = ia\.image_id\)/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "public"\."we""ird" r WHERE r\."image_id" = ia\.image_id\)/);
    assert.match(sql, /ORDER BY ia\.image_id\s+LIMIT \$3/);
    assert.equal(sweep.buildUnreferencedSql([]), "TRUE");
  });

  it("prefilters candidates on the user-media container, escaping LIKE wildcards", () => {
    assert.equal(sweep.userMediaUrlLikePrefix("nail-photos"), "%/nail-photos/");
    assert.equal(sweep.userMediaUrlLikePrefix("a_b%c"), "%/a\\_b\\%c/");
  });
});

describe("isSweepableUserMediaUrl", () => {
  it("accepts only user-media blobs under the owner's prefix", () => {
    assert.equal(sweep.isSweepableUserMediaUrl(mediaUrl("7/123/abc.jpg"), 7), true);
    assert.equal(sweep.isSweepableUserMediaUrl(mediaUrl("7/manicures/9/abc.jpg"), "7"), true);
    // Path-style (Azurite) URL.
    assert.equal(sweep.isSweepableUserMediaUrl("http://127.0.0.1:10000/devstoreaccount1/nail-photos/7/1/a.jpg", 7), true);
  });

  it("refuses catalog imagery, other owners, inline captures and junk", () => {
    assert.equal(sweep.isSweepableUserMediaUrl(catalogUrl("7/123/abc.jpg"), 7), false);
    assert.equal(sweep.isSweepableUserMediaUrl(mediaUrl("8/123/abc.jpg"), 7), false);
    assert.equal(sweep.isSweepableUserMediaUrl(mediaUrl("7"), 7), false);
    assert.equal(sweep.isSweepableUserMediaUrl("inline://capture/abc/def.jpg", 7), false);
    assert.equal(sweep.isSweepableUserMediaUrl("not a url", 7), false);
    assert.equal(sweep.isSweepableUserMediaUrl(null, 7), false);
  });
});

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------
describe("sweepOrphanedUserMedia", () => {
  it("deletes the blob, then the row, for each orphan past the grace period", async () => {
    const db = createFakeDb({
      10: { ownerId: 1, storageUrl: mediaUrl("1/5/a.jpg") },
      11: { ownerId: 1, storageUrl: mediaUrl("1/6/b.jpg"), refs: 1 }, // still referenced
      12: { ownerId: 2, storageUrl: mediaUrl("2/7/c.jpg"), old: false }, // inside the grace period
      13: { ownerId: 3, storageUrl: catalogUrl("3/8/d.jpg"), ownerType: "source" }, // catalog asset
    });
    const { deps, deleted } = createDeps(db);
    const result = await sweep.sweepOrphanedUserMedia(deps, CONFIG);

    assert.deepEqual(result, { scanned: 1, deleted: 1, blobMissing: 0, failed: 0, skipped: 0, truncated: false });
    assert.deepEqual(deleted, [mediaUrl("1/5/a.jpg")]);
    assert.deepEqual(db.state.log, ["lock:10", `blob:${mediaUrl("1/5/a.jpg")}`, "row:10", "commit"]);
    assert.deepEqual([...db.state.assets.keys()], [11, 12, 13]);
    assert.equal(db.state.candidateCalls[0].grace, 86400);
  });

  it("deletes a user-media thumbnail too", async () => {
    const db = createFakeDb({
      10: { ownerId: 1, storageUrl: mediaUrl("1/5/a.jpg"), thumbUrl: mediaUrl("1/5/a-thumb.jpg") },
    });
    const { deps, deleted } = createDeps(db);
    await sweep.sweepOrphanedUserMedia(deps, CONFIG);
    assert.deepEqual(deleted, [mediaUrl("1/5/a.jpg"), mediaUrl("1/5/a-thumb.jpg")]);
  });

  it("counts a blob that is already gone (404) and still deletes the row", async () => {
    const db = createFakeDb({ 10: { ownerId: 1, storageUrl: mediaUrl("1/5/a.jpg") } });
    const { deps } = createDeps(db, { missing: [mediaUrl("1/5/a.jpg")] });
    const result = await sweep.sweepOrphanedUserMedia(deps, CONFIG);
    assert.deepEqual(result, { scanned: 1, deleted: 1, blobMissing: 1, failed: 0, skipped: 0, truncated: false });
    assert.equal(db.state.assets.has(10), false);
  });

  it("keeps the row when the blob delete fails, and moves on", async () => {
    const db = createFakeDb({
      10: { ownerId: 1, storageUrl: mediaUrl("1/5/a.jpg") },
      11: { ownerId: 1, storageUrl: mediaUrl("1/6/b.jpg") },
    });
    const { deps } = createDeps(db, { fail: [mediaUrl("1/5/a.jpg")] });
    const result = await sweep.sweepOrphanedUserMedia(deps, CONFIG);
    assert.deepEqual(result, { scanned: 2, deleted: 1, blobMissing: 0, failed: 1, skipped: 0, truncated: false });
    assert.deepEqual([...db.state.assets.keys()], [10]);
  });

  it("counts a failed row delete after the blob is gone (retried next run as a 404)", async () => {
    const db = createFakeDb({ 10: { ownerId: 1, storageUrl: mediaUrl("1/5/a.jpg") } }, { failRowDelete: [10] });
    const warnings = [];
    const { deps } = createDeps(db);
    deps.warn = (message) => warnings.push(message);
    const result = await sweep.sweepOrphanedUserMedia(deps, CONFIG);
    assert.equal(result.failed, 1);
    assert.equal(db.state.assets.has(10), true);
    assert.match(warnings[0], /blob already deleted/);
  });

  it("never deletes catalog, inline or other-owner blobs of user rows, and does not rescan them", async () => {
    const db = createFakeDb({
      10: { ownerId: 1, storageUrl: catalogUrl("1/5/a.jpg") }, // capture frame reusing a catalog blob
      11: { ownerId: 1, storageUrl: "inline://capture/abc/def.jpg" },
      12: { ownerId: 1, storageUrl: mediaUrl("2/5/a.jpg") }, // owner mismatch
    });
    const { deps, deleted } = createDeps(db);
    const result = await sweep.sweepOrphanedUserMedia(deps, CONFIG);
    assert.deepEqual(result, { scanned: 0, deleted: 0, blobMissing: 0, failed: 0, skipped: 0, truncated: false });
    assert.deepEqual(deleted, []);
    assert.equal(db.state.assets.size, 3);
  });

  it("still refuses an other-owner blob if one gets past the SQL prefilter", async () => {
    const db = createFakeDb({ 10: { ownerId: 1, storageUrl: mediaUrl("1/5/a.jpg") } });
    const query = db.query;
    db.query = async (text, values) =>
      text.includes("FOR UPDATE SKIP LOCKED")
        ? { rows: [{ ownerId: "2", storageUrl: mediaUrl("1/5/a.jpg"), thumbUrl: null }] }
        : query(text, values);
    const { deps, deleted } = createDeps(db);
    deps.transaction = async (cb) => cb({ query: db.query });
    const result = await sweep.sweepOrphanedUserMedia(deps, CONFIG);
    assert.equal(result.skipped, 1);
    assert.deepEqual(deleted, []);
  });

  it("never deletes a blob another image_asset row also uses", async () => {
    const db = createFakeDb({
      10: { ownerId: 1, storageUrl: mediaUrl("1/5/a.jpg") },
      11: { ownerId: 1, storageUrl: mediaUrl("1/6/b.jpg"), refs: 1, thumbUrl: mediaUrl("1/5/a.jpg") },
    });
    const { deps, deleted } = createDeps(db);
    const result = await sweep.sweepOrphanedUserMedia(deps, CONFIG);
    assert.deepEqual(result, { scanned: 1, deleted: 0, blobMissing: 0, failed: 0, skipped: 1, truncated: false });
    assert.deepEqual(deleted, []);
    assert.equal(db.state.assets.size, 2);
  });

  it("skips an asset locked by another transaction or referenced after the scan", async () => {
    const db = createFakeDb(
      {
        10: { ownerId: 1, storageUrl: mediaUrl("1/5/a.jpg") },
        11: { ownerId: 1, storageUrl: mediaUrl("1/6/b.jpg") },
      },
      {
        locked: [10],
        onLock: (id, state) => {
          if (id === 11) state.assets.get(11).refs = 1; // a manicure started pointing at it
        },
      }
    );
    const { deps, deleted } = createDeps(db);
    const result = await sweep.sweepOrphanedUserMedia(deps, CONFIG);
    assert.deepEqual(result, { scanned: 2, deleted: 0, blobMissing: 0, failed: 0, skipped: 2, truncated: false });
    assert.deepEqual(deleted, []);
  });

  it("pages by image_id and stops at maxPerRun", async () => {
    const assets = {};
    for (let id = 1; id <= 7; id += 1) assets[id] = { ownerId: 1, storageUrl: mediaUrl(`1/${id}/a.jpg`) };
    const db = createFakeDb(assets, { locked: [1, 2, 3, 4, 5, 6, 7] }); // all skipped, so ids stay
    const { deps } = createDeps(db);

    const capped = await sweep.sweepOrphanedUserMedia(deps, { ...CONFIG, batchSize: 2, maxPerRun: 5 });
    assert.equal(capped.scanned, 5);
    assert.equal(capped.truncated, true);
    assert.deepEqual(
      db.state.candidateCalls.map((c) => [c.cursor, c.limit]),
      [["0", 2], ["2", 2], ["4", 1]]
    );

    db.state.candidateCalls = [];
    const full = await sweep.sweepOrphanedUserMedia(deps, { ...CONFIG, batchSize: 3, maxPerRun: 100 });
    assert.equal(full.scanned, 7);
    assert.equal(full.truncated, false);
    assert.deepEqual(db.state.candidateCalls.map((c) => c.cursor), ["0", "3", "6"]);
  });

  it("throws when the reference catalog cannot be read", async () => {
    const { deps } = createDeps(createFakeDb({}, { references: [{ ...REFERENCES[0], columns: ["a", "b"] }] }));
    await assert.rejects(sweep.sweepOrphanedUserMedia(deps, CONFIG), sweep.OrphanMediaSweepError);
  });
});

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------
describe("orphan-media-sweep timer", () => {
  const context = () => ({ log() {}, warn() {}, error() {}, invocationId: "t" });

  it("is registered on the default schedule", () => {
    assert.equal(registeredTimers["orphan-media-sweep"].schedule, "0 17 3 * * *");
    assert.equal(registeredTimers["orphan-media-sweep"].runOnStartup, false);
  });

  it("skips without a storage connection", async () => {
    let queried = false;
    queryMock = async () => {
      queried = true;
      return { rows: [] };
    };
    await registeredTimers["orphan-media-sweep"].handler({}, context());
    assert.equal(queried, false);
    assert.deepEqual(telemetry.events.map((e) => e.name), ["orphan_media_sweep.skipped"]);
  });

  it("deletes only user-media blobs and reports the counts", async () => {
    process.env.AZURE_STORAGE_CONNECTION =
      "DefaultEndpointsProtocol=https;AccountName=swatchwatchacct;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
    const db = createFakeDb({
      10: { ownerId: 1, storageUrl: mediaUrl("1/5/a.jpg") },
      11: { ownerId: 1, storageUrl: mediaUrl("1/6/b.jpg") },
    });
    queryMock = db.query;
    transactionMock = db.transaction;
    const blobDeletes = [];
    blobStorage.deleteBlobFromStorageUrl = async (url, options) => {
      blobDeletes.push({ url, allowedContainers: options.allowedContainers });
      return url !== mediaUrl("1/6/b.jpg");
    };

    await registeredTimers["orphan-media-sweep"].handler({}, context());

    assert.deepEqual(blobDeletes.map((d) => d.allowedContainers), [["nail-photos"], ["nail-photos"]]);
    const completed = telemetry.events.find((e) => e.name === "orphan_media_sweep.completed");
    assert.ok(completed, "completed event emitted");
    assert.equal(completed.properties.scanned, 2);
    assert.equal(completed.properties.deleted, 2);
    assert.equal(completed.properties.blobMissing, 1);
    assert.equal(completed.properties.failed, 0);
    assert.deepEqual(
      Object.fromEntries(telemetry.metrics.map((m) => [m.name, m.value])),
      {
        "orphan_media_sweep.scanned": 2,
        "orphan_media_sweep.deleted": 2,
        "orphan_media_sweep.blobMissing": 1,
        "orphan_media_sweep.failed": 0,
        "orphan_media_sweep.skipped": 0,
      }
    );
  });

  it("reports a failed run without throwing", async () => {
    process.env.AZURE_STORAGE_CONNECTION =
      "DefaultEndpointsProtocol=https;AccountName=swatchwatchacct;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
    queryMock = async () => {
      throw new Error("db down");
    };
    await registeredTimers["orphan-media-sweep"].handler({}, context());
    assert.deepEqual(telemetry.events.map((e) => e.name), ["orphan_media_sweep.failed"]);
    assert.equal(telemetry.exceptions.length, 1);
  });

  it("refuses to run when the user-media container is the catalog container", async () => {
    process.env.AZURE_STORAGE_CONNECTION =
      "DefaultEndpointsProtocol=https;AccountName=swatchwatchacct;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
    process.env.USER_MEDIA_CONTAINER = "swatches";
    let queried = false;
    queryMock = async () => {
      queried = true;
      return { rows: [] };
    };
    await registeredTimers["orphan-media-sweep"].handler({}, context());
    assert.equal(queried, false);
    assert.deepEqual(telemetry.events.map((e) => e.name), ["orphan_media_sweep.failed"]);
  });
});
