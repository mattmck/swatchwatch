/**
 * Admin bottle eval samples (Slice 0 of bottle recognition):
 *   GET/POST /api/bottle-eval-admin/samples
 *   DELETE   /api/bottle-eval-admin/samples/{id}
 *   POST     /api/bottle-eval-admin/samples/{id}/frames
 *   DELETE   /api/bottle-eval-admin/samples/{id}/frames/{frameId}
 *
 * Runs without a database or storage account: lib/db is an in-memory fake, blob uploads and
 * deletes are recorded, and the nail-photo sanitizer is replaced by a stub that returns a fixed
 * 10×10 JPEG (its real behavior is covered by nail-photo-image.unit.test.cjs). Auth is the real
 * withAdmin in dev-bypass mode over the fake app_user lookup.
 */
const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

process.env.IMAGE_PROXY_SIGNING_KEY = "bottle-eval-unit-test-signing-key-0123456789";
delete process.env.USER_MEDIA_CONTAINER;
delete process.env.SOURCE_IMAGE_CONTAINER;
delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

// The real error class, so `instanceof` agrees between the stub and lib/nail-photo-upload.
const { NailPhotoInputError } = require("../dist/lib/nail-photo-image");

const USER = 1; // role user
const ADMIN = 5; // role admin
const OTHER_ADMIN = 9; // role admin
const ROLES = { [USER]: "user", [ADMIN]: "admin", [OTHER_ADMIN]: "admin" };
const BLOB_ORIGIN = "https://acct.blob.core.windows.net";
const VALID_IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

// ---------------------------------------------------------------------------
// Recorders + fake DB
// ---------------------------------------------------------------------------
let events;
let db;
let failFrameInsert;
let failBlobDelete;
let sanitizerCalls;
let telemetry;

function resetState() {
  events = [];
  failFrameInsert = false;
  failBlobDelete = false;
  sanitizerCalls = 0;
  telemetry = [];
  db = {
    shades: new Map([
      [42, { shadeId: 42, brand: "Holo Taco", shadeName: "Unicorn Skin", merged: false }],
      [43, { shadeId: 43, brand: "Holo Taco", shadeName: "Old Name", merged: true }],
    ]),
    samples: new Map(), // id -> { shadeId, brandText, shadeText, notes, createdBy, createdAt }
    frames: new Map(), // frameId -> { sampleId, imageId, surface, frameType, position, width, height, sizeBytes, createdAt }
    assets: new Map(), // imageId -> { ownerId, storageUrl }
    referencedImages: new Set(), // imageIds another table still references (kept by the NOT EXISTS guards)
    nextSampleId: 7,
    nextFrameId: 100,
    nextImageId: 500,
  };
}
resetState();

function sqlEvents() {
  return events.filter((e) => e.kind === "sql" && !e.auth);
}

function addSample(id, { createdBy = ADMIN, shadeId = null, brandText = "Indie", shadeText = "Fog" } = {}) {
  db.samples.set(id, { shadeId, brandText, shadeText, notes: null, createdBy, createdAt: new Date("2026-10-23T10:00:00Z") });
}

function addFrame(sampleId, ownerId, { surface = "front", frameType = "label" } = {}) {
  const imageId = db.nextImageId++;
  const frameId = db.nextFrameId++;
  db.assets.set(imageId, {
    ownerId,
    storageUrl: `${BLOB_ORIGIN}/nail-photos/${ownerId}/bottle-eval/${sampleId}/0000000${frameId}-aaaa-bbbb-cccc-dddddddddddd.jpg`,
  });
  const position = [...db.frames.values()].filter((f) => f.sampleId === sampleId).length + 1;
  db.frames.set(frameId, {
    sampleId,
    imageId,
    surface,
    frameType,
    position,
    width: 10,
    height: 10,
    sizeBytes: 100,
    createdAt: new Date("2026-10-23T10:05:00Z"),
  });
  return frameId;
}

function sampleRow(id) {
  const s = db.samples.get(id);
  const shade = s.shadeId ? db.shades.get(s.shadeId) : null;
  return {
    sampleId: String(id),
    shadeId: s.shadeId ? String(s.shadeId) : null,
    brand: shade ? shade.brand : s.brandText,
    shadeName: shade ? shade.shadeName : s.shadeText,
    notes: s.notes,
    createdByUserId: String(s.createdBy),
    createdAt: s.createdAt,
  };
}

function frameRows(sampleIds) {
  const wanted = new Set(sampleIds.map(Number));
  return [...db.frames.entries()]
    .filter(([, f]) => wanted.has(f.sampleId))
    .sort(([, a], [, b]) => a.sampleId - b.sampleId || a.position - b.position)
    .map(([frameId, f]) => ({
      frameId: String(frameId),
      sampleId: String(f.sampleId),
      surface: f.surface,
      frameType: f.frameType,
      storageUrl: db.assets.get(f.imageId).storageUrl,
      ownerId: String(db.assets.get(f.imageId).ownerId),
      width: f.width,
      height: f.height,
      sizeBytes: f.sizeBytes,
      createdAt: f.createdAt,
    }));
}

