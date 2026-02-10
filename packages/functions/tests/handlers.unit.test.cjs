const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// Module-level mocking via require interception
// ---------------------------------------------------------------------------

// Track registered routes from app.http()
const registeredRoutes = {};

// Mutable mock implementations — tests can override these
let queryMock = async () => ({ rows: [] });
let transactionMock = async (cb) => cb(fakeClient());

function fakeClient() {
  return { query: async () => ({ rows: [] }) };
}

// Intercept require() to replace modules before handler code loads
const originalResolve = Module._resolveFilename;
const mockModules = {};

function registerMock(id, exports) {
  mockModules[id] = exports;
}

Module._resolveFilename = function (request, parent, ...rest) {
  // Match against mock keys (partial path match)
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) {
      return key;
    }
  }
  return originalResolve.call(this, request, parent, ...rest);
};

// Register mocks
registerMock("@azure/functions", {
  app: {
    http: (name, opts) => {
      registeredRoutes[name] = opts;
    },
  },
});

registerMock("jose", {
  createRemoteJWKSet: () => {},
  jwtVerify: async () => ({ payload: {} }),
});

// db mock needs to proxy to mutable queryMock/transactionMock
const dbMockPath = path.resolve(__dirname, "../dist/lib/db.js");
registerMock(dbMockPath, {
  query: (...args) => queryMock(...args),
  transaction: (...args) => transactionMock(...args),
  getPool: () => ({}),
  closePool: async () => {},
});
// Also register by relative path patterns the handlers use
registerMock("../lib/db", {
  get query() { return (...args) => queryMock(...args); },
  get transaction() { return (...args) => transactionMock(...args); },
  get getPool() { return () => ({}); },
  get closePool() { return async () => {}; },
});

// Pre-populate require.cache for mocked modules
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports,
  };
}

// Also cache the db module under its resolved path
const dbRelativePath = "../lib/db";
require.cache[dbRelativePath] = {
  id: dbRelativePath,
  filename: dbRelativePath,
  loaded: true,
  exports: mockModules["../lib/db"],
};

// ---------------------------------------------------------------------------
// Helpers: fake HttpRequest and InvocationContext
// ---------------------------------------------------------------------------
function fakeRequest({
  method = "GET",
  url = "http://localhost:7071/api/test",
  headers = {},
  params = {},
  body = undefined,
  contentType = undefined,
} = {}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) {
    headerMap.set(k.toLowerCase(), v);
  }
  if (contentType) headerMap.set("content-type", contentType);

  return {
    method,
    url,
    headers: {
      get: (name) => headerMap.get(name.toLowerCase()) || null,
    },
    params,
    json: async () => body,
    arrayBuffer: async () =>
      body ? new TextEncoder().encode(JSON.stringify(body)).buffer : new ArrayBuffer(0),
  };
}

function fakeContext() {
  return {
    log: () => {},
    error: () => {},
    warn: () => {},
  };
}

// ---------------------------------------------------------------------------
// Import handler modules — they register routes via the mocked app.http()
// ---------------------------------------------------------------------------
const authLib = require("../dist/lib/auth");
require("../dist/functions/auth");
require("../dist/functions/polishes");
require("../dist/functions/catalog");
require("../dist/functions/voice");
require("../dist/functions/capture");

// Reset mocks between tests
afterEach(() => {
  queryMock = async () => ({ rows: [] });
  transactionMock = async (cb) => cb(fakeClient());
  delete process.env.AUTH_DEV_BYPASS;
  delete process.env.AZURE_AD_B2C_TENANT;
  delete process.env.AZURE_AD_B2C_CLIENT_ID;
});

// ═══════════════════════════════════════════════════════════════════════════
// lib/auth — AuthError, authenticateRequest, withAuth
// ═══════════════════════════════════════════════════════════════════════════

describe("lib/auth — AuthError", () => {
  it("is an instance of Error with name AuthError", () => {
    const err = new authLib.AuthError("test message");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "AuthError");
    assert.equal(err.message, "test message");
  });
});

