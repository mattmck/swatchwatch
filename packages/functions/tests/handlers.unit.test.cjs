const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// Module-level mocking via require interception
// ---------------------------------------------------------------------------

// Track registered routes from app.http()
const registeredRoutes = {};
const registeredQueues = {};

// Mutable mock implementations — tests can override these
let queryMock = async () => ({ rows: [] });
let transactionMock = async (cb) => cb(fakeClient());

function expectMethods(routeName, expectedMethods) {
  assert.ok(registeredRoutes[routeName], `route ${routeName} should be registered`);
  const actual = registeredRoutes[routeName].methods || [];
  for (const method of expectedMethods) {
    assert.ok(
      actual.includes(method),
      `route ${routeName} should include ${method} (got ${actual})`
    );
  }
}

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
    storageQueue: (name, opts) => {
      registeredQueues[name] = opts;
    },
  },
  output: {
    storageQueue: (opts) => ({ __type: "storageQueue", ...opts }),
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

// Stub AI hex detection to avoid external calls during tests
registerMock("../lib/ai-color-detection", {
  detectHexWithAzureOpenAI: async () => ({
    hex: "#ABCDEF",
    confidence: 0.87,
    provider: "azure-openai",
  }),
});

// Stub blob storage reader to avoid network
registerMock("../lib/blob-storage", {
  readBlobFromStorageUrl: async () => ({
    bytes: Buffer.from("fakeimg"),
    contentType: "image/png",
    checksumSha256: "deadbeef",
    sizeBytes: 7,
    storageUrl: "https://example.com/fake.png",
  }),
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
  const outputValues = new Map();
  return {
    log: () => {},
    error: () => {},
    warn: () => {},
    extraOutputs: {
      set: (binding, value) => outputValues.set(binding, value),
      get: (binding) => outputValues.get(binding),
    },
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
require("../dist/functions/ingestion");
require("../dist/functions/ingestion-worker");

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
      rows: [{ user_id: 1, external_id: "ext-1", email: "test@example.com", role: "admin" }],
    });
    const req = fakeRequest({ headers: { authorization: "Bearer dev:1" } });
    const result = await authLib.authenticateRequest(req, fakeContext());
    assert.equal(result.userId, 1);
    assert.equal(result.externalId, "ext-1");
    assert.equal(result.email, "test@example.com");
    assert.equal(result.role, "admin");
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
      rows: [{ user_id: 42, external_id: "ext-42", email: null, role: "user" }],
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

describe("lib/auth — withAdmin wrapper", () => {
  it("returns 403 for authenticated non-admin users", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 1, external_id: "ext-1", email: null, role: "user" }],
    });

    const handler = authLib.withAdmin(async () => ({ status: 200 }));
    const req = fakeRequest({ headers: { authorization: "Bearer dev:1" } });
    const res = await handler(req, fakeContext());

    assert.equal(res.status, 403);
    assert.equal(res.jsonBody.error, "Admin role required");
  });

  it("allows authenticated admin users", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 2, external_id: "dev-admin-2", email: null, role: "admin" }],
    });

    const handler = authLib.withAdmin(async (_req, _ctx, userId) => ({
      status: 200,
      jsonBody: { userId },
    }));
    const req = fakeRequest({ headers: { authorization: "Bearer dev:2" } });
    const res = await handler(req, fakeContext());

    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.userId, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// functions/auth — route registration, getAuthConfig
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/auth — route registration", () => {
  it("registers auth-validate POST route", () => {
    expectMethods("auth-validate", ["POST"]);
    assert.equal(registeredRoutes["auth-validate"].route, "auth/validate");
  });

  it("registers auth-config GET route", () => {
    expectMethods("auth-config", ["GET"]);
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
    assert.ok(registeredRoutes["polishes-mutate"]);
    assert.ok(registeredRoutes["polishes-recalc-hex"]);
  });

  it("polishes-list accepts GET", () => {
    expectMethods("polishes-list", ["GET"]);
    assert.equal(registeredRoutes["polishes-list"].route, "polishes/{id?}");
  });

  it("polishes-create accepts POST", () => {
    expectMethods("polishes-create", ["POST"]);
  });

  it("polishes-update accepts PUT", () => {
    expectMethods("polishes-mutate", ["PUT"]);
  });

  it("polishes-delete accepts DELETE", () => {
    expectMethods("polishes-mutate", ["DELETE"]);
  });
});