async function fakeQuery(sql, params = [], inTx = false) {
  const text = String(sql);
  const auth = /FROM\s+app_user/i.test(text) && /WHERE\s+user_id\s*=\s*\$1/i.test(text);
  events.push({ kind: "sql", sql: text, params, inTx, auth });

  if (auth) {
    const id = Number(params[0]);
    const role = ROLES[id];
    return { rows: role ? [{ user_id: id, external_id: `ext-${id}`, email: null, role, suspended: false }] : [] };
  }
  if (/^\s*INSERT\s+INTO\s+bottle_eval_sample/i.test(text)) {
    const id = db.nextSampleId++;
    const createdAt = new Date("2026-10-23T12:00:00Z");
    db.samples.set(id, {
      shadeId: params[0] === null ? null : Number(params[0]),
      brandText: params[1],
      shadeText: params[2],
      notes: params[3],
      createdBy: Number(params[4]),
      createdAt,
    });
    return { rows: [{ sampleId: String(id), createdAt }] };
  }
  if (/^\s*INSERT\s+INTO\s+image_asset/i.test(text)) {
    const imageId = db.nextImageId++;
    db.assets.set(imageId, { ownerId: Number(params[0]), storageUrl: params[1] });
    return { rows: [{ imageId: String(imageId) }] };
  }
  if (/^\s*INSERT\s+INTO\s+bottle_eval_frame/i.test(text)) {
    if (failFrameInsert) throw new Error("simulated frame insert failure");
    const frameId = db.nextFrameId++;
    const [sampleId, imageId, surface, frameType, position, , width, height, sizeBytes] = params;
    db.frames.set(frameId, {
      sampleId: Number(sampleId),
      imageId: Number(imageId),
      surface,
      frameType,
      position,
      width,
      height,
      sizeBytes,
      createdAt: new Date("2026-10-23T12:01:00Z"),
    });
    return { rows: [{ frameId: String(frameId) }] };
  }
  if (/^\s*DELETE\s+FROM\s+bottle_eval_frame/i.test(text)) {
    const sampleId = Number(params[0]);
    const frameId = params.length > 1 ? Number(params[1]) : null;
    const rows = [];
    for (const [id, f] of [...db.frames]) {
      if (f.sampleId !== sampleId || (frameId !== null && id !== frameId)) continue;
      db.frames.delete(id);
      rows.push({ imageId: String(f.imageId) });
    }
    return { rows };
  }
  if (/^\s*DELETE\s+FROM\s+image_asset/i.test(text)) {
    const ids = (Array.isArray(params[0]) ? params[0] : [params[0]]).map(Number);
    const rows = [];
    for (const id of ids) {
      const asset = db.assets.get(id);
      if (!asset || db.referencedImages.has(id)) continue;
      db.assets.delete(id);
      rows.push({ storageUrl: asset.storageUrl, ownerId: String(asset.ownerId) });
    }
    return { rows };
  }
  if (/^\s*DELETE\s+FROM\s+bottle_eval_sample/i.test(text)) {
    const id = Number(params[0]);
    const existed = db.samples.delete(id);
    for (const [frameId, f] of [...db.frames]) if (f.sampleId === id) db.frames.delete(frameId);
    return { rows: existed ? [{ sampleId: String(id) }] : [], rowCount: existed ? 1 : 0 };
  }
  if (/FOR\s+UPDATE/i.test(text)) {
    const id = Number(params[0]);
    return { rows: db.samples.has(id) ? [{ sampleId: String(id) }] : [] };
  }
  if (/FROM\s+shade\s+sh/i.test(text)) {
    const shade = db.shades.get(Number(params[0]));
    return { rows: shade ? [shade] : [] };
  }
  if (/COUNT\(\*\)::int\s+AS\s+total/i.test(text)) {
    return { rows: [{ total: db.samples.size }] };
  }
  if (/AS\s+"maxPosition"/i.test(text) || /AS\s+"frameCount"/i.test(text)) {
    const id = Number(params[0]);
    if (!db.samples.has(id)) return { rows: [] };
    const frames = [...db.frames.values()].filter((f) => f.sampleId === id);
    return {
      rows: [
        {
          sampleId: String(id),
          frameCount: frames.length,
          maxPosition: frames.reduce((max, f) => Math.max(max, f.position), 0),
        },
      ],
    };
  }
  if (/FROM\s+bottle_eval_frame\s+f/i.test(text)) {
    return { rows: frameRows(params[0]) };
  }
  if (/FROM\s+bottle_eval_sample\s+s/i.test(text)) {
    if (/LIMIT/i.test(text)) {
      const after = params[0] === null ? Infinity : Number(params[0]);
      const limit = Number(params[1]);
      const ids = [...db.samples.keys()].filter((id) => id < after).sort((a, b) => b - a).slice(0, limit);
      return { rows: ids.map(sampleRow) };
    }
    const id = Number(params[0]);
    return { rows: db.samples.has(id) ? [sampleRow(id)] : [] };
  }
  throw new Error(`unexpected SQL in fake db: ${text}`);
}