describe("lib/auth — authenticateRequest", () => {
  it("throws on missing Authorization header", async () => {
    const req = fakeRequest();
    await assert.rejects(
      () => authLib.authenticateRequest(req, fakeContext()),
      (err) => err instanceof authLib.AuthError && /Missing/.test(err.message)
    );
  });

  it("throws on malformed Authorization header (no Bearer prefix)", async () => {
    const req = fakeRequest({ headers: { authorization: "Basic abc" } });
    await assert.rejects(
      () => authLib.authenticateRequest(req, fakeContext()),
      (err) => err instanceof authLib.AuthError && /Missing/.test(err.message)
    );
  });

  it("throws on empty token after Bearer", async () => {
    const req = fakeRequest({ headers: { authorization: "Bearer " } });
    await assert.rejects(
      () => authLib.authenticateRequest(req, fakeContext()),
      (err) => err instanceof authLib.AuthError && /Empty/.test(err.message)
    );
  });

  it("dev bypass: rejects invalid token format", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const req = fakeRequest({ headers: { authorization: "Bearer not-a-dev-token" } });
    await assert.rejects(
      () => authLib.authenticateRequest(req, fakeContext()),
      (err) => err instanceof authLib.AuthError && /Invalid dev token/.test(err.message)
    );
  });

  it("dev bypass: rejects when user not found in DB", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({ rows: [] });
    const req = fakeRequest({ headers: { authorization: "Bearer dev:999" } });
    await assert.rejects(
      () => authLib.authenticateRequest(req, fakeContext()),
      (err) => err instanceof authLib.AuthError && /not found/.test(err.message)
    );
  });

  it("dev bypass: returns AuthResult for valid token", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 1, external_id: "ext-1", email: "test@example.com" }],
    });
    const req = fakeRequest({ headers: { authorization: "Bearer dev:1" } });
    const result = await authLib.authenticateRequest(req, fakeContext());
    assert.equal(result.userId, 1);
    assert.equal(result.externalId, "ext-1");
    assert.equal(result.email, "test@example.com");
  });

  it("production: throws when B2C not configured", async () => {
    const req = fakeRequest({ headers: { authorization: "Bearer some.jwt.token" } });
    await assert.rejects(
      () => authLib.authenticateRequest(req, fakeContext()),
      (err) => err instanceof authLib.AuthError && /not configured/.test(err.message)
    );
  });
});

describe("lib/auth — withAuth wrapper", () => {
  it("returns 401 when no auth header", async () => {
    const handler = authLib.withAuth(async (req, ctx, userId) => ({
      status: 200,
      jsonBody: { userId },
    }));
    const res = await handler(fakeRequest(), fakeContext());
    assert.equal(res.status, 401);
    assert.ok(res.jsonBody.error);
  });

  it("passes userId to inner handler on success", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 42, external_id: "ext-42", email: null }],
    });
    const handler = authLib.withAuth(async (req, ctx, userId) => ({
      status: 200,
      jsonBody: { userId },
    }));
    const req = fakeRequest({ headers: { authorization: "Bearer dev:42" } });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.userId, 42);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// functions/auth — route registration, getAuthConfig
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/auth — route registration", () => {
  it("registers auth-validate POST route", () => {
    assert.ok(registeredRoutes["auth-validate"]);
    assert.deepEqual(registeredRoutes["auth-validate"].methods, ["POST"]);
    assert.equal(registeredRoutes["auth-validate"].route, "auth/validate");
  });

  it("registers auth-config GET route", () => {
    assert.ok(registeredRoutes["auth-config"]);
    assert.deepEqual(registeredRoutes["auth-config"].methods, ["GET"]);
    assert.equal(registeredRoutes["auth-config"].route, "auth/config");
  });
});

