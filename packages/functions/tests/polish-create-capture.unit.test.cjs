/**
 * One-tap create from the bottle flow: POST /api/polishes accepts the capture session's
 * `captureId`, marks the caller's session matched with the new shade inside the create
 * transaction, learns the session's scanned GTIN, and releases the frame blobs after commit.
 * Runs without a database (same mocking as polish-create-barcode).
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const registeredRoutes = {};
let queryMock = async () => ({ rows: [] });
let transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });

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
    http: (name, opts) => {
      registeredRoutes[name] = opts;
    },
    storageQueue: () => {},
    timer: () => {},
  },
  output: { storageQueue: (opts) => ({ __type: "storageQueue", ...opts }) },
});
registerMock("jose", {
  errors: { JOSEError: class JOSEError extends Error {} },
  createRemoteJWKSet: () => {},
  jwtVerify: async () => ({ payload: {} }),
});
const dbMock = {
  query: (...args) => queryMock(...args),
  transaction: (...args) => transactionMock(...args),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
registerMock("../lib/ai-color-detection", {
  detectHexWithAzureOpenAI: async () => ({ hex: "#ABCDEF", confidence: 0.9, finishes: [], provider: "azure-openai" }),
});
const releaseCalls = [];
const events = [];
registerMock("../lib/capture-frame-store", {
  releaseCaptureFrames: async (input) => {
    events.push("release");
    releaseCalls.push(input);
    return { released: 0, blobMissing: 0, failed: 0 };
  },
});
registerMock("../lib/blob-storage", {
  deleteBlobFromStorageUrl: async () => true,
  userMediaContainer: () => "nail-photos",
  isCatalogStorageUrl: () => false,
  isUserMediaStorageUrl: () => false,
  readBlobFromStorageUrl: async () => {
    throw new Error("blob reads are not exercised here");
  },
});
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}


require("../dist/functions/polishes");
const {
  MARK_SESSION_CREATED_SHADE_SQL,
  LOCK_CAPTURE_SESSION_SQL,
  SELECT_SESSION_FRAME_GTIN_SQL,
} = require("../dist/lib/capture-session");

afterEach(() => {
  queryMock = async () => ({ rows: [] });
  transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });
  delete process.env.AUTH_DEV_BYPASS;
  releaseCalls.length = 0;
  events.length = 0;
});

function fakeRequest({ method = "GET", url, params = {}, body } = {}) {
  return {
    method,
    url,
    headers: { get: (name) => (name.toLowerCase() === "authorization" ? "Bearer dev:1" : null) },
    params,
    json: async () => body,
  };
}

function fakeContext() {
  return { log: () => {}, warn: () => {}, error: () => {}, extraOutputs: { set: () => {}, get: () => undefined } };
}

const USER_ROW = { user_id: 1, external_id: "ext-1", email: null, role: "user" };
const POLISH_ROW = { id: "9", shadeId: "9", brand: "Indie", name: "X", finish: "creme", status: "owned" };
const CAPTURE_ID = "3f2b8c1e-6f1a-4c55-9a7e-0b1c2d3e4f50";
const SESSION_ID = 77;

function mockPool() {
  process.env.AUTH_DEV_BYPASS = "true";
  const calls = [];
  queryMock = async (text, params) => {
    if (/FROM\s+app_user/i.test(text)) return { rows: [USER_ROW] };
    calls.push({ text: String(text), params });
    return { rows: [POLISH_ROW] };
  };
  return calls;
}

/**
 * Transaction client recording every statement. `session` is what the locked-session query
 * returns (null = no row for this caller); `frameGtin` the newest frame's decoded GTIN.
 * A throw inside the callback skips the "committed" event, like the real transaction().
 */
function mockTransaction({ session, frameGtin = null } = {}) {
  const calls = [];
  transactionMock = async (cb) => {
    const result = await cb({
      query: async (text, params) => {
        calls.push({ text: String(text), params });
        if (/SELECT brand_id FROM brand/.test(text)) return { rows: [{ brand_id: 3 }] };
        if (/INSERT INTO shade\b/.test(text)) return { rows: [{ shade_id: 9 }] };
        if (/INSERT INTO user_inventory_item/.test(text)) return { rows: [{ inventoryItemId: "42" }] };
        if (text === LOCK_CAPTURE_SESSION_SQL) return { rows: session ? [session] : [] };
        if (text === SELECT_SESSION_FRAME_GTIN_SQL) return { rows: frameGtin ? [{ gtin: frameGtin, format: null }] : [] };
        return { rows: [] };
      },
    });
    events.push("committed");
    return result;
  };
  return calls;
}

async function post(body, txOptions) {
  const queries = mockPool();
  const tx = mockTransaction(txOptions);
  const res = await registeredRoutes["polishes-create"].handler(
    fakeRequest({ method: "POST", url: "http://localhost:7071/api/polishes", body }),
    fakeContext()
  );
  return { res, tx, queries };
}

