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
let jwtVerifyMock = async () => ({ payload: {} });
let stytchAuthenticateJwtMock = async () => ({ session: { user_id: "stytch-user-1" } });
let stytchUserGetMock = async () => ({ emails: [] });

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
  jwtVerify: (...args) => jwtVerifyMock(...args),
});

registerMock("stytch", {
  Client: class {
    constructor() {
      this.sessions = {
        authenticateJwt: (...args) => stytchAuthenticateJwtMock(...args),
      };
      this.users = {
        get: (...args) => stytchUserGetMock(...args),
      };
    }
  },
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

// Reset mocks between tests
afterEach(() => {
  queryMock = async () => ({ rows: [] });
  transactionMock = async (cb) => cb(fakeClient());
  jwtVerifyMock = async () => ({ payload: {} });
  stytchAuthenticateJwtMock = async () => ({ session: { user_id: "stytch-user-1" } });
  stytchUserGetMock = async () => ({ emails: [] });
  delete process.env.AUTH_DEV_BYPASS;
  delete process.env.AUTH_PROVIDER;
  delete process.env.AUTH0_DOMAIN;
  delete process.env.AUTH0_AUDIENCE;
  delete process.env.AUTH0_ISSUER_BASE_URL;
  delete process.env.AUTH0_CLIENT_ID;
  delete process.env.STYTCH_PROJECT_ID;
  delete process.env.STYTCH_SECRET;
  delete process.env.STYTCH_PUBLIC_TOKEN;
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

  it("production: throws when no auth provider is configured", async () => {
    const req = fakeRequest({ headers: { authorization: "Bearer some.jwt.token" } });
    await assert.rejects(
      () => authLib.authenticateRequest(req, fakeContext()),
      (err) => err instanceof authLib.AuthError && /no auth provider configured/i.test(err.message)
    );
  });

  it("auth0: validates token and returns linked user", async () => {
    process.env.AUTH_PROVIDER = "auth0";
    process.env.AUTH0_DOMAIN = "example.us.auth0.com";
    process.env.AUTH0_AUDIENCE = "https://api.swatchwatch.dev";
    process.env.AUTH0_ISSUER_BASE_URL = "https://example.us.auth0.com/";

    jwtVerifyMock = async () => ({
      payload: {
        sub: "auth0|123",
        email: "auth0@example.com",
        email_verified: true,
      },
    });

    transactionMock = async (cb) => cb({
      query: async (sql) => {
        if (sql.includes("FROM user_identity")) return { rows: [{ user_id: 9 }] };
        if (sql.includes("UPDATE app_user")) return { rows: [] };
        return { rows: [] };
      },
    });

    const req = fakeRequest({ headers: { authorization: "Bearer valid.auth0.jwt" } });
    const result = await authLib.authenticateRequest(req, fakeContext());
    assert.equal(result.userId, 9);
    assert.equal(result.externalId, "auth0|123");
    assert.equal(result.email, "auth0@example.com");
  });

  it("stytch: validates token and returns linked user", async () => {
    process.env.AUTH_PROVIDER = "stytch";
    process.env.STYTCH_PROJECT_ID = "project-test-123";
    process.env.STYTCH_SECRET = "secret-test-123";

    stytchAuthenticateJwtMock = async () => ({
      session: { user_id: "user-test-abc" },
    });
    stytchUserGetMock = async () => ({
      emails: [{ email: "stytch@example.com", verified: true }],
    });

    transactionMock = async (cb) => cb({
      query: async (sql) => {
        if (sql.includes("FROM user_identity")) return { rows: [{ user_id: 12 }] };
        if (sql.includes("UPDATE app_user")) return { rows: [] };
        return { rows: [] };
      },
    });

    const req = fakeRequest({ headers: { authorization: "Bearer valid.stytch.jwt" } });
    const result = await authLib.authenticateRequest(req, fakeContext());
    assert.equal(result.userId, 12);
    assert.equal(result.externalId, "user-test-abc");
    assert.equal(result.email, "stytch@example.com");
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
  it("returns 503 when auth env vars are not set", async () => {
    const handler = registeredRoutes["auth-config"].handler;
    const res = await handler(fakeRequest(), fakeContext());
    assert.equal(res.status, 503);
    assert.ok(res.jsonBody.error);
  });

  it("returns Auth0 config when Auth0 env vars are set", async () => {
    process.env.AUTH_PROVIDER = "auth0";
    process.env.AUTH0_DOMAIN = "example.us.auth0.com";
    process.env.AUTH0_AUDIENCE = "https://api.swatchwatch.dev";
    process.env.AUTH0_ISSUER_BASE_URL = "https://example.us.auth0.com/";
    process.env.AUTH0_CLIENT_ID = "auth0-client-id";
    const handler = registeredRoutes["auth-config"].handler;
    const res = await handler(fakeRequest(), fakeContext());
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.provider, "auth0");
    assert.equal(res.jsonBody.auth0.clientId, "auth0-client-id");
    assert.equal(res.jsonBody.auth0.audience, "https://api.swatchwatch.dev");
  });

  it("returns Stytch config when Stytch env vars are set", async () => {
    process.env.AUTH_PROVIDER = "stytch";
    process.env.STYTCH_PROJECT_ID = "project-test-123";
    process.env.STYTCH_PUBLIC_TOKEN = "public-token-test-123";
    const handler = registeredRoutes["auth-config"].handler;
    const res = await handler(fakeRequest(), fakeContext());
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.provider, "stytch");
    assert.equal(res.jsonBody.stytch.projectId, "project-test-123");
    assert.equal(res.jsonBody.stytch.publicToken, "public-token-test-123");
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