describe("functions/auth — getAuthConfig", () => {
  it("returns 503 when B2C env vars not set", async () => {
    const handler = registeredRoutes["auth-config"].handler;
    const res = await handler(fakeRequest(), fakeContext());
    assert.equal(res.status, 503);
    assert.ok(res.jsonBody.error);
  });

  it("returns config when B2C env vars are set", async () => {
    process.env.AZURE_AD_B2C_TENANT = "mytenant";
    process.env.AZURE_AD_B2C_CLIENT_ID = "my-client-id";
    const handler = registeredRoutes["auth-config"].handler;
    const res = await handler(fakeRequest(), fakeContext());
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.clientId, "my-client-id");
    assert.ok(res.jsonBody.authority.includes("mytenant"));
    assert.ok(res.jsonBody.knownAuthorities[0].includes("mytenant"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// functions/polishes — route registration, input validation
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/polishes — route registration", () => {
  it("registers all CRUD routes", () => {
    assert.ok(registeredRoutes["polishes-list"]);
    assert.ok(registeredRoutes["polishes-create"]);
    assert.ok(registeredRoutes["polishes-update"]);
    assert.ok(registeredRoutes["polishes-delete"]);
  });

  it("polishes-list accepts GET", () => {
    assert.deepEqual(registeredRoutes["polishes-list"].methods, ["GET"]);
    assert.equal(registeredRoutes["polishes-list"].route, "polishes/{id?}");
  });

  it("polishes-create accepts POST", () => {
    assert.deepEqual(registeredRoutes["polishes-create"].methods, ["POST"]);
  });

  it("polishes-update accepts PUT", () => {
    assert.deepEqual(registeredRoutes["polishes-update"].methods, ["PUT"]);
  });

  it("polishes-delete accepts DELETE", () => {
    assert.deepEqual(registeredRoutes["polishes-delete"].methods, ["DELETE"]);
  });
});

describe("functions/polishes — createPolish validation", () => {
  function authedRequest(overrides) {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 1, external_id: "ext-1", email: null }],
    });
    return fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/polishes",
      headers: { authorization: "Bearer dev:1" },
      ...overrides,
    });
  }

  it("returns 400 when brand is missing", async () => {
    const handler = registeredRoutes["polishes-create"].handler;
    const req = authedRequest({ body: { name: "Shade" } });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
    assert.ok(res.jsonBody.error.toLowerCase().includes("brand"));
  });

  it("returns 400 when name is missing", async () => {
    const handler = registeredRoutes["polishes-create"].handler;
    const req = authedRequest({ body: { brand: "OPI" } });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
    assert.ok(res.jsonBody.error.toLowerCase().includes("name"));
  });
});

describe("functions/polishes — updatePolish validation", () => {
  it("returns 400 when id param is missing", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 1, external_id: "ext-1", email: null }],
    });
    const handler = registeredRoutes["polishes-update"].handler;
    const req = fakeRequest({
      method: "PUT",
      url: "http://localhost:7071/api/polishes",
      headers: { authorization: "Bearer dev:1" },
      params: {},
      body: { quantity: 2 },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
    assert.ok(res.jsonBody.error.toLowerCase().includes("id"));
  });
});

describe("functions/polishes — deletePolish validation", () => {
  it("returns 400 when id param is missing", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 1, external_id: "ext-1", email: null }],
    });
    const handler = registeredRoutes["polishes-delete"].handler;
    const req = fakeRequest({
      method: "DELETE",
      url: "http://localhost:7071/api/polishes",
      headers: { authorization: "Bearer dev:1" },
      params: {},
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
    assert.ok(res.jsonBody.error.toLowerCase().includes("id"));
  });

  it("returns 404 when polish not found", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;
    queryMock = async () => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      return { rows: [] };
    };
    const handler = registeredRoutes["polishes-delete"].handler;
    const req = fakeRequest({
      method: "DELETE",
      url: "http://localhost:7071/api/polishes/999",
      headers: { authorization: "Bearer dev:1" },
      params: { id: "999" },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 404);
  });
});

