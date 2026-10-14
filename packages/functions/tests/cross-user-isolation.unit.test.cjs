// Cross-user isolation unit tests (issue #53).
//
// Proves, with a mocked DB that behaves like `WHERE user_id = $n`, that user-owned resource
// handlers scope every read/write to the authenticated caller (Bearer dev:<id>) and that
// ownership cannot be spoofed through body/query parameters.
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const registeredRoutes = {};
let queryMock = async () => ({ rows: [] });
let transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });

const originalResolve = Module._resolveFilename;
const mockModules = {};
function registerMock(id, exports) {
  mockModules[id] = exports;
}
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
  },
  output: { storageQueue: (opts) => ({ __type: "storageQueue", ...opts }) },
});
registerMock("jose", { createRemoteJWKSet: () => {}, jwtVerify: async () => ({ payload: {} }) });

const dbMock = {
  query: (...args) => queryMock(...args),
  transaction: (...args) => transactionMock(...args),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
registerMock("../lib/ai-color-detection", {
  detectHexWithAzureOpenAI: async () => ({ hex: "#ABCDEF", confidence: 0.87, finishes: ["creme"] }),
});
registerMock("../lib/ocr", { extractTextFromImage: async () => null });
registerMock("../lib/ocr-parser", { parseLabelText: async () => null });

class BlobAccessDeniedError extends Error {}
class BlobReadError extends Error {}
let blobReads = [];
registerMock("../lib/blob-storage", {
  BlobAccessDeniedError,
  BlobReadError,
  readBlobFromStorageUrl: async (url) => {
    blobReads.push(url);
    return {
      bytes: Buffer.from("fakeimg"),
      contentType: "image/png",
      checksumSha256: "deadbeef",
      sizeBytes: 7,
      storageUrl: url,
    };
  },
  validateImageUpload: () => "image/png",
  stripImageMetadata: async (b) => b,
});

for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

function fakeRequest({ method = "GET", url = "http://localhost:7071/api/test", headers = {}, params = {}, body } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    url,
    headers: { get: (n) => headerMap.get(n.toLowerCase()) || null },
    params,
    query: new URL(url).searchParams,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}
function fakeContext() {
  return {
    log: () => {},
    error: () => {},
    warn: () => {},
    extraOutputs: { set: () => {}, get: () => undefined },
  };
}

require("../dist/functions/polishes");
require("../dist/functions/capture");
require("../dist/functions/images");
require("../dist/functions/admin-users");
const imageProxy = require("../dist/lib/image-proxy");

// ---------------------------------------------------------------------------
// Simulated multi-tenant DB: user 1 owns everything, user 2 owns nothing.
// ---------------------------------------------------------------------------
const OWNER = 1;
const ATTACKER = 2;
const SHADE_ID = 500;
const CAPTURE_ID = "11111111-1111-4111-8111-111111111111";
const auth = (id) => ({ authorization: `Bearer dev:${id}` });

let calls; // every top-level query: { sql, params }
let clientCalls; // every transaction-client query
let userRoles;

function simulateQuery(sql, params, sink) {
  sink.push({ sql, params });
  if (/FROM app_user/.test(sql)) {
    const id = params[0];
    return { rows: [{ user_id: id, external_id: `ext-${id}`, email: null, role: userRoles[id] || "user" }] };
  }
  if (/FROM capture_session/.test(sql) && /user_id\s*=\s*\$2/.test(sql)) {
    return params[1] === OWNER
      ? { rows: [{ id: 9, captureId: CAPTURE_ID, status: "processing", topConfidence: null, acceptedEntityType: null, acceptedEntityId: null, metadata: {} }] }
      : { rows: [] };
  }
  if (/DELETE FROM user_inventory_item/.test(sql)) {
    return params[1] === OWNER ? { rows: [{ id: "77" }] } : { rows: [] };
  }
  if (/INSERT INTO user_inventory_item/.test(sql)) {
    return { rows: [{ inventoryItemId: "900" }] };
  }
  if (/SELECT 1 FROM shade WHERE shade_id/.test(sql)) {
    return { rows: [{ "?column?": 1 }] };
  }
  if (/FROM shade s/.test(sql) && /user_inventory_item ui/.test(sql)) {
    // POLISH_SELECT: shade catalog is shared, inventory columns join on ui.user_id = $1.
    const owns = params[0] === OWNER;
    return {
      rows: [
        {
          id: String(SHADE_ID),
          shadeId: String(SHADE_ID),
          inventoryItemId: owns ? "77" : null,
          userId: String(params[0]),
          brand: "Brand",
          name: "Shade",
          color: "",
          finish: "creme",
          finishes: ["creme"],
          collection: "",
          quantity: owns ? 3 : null,
          notes: owns ? "user1 secret note" : null,
          swatchImageUrl: null,
        },
      ],
    };
  }
  return { rows: [] };
}

async function call(routeName, req) {
  return registeredRoutes[routeName].handler(req, fakeContext());
}
const ownedBy = (entries, id) => entries.filter((c) => c.params.includes(id));
const dataCalls = () => calls.filter((c) => !/FROM app_user/.test(c.sql));

beforeEach(() => {
  process.env.AUTH_DEV_BYPASS = "true";
  calls = [];
  clientCalls = [];
  blobReads = [];
  userRoles = {};
  queryMock = async (sql, params = []) => simulateQuery(sql, params, calls);
  transactionMock = async (cb) =>
    cb({ query: async (sql, params = []) => simulateQuery(sql, params, clientCalls) });
});
afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
  delete process.env.IMAGE_PROXY_SIGNING_KEY;
});

