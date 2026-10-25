/**
 * Manual add from Rapid Add's unknown-barcode path (#21, #325): POST /api/polishes accepts the
 * scanned `barcode` and remembers it on the resulting shade for the caller only
 * (`user_shade_barcode`), so the next scan of that bottle matches. Never writes the shared
 * catalog `barcode` table. Runs without a database (same mocking as inventory-status).
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
registerMock("../lib/blob-storage", {
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


afterEach(() => {
  queryMock = async () => ({ rows: [] });
  transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });
  delete process.env.AUTH_DEV_BYPASS;
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
  return { log: () => {}, error: () => {}, warn: () => {}, extraOutputs: { set: () => {}, get: () => undefined } };
}

const USER_ROW = { user_id: 1, external_id: "ext-1", email: null, role: "user" };

/** Auth succeeds; every other pool query is recorded and answered by `respond`. */
function mockPool(respond = () => ({ rows: [] })) {
  process.env.AUTH_DEV_BYPASS = "true";
  const calls = [];
  queryMock = async (text, params) => {
    if (/FROM\s+app_user/i.test(text)) return { rows: [USER_ROW] };
    calls.push({ text: String(text), params });
    return respond(String(text), params);
  };
  return calls;
}

/** Transaction client recording every statement; the inventory upsert returns an id. */
function mockTransaction() {
  const calls = [];
  transactionMock = async (cb) =>
    cb({
      query: async (text, params) => {
        calls.push({ text: String(text), params });
        if (/INSERT INTO user_inventory_item/.test(text)) return { rows: [{ inventoryItemId: "42" }] };
        return { rows: [] };
      },
    });
  return calls;
}

function upsertCall(calls) {
  const call = calls.find((c) => /INSERT INTO user_inventory_item/.test(c.text));
  assert.ok(call, "expected the inventory upsert");
  return call;
}

/** Param bound to `$n` in the upsert (1-based). */

const POLISH_ROW = { id: "9", shadeId: "9", brand: "Indie", name: "X", finish: "creme", status: "owned" };

async function post(body) {
  mockPool((text) => {
    if (/AS "ownSubmitted"/.test(text) && !/AS "inventoryItemId"/.test(text)) return { rows: [{ ownSubmitted: false, brand: "Indie", shadeName: "X" }] };
    return { rows: [POLISH_ROW] };
  });
  const tx = mockTransaction();
  const res = await registeredRoutes["polishes-create"].handler(
    fakeRequest({ method: "POST", url: "http://localhost:7071/api/polishes", body }),
    fakeContext()
  );
  return { res, tx };
}

const learned = (tx) => tx.filter((c) => /user_shade_barcode/.test(c.text));

describe("functions/polishes — create with a scanned barcode", () => {
  it("remembers the canonical GTIN on the shade for the caller", async () => {
    const { res, tx } = await post({ shadeId: "9", brand: "Indie", name: "X", color: "#ff0000", barcode: "036000291452", barcodeFormat: "upc_a" });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const writes = learned(tx);
    assert.equal(writes.length, 1);
    assert.match(writes[0].text, /INSERT INTO user_shade_barcode/);
    assert.deepEqual(writes[0].params, [1, "0036000291452", 9, "UPC_A", null]);
    assert.equal(tx.filter((c) => /INSERT INTO barcode\b/.test(c.text)).length, 0, "never the shared catalog");
  });

  it("returns 400 for a barcode that is not a valid EAN/UPC, before any write", async () => {
    const { res, tx } = await post({ shadeId: "9", brand: "Indie", name: "X", color: "#ff0000", barcode: "12345" });
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /barcode/i);
    assert.equal(tx.length, 0);
  });

  it("keeps a barcode with a bad check digit (canonical key), not a 400", async () => {
    const { res, tx } = await post({ shadeId: "9", brand: "Indie", name: "X", color: "#ff0000", barcode: "036000291453" });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.deepEqual(learned(tx)[0].params, [1, "0036000291453", 9, "UPC_A", null]);
  });

  it("learns the canonical key for an iOS-style 13-digit UPC-A", async () => {
    const { tx } = await post({ shadeId: "9", brand: "Indie", name: "X", color: "#ff0000", barcode: "0036000291452", barcodeFormat: "ean_13" });
    assert.equal(learned(tx)[0].params[1], "0036000291452");
  });

  it("writes nothing extra without a barcode", async () => {
    const { res, tx } = await post({ shadeId: "9", brand: "Indie", name: "X", color: "#ff0000" });
    assert.equal(res.status, 201);
    assert.equal(learned(tx).length, 0);
  });
});