describe("functions/polishes — getPolishes", () => {
  it("returns 404 when single polish not found by id", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;
    queryMock = async () => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      return { rows: [] };
    };
    const handler = registeredRoutes["polishes-list"].handler;
    const req = fakeRequest({
      url: "http://localhost:7071/api/polishes/999",
      headers: { authorization: "Bearer dev:1" },
      params: { id: "999" },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 404);
  });

  it("returns paginated list shape", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;
    queryMock = async () => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (callCount === 2) {
        return { rows: [{ id: "1", brand: "OPI", name: "Red", color: "Red" }] };
      }
      // count query
      return { rows: [{ total: "1" }] };
    };
    const handler = registeredRoutes["polishes-list"].handler;
    const req = fakeRequest({
      url: "http://localhost:7071/api/polishes",
      headers: { authorization: "Bearer dev:1" },
      params: {},
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.jsonBody.polishes));
    assert.equal(typeof res.jsonBody.total, "number");
    assert.equal(typeof res.jsonBody.page, "number");
    assert.equal(typeof res.jsonBody.pageSize, "number");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// functions/catalog — input validation, search results
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/catalog — route registration", () => {
  it("registers catalog-search GET route", () => {
    assert.ok(registeredRoutes["catalog-search"]);
    assert.deepEqual(registeredRoutes["catalog-search"].methods, ["GET"]);
    assert.equal(registeredRoutes["catalog-search"].route, "catalog/search");
  });

  it("registers catalog-shade GET route", () => {
    assert.ok(registeredRoutes["catalog-shade"]);
    assert.deepEqual(registeredRoutes["catalog-shade"].methods, ["GET"]);
    assert.equal(registeredRoutes["catalog-shade"].route, "catalog/shade/{id}");
  });
});

describe("functions/catalog — searchCatalog validation", () => {
  it("returns 400 when q parameter is missing", async () => {
    const handler = registeredRoutes["catalog-search"].handler;
    const req = fakeRequest({ url: "http://localhost:7071/api/catalog/search" });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
    assert.ok(res.jsonBody.error.includes("q"));
  });

  it("returns 400 when q parameter is empty whitespace", async () => {
    const handler = registeredRoutes["catalog-search"].handler;
    const req = fakeRequest({ url: "http://localhost:7071/api/catalog/search?q=%20%20" });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
  });

  it("returns results for valid query", async () => {
    queryMock = async () => ({
      rows: [
        { shadeId: "1", brand: "OPI", name: "Big Apple Red", finish: "cream", collection: null, similarity: 0.8 },
      ],
    });
    const handler = registeredRoutes["catalog-search"].handler;
    const req = fakeRequest({ url: "http://localhost:7071/api/catalog/search?q=OPI" });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.query, "OPI");
    assert.ok(Array.isArray(res.jsonBody.results));
    assert.equal(res.jsonBody.total, 1);
  });

  it("rounds similarity to 3 decimal places", async () => {
    queryMock = async () => ({
      rows: [
        { shadeId: "1", brand: "OPI", name: "Red", finish: null, collection: null, similarity: 0.66667 },
      ],
    });
    const handler = registeredRoutes["catalog-search"].handler;
    const req = fakeRequest({ url: "http://localhost:7071/api/catalog/search?q=OPI" });
    const res = await handler(req, fakeContext());
    assert.equal(res.jsonBody.results[0].similarity, 0.667);
  });
});