// ---------------------------------------------------------------------------
// Module mocks (exact request ids only)
// ---------------------------------------------------------------------------
const registeredRoutes = {};
const mockModules = {};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (Object.prototype.hasOwnProperty.call(mockModules, request)) return request;
  return originalResolve.call(this, request, parent, ...rest);
};

const dbMock = {
  query: (sql, params) => fakeQuery(sql, params, false),
  transaction: async (cb) => {
    events.push({ kind: "tx-begin" });
    try {
      const result = await cb({ query: (sql, params) => fakeQuery(sql, params, true) });
      events.push({ kind: "tx-commit" });
      return result;
    } catch (error) {
      events.push({ kind: "tx-rollback" });
      throw error;
    }
  },
  getPool: () => ({}),
  closePool: async () => {},
};
mockModules["@azure/functions"] = {
  app: {
    http: (name, opts) => {
      registeredRoutes[name] = opts;
    },
  },
};
mockModules["../lib/db"] = dbMock;
mockModules["./db"] = dbMock;
mockModules["../lib/blob-storage"] = {
  userMediaContainer: () => "nail-photos",
  uploadBytesToBlob: async (params) => {
    events.push({ kind: "upload", params });
    return `${BLOB_ORIGIN}/${params.containerName}/${params.blobName}`;
  },
  deleteBlobFromStorageUrl: async (storageUrl, options) => {
    events.push({ kind: "blob-delete", storageUrl, options });
    if (failBlobDelete) throw new Error("simulated blob delete failure");
    return true;
  },
};
mockModules["../lib/nail-photo-image"] = {
  NailPhotoInputError,
  parseNailPhotoDataUrl: (value) => {
    sanitizerCalls++;
    if (typeof value === "string" && value.startsWith("data:image/heic")) {
      throw new NailPhotoInputError("Unsupported image type: image/heic", 415);
    }
    return { declaredType: "image/jpeg", bytes: Buffer.from("raw") };
  },
  normalizeNailPhoto: async () => {
    sanitizerCalls++;
    return {
      bytes: Buffer.alloc(100, 1),
      contentType: "image/jpeg",
      width: 10,
      height: 10,
      checksumSha256: "ab".repeat(32),
    };
  },
};
mockModules["../lib/telemetry"] = {
  trackEvent: (name, properties) => telemetry.push({ name, properties }),
  trackException: () => {},
  trackMetric: () => {},
};
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const lib = require("../dist/lib/bottle-eval");
require("../dist/functions/bottle-eval-admin");

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) delete require.cache[id];
});