describe("functions/polishes — recalcHex", () => {
  function adminRequest(overrides) {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (...args) => {
      // First call: auth user lookup
      if (args[0]?.includes("FROM app_user")) {
        return {
          rows: [{ user_id: 1, external_id: "ext-1", email: "admin@test", role: "admin" }],
        };
      }
      // Shade lookup
      if (args[0]?.includes("FROM shade s")) {
        return {
          rows: [
            {
              shade_id: 123,
              shade_name_canonical: "Test Shade",
              detected_hex: null,
              vendor_hex: null,
              storage_url: "https://example.com/fake.png",
            },
          ],
        };
      }
      // Update detected_hex
      return { rows: [] };
    };

    return fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/polishes/123/recalc-hex",
      headers: { authorization: "Bearer dev:1" },
      params: { id: "123" },
      ...overrides,
    });
  }

  it("returns 400 when id param is missing", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 1, external_id: "ext-1", email: "admin@test", role: "admin" }],
    });
    const handler = registeredRoutes["polishes-recalc-hex"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/polishes/recalc-hex",
      headers: { authorization: "Bearer dev:1" },
      params: {},
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
  });

  it("returns 422 when no image is available", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let calls = 0;
    queryMock = async (...args) => {
      calls += 1;
      if (calls === 1) {
        return {
          rows: [{ user_id: 1, external_id: "ext-1", email: "admin@test", role: "admin" }],
        };
      }
      if (calls === 2) {
        return {
          rows: [
            {
              shade_id: 123,
              shade_name_canonical: "No Image Shade",
              detected_hex: "#111111",
              vendor_hex: null,
              storage_url: null,
            },
          ],
        };
      }
      return { rows: [] };
    };

    const handler = registeredRoutes["polishes-recalc-hex"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/polishes/123/recalc-hex",
      headers: { authorization: "Bearer dev:1" },
      params: { id: "123" },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 422);
    assert.match(res.jsonBody.error, /No image/i);
  });

  it("detects and updates hex when image is present", async () => {
    const handler = registeredRoutes["polishes-recalc-hex"].handler;
    const req = adminRequest();
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.detectedHex, "#ABCDEF");
    assert.match(res.jsonBody.message, /Detected hex/i);
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
    const handler = registeredRoutes["polishes-mutate"].handler;
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
    const handler = registeredRoutes["polishes-mutate"].handler;
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
    const handler = registeredRoutes["polishes-mutate"].handler;
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
    expectMethods("catalog-search", ["GET"]);
    assert.equal(registeredRoutes["catalog-search"].route, "catalog/search");
  });

  it("registers catalog-shade GET route", () => {
    assert.ok(registeredRoutes["catalog-shade"]);
    expectMethods("catalog-shade", ["GET"]);
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
        { shadeId: "1", brand: "OPI", name: "Big Apple Red", finish: "creme", collection: null, similarity: 0.8 },
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
            finish: "creme", collection: "NYC", releaseYear: 2020, status: "active",
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
    expectMethods("voice-process", ["POST"]);
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
// functions/ingestion — route registration
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/ingestion — route registration", () => {
  it("registers ingestion routes", () => {
    assert.ok(registeredRoutes["ingestion-jobs"]);
    assert.ok(registeredRoutes["ingestion-job-detail"]);
  });

  it("uses expected methods and route patterns", () => {
    assert.deepEqual(registeredRoutes["ingestion-jobs"].methods, ["GET", "POST", "OPTIONS"]);
    assert.equal(registeredRoutes["ingestion-jobs"].route, "ingestion/jobs");
    assert.deepEqual(registeredRoutes["ingestion-job-detail"].methods, ["GET", "OPTIONS"]);
    assert.equal(registeredRoutes["ingestion-job-detail"].route, "ingestion/jobs/{id}");
  });
});