describe("functions/catalog — getShade validation", () => {
  it("returns 400 when id param is missing", async () => {
    const handler = registeredRoutes["catalog-shade"].handler;
    const req = fakeRequest({
      url: "http://localhost:7071/api/catalog/shade",
      params: {},
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
    assert.ok(res.jsonBody.error.includes("id"));
  });

  it("returns 404 when shade not found", async () => {
    queryMock = async () => ({ rows: [] });
    const handler = registeredRoutes["catalog-shade"].handler;
    const req = fakeRequest({
      url: "http://localhost:7071/api/catalog/shade/999",
      params: { id: "999" },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 404);
  });

  it("returns shade detail with aliases", async () => {
    let callCount = 0;
    queryMock = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          rows: [{
            shadeId: "1", brand: "OPI", brandId: "10", name: "Big Apple Red",
            finish: "cream", collection: "NYC", releaseYear: 2020, status: "active",
          }],
        };
      }
      // alias query
      return { rows: [{ alias: "BAR" }, { alias: "Apple Red" }] };
    };
    const handler = registeredRoutes["catalog-shade"].handler;
    const req = fakeRequest({
      url: "http://localhost:7071/api/catalog/shade/1",
      params: { id: "1" },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.shadeId, "1");
    assert.equal(res.jsonBody.brand, "OPI");
    assert.deepEqual(res.jsonBody.aliases, ["BAR", "Apple Red"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// functions/voice — input validation
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/voice — route registration", () => {
  it("registers voice-process POST route", () => {
    assert.ok(registeredRoutes["voice-process"]);
    assert.deepEqual(registeredRoutes["voice-process"].methods, ["POST"]);
    assert.equal(registeredRoutes["voice-process"].route, "voice");
  });
});

describe("functions/voice — processVoiceInput validation", () => {
  it("returns 400 for non-audio content type", async () => {
    const handler = registeredRoutes["voice-process"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/voice",
      contentType: "application/json",
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
    assert.ok(res.jsonBody.error.toLowerCase().includes("content type"));
  });

  it("returns 400 for empty audio body", async () => {
    const handler = registeredRoutes["voice-process"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/voice",
      contentType: "audio/wav",
    });
    req.arrayBuffer = async () => new ArrayBuffer(0);
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
    assert.ok(res.jsonBody.error.toLowerCase().includes("no audio"));
  });

  it("accepts multipart/form-data content type", async () => {
    const handler = registeredRoutes["voice-process"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/voice",
      contentType: "multipart/form-data; boundary=---",
    });
    req.arrayBuffer = async () => new ArrayBuffer(1024);
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);
  });

  it("returns stub response for valid audio", async () => {
    const handler = registeredRoutes["voice-process"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/voice",
      contentType: "audio/wav",
    });
    req.arrayBuffer = async () => new ArrayBuffer(1024);
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.message, "Voice input processed");
    assert.ok("parsedDetails" in res.jsonBody);
    assert.ok("transcription" in res.jsonBody);
    assert.equal(res.jsonBody.parsedDetails.confidence, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// functions/capture — route registration, auth + basic workflow
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/capture — route registration", () => {
  it("registers all capture routes", () => {
    assert.ok(registeredRoutes["capture-start"]);
    assert.ok(registeredRoutes["capture-frame"]);
    assert.ok(registeredRoutes["capture-finalize"]);
    assert.ok(registeredRoutes["capture-status"]);
    assert.ok(registeredRoutes["capture-answer"]);
  });

  it("uses expected methods and route patterns", () => {
    assert.deepEqual(registeredRoutes["capture-start"].methods, ["POST"]);
    assert.equal(registeredRoutes["capture-start"].route, "capture/start");
    assert.deepEqual(registeredRoutes["capture-frame"].methods, ["POST"]);
    assert.equal(registeredRoutes["capture-frame"].route, "capture/{captureId}/frame");
    assert.deepEqual(registeredRoutes["capture-finalize"].methods, ["POST"]);
    assert.equal(registeredRoutes["capture-finalize"].route, "capture/{captureId}/finalize");
    assert.deepEqual(registeredRoutes["capture-status"].methods, ["GET"]);
    assert.equal(registeredRoutes["capture-status"].route, "capture/{captureId}/status");
    assert.deepEqual(registeredRoutes["capture-answer"].methods, ["POST"]);
    assert.equal(registeredRoutes["capture-answer"].route, "capture/{captureId}/answer");
  });
});

describe("functions/capture — startCapture", () => {
  it("returns 401 when request is unauthenticated", async () => {
    const handler = registeredRoutes["capture-start"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/start",
      }),
      fakeContext()
    );
    assert.equal(res.status, 401);
  });

  it("creates a capture session for an authenticated user", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;
    queryMock = async () => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      return { rows: [{ captureId: "11111111-1111-4111-8111-111111111111", status: "processing" }] };
    };

    const handler = registeredRoutes["capture-start"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/start",
        headers: { authorization: "Bearer dev:1" },
        body: { metadata: { source: "mobile" } },
      }),
      fakeContext()
    );

    assert.equal(res.status, 201);
    assert.equal(res.jsonBody.status, "processing");
    assert.equal(res.jsonBody.captureId, "11111111-1111-4111-8111-111111111111");
    assert.ok(Array.isArray(res.jsonBody.uploadUrls));
    assert.ok(res.jsonBody.guidanceConfig);
  });
});