const savedEnv = {};
beforeEach(() => {
  for (const key of [
    "AUTH_DEV_BYPASS",
    "AZURE_AD_B2C_TENANT",
    "AZURE_AD_B2C_CLIENT_ID",
    "WEBSITE_INSTANCE_ID",
    "WEBSITE_HOSTNAME",
    "AZURE_STORAGE_CONNECTION",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AUTH_DEV_BYPASS = "true";
  process.env.AZURE_STORAGE_CONNECTION = "UseDevelopmentStorage=true";
  resetState();
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fakeContext() {
  return { log() {}, warn() {}, error() {}, invocationId: "test-invocation" };
}

function call(name, { method, userId = ADMIN, params = {}, body, query = "" }) {
  const route = registeredRoutes[name].route.replace(/\{(\w+)\??\}/g, (_, key) => params[key] ?? "x");
  const url = `http://localhost:7071/api/${route}${query}`;
  const raw = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const headers = new Map([["authorization", `Bearer dev:${userId}`]]);
  if (raw) headers.set("content-length", String(raw.length));
  const request = {
    method,
    url,
    params,
    headers: { get: (key) => headers.get(key.toLowerCase()) ?? null },
    json: async () => {
      if (!raw) throw new Error("no body");
      return JSON.parse(raw.toString("utf8"));
    },
    arrayBuffer: async () => (raw ? raw : Buffer.alloc(0)),
  };
  return registeredRoutes[name].handler(request, fakeContext());
}

function assertNoRawBlobUrls(value) {
  const serialized = JSON.stringify(value);
  const hosts = (serialized.match(/https?:\/\/[^\s"'<>\\]+/g) || []).map((u) => new URL(u).hostname);
  const blobHosts = hosts.filter((h) => h === "blob.core.windows.net" || h.endsWith(".blob.core.windows.net"));
  assert.deepEqual(blobHosts, [], `raw blob URL leaked: ${serialized}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers
// ═══════════════════════════════════════════════════════════════════════════

describe("bottle-eval lib", () => {
  it("bottleEvalBlobName puts frames under {admin}/bottle-eval/{sample}/", () => {
    assert.match(lib.bottleEvalBlobName(5, 7), /^5\/bottle-eval\/7\/[0-9a-f-]{36}\.jpg$/);
    assert.notEqual(lib.bottleEvalBlobName(5, 7), lib.bottleEvalBlobName(5, 7));
  });

  it("isBottleEvalStorageUrl accepts only that admin's prefix in the user-media container", () => {
    const url = `${BLOB_ORIGIN}/nail-photos/5/bottle-eval/7/x.jpg`;
    assert.equal(lib.isBottleEvalStorageUrl(url, 5), true);
    assert.equal(lib.isBottleEvalStorageUrl(url, 9), false);
    assert.equal(lib.isBottleEvalStorageUrl(`${BLOB_ORIGIN}/nail-photos/5/7001/x.jpg`, 5), false);
    assert.equal(lib.isBottleEvalStorageUrl(`${BLOB_ORIGIN}/source-images/5/bottle-eval/7/x.jpg`, 5), false);
    assert.equal(lib.isBottleEvalStorageUrl("not a url", 5), false);
  });

  it("parseListQuery defaults, clamps and rejects a bad cursor", () => {
    assert.deepEqual(lib.parseListQuery(new URL("http://x/")), { after: null, limit: 25 });
    assert.deepEqual(lib.parseListQuery(new URL("http://x/?after=12&limit=500")), { after: 12, limit: 100 });
    assert.equal(lib.parseListQuery(new URL("http://x/?limit=0")).limit, 1);
    assert.equal(lib.parseListQuery(new URL("http://x/?limit=abc")).limit, 25);
    assert.throws(() => lib.parseListQuery(new URL("http://x/?after=abc")));
    assert.throws(() => lib.parseListQuery(new URL("http://x/?after=1234567890123456789")));
  });

  it("toBottleEvalSamples groups frames per sample in input order and asks mint per frame", () => {
    const minted = [];
    const samples = lib.toBottleEvalSamples(
      [
        { sampleId: "8", shadeId: null, brand: "B", shadeName: "S", notes: null, createdByUserId: "5", createdAt: "2026-10-23T10:00:00Z" },
        { sampleId: "7", shadeId: "42", brand: "Holo Taco", shadeName: "Unicorn Skin", notes: "n", createdByUserId: "9", createdAt: new Date("2026-10-23T09:00:00Z") },
      ],
      [
        { frameId: "2", sampleId: "7", surface: "glass", frameType: "color", storageUrl: "u2", ownerId: "9", width: 1, height: 2, sizeBytes: 3, createdAt: "2026-10-23T09:01:00Z" },
        { frameId: "1", sampleId: "7", surface: "front", frameType: "label", storageUrl: "u1", ownerId: "5", width: null, height: null, sizeBytes: null, createdAt: "2026-10-23T09:02:00Z" },
      ],
      (storageUrl, ownerId) => {
        minted.push([storageUrl, ownerId]);
        return ownerId === 5 ? `minted:${storageUrl}` : null;
      }
    );
    assert.deepEqual(samples.map((s) => s.sampleId), ["8", "7"]);
    assert.equal(samples[0].inCatalog, false);
    assert.deepEqual(samples[0].frames, []);
    assert.equal(samples[1].inCatalog, true);
    assert.equal(samples[1].createdAt, "2026-10-23T09:00:00.000Z");
    assert.deepEqual(samples[1].frames.map((f) => [f.frameId, f.imageUrl]), [["2", null], ["1", "minted:u1"]]);
    assert.deepEqual(minted, [["u2", 9], ["u1", 5]]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════════

const ROUTE_CALLS = [
  ["bottle-eval-admin-samples", "GET", {}],
  ["bottle-eval-admin-samples", "POST", {}],
  ["bottle-eval-admin-sample", "DELETE", { id: "7" }],
  ["bottle-eval-admin-frames", "POST", { id: "7" }],
  ["bottle-eval-admin-frame", "DELETE", { id: "7", frameId: "100" }],
];

describe("bottle-eval-admin routes", () => {
  it("registers all four routes with withAdmin", async () => {
    assert.deepEqual(
      Object.keys(registeredRoutes).sort(),
      ["bottle-eval-admin-frame", "bottle-eval-admin-frames", "bottle-eval-admin-sample", "bottle-eval-admin-samples"]
    );
    assert.equal(registeredRoutes["bottle-eval-admin-samples"].route, "bottle-eval-admin/samples");
    assert.equal(registeredRoutes["bottle-eval-admin-sample"].route, "bottle-eval-admin/samples/{id}");
    assert.equal(registeredRoutes["bottle-eval-admin-frames"].route, "bottle-eval-admin/samples/{id}/frames");
    assert.equal(registeredRoutes["bottle-eval-admin-frame"].route, "bottle-eval-admin/samples/{id}/frames/{frameId}");
    for (const opts of Object.values(registeredRoutes)) assert.equal(opts.authLevel, "anonymous");

    addSample(7);
    addFrame(7, ADMIN);
    for (const [name, method, params] of ROUTE_CALLS) {
      events = [];
      const body = method === "POST" ? { surface: "glass", image: VALID_IMAGE, brandText: "A", shadeText: "B" } : undefined;
      const res = await call(name, { method, userId: USER, params, body });
      assert.equal(res.status, 403, `${method} ${name}`);
      assert.deepEqual(sqlEvents(), [], `${method} ${name} ran SQL past the auth lookup`);
      assert.equal(events.filter((e) => e.kind !== "sql").length, 0, `${method} ${name} had side effects`);
    }
    assert.equal(sanitizerCalls, 0);
  });

  it("POST samples creates a catalog sample", async () => {
    const res = await call("bottle-eval-admin-samples", { method: "POST", body: { shadeId: "42" } });
    assert.equal(res.status, 201);
    assert.equal(res.headers["Cache-Control"], "private, no-store");
    const { sample } = res.jsonBody;
    assert.equal(sample.sampleId, "7");
    assert.equal(sample.shadeId, "42");
    assert.equal(sample.inCatalog, true);
    assert.equal(sample.brand, "Holo Taco");
    assert.equal(sample.shadeName, "Unicorn Skin");
    assert.equal(sample.createdByUserId, String(ADMIN));
    assert.deepEqual(sample.frames, []);
    const insert = sqlEvents().find((e) => /INSERT\s+INTO\s+bottle_eval_sample/i.test(e.sql));
    assert.deepEqual(insert.params, [42, "Holo Taco", "Unicorn Skin", null, ADMIN]);
    assert.ok(telemetry.some((t) => t.name === "bottle_eval.sample_created" && t.properties.inCatalog === true));
  });

  it("POST samples creates an external sample from text", async () => {
    const res = await call("bottle-eval-admin-samples", {
      method: "POST",
      body: { brandText: " Indie ", shadeText: "Fog", notes: "  " },
    });
    assert.equal(res.status, 201);
    assert.equal(res.jsonBody.sample.inCatalog, false);
    assert.equal(res.jsonBody.sample.shadeId, null);
    assert.equal(res.jsonBody.sample.brand, "Indie");
    const insert = sqlEvents().find((e) => /INSERT\s+INTO\s+bottle_eval_sample/i.test(e.sql));
    assert.deepEqual(insert.params, [null, "Indie", "Fog", null, ADMIN]);
    assert.equal(sqlEvents().some((e) => /FROM\s+shade\s+sh/i.test(e.sql)), false);
  });

  it("POST samples twice for the same shade creates two rows", async () => {
    const first = await call("bottle-eval-admin-samples", { method: "POST", body: { shadeId: 42 } });
    const second = await call("bottle-eval-admin-samples", { method: "POST", body: { shadeId: 42 } });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.jsonBody.sample.sampleId, second.jsonBody.sample.sampleId);
    assert.equal(sqlEvents().filter((e) => /INSERT\s+INTO\s+bottle_eval_sample/i.test(e.sql)).length, 2);
  });

  it("POST samples rejects a merged or unknown shade with 404", async () => {
    for (const shadeId of ["43", "999"]) {
      const res = await call("bottle-eval-admin-samples", { method: "POST", body: { shadeId } });
      assert.equal(res.status, 404, `shade ${shadeId}`);
    }
    assert.equal(sqlEvents().some((e) => /INSERT/i.test(e.sql)), false);
  });

  it("POST samples rejects a body with both shadeId and text with 400", async () => {
    const res = await call("bottle-eval-admin-samples", {
      method: "POST",
      body: { shadeId: "42", brandText: "Holo Taco", shadeText: "Unicorn Skin" },
    });
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /not both/);
    assert.deepEqual(sqlEvents(), []);
  });

  it("POST samples answers 400 for invalid JSON and for a shadeId too large for bigint", async () => {
    const bad = await call("bottle-eval-admin-samples", { method: "POST", body: "{not json" });
    assert.equal(bad.status, 400);
    const huge = await call("bottle-eval-admin-samples", { method: "POST", body: { shadeId: "1".repeat(25) } });
    assert.equal(huge.status, 400);
    assert.deepEqual(sqlEvents(), []);
  });

  it("POST frames stores blob then rows", async () => {
    addSample(7);
    const res = await call("bottle-eval-admin-frames", {
      method: "POST",
      params: { id: "7" },
      body: { surface: "glass", image: VALID_IMAGE },
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers["Cache-Control"], "private, no-store");

    const uploadIndex = events.findIndex((e) => e.kind === "upload");
    const txIndex = events.findIndex((e) => e.kind === "tx-begin");
    const assetIndex = events.findIndex((e) => e.kind === "sql" && /INSERT\s+INTO\s+image_asset/i.test(e.sql));
    const frameIndex = events.findIndex((e) => e.kind === "sql" && /INSERT\s+INTO\s+bottle_eval_frame/i.test(e.sql));
    assert.ok(uploadIndex >= 0 && uploadIndex < txIndex && txIndex < assetIndex && assetIndex < frameIndex, "upload → tx → image_asset → frame");

    const upload = events[uploadIndex].params;
    assert.equal(upload.containerName, "nail-photos");
    assert.match(upload.blobName, /^5\/bottle-eval\/7\/[0-9a-f-]{36}\.jpg$/);
    assert.equal(upload.contentType, "image/jpeg");

    const lock = events.findIndex((e) => e.kind === "sql" && e.inTx && /FOR\s+UPDATE/i.test(e.sql));
    assert.ok(lock > txIndex && lock < assetIndex, "sample locked before the inserts");

    const asset = events[assetIndex];
    assert.ok(asset.inTx);
    assert.match(asset.sql, /'user'/);
    assert.match(asset.sql, /'user_uploaded'/);
    assert.equal(Number(asset.params[0]), ADMIN);
    assert.equal(asset.params[1], `${BLOB_ORIGIN}/nail-photos/${upload.blobName}`);

    const frame = events[frameIndex];
    assert.ok(frame.inTx);
    assert.equal(frame.params[2], "glass");
    assert.equal(frame.params[3], "color");
    assert.equal(frame.params[4], 1);

    const { sample, frameId } = res.jsonBody;
    assert.equal(sample.sampleId, "7");
    assert.equal(sample.frames.length, 1);
    assert.equal(typeof frameId, "string");
    assert.equal(frameId, sample.frames[0].frameId, "frameId is the inserted frame's id");
    assert.equal(sample.frames[0].surface, "glass");
    assert.equal(sample.frames[0].frameType, "color");
    assert.ok(new URL(sample.frames[0].imageUrl).pathname.startsWith("/api/images/v3."), sample.frames[0].imageUrl);
    assertNoRawBlobUrls(res.jsonBody);
    assert.ok(telemetry.some((t) => t.name === "bottle_eval.frame_added" && t.properties.surface === "glass"));
  });

  it("POST frames appends after the current last position", async () => {
    addSample(7);
    addFrame(7, ADMIN);
    addFrame(7, OTHER_ADMIN, { surface: "bottom" });
    const res = await call("bottle-eval-admin-frames", { method: "POST", params: { id: "7" }, body: { surface: "box", image: VALID_IMAGE } });
    assert.equal(res.status, 201);
    const frame = events.find((e) => e.kind === "sql" && /INSERT\s+INTO\s+bottle_eval_frame/i.test(e.sql));
    assert.equal(frame.params[4], 3);
    assert.equal(frame.params[3], "label");
    assert.deepEqual(res.jsonBody.sample.frames.map((f) => f.surface), ["front", "bottom", "box"]);
    assert.equal(res.jsonBody.frameId, res.jsonBody.sample.frames[2].frameId);
  });

  it("POST frames with a HEIC body answers 415 and stores nothing", async () => {
    addSample(7);
    const res = await call("bottle-eval-admin-frames", {
      method: "POST",
      params: { id: "7" },
      body: { surface: "front", image: "data:image/heic;base64,AAAA" },
    });
    assert.equal(res.status, 415);
    assert.equal(events.some((e) => e.kind === "upload" || e.kind === "tx-begin"), false);
    assert.equal(sqlEvents().some((e) => /INSERT/i.test(e.sql)), false);
  });

  it("POST frames rejects an unknown surface with 400 before decoding", async () => {
    addSample(7);
    const res = await call("bottle-eval-admin-frames", { method: "POST", params: { id: "7" }, body: { surface: "cap", image: VALID_IMAGE } });
    assert.equal(res.status, 400);
    assert.equal(sanitizerCalls, 0);
  });

  it("POST frames for an unknown sample answers 404", async () => {
    const res = await call("bottle-eval-admin-frames", { method: "POST", params: { id: "77" }, body: { surface: "front", image: VALID_IMAGE } });
    assert.equal(res.status, 404);
    assert.equal(sanitizerCalls, 0);
    assert.equal(events.some((e) => e.kind === "upload"), false);
  });

  it("POST frames at the cap answers 409", async () => {
    addSample(7);
    for (let i = 0; i < 12; i++) addFrame(7, ADMIN);
    const res = await call("bottle-eval-admin-frames", { method: "POST", params: { id: "7" }, body: { surface: "front", image: VALID_IMAGE } });
    assert.equal(res.status, 409);
    assert.equal(events.some((e) => e.kind === "upload"), false);
    assert.equal(sanitizerCalls, 0);
  });

  it("POST frames deletes the uploaded blob when the DB write fails", async () => {
    addSample(7);
    failFrameInsert = true;
    const res = await call("bottle-eval-admin-frames", { method: "POST", params: { id: "7" }, body: { surface: "front", image: VALID_IMAGE } });
    assert.equal(res.status, 500);
    const upload = events.find((e) => e.kind === "upload");
    const removed = events.filter((e) => e.kind === "blob-delete");
    assert.equal(removed.length, 1);
    assert.equal(removed[0].storageUrl, `${BLOB_ORIGIN}/nail-photos/${upload.params.blobName}`);
    assert.deepEqual(removed[0].options, { allowedContainers: ["nail-photos"] });
  });

  it("without AZURE_STORAGE_CONNECTION POST frames answers 503 before decoding", async () => {
    delete process.env.AZURE_STORAGE_CONNECTION;
    addSample(7);
    const res = await call("bottle-eval-admin-frames", { method: "POST", params: { id: "7" }, body: { surface: "front", image: VALID_IMAGE } });
    assert.equal(res.status, 503);
    assert.deepEqual(res.jsonBody, { error: "Photo storage is not configured" });
    assert.equal(sanitizerCalls, 0);
    assert.equal(events.some((e) => e.kind === "upload"), false);
  });

  it("GET samples hides other admins' frame urls", async () => {
    addSample(7, { createdBy: OTHER_ADMIN, shadeId: 42 });
    addFrame(7, OTHER_ADMIN);
    addSample(8, { createdBy: ADMIN });
    addFrame(8, ADMIN, { surface: "glass", frameType: "color" });

    const res = await call("bottle-eval-admin-samples", { method: "GET" });
    assert.equal(res.status, 200);
    assert.equal(res.headers["Cache-Control"], "private, no-store");
    const { samples, total, nextCursor } = res.jsonBody;
    assert.equal(total, 2);
    assert.equal(nextCursor, null);
    assert.deepEqual(samples.map((s) => s.sampleId), ["8", "7"]);
    const other = samples.find((s) => s.sampleId === "7");
    assert.equal(other.inCatalog, true);
    assert.equal(other.brand, "Holo Taco");
    assert.equal(other.frames.length, 1);
    assert.equal(other.frames[0].imageUrl, null);
    const mine = samples.find((s) => s.sampleId === "8");
    assert.ok(new URL(mine.frames[0].imageUrl).pathname.startsWith("/api/images/v3."));
    assertNoRawBlobUrls(res.jsonBody);

    const asOther = await call("bottle-eval-admin-samples", { method: "GET", userId: OTHER_ADMIN });
    const seen = asOther.jsonBody.samples.find((s) => s.sampleId === "7");
    assert.ok(seen.frames[0].imageUrl, "the owner gets its own frame url");
    assert.equal(asOther.jsonBody.samples.find((s) => s.sampleId === "8").frames[0].imageUrl, null);
  });

  it("GET samples pages newest first with a keyset cursor", async () => {
    for (const id of [3, 4, 5]) addSample(id);
    const first = await call("bottle-eval-admin-samples", { method: "GET", query: "?limit=2" });
    assert.deepEqual(first.jsonBody.samples.map((s) => s.sampleId), ["5", "4"]);
    assert.equal(first.jsonBody.nextCursor, "4");
    assert.equal(first.jsonBody.total, 3);
    const second = await call("bottle-eval-admin-samples", { method: "GET", query: "?limit=2&after=4" });
    assert.deepEqual(second.jsonBody.samples.map((s) => s.sampleId), ["3"]);
    assert.equal(second.jsonBody.nextCursor, null);
    const bad = await call("bottle-eval-admin-samples", { method: "GET", query: "?after=nope" });
    assert.equal(bad.status, 400);
  });

  it("DELETE sample answers 204 and tolerates a failing blob delete", async () => {
    addSample(7);
    addFrame(7, ADMIN);
    addFrame(7, OTHER_ADMIN);
    failBlobDelete = true;
    const res = await call("bottle-eval-admin-sample", { method: "DELETE", params: { id: "7" } });
    assert.equal(res.status, 204);
    const deleteSample = sqlEvents().find((e) => /DELETE\s+FROM\s+bottle_eval_sample/i.test(e.sql));
    assert.ok(deleteSample && deleteSample.inTx, "the sample DELETE ran in the transaction");
    assert.equal(db.samples.has(7), false);
    assert.equal(db.assets.size, 0, "frame image_asset rows removed");
    const blobDeletes = events.filter((e) => e.kind === "blob-delete");
    assert.equal(blobDeletes.length, 2);
    assert.ok(events.indexOf(blobDeletes[0]) > events.findIndex((e) => e.kind === "tx-commit"), "blobs deleted after commit");
    for (const d of blobDeletes) assert.deepEqual(d.options, { allowedContainers: ["nail-photos"] });
    assert.equal(telemetry.filter((t) => t.name === "bottle_eval.blob_delete_failed").length, 2);
    assert.ok(telemetry.some((t) => t.name === "bottle_eval.sample_deleted"));

    const again = await call("bottle-eval-admin-sample", { method: "DELETE", params: { id: "7" } });
    assert.equal(again.status, 204);
  });

  it("DELETE sample keeps an image row another table references, and its blob", async () => {
    addSample(7);
    addFrame(7, ADMIN);
    addFrame(7, ADMIN, { surface: "bottom", frameType: "barcode" });
    const [goneImage, keptImage] = [...db.frames.values()].map((f) => f.imageId);
    db.referencedImages.add(keptImage); // e.g. also linked as a mani-log photo
    const res = await call("bottle-eval-admin-sample", { method: "DELETE", params: { id: "7" } });
    assert.equal(res.status, 204);

    const deleteImages = sqlEvents().find((e) => /DELETE\s+FROM\s+image_asset/i.test(e.sql));
    assert.ok(deleteImages, "the image_asset DELETE ran");
    const compact = deleteImages.sql.replace(/\s+/g, " ");
    for (const guard of [
      "NOT EXISTS (SELECT 1 FROM manicure m WHERE m.photo_image_id = image_asset.image_id)",
      "NOT EXISTS (SELECT 1 FROM capture_frame cf WHERE cf.image_id = image_asset.image_id)",
      "NOT EXISTS (SELECT 1 FROM inventory_nail_photo p WHERE p.image_id = image_asset.image_id)",
    ]) {
      assert.ok(compact.includes(guard), `the image DELETE guards with ${guard}`);
    }
    assert.match(compact, /RETURNING storage_url/);

    assert.equal(db.assets.has(goneImage), false);
    assert.equal(db.assets.has(keptImage), true, "the referenced image row is kept");
    const blobDeletes = events.filter((e) => e.kind === "blob-delete");
    assert.equal(blobDeletes.length, 1, "only the deleted row's blob is deleted");
    assert.notEqual(blobDeletes[0].storageUrl, db.assets.get(keptImage).storageUrl);
  });

  it("DELETE frame answers 204, removes the frame and its image_asset, then the blob", async () => {
    addSample(7);
    const keep = addFrame(7, ADMIN);
    const victim = addFrame(7, ADMIN, { surface: "glass", frameType: "color" });
    const res = await call("bottle-eval-admin-frame", { method: "DELETE", params: { id: "7", frameId: String(victim) } });
    assert.equal(res.status, 204);
    assert.deepEqual([...db.frames.keys()], [keep]);
    assert.equal(db.assets.size, 1);
    const blobDeletes = events.filter((e) => e.kind === "blob-delete");
    assert.equal(blobDeletes.length, 1);
    assert.match(blobDeletes[0].storageUrl, /\/nail-photos\/5\/bottle-eval\/7\//);

    const again = await call("bottle-eval-admin-frame", { method: "DELETE", params: { id: "7", frameId: String(victim) } });
    assert.equal(again.status, 204);
  });

  it("answers 400 for malformed or oversized ids without querying", async () => {
    for (const [name, method, params] of [
      ["bottle-eval-admin-sample", "DELETE", { id: "abc" }],
      ["bottle-eval-admin-sample", "DELETE", { id: "9".repeat(19) }],
      ["bottle-eval-admin-frames", "POST", { id: "0" }],
      ["bottle-eval-admin-frame", "DELETE", { id: "7", frameId: "-1" }],
    ]) {
      events = [];
      const res = await call(name, { method, params, body: method === "POST" ? { surface: "front", image: VALID_IMAGE } : undefined });
      assert.equal(res.status, 400, `${method} ${name} ${JSON.stringify(params)}`);
      assert.deepEqual(sqlEvents(), []);
    }
  });
});

describe("bottle eval sample SQL", () => {
  it("resolves a merged shade to the surviving shade id", () => {
    const { SAMPLE_COLUMNS_SQL } = require("../dist/lib/bottle-eval");
    assert.match(SAMPLE_COLUMNS_SQL, /COALESCE\(sh\.merged_into_shade_id, s\.shade_id\)::text AS "shadeId"/);
    assert.match(SAMPLE_COLUMNS_SQL, /LEFT JOIN shade sh ON sh\.shade_id = s\.shade_id/);
  });

  it("reads the family of the shade's first finish from finish_type", () => {
    const { SAMPLE_COLUMNS_SQL } = require("../dist/lib/bottle-eval");
    assert.match(SAMPLE_COLUMNS_SQL, /FROM finish_type ft\s+WHERE lower\(ft\.name\) = lower\(sh\.finishes\[1\]\)\) AS "finishFamily"/);
    assert.match(SAMPLE_COLUMNS_SQL, /sh\.finishes\[1\] AS "primaryFinish"/);
  });
});