describe("cross-user isolation — inventory (polishes)", () => {
  it("detail: user 2 reading user 1's shade sees no inventory data; SQL param is user 2", async () => {
    const res = await call("polishes-list", fakeRequest({ headers: auth(ATTACKER), params: { id: String(SHADE_ID) } }));
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.inventoryItemId, null);
    assert.equal(res.jsonBody.quantity, null);
    assert.equal(res.jsonBody.notes, null);
    const scoped = dataCalls().filter((c) => /user_inventory_item/.test(c.sql));
    assert.equal(scoped.length, 1);
    assert.deepEqual(scoped[0].params, [ATTACKER, SHADE_ID]);
    // Remaining queries (shared catalog images) never carry user 1's id.
    for (const c of dataCalls()) assert.ok(!c.params.includes(OWNER));
  });

  it("detail: owner (control) does see their inventory data", async () => {
    const res = await call("polishes-list", fakeRequest({ headers: auth(OWNER), params: { id: String(SHADE_ID) } }));
    assert.equal(res.jsonBody.quantity, 3);
    assert.equal(dataCalls()[0].params[0], OWNER);
  });

  it("list: user 2 query is scoped by params[0] === 2 and no user 1 rows leak; ?userId=1 is ignored", async () => {
    const res = await call(
      "polishes-list",
      fakeRequest({ headers: auth(ATTACKER), url: "http://localhost:7071/api/polishes?userId=1&user_id=1" })
    );
    assert.equal(res.status, 200);
    const listCalls = dataCalls();
    assert.ok(listCalls.length > 0);
    for (const c of listCalls) {
      assert.equal(c.params[0], ATTACKER);
      assert.ok(!c.params.includes(OWNER), `params leaked user 1: ${JSON.stringify(c.params)}`);
    }
    const rows = Array.isArray(res.jsonBody) ? res.jsonBody : res.jsonBody.polishes || res.jsonBody.items || [];
    for (const r of rows) assert.notEqual(r.notes, "user1 secret note");
  });

  it("update: user 2 PUT on user 1's shade upserts only user 2's row; body userId/user_id ignored", async () => {
    const res = await call(
      "polishes-mutate",
      fakeRequest({
        method: "PUT",
        headers: auth(ATTACKER),
        params: { id: String(SHADE_ID) },
        body: { quantity: 9, notes: "pwn", userId: OWNER, user_id: OWNER },
      })
    );
    assert.equal(res.status, 200);
    const upserts = clientCalls.filter((c) => /INSERT INTO user_inventory_item/.test(c.sql));
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].params[0], ATTACKER);
    assert.equal(upserts[0].params[1], SHADE_ID);
    assert.equal(ownedBy(clientCalls, OWNER).filter((c) => /user_inventory_item/.test(c.sql)).length, 0);
    assert.equal(res.jsonBody.userId, String(ATTACKER));
  });

  it("delete: user 2 DELETE uses [shadeId, 2] and gets 404 when nothing is owned", async () => {
    const res = await call(
      "polishes-mutate",
      fakeRequest({ method: "DELETE", headers: auth(ATTACKER), params: { id: String(SHADE_ID) } })
    );
    assert.equal(res.status, 404);
    const del = calls.find((c) => /DELETE FROM user_inventory_item/.test(c.sql));
    assert.ok(del);
    assert.match(del.sql, /user_id = \$2/);
    assert.deepEqual(del.params, [SHADE_ID, ATTACKER]);
  });

  it("delete: owner (control) deletes with [shadeId, 1] and gets 200", async () => {
    const res = await call(
      "polishes-mutate",
      fakeRequest({ method: "DELETE", headers: auth(OWNER), params: { id: String(SHADE_ID) } })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(calls.find((c) => /DELETE FROM/.test(c.sql)).params, [SHADE_ID, OWNER]);
  });

  it("create: body userId/user_id spoofing is ignored; insert uses authenticated user 2", async () => {
    const res = await call(
      "polishes-create",
      fakeRequest({
        method: "POST",
        headers: auth(ATTACKER),
        body: { shadeId: String(SHADE_ID), quantity: 4, userId: OWNER, user_id: OWNER },
      })
    );
    assert.equal(res.status, 201);
    const inserts = clientCalls.filter((c) => /INSERT INTO user_inventory_item/.test(c.sql));
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].params[0], ATTACKER);
    assert.ok(!inserts[0].params.includes(OWNER));
  });
});