describe("functions/ingestion-worker — queue registration", () => {
  it("registers ingestion queue worker", () => {
    assert.ok(registeredQueues["ingestion-job-worker"]);
    assert.equal(registeredQueues["ingestion-job-worker"].queueName, "ingestion-jobs");
  });
});

describe("functions/ingestion-worker — payload validation", () => {
  it("marks job failed when payload has string jobId but invalid userId", async () => {
    const handler = registeredQueues["ingestion-job-worker"].handler;
    const calls = [];

    queryMock = async (...args) => {
      calls.push(args);
      const [text] = args;
      if (typeof text === "string" && text.includes("FROM ingestion_job j")) {
        return {
          rows: [
            {
              jobId: "1",
              source: "HoloTacoShopify",
              jobType: "connector_verify",
              status: "queued",
              startedAt: "2026-02-11T20:56:55.161Z",
              finishedAt: null,
              metrics: null,
              error: null,
            },
          ],
        };
      }

      return { rows: [] };
    };

    await handler(
      {
        jobId: "1",
        userId: "not-a-number",
        queuedAt: "2026-02-11T20:56:55.161Z",
        request: {
          source: "HoloTacoShopify",
          page: 1,
          pageSize: 50,
          maxRecords: 50,
          materializeToInventory: true,
          recentDays: 120,
          searchTerm: "recent",
        },
        requestedMetrics: {
          searchTerm: "recent",
          requestedPage: 1,
          requestedPageSize: 50,
          maxRecords: 50,
          recentDays: 120,
          materializeToInventory: true,
          triggeredByUserId: "2",
        },
      },
      fakeContext()
    );

    const failedCall = calls.find(
      ([text]) => typeof text === "string" && text.includes("SET status = 'failed'")
    );
    assert.ok(failedCall, "expected invalid payload to mark ingestion_job failed");
    assert.equal(failedCall[1][0], 1);
    assert.match(failedCall[1][1], /Invalid ingestion queue payload: userId is required/);
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
    expectMethods("capture-start", ["POST"]);
    assert.equal(registeredRoutes["capture-start"].route, "capture/start");
    expectMethods("capture-frame", ["POST"]);
    assert.equal(registeredRoutes["capture-frame"].route, "capture/{captureId}/frame");
    expectMethods("capture-finalize", ["POST"]);
    assert.equal(registeredRoutes["capture-finalize"].route, "capture/{captureId}/finalize");
    expectMethods("capture-status", ["GET"]);
    assert.equal(registeredRoutes["capture-status"].route, "capture/{captureId}/status");
    expectMethods("capture-answer", ["POST"]);
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
    const capturedArgs = [];
    queryMock = async (...args) => {
      capturedArgs.push(args);
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

    const insertCall = capturedArgs.find(([text]) => typeof text === "string" && text.includes("INSERT INTO capture_session"));
    assert.ok(insertCall);
    const insertParams = insertCall[1];
    assert.equal(insertParams[2].source, "mobile");
    assert.equal(insertParams[2].pipeline.status, "awaiting_frames");
    assert.equal(insertParams[2].pipeline.ingest.status, "awaiting_frames");
    assert.equal(insertParams[2].pipeline.ingest.framesReceived, 0);
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

  it("normalizes data URL image uploads and enriches ingestion metadata", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;
    const imageInsertParams = [];
    const frameInsertParams = [];
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
        query: async (text, params) => {
          if (text.includes("INSERT INTO image_asset")) {
            imageInsertParams.push(params);
            return { rows: [{ imageId: "500" }] };
          }
          if (text.includes("INSERT INTO capture_frame")) {
            frameInsertParams.push(params);
            return { rows: [{ frameId: "901" }] };
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
          imageBlobUrl: "data:image/png;base64,YWJj",
          quality: { blur: 0.1 },
        },
      }),
      fakeContext()
    );

    assert.equal(res.status, 201);
    assert.equal(res.jsonBody.frameId, "901");
    assert.equal(imageInsertParams.length, 1);
    assert.ok(imageInsertParams[0][1].startsWith("inline://capture/11111111-1111-4111-8111-111111111111/"));
    assert.equal(typeof imageInsertParams[0][2], "string");
    assert.equal(imageInsertParams[0][2].length, 64);
    assert.equal(frameInsertParams.length, 1);
    assert.equal(frameInsertParams[0][3].blur, 0.1);
    assert.equal(frameInsertParams[0][3].ingestion.source, "data_url");
    assert.equal(frameInsertParams[0][3].ingestion.mimeType, "image/png");
    assert.equal(frameInsertParams[0][3].ingestion.byteSize, 3);
  });

  it("normalizes request quality hints into quality.extracted", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;
    const frameInsertParams = [];
    const captureSessionUpdateParams = [];
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
        query: async (text, params) => {
          if (text.includes("INSERT INTO image_asset")) {
            return { rows: [{ imageId: "500" }] };
          }
          if (text.includes("INSERT INTO capture_frame")) {
            frameInsertParams.push(params);
            return { rows: [{ frameId: "902" }] };
          }
          if (text.includes("UPDATE capture_session")) {
            captureSessionUpdateParams.push(params);
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
          frameType: "barcode",
          imageBlobUrl: "https://blob.example/frame.png",
          quality: { gtin: "1234567890123" },
        },
      }),
      fakeContext()
    );

    assert.equal(res.status, 201);
    assert.equal(res.jsonBody.frameId, "902");
    assert.equal(frameInsertParams.length, 1);
    assert.equal(frameInsertParams[0][3].extracted.gtin, "1234567890123");
    assert.equal(frameInsertParams[0][3].extracted.source, "request_quality");
    assert.equal(captureSessionUpdateParams.length, 1);
    assert.equal(captureSessionUpdateParams[0][1].pipeline.ingest.status, "frames_received");
    assert.equal(captureSessionUpdateParams[0][1].pipeline.ingest.framesReceived, 1);
    assert.equal(captureSessionUpdateParams[0][1].pipeline.ingest.frameTypeCounts.barcode, 1);
    assert.equal(captureSessionUpdateParams[0][1].pipeline.ingest.lastFrameHasExtractedEvidence, true);
    assert.equal(captureSessionUpdateParams[0][1].pipeline.ingest.lastExtractionSource, "request_quality");
    assert.equal(captureSessionUpdateParams[0][1].pipeline.status, "ready_for_finalize");
  });

  it("rejects blob URL image references", async () => {
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

    const handler = registeredRoutes["capture-frame"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/11111111-1111-4111-8111-111111111111/frame",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "11111111-1111-4111-8111-111111111111" },
        body: {
          frameType: "label",
          imageBlobUrl: "blob:http://localhost:3000/some-local-frame",
        },
      }),
      fakeContext()
    );

    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /blob:/i);
  });
});