describe("functions/capture — addCaptureFrame", () => {
  it("returns 400 for invalid UUID capture id", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 1, external_id: "ext-1", email: null }],
    });
    const handler = registeredRoutes["capture-frame"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/not-a-uuid/frame",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "not-a-uuid" },
        body: { frameType: "label", imageBlobUrl: "https://blob.example/frame.png" },
      }),
      fakeContext()
    );
    assert.equal(res.status, 400);
  });

  it("creates frame with imageBlobUrl", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;
    queryMock = async () => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (callCount === 2) {
        return { rows: [{ id: 10, captureId: "11111111-1111-4111-8111-111111111111", status: "processing", topConfidence: null, acceptedEntityType: null, acceptedEntityId: null, metadata: null }] };
      }
      return { rows: [] };
    };
    transactionMock = async (cb) =>
      cb({
        query: async (text) => {
          if (text.includes("INSERT INTO image_asset")) {
            return { rows: [{ imageId: "500" }] };
          }
          if (text.includes("INSERT INTO capture_frame")) {
            return { rows: [{ frameId: "900" }] };
          }
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["capture-frame"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/11111111-1111-4111-8111-111111111111/frame",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "11111111-1111-4111-8111-111111111111" },
        body: {
          frameType: "label",
          imageBlobUrl: "https://blob.example/frame.png",
          quality: { blur: 0.1 },
        },
      }),
      fakeContext()
    );

    assert.equal(res.status, 201);
    assert.equal(res.jsonBody.received, true);
    assert.equal(res.jsonBody.frameId, "900");
    assert.equal(res.jsonBody.captureId, "11111111-1111-4111-8111-111111111111");
  });
});

describe("functions/capture — finalize/status/answer workflow", () => {
  it("finalize returns needs_question when no frames exist", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;
    queryMock = async () => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (callCount === 2) {
        return { rows: [{ id: 10, captureId: "11111111-1111-4111-8111-111111111111", status: "processing", topConfidence: null, acceptedEntityType: null, acceptedEntityId: null, metadata: null }] };
      }
      if (callCount === 3) {
        return { rows: [{ totalFrames: "0" }] };
      }
      return { rows: [] };
    };
    transactionMock = async (cb) =>
      cb({
        query: async (text) => {
          if (text.includes("INSERT INTO capture_question")) {
            return {
              rows: [{
                id: "321",
                key: "capture_frame",
                prompt: "Upload at least one barcode or label frame so we can continue matching.",
                type: "single_select",
                options: ["scan_barcode", "upload_label_photo", "skip"],
                status: "open",
                createdAt: "2026-02-10T00:00:00.000Z",
              }],
            };
          }
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["capture-finalize"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/11111111-1111-4111-8111-111111111111/finalize",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "11111111-1111-4111-8111-111111111111" },
      }),
      fakeContext()
    );

    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "needs_question");
    assert.equal(res.jsonBody.question.key, "capture_frame");
  });

  it("status returns open question payload", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;
    queryMock = async () => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (callCount === 2) {
        return {
          rows: [{
            id: 10,
            captureId: "11111111-1111-4111-8111-111111111111",
            status: "needs_question",
            topConfidence: "0.5",
            acceptedEntityType: null,
            acceptedEntityId: null,
            metadata: { source: "mobile" },
          }],
        };
      }
      return {
        rows: [{
          id: "321",
          key: "capture_frame",
          prompt: "Upload at least one barcode or label frame so we can continue matching.",
          type: "single_select",
          options: ["scan_barcode", "upload_label_photo", "skip"],
          status: "open",
          createdAt: "2026-02-10T00:00:00.000Z",
        }],
      };
    };

    const handler = registeredRoutes["capture-status"].handler;
    const res = await handler(
      fakeRequest({
        method: "GET",
        url: "http://localhost:7071/api/capture/11111111-1111-4111-8111-111111111111/status",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "11111111-1111-4111-8111-111111111111" },
      }),
      fakeContext()
    );

    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "needs_question");
    assert.equal(res.jsonBody.topConfidence, 0.5);
    assert.equal(res.jsonBody.question.id, "321");
  });

  it("answer returns 400 when answer is missing", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 1, external_id: "ext-1", email: null }],
    });

    const handler = registeredRoutes["capture-answer"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/11111111-1111-4111-8111-111111111111/answer",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "11111111-1111-4111-8111-111111111111" },
        body: {},
      }),
      fakeContext()
    );
    assert.equal(res.status, 400);
  });
});