describe("cross-user isolation — capture sessions", () => {
  const sessionLookups = () => calls.filter((c) => /FROM capture_session/.test(c.sql));
  const writes = () =>
    [...calls, ...clientCalls].filter((c) => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.sql));

  const cases = [
    ["capture-status", { method: "GET" }],
    ["capture-frame", { method: "POST", body: { frameType: "label", imageBlobUrl: "https://x/y.png", userId: OWNER } }],
    ["capture-finalize", { method: "POST", body: {} }],
    ["capture-answer", { method: "POST", body: { answer: "yes", userId: OWNER } }],
  ];

  for (const [route, extra] of cases) {
    it(`${route}: user 2 on user 1's captureId -> 404, lookup scoped to user 2, nothing written`, async () => {
      const res = await call(route, fakeRequest({ ...extra, headers: auth(ATTACKER), params: { captureId: CAPTURE_ID } }));
      assert.equal(res.status, 404);
      const lookups = sessionLookups();
      assert.ok(lookups.length >= 1);
      for (const l of lookups) {
        assert.match(l.sql, /user_id\s*=\s*\$2/);
        assert.deepEqual(l.params, [CAPTURE_ID, ATTACKER]);
      }
      assert.deepEqual(writes(), []);
    });

    it(`${route}: owner (control) is able to resolve the session with params [captureId, 1]`, async () => {
      await call(route, fakeRequest({ ...extra, headers: auth(OWNER), params: { captureId: CAPTURE_ID } }));
      const lookups = sessionLookups();
      assert.ok(lookups.length >= 1);
      assert.deepEqual(lookups[0].params, [CAPTURE_ID, OWNER]);
    });
  }

  it("capture-start: new session is inserted for the authenticated user, ignoring body userId", async () => {
    const res = await call(
      "capture-start",
      fakeRequest({
        method: "POST",
        headers: auth(ATTACKER),
        body: { userId: OWNER, user_id: OWNER },
      })
    );
    // simulateQuery returns no row for the INSERT; the handler may 500 but must have bound user 2.
    void res;
    const ins = calls.find((c) => /INSERT INTO capture_session/.test(c.sql));
    assert.ok(ins);
    assert.equal(ins.params[1], ATTACKER);
    assert.ok(!ins.params.includes(OWNER));
  });
});