describe("functions/capture — finalize/status/answer workflow", () => {
  it("finalize returns needs_question when no frames exist", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;
    let capturedMetadataPatch = null;
    queryMock = async () => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (callCount === 2) {
        return { rows: [{ id: 10, captureId: "11111111-1111-4111-8111-111111111111", status: "processing", topConfidence: null, acceptedEntityType: null, acceptedEntityId: null, metadata: null }] };
      }
      if (callCount === 3) {
        return { rows: [] };
      }
      return { rows: [] };
    };
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          if (text.includes("SET status = 'needs_question'")) {
            capturedMetadataPatch = params[2];
          }
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
    assert.ok(capturedMetadataPatch);
    assert.equal(capturedMetadataPatch.pipeline.finalize.attempt, 1);
    assert.equal(capturedMetadataPatch.pipeline.finalize.outcome, "needs_question");
    assert.equal(capturedMetadataPatch.resolver.step, "awaiting_frames");
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

  it("finalize matches by shade hints when confidence is high", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;
    let capturedMetadataPatch = null;
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
            status: "processing",
            topConfidence: null,
            acceptedEntityType: null,
            acceptedEntityId: null,
            metadata: { brand: "OPI", shadeName: "Big Apple Red" },
          }],
        };
      }
      if (callCount === 3) {
        return { rows: [{ frameType: "label", quality: { brand: "OPI", shadeName: "Big Apple Red" } }] };
      }
      if (callCount === 4) {
        return {
          rows: [{
            shadeId: "21",
            brand: "OPI",
            shadeName: "Big Apple Red",
            score: 0.95,
          }],
        };
      }
      return { rows: [] };
    };
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          if (text.includes("SET status = 'matched'")) {
            capturedMetadataPatch = params[4];
          }
          if (text.includes("SELECT inventory_item_id AS id")) {
            return { rows: [] };
          }
          if (text.includes("INSERT INTO user_inventory_item")) {
            return { rows: [{ id: 701 }] };
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
    assert.equal(res.jsonBody.status, "matched");
    assert.ok(capturedMetadataPatch);
    assert.equal(capturedMetadataPatch.pipeline.finalize.outcome, "matched");
    assert.equal(capturedMetadataPatch.pipeline.status, "matched");
    assert.equal(capturedMetadataPatch.resolver.step, "matched_by_shade_similarity");
    assert.equal(capturedMetadataPatch.resolver.audit.frameCount, 1);
  });

  it("finalize can match from metadata text hints without frames", async () => {
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
            id: 12,
            captureId: "33333333-3333-4333-8333-333333333333",
            status: "processing",
            topConfidence: null,
            acceptedEntityType: null,
            acceptedEntityId: null,
            metadata: { brand: "OPI", shadeName: "Big Apple Red" },
          }],
        };
      }
      if (callCount === 3) {
        return { rows: [] };
      }
      if (callCount === 4) {
        return {
          rows: [{
            shadeId: "21",
            brand: "OPI",
            shadeName: "Big Apple Red",
            score: 0.95,
          }],
        };
      }
      return { rows: [] };
    };
    transactionMock = async (cb) =>
      cb({
        query: async (text) => {
          if (text.includes("SELECT inventory_item_id AS id")) {
            return { rows: [] };
          }
          if (text.includes("INSERT INTO user_inventory_item")) {
            return { rows: [{ id: 704 }] };
          }
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["capture-finalize"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/33333333-3333-4333-8333-333333333333/finalize",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "33333333-3333-4333-8333-333333333333" },
      }),
      fakeContext()
    );

    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "matched");
  });

  it("finalize asks candidate selection question for medium-confidence matches", async () => {
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
            status: "processing",
            topConfidence: null,
            acceptedEntityType: null,
            acceptedEntityId: null,
            metadata: { brand: "OPI", shadeName: "Big Apple" },
          }],
        };
      }
      if (callCount === 3) {
        return { rows: [{ frameType: "label", quality: { brand: "OPI", shadeName: "Big Apple" } }] };
      }
      if (callCount === 4) {
        return {
          rows: [{
            shadeId: "21",
            brand: "OPI",
            shadeName: "Big Apple Red",
            score: 0.81,
          }],
        };
      }
      return { rows: [] };
    };
    transactionMock = async (cb) =>
      cb({
        query: async (text) => {
          if (text.includes("INSERT INTO capture_question")) {
            return {
              rows: [{
                id: "444",
                key: "candidate_select",
                prompt: "We found close shade matches. Reply with a shade ID from the options below, or skip.",
                type: "single_select",
                options: ["21: OPI — Big Apple Red", "skip"],
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
    assert.equal(res.jsonBody.question.key, "candidate_select");
  });

  it("finalize matches by barcode and stores inventory via sku", async () => {
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
            id: 11,
            captureId: "22222222-2222-4222-8222-222222222222",
            status: "processing",
            topConfidence: null,
            acceptedEntityType: null,
            acceptedEntityId: null,
            metadata: { gtin: "1234567890123" },
          }],
        };
      }
      if (callCount === 3) {
        return { rows: [{ frameType: "barcode", quality: { gtin: "1234567890123" } }] };
      }
      if (callCount === 4) {
        return {
          rows: [{
            skuId: "501",
            shadeId: "21",
            brand: "OPI",
            productName: "Big Apple Red",
            shadeName: "Big Apple Red",
          }],
        };
      }
      return { rows: [] };
    };
    transactionMock = async (cb) =>
      cb({
        query: async (text) => {
          if (text.includes("SELECT inventory_item_id AS id")) {
            return { rows: [] };
          }
          if (text.includes("SELECT shade_id AS \"shadeId\"")) {
            return { rows: [{ shadeId: 21 }] };
          }
          if (text.includes("INSERT INTO user_inventory_item")) {
            return { rows: [{ id: 703 }] };
          }
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["capture-finalize"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/22222222-2222-4222-8222-222222222222/finalize",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "22222222-2222-4222-8222-222222222222" },
      }),
      fakeContext()
    );

    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "matched");
  });

  it("answering candidate selection marks capture as matched", async () => {
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
            topConfidence: "0.81",
            acceptedEntityType: null,
            acceptedEntityId: null,
            metadata: null,
          }],
        };
      }
      if (callCount === 3) {
        return {
          rows: [{
            id: "444",
            key: "candidate_select",
            prompt: "Choose a match",
            type: "single_select",
            options: ["21: OPI — Big Apple Red", "skip"],
            status: "open",
            createdAt: "2026-02-10T00:00:00.000Z",
          }],
        };
      }
      // nextQuestion lookup after transaction
      return { rows: [] };
    };
    transactionMock = async (cb) =>
      cb({
        query: async (text) => {
          if (text.includes("SELECT inventory_item_id AS id")) {
            return { rows: [] };
          }
          if (text.includes("INSERT INTO user_inventory_item")) {
            return { rows: [{ id: 702 }] };
          }
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["capture-answer"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/11111111-1111-4111-8111-111111111111/answer",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "11111111-1111-4111-8111-111111111111" },
        body: { questionId: "444", answer: "21" },
      }),
      fakeContext()
    );

    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "matched");
  });

  it("stores structured brand_shade answer and returns processing", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;
    const capturedArgs = [];
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
            topConfidence: "0.4",
            acceptedEntityType: null,
            acceptedEntityId: null,
            metadata: null,
          }],
        };
      }
      if (callCount === 3) {
        return {
          rows: [{
            id: "445",
            key: "brand_shade",
            prompt: "Tell us brand and shade",
            type: "free_text",
            options: null,
            status: "open",
            createdAt: "2026-02-10T00:00:00.000Z",
          }],
        };
      }
      return { rows: [] };
    };
    transactionMock = async (cb) =>
      cb({
        query: async (_text, params) => {
          capturedArgs.push(params);
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["capture-answer"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/11111111-1111-4111-8111-111111111111/answer",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "11111111-1111-4111-8111-111111111111" },
        body: { questionId: "445", answer: "OPI - Big Apple Red" },
      }),
      fakeContext()
    );

    const updateParams = capturedArgs.find((params) => params?.[1] === "brand_shade");
    assert.ok(updateParams);
    assert.equal(typeof updateParams[2], "string");
    assert.ok(updateParams[2].includes("\"brand\":\"OPI\""));
    assert.ok(updateParams[2].includes("\"shadeName\":\"Big Apple Red\""));
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "processing");
  });
});