const NEW_SHADE = { brand: "Indie", name: "X", color: "#ff0000" };
const learned = (tx) => tx.filter((c) => /INSERT INTO user_shade_barcode/.test(c.text));
const sessionWrites = (tx) => tx.filter((c) => c.text === MARK_SESSION_CREATED_SHADE_SQL);
const shadeWrites = (tx) => tx.filter((c) => /INSERT INTO shade\b/.test(c.text));
const inventoryWrites = (tx) => tx.filter((c) => /INSERT INTO user_inventory_item/.test(c.text));
const touchedSession = (calls) => calls.some((c) => /capture_session/.test(c.text));

describe("functions/polishes — create with a captureId", () => {
  it("marks the caller's session matched with the new shade, then releases the frames after commit", async () => {
    const { res, tx } = await post(
      { ...NEW_SHADE, captureId: CAPTURE_ID },
      { session: { id: SESSION_ID, status: "processing", metadata: {} } }
    );
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const lock = tx.find((c) => c.text === LOCK_CAPTURE_SESSION_SQL);
    assert.deepEqual(lock.params, [CAPTURE_ID, 1]);
    const writes = sessionWrites(tx);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].params, [SESSION_ID, 9, 1]);
    assert.ok(
      tx.indexOf(writes[0]) > tx.findIndex((c) => /INSERT INTO user_inventory_item/.test(c.text)),
      "the session is marked after the inventory upsert"
    );
    assert.equal(releaseCalls.length, 1);
    assert.equal(releaseCalls[0].sessionId, SESSION_ID);
    assert.equal(releaseCalls[0].userId, 1);
    assert.equal(releaseCalls[0].captureId, CAPTURE_ID);
    assert.deepEqual(events, ["committed", "release"], "release runs after the transaction callback resolved");
  });

  it("learns the session's scanned GTIN when the body sends no barcode", async () => {
    const { res, tx } = await post(
      { ...NEW_SHADE, captureId: CAPTURE_ID },
      { session: { id: SESSION_ID, status: "needs_question", metadata: { gtin: "4006381333931" } } }
    );
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const writes = learned(tx);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].params, [1, "4006381333931", 9, "EAN_13", SESSION_ID]);
  });

  it("falls back to the newest frame's decoded GTIN", async () => {
    const { tx } = await post(
      { ...NEW_SHADE, captureId: CAPTURE_ID },
      { session: { id: SESSION_ID, status: "processing", metadata: null }, frameGtin: "036000291452" }
    );
    const writes = learned(tx);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].params[1], "0036000291452");
    assert.equal(writes[0].params[4], SESSION_ID);
  });

  it("lets the body's barcode win: one INSERT only", async () => {
    const { res, tx } = await post(
      { ...NEW_SHADE, captureId: CAPTURE_ID, barcode: "036000291452", barcodeFormat: "upc_a" },
      { session: { id: SESSION_ID, status: "processing", metadata: { gtin: "4006381333931" } } }
    );
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const writes = learned(tx);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].params[1], "0036000291452");
  });

  it("returns 404 for an unknown or another user's session and writes no shade or inventory row", async () => {
    const { res, tx } = await post({ ...NEW_SHADE, captureId: CAPTURE_ID }, { session: null });
    assert.equal(res.status, 404);
    assert.equal(res.jsonBody.error, "Capture session not found");
    // The shade and inventory rows are written before the session is checked; the thrown error
    // must reach transaction() so they roll back instead of committing.
    assert.equal(sessionWrites(tx).length, 0);
    assert.equal(learned(tx).length, 0);
    assert.ok(!events.includes("committed"), "the transaction must roll back");
    assert.equal(releaseCalls.length, 0);
  });

  it("returns 409 for a cancelled session and rolls the transaction back", async () => {
    const { res, tx } = await post(
      { ...NEW_SHADE, captureId: CAPTURE_ID },
      { session: { id: SESSION_ID, status: "cancelled", metadata: {} } }
    );
    assert.equal(res.status, 409);
    assert.equal(res.jsonBody.error, "Capture session is cancelled");
    assert.equal(sessionWrites(tx).length, 0);
    assert.ok(!events.includes("committed"), "the transaction must roll back");
    assert.equal(releaseCalls.length, 0);
  });

  it("returns 400 for a captureId that is not a UUID, before any query", async () => {
    const { res, tx, queries } = await post({ ...NEW_SHADE, captureId: "nope" });
    assert.equal(res.status, 400);
    assert.equal(res.jsonBody.error, "captureId must be a valid UUID");
    assert.equal(tx.length, 0);
    assert.equal(queries.length, 0);
  });

  it("re-marks a session a legacy finalize already matched", async () => {
    const { res, tx } = await post(
      { ...NEW_SHADE, captureId: CAPTURE_ID },
      { session: { id: SESSION_ID, status: "matched", metadata: { inventoryItemId: 5 } } }
    );
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.deepEqual(sessionWrites(tx)[0].params, [SESSION_ID, 9, 1]);
  });

  it("is today's path without a captureId: no session query, no release", async () => {
    const { res, tx } = await post(NEW_SHADE);
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(touchedSession(tx), false);
    assert.equal(releaseCalls.length, 0);
    assert.equal(shadeWrites(tx).length + inventoryWrites(tx).length > 0, true);
  });
});