describe("cross-user isolation — unauthenticated requests", () => {
  const routes = [
    ["polishes-list", { method: "GET", params: { id: String(SHADE_ID) } }],
    ["polishes-list", { method: "GET" }],
    ["polishes-create", { method: "POST", body: { shadeId: "1" } }],
    ["polishes-mutate", { method: "PUT", params: { id: String(SHADE_ID) }, body: { quantity: 1 } }],
    ["polishes-mutate", { method: "DELETE", params: { id: String(SHADE_ID) } }],
    ["capture-start", { method: "POST", body: {} }],
    ["capture-status", { method: "GET", params: { captureId: CAPTURE_ID } }],
    ["capture-frame", { method: "POST", params: { captureId: CAPTURE_ID }, body: { frameType: "label", imageBlobUrl: "u" } }],
    ["capture-finalize", { method: "POST", params: { captureId: CAPTURE_ID }, body: {} }],
    ["capture-answer", { method: "POST", params: { captureId: CAPTURE_ID }, body: { answer: "x" } }],
  ];
  for (const [route, req] of routes) {
    it(`${route} ${req.method}${req.params ? " (with params)" : ""}: no Authorization -> 401 and no DB access`, async () => {
      const res = await call(route, fakeRequest(req));
      assert.equal(res.status, 401);
      assert.equal(calls.length, 0);
      assert.equal(clientCalls.length, 0);
    });
  }

  it("malformed dev token (not dev:<digits>) -> 401 and no data queries", async () => {
    const res = await call("polishes-list", fakeRequest({ headers: { authorization: "Bearer dev:1 OR 1=1" } }));
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
});

describe("cross-user isolation — admin routes", () => {
  const adminRoutes = [
    ["admin-users-list", { method: "GET" }],
    ["admin-users-merge", { method: "POST", body: { sourceUserId: 1, targetUserId: 2 } }],
    ["polishes-recalc-hex", { method: "POST", params: { id: String(SHADE_ID) } }],
  ];
  for (const [route, req] of adminRoutes) {
    it(`${route}: non-admin user -> 403 and no data queries`, async () => {
      const res = await call(route, fakeRequest({ ...req, headers: auth(ATTACKER) }));
      assert.equal(res.status, 403);
      assert.equal(dataCalls().length, 0);
      assert.equal(clientCalls.length, 0);
    });
    it(`${route}: unauthenticated -> 401`, async () => {
      const res = await call(route, fakeRequest(req));
      assert.equal(res.status, 401);
    });
  }
});

describe("functions/images — cross-user media access (KNOWN GAP, see #227)", () => {
  // KNOWN GAP (#227): the image proxy route is anonymous and its signed ids are bearer
  // capabilities that are NOT scoped to an owner. Anyone holding a validly signed id can fetch the
  // blob without an Authorization header, regardless of which user the media belongs to.
  // THIS TEST PINS TODAY'S BEHAVIOR. When owner-scoped image URLs land (#227), flip it to
  // expect 401/403 for a request lacking (or carrying another user's) credentials.
  const OTHER_USERS_BLOB = "https://acct.blob.core.windows.net/swatches/user-1/private.png";

  beforeEach(() => {
    process.env.IMAGE_PROXY_SIGNING_KEY = "x".repeat(40);
  });

  it("route is registered anonymous with no auth wrapper (no DB lookup of the caller)", async () => {
    assert.equal(registeredRoutes.images.authLevel, "anonymous");
    const id = imageProxy.encodeImageProxyId(OTHER_USERS_BLOB);
    const res = await registeredRoutes.images.handler(fakeRequest({ params: { id }, url: `http://localhost/api/images/${id}` }), fakeContext());
    assert.equal(res.status, 200);
    assert.equal(calls.length, 0, "images handler must not consult app_user (no auth)");
  });

  it("returns 200 for another user's blob id with NO Authorization header (current behavior)", async () => {
    const id = imageProxy.encodeImageProxyId(OTHER_USERS_BLOB);
    const res = await registeredRoutes.images.handler(fakeRequest({ params: { id }, url: `http://localhost/api/images/${id}` }), fakeContext());
    assert.equal(res.status, 200);
    assert.deepEqual(blobReads, [OTHER_USERS_BLOB]);
  });

  it("returns 200 even when a different user's token is presented (token is ignored)", async () => {
    const id = imageProxy.encodeImageProxyId(OTHER_USERS_BLOB);
    const res = await registeredRoutes.images.handler(
      fakeRequest({ params: { id }, headers: auth(ATTACKER), url: `http://localhost/api/images/${id}` }),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.equal(calls.length, 0);
  });

  it("mitigation that exists today: unsigned/forged ids are rejected with 403 and never reach storage", async () => {
    const forged = Buffer.from(OTHER_USERS_BLOB).toString("base64url");
    for (const id of [forged, `${forged}.${"A".repeat(43)}`]) {
      const res = await registeredRoutes.images.handler(fakeRequest({ params: { id }, url: `http://localhost/api/images/${id}` }), fakeContext());
      assert.equal(res.status, 403);
    }
    assert.deepEqual(blobReads, []);
  });
});
