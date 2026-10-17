const { describe, it, afterEach, beforeEach } = require("node:test");
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
  const allowed = new Set([...expectedMethods, "OPTIONS"]);

  for (const method of expectedMethods) {
    assert.ok(
      actual.includes(method),
      `route ${routeName} should include ${method} (got ${actual})`
    );
  }

  for (const method of actual) {
    assert.ok(
      allowed.has(method),
      `route ${routeName} should not include unexpected method ${method} (allowed: ${[...allowed].join(", ")})`
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
    finishes: ["creme"],
    provider: "azure-openai",
  }),
});

// Mutable OCR + LLM mocks — individual tests can override these
let extractTextFromImageMock = async () => null;
let parseLabelTextMock = async () => null;
let stripImageMetadataMock = async (bytes) => bytes;

registerMock("../lib/ocr", {
  get extractTextFromImage() { return extractTextFromImageMock; },
});
registerMock("../lib/ocr-parser", {
  get parseLabelText() { return parseLabelTextMock; },
});

// Stub blob storage reader to avoid network
/** Container segment of a blob URL (virtual-host or path-style), same parsing as lib/blob-storage. */
function mockBlobContainer(storageUrl) {
  try {
    const parsed = new URL(storageUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return (segments[/^[^.]+\.blob\./i.test(parsed.hostname) ? 0 : 1] ?? "").toLowerCase();
  } catch {
    return "";
  }
}

registerMock("../lib/blob-storage", {
  isCatalogStorageUrl: (url) => mockBlobContainer(url) === "source-images",
  isUserMediaStorageUrl: (url) => mockBlobContainer(url) === "nail-photos",
  // Remote capture image URLs are allowlisted by the real validator (see capture-image-url tests);
  // here only the fixture host is "on the configured storage account".
  checkStorageImageUrl: (url) => (String(url).startsWith("https://blob.example/") ? null : "not allowed"),
  readBlobFromStorageUrl: async () => ({
    bytes: Buffer.from("fakeimg"),
    contentType: "image/png",
    checksumSha256: "deadbeef",
    sizeBytes: 7,
    storageUrl: "https://example.com/fake.png",
  }),
  validateImageUpload: (contentType, sizeBytes) => {
    const normalizedType = String(contentType || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const allowedMimeTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
      "image/gif",
    ]);

    if (!normalizedType || !allowedMimeTypes.has(normalizedType)) {
      throw new Error("Unsupported image type");
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new Error("Image payload is empty");
    }
    if (sizeBytes > 5 * 1024 * 1024) {
      throw new Error("Image too large");
    }

    return normalizedType;
  },
  // Identity strip by default; individual tests can observe the call via stripImageMetadataMock.
  stripImageMetadata: async (bytes) => stripImageMetadataMock(bytes),
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
require("../dist/functions/admin-users");

// Reset mocks between tests
afterEach(() => {
  queryMock = async () => ({ rows: [] });
  transactionMock = async (cb) => cb(fakeClient());
  extractTextFromImageMock = async () => null;
  parseLabelTextMock = async () => null;
  stripImageMetadataMock = async (bytes) => bytes;
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

  it("dev bypass: coerces a BIGINT user_id returned as a string to a number (#227)", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: "1", external_id: "ext-1", email: null, role: "user" }],
    });
    const req = fakeRequest({ headers: { authorization: "Bearer dev:1" } });
    const result = await authLib.authenticateRequest(req, fakeContext());
    assert.equal(result.userId, 1);
    assert.equal(typeof result.userId, "number");
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
// functions/admin-users — route registration, validation
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/admin-users — route registration", () => {
  it("registers admin-users-list GET route", () => {
    expectMethods("admin-users-list", ["GET"]);
    assert.equal(registeredRoutes["admin-users-list"].route, "users-admin");
  });

  it("registers admin-users-merge POST route", () => {
    expectMethods("admin-users-merge", ["POST"]);
    assert.equal(registeredRoutes["admin-users-merge"].route, "users-admin/merge");
  });
});

describe("functions/admin-users — merge validation", () => {
  it("returns 400 when ids are missing", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 2, external_id: "dev-user-2", email: "admin@test", role: "admin" }],
    });
    const handler = registeredRoutes["admin-users-merge"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/users-admin/merge",
      headers: { authorization: "Bearer dev:2" },
      body: {},
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /sourceUserId/i);
  });

  it("returns 400 when ids are equal", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 2, external_id: "dev-user-2", email: "admin@test", role: "admin" }],
    });
    const handler = registeredRoutes["admin-users-merge"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/users-admin/merge",
      headers: { authorization: "Bearer dev:2" },
      body: { sourceUserId: 2, targetUserId: 2 },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /must be different/i);
  });

  it("returns 200 and merge counters on successful merge", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (...args) => {
      if (args[0]?.includes("FROM app_user")) {
        return {
          rows: [{ user_id: 2, external_id: "dev-user-2", email: "admin@test", role: "admin" }],
        };
      }
      return { rows: [] };
    };

    transactionMock = async (cb) => cb({
      query: async (sql) => {
        if (sql.includes("FROM app_user") && sql.includes("WHERE user_id = ANY")) {
          return {
            rows: [
              { userId: 10, role: "user", email: "source@test.dev", externalId: "oid-source" },
              { userId: 20, role: "user", email: "target@test.dev", externalId: "oid-target" },
            ],
          };
        }
        if (sql.includes("UPDATE user_inventory_item target")) return { rows: [], rowCount: 1 };
        if (sql.includes("DELETE FROM user_inventory_item source")) return { rows: [], rowCount: 1 };
        if (sql.includes("UPDATE user_inventory_item")) return { rows: [], rowCount: 2 };
        if (sql.includes("UPDATE user_submission")) return { rows: [], rowCount: 3 };
        if (sql.includes("UPDATE capture_session")) return { rows: [], rowCount: 4 };
        if (sql.includes("UPDATE capture_answer")) return { rows: [], rowCount: 5 };
        if (sql.includes("UPDATE click_event")) return { rows: [], rowCount: 6 };
        if (sql.includes("INSERT INTO user_external_identities")) return { rows: [], rowCount: 2 };
        if (sql.includes("UPDATE app_user")) return { rows: [], rowCount: 1 };
        if (sql.includes("DELETE FROM app_user")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    });

    const handler = registeredRoutes["admin-users-merge"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/users-admin/merge",
      headers: { authorization: "Bearer dev:2" },
      body: { sourceUserId: 10, targetUserId: 20 },
    });
    const res = await handler(req, fakeContext());

    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.merged, true);
    assert.equal(res.jsonBody.sourceUserId, 10);
    assert.equal(res.jsonBody.targetUserId, 20);
    assert.equal(res.jsonBody.mergedInventoryRows, 2);
    assert.equal(res.jsonBody.mergedIdentityRows, 2);
    assert.equal(res.jsonBody.mergedSubmissionRows, 3);
    assert.equal(res.jsonBody.mergedCaptureRows, 4);
    assert.equal(res.jsonBody.mergedCaptureAnswerRows, 5);
    assert.equal(res.jsonBody.mergedClickEventRows, 6);
    assert.equal(res.jsonBody.mergedInventoryDuplicateRows, 1);
    assert.match(res.jsonBody.message, /Merged user 10 into 20/i);
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

  it("polishes-mutate accepts PUT + DELETE", () => {
    expectMethods("polishes-mutate", ["PUT", "DELETE"]);
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

  it("does not depend on shade.external_id in recalc shade lookup query", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let removedJoinUsed = false;
    queryMock = async (...args) => {
      const sql = args[0] || "";
      if (sql.includes("FROM app_user")) {
        return {
          rows: [{ user_id: 1, external_id: "ext-1", email: "admin@test", role: "admin" }],
        };
      }
      if (sql.includes("FROM shade s")) {
        if (sql.includes("ON ep.external_id = s.external_id")) {
          removedJoinUsed = true;
          throw new Error("column s.external_id does not exist");
        }
        return {
          rows: [
            {
              shade_id: 123,
              shade_name_canonical: "Tag Edge Case",
              detected_hex: null,
              vendor_hex: null,
              storage_url: "https://example.com/fake.png",
              vendor_tags: null,
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
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.detectedHex, "#ABCDEF");
    assert.equal(removedJoinUsed, false);
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
        return {
          rows: [
            {
              id: "1",
              brand: "OPI",
              name: "Red",
              color: "Red",
              finish: "cream",
              swatchImageUrl: null,
              totalCount: "1",
            },
          ],
        };
      }
      // Fallback count query (only runs for a page past the end).
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
    assert.equal(res.jsonBody.total, 1);
    assert.ok(!("totalCount" in res.jsonBody.polishes[0]), "window column must not leak into rows");
    assert.equal(typeof res.jsonBody.page, "number");
    assert.equal(typeof res.jsonBody.pageSize, "number");
    assert.equal(res.jsonBody.polishes[0].finish, "creme");
  });
});

describe("functions/polishes — primary swatch image selection", () => {
  // Ingestion inserts gallery swatches after the product swatch, so "newest swatch" is a gallery
  // image. Readers must rank the source_product swatch first and only then fall back to newest.
  const PRIMARY_FIRST_ORDER =
    /ORDER BY COALESCE\(sw\.swatch_type = 'source_product', false\) DESC, sw\.swatch_id DESC/;
  const authUserRow = { user_id: 1, external_id: "ext-1", email: "admin@test", role: "admin" };

  it("list thumbnail lateral join prefers the source_product swatch", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let listSql = null;
    queryMock = async (sql) => {
      if (sql.includes("FROM app_user")) return { rows: [authUserRow] };
      if (sql.includes("swatch_img")) {
        listSql = sql;
        return { rows: [] };
      }
      return { rows: [{ total: "0" }] };
    };

    const handler = registeredRoutes["polishes-list"].handler;
    const res = await handler(
      fakeRequest({
        url: "http://localhost:7071/api/polishes",
        headers: { authorization: "Bearer dev:1" },
        params: {},
      }),
      fakeContext()
    );

    assert.equal(res.status, 200);
    assert.ok(listSql, "list query should select the swatch thumbnail");
    const lateral = listSql.slice(
      listSql.indexOf("LEFT JOIN LATERAL"),
      listSql.indexOf(") AS swatch_img")
    );
    assert.match(lateral, PRIMARY_FIRST_ORDER);
  });

  it("detail returns every source image with the product image first", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let imagesSql = null;
    queryMock = async (sql) => {
      if (sql.includes("FROM app_user")) return { rows: [authUserRow] };
      if (sql.includes('AS "storageUrl"')) {
        imagesSql = sql;
        // Rows as Postgres returns them under the primary-first ordering.
        return {
          rows: [
            { storageUrl: "https://example.com/product.png" },
            { storageUrl: "https://example.com/gallery-2.png" },
            { storageUrl: "https://example.com/gallery-1.png" },
          ],
        };
      }
      if (sql.includes("swatch_img")) {
        return {
          rows: [
            {
              id: "77",
              brand: "OPI",
              name: "Primary",
              finish: "creme",
              swatchImageUrl: "https://example.com/product.png",
            },
          ],
        };
      }
      return { rows: [] };
    };

    const handler = registeredRoutes["polishes-list"].handler;
    const res = await handler(
      fakeRequest({
        url: "http://localhost:7071/api/polishes/77",
        headers: { authorization: "Bearer dev:1" },
        params: { id: "77" },
      }),
      fakeContext()
    );

    assert.equal(res.status, 200);
    assert.ok(imagesSql, "detail should query the shade's swatch images");
    assert.match(imagesSql, PRIMARY_FIRST_ORDER);
    assert.doesNotMatch(imagesSql, /LIMIT/, "detail should return all images, not just the primary");
    assert.deepEqual(res.jsonBody.sourceImageUrls, [
      "https://example.com/product.png",
      "https://example.com/gallery-2.png",
      "https://example.com/gallery-1.png",
    ]);
    assert.equal(res.jsonBody.swatchImageUrl, "https://example.com/product.png");
  });

  for (const [label, authRow] of [
    ["numeric user_id", authUserRow],
    // node-postgres returns BIGINT (int8) columns as strings; ownership must still match.
    ["BIGINT user_id returned as a string", { ...authUserRow, user_id: "1" }],
  ]) {
  it(`detail mints owner-scoped ids only for private image_asset rows the caller owns (#227, ${label})`, async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const imageProxy = require("../dist/lib/image-proxy");
    const CATALOG = "https://swatchacct.blob.core.windows.net/source-images/opi/product.png";
    const MINE = "https://swatchacct.blob.core.windows.net/nail-photos/user-1/mine.png";
    const THEIRS = "https://swatchacct.blob.core.windows.net/nail-photos/user-2/theirs.png";
    const SYSTEM = "https://swatchacct.blob.core.windows.net/nail-photos/system/unowned.png";
    // Owned by the caller but outside USER_MEDIA_CONTAINER: the proxy could never serve it.
    const MINE_ELSEWHERE = "https://swatchacct.blob.core.windows.net/connector-raw/user-1/mine.png";
    let imagesSql = null;
    queryMock = async (sql) => {
      if (sql.includes("FROM app_user")) return { rows: [authRow] };
      if (sql.includes('AS "storageUrl"')) {
        imagesSql = sql;
        return {
          rows: [
            { storageUrl: CATALOG, ownerType: "system", ownerId: null },
            { storageUrl: MINE, ownerType: "user", ownerId: "1" },
            { storageUrl: THEIRS, ownerType: "user", ownerId: "2" },
            { storageUrl: SYSTEM, ownerType: "system", ownerId: "1" },
            { storageUrl: MINE_ELSEWHERE, ownerType: "user", ownerId: "1" },
          ],
        };
      }
      if (sql.includes("swatch_img")) {
        return { rows: [{ id: "77", brand: "OPI", name: "Primary", finish: "creme", swatchImageUrl: CATALOG }] };
      }
      return { rows: [] };
    };

    const errors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    let res;
    try {
      res = await registeredRoutes["polishes-list"].handler(
        fakeRequest({
          url: "http://localhost:7071/api/polishes/77",
          headers: { authorization: "Bearer dev:1" },
          params: { id: "77" },
        }),
        fakeContext()
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(res.status, 200);
    assert.match(imagesSql, /ia\.owner_type AS "ownerType", ia\.owner_id AS "ownerId"/);
    const decoded = res.jsonBody.sourceImageUrls.map((url) =>
      imageProxy.decodeImageProxyIdWithExpiry(decodeURIComponent(new URL(url).pathname.split("/").pop()))
    );
    assert.deepEqual(
      decoded.map(({ url, scope, ownerUserId }) => ({ url, scope, ownerUserId })),
      [
        { url: CATALOG, scope: "public", ownerUserId: undefined },
        { url: MINE, scope: "private", ownerUserId: 1 },
      ],
      "other users', unowned, and unservable private media must be omitted"
    );
    assert.deepEqual(errors, [], "omitting another user's media is expected, not an error");
  });
  }

  it("recalc-hex shade lookup prefers the source_product swatch image", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let shadeSql = null;
    queryMock = async (sql) => {
      if (sql.includes("FROM app_user")) return { rows: [authUserRow] };
      if (sql.includes("FROM shade s")) {
        shadeSql = sql;
        return {
          rows: [
            {
              shade_id: 123,
              shade_name_canonical: "Primary Shade",
              detected_hex: null,
              vendor_hex: null,
              storage_url: "https://example.com/product.png",
              vendor_tags: null,
            },
          ],
        };
      }
      return { rows: [] };
    };

    const handler = registeredRoutes["polishes-recalc-hex"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/polishes/123/recalc-hex",
        headers: { authorization: "Bearer dev:1" },
        params: { id: "123" },
      }),
      fakeContext()
    );

    assert.equal(res.status, 200);
    assert.ok(shadeSql, "recalc-hex should look up the shade and its swatch image");
    assert.match(shadeSql, PRIMARY_FIRST_ORDER);
    assert.match(shadeSql, /LIMIT 1/);
  });
});

describe("functions/polishes — matchImage", () => {
  const sharp = require("sharp");

  async function splitPngDataUrl() {
    const width = 40;
    const height = 40;
    const buf = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = x < 20 ? [208, 16, 32] : [16, 48, 192];
        const i = (y * width + x) * 3;
        buf[i] = r;
        buf[i + 1] = g;
        buf[i + 2] = b;
      }
    }
    const png = await sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  }

  function matchRequest(body, extraHeaders = {}) {
    return fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/polishes/match-image",
      headers: { authorization: "Bearer dev:1", ...extraHeaders },
      body,
    });
  }

  function mockAuthThen(rowsForPolishQuery, seenQueries = []) {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (sql, params) => {
      if (sql.includes("FROM app_user")) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null, role: "user" }] };
      }
      seenQueries.push({ sql, params });
      return { rows: rowsForPolishQuery };
    };
  }

  it("registers POST polishes/match-image", () => {
    expectMethods("polishes-match-image", ["POST"]);
    assert.equal(registeredRoutes["polishes-match-image"].route, "polishes/match-image");
  });

  it("returns 401 without auth", async () => {
    const handler = registeredRoutes["polishes-match-image"].handler;
    const req = fakeRequest({ method: "POST", url: "http://localhost:7071/api/polishes/match-image", body: {} });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 401);
  });

  it("returns 400 when image is missing", async () => {
    mockAuthThen([]);
    const handler = registeredRoutes["polishes-match-image"].handler;
    const res = await handler(matchRequest({}), fakeContext());
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /image/i);
  });

  it("returns 400 for a non-image MIME type", async () => {
    mockAuthThen([]);
    const handler = registeredRoutes["polishes-match-image"].handler;
    const res = await handler(
      matchRequest({ image: `data:application/pdf;base64,${Buffer.from("%PDF").toString("base64")}` }),
      fakeContext()
    );
    assert.equal(res.status, 400);
  });

  it("returns 400 when the bytes are not a decodable image", async () => {
    const seen = [];
    mockAuthThen([], seen);
    const handler = registeredRoutes["polishes-match-image"].handler;
    const res = await handler(
      matchRequest({ image: `data:image/png;base64,${Buffer.from("not really a png").toString("base64")}` }),
      fakeContext()
    );
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /decode/i);
    assert.equal(seen.length, 0, "should not query polishes for an invalid image");
  });

  it("returns 413 when content-length exceeds the body limit", async () => {
    mockAuthThen([]);
    const handler = registeredRoutes["polishes-match-image"].handler;
    const res = await handler(
      matchRequest({ image: "data:image/png;base64,AAAA" }, { "content-length": String(20 * 1024 * 1024) }),
      fakeContext()
    );
    assert.equal(res.status, 413);
  });

  it("matches only the caller's owned polishes and returns sorted results", async () => {
    const seen = [];
    mockAuthThen(
      [
        { id: "10", shadeId: "10", userId: "1", brand: "OPI", name: "Big Apple Red", color: "", vendorHex: "#D11121", finish: "cream", swatchImageUrl: null },
        { id: "11", shadeId: "11", userId: "1", brand: "Essie", name: "Butler Please", color: "", detectedHex: "#1131C1", finish: "creme", swatchImageUrl: null },
        { id: "12", shadeId: "12", userId: "1", brand: "Zoya", name: "No Hex", color: "", swatchImageUrl: null },
        { id: "13", shadeId: "13", userId: "1", brand: "ILNP", name: "Mint", color: "", vendorHex: "#98FF98", swatchImageUrl: null },
      ],
      seen
    );
    const handler = registeredRoutes["polishes-match-image"].handler;
    const res = await handler(matchRequest({ image: await splitPngDataUrl(), limit: 2 }), fakeContext());

    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].params, [1]);
    assert.match(seen[0].sql, /COALESCE\(ui\.quantity, 0\) > 0/);

    const body = res.jsonBody;
    const hexes = body.extractedColors.map((c) => c.hex);
    assert.ok(hexes.includes("#D01020") && hexes.includes("#1030C0"), hexes.join(","));
    assert.equal(body.candidateCount, 3);
    assert.equal(body.matches.length, 2);
    assert.deepEqual(body.matches.map((m) => m.polish.id).sort(), ["10", "11"]);
    for (const m of body.matches) {
      assert.equal(m.confidence, "high");
      assert.ok(["#D01020", "#1030C0"].includes(m.matchedColor));
    }
    assert.ok(body.matches[0].distance <= body.matches[1].distance);
    assert.equal(body.matches.find((m) => m.polish.id === "10").polish.finish, "creme");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// functions/polishes — multi-finish contract (#43)
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/polishes — multi-finish", () => {
  const finishLib = require("../dist/lib/finishes");

  afterEach(() => {
    finishLib.resetFinishAliasCache();
  });

  /** Rows as returned by the single finish catalog query (finish_type + finish_normalization). */
  function aliasRows({ withChrome = false } = {}) {
    const types = ["holographic", "shimmer", "creme", ...(withChrome ? ["chrome"] : [])].map((name) => ({
      kind: "type",
      sourceValue: name,
      normalizedFinishName: name,
    }));
    return [
      ...types,
      { kind: "alias", sourceValue: "holo", normalizedFinishName: "holographic" },
      { kind: "alias", sourceValue: "cream", normalizedFinishName: "creme" },
      ...(withChrome ? [{ kind: "alias", sourceValue: "mirror", normalizedFinishName: "chrome" }] : []),
    ];
  }

  describe("loadFinishCatalog", () => {
    beforeEach(() => {
      // Earlier tests in this file may have cached a (fallback) catalog.
      finishLib.resetFinishAliasCache();
    });

    it("builds aliases and validNames from one query and caches it", async () => {
      let queries = 0;
      queryMock = async () => {
        queries++;
        return { rows: aliasRows({ withChrome: true }) };
      };
      const catalog = await finishLib.loadFinishCatalog();
      assert.deepEqual([...catalog.validNames].sort(), ["chrome", "creme", "holographic", "shimmer"]);
      assert.equal(catalog.aliases.get("mirror"), "chrome");
      assert.equal(catalog.aliases.get("holo"), "holographic");
      assert.equal(catalog.aliases.get("chrome"), "chrome");
      await finishLib.loadFinishCatalog();
      assert.equal(queries, 1, "second load should be served from the cache");
      finishLib.resetFinishAliasCache();
      await finishLib.loadFinishCatalog();
      assert.equal(queries, 2, "reset should force a reload");
    });

    it("ignores alias rows whose target is not a finish_type", async () => {
      queryMock = async () => ({
        rows: [
          ...aliasRows(),
          { kind: "alias", sourceValue: "suede", normalizedFinishName: "velvet" },
        ],
      });
      const catalog = await finishLib.loadFinishCatalog();
      assert.ok(!catalog.validNames.has("velvet"));
      assert.equal(catalog.aliases.has("suede"), false);
    });

    it("falls back to the built-in finishes and aliases when the query throws", async () => {
      const { CANONICAL_FINISHES } = require("swatchwatch-shared");
      queryMock = async () => {
        throw new Error("db down");
      };
      let fallbackMessage = null;
      const catalog = await finishLib.loadFinishCatalog({ onFallback: (message) => (fallbackMessage = message) });
      assert.equal(fallbackMessage, "db down");
      assert.deepEqual([...catalog.validNames].sort(), [...CANONICAL_FINISHES].sort());
      assert.equal(catalog.aliases, finishLib.DEFAULT_FINISH_ALIAS_MAP);
      assert.equal(finishLib.canonicalizeFinish("holo", catalog), "holographic");
    });

    it("uses the built-in names when finish_type returns no rows", async () => {
      const { CANONICAL_FINISHES } = require("swatchwatch-shared");
      queryMock = async () => ({ rows: [] });
      const catalog = await finishLib.loadFinishCatalog();
      assert.deepEqual([...catalog.validNames].sort(), [...CANONICAL_FINISHES].sort());
    });
  });

  it("selects finishes and filters by finish against the multi-finish array and legacy column", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const listCalls = [];
    queryMock = async (text, params) => {
      if (text.includes("FROM app_user")) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (text.includes("FROM finish_normalization")) {
        return { rows: aliasRows() };
      }
      if (text.includes("COUNT(*) AS total")) {
        return { rows: [{ total: "1" }] };
      }
      listCalls.push({ text, params });
      return {
        rows: [
          {
            id: "7",
            brand: "Holo Taco",
            name: "Rainbow Road",
            color: "",
            finish: "shimmer",
            finishes: ["shimmer", "holographic"],
            swatchImageUrl: null,
            totalCount: "1",
          },
        ],
      };
    };

    const handler = registeredRoutes["polishes-list"].handler;
    const req = fakeRequest({
      url: "http://localhost:7071/api/polishes?finish=holo&finishes=Shimmer,cream",
      headers: { authorization: "Bearer dev:1" },
      params: {},
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody.polishes[0].finishes, ["shimmer", "holographic"]);
    assert.equal(res.jsonBody.polishes[0].finish, "shimmer");

    assert.equal(listCalls.length, 1);
    const { text, params } = listCalls[0];
    assert.ok(text.includes("AS finishes"), "POLISH_SELECT should project finishes");
    assert.ok(text.includes("s.finishes, ARRAY[]::text[]) &&"), "should use array overlap for finish filter");
    // finish=holo → canonical holographic (+ raw legacy value)
    assert.ok(params.some((p) => Array.isArray(p) && p.length === 1 && p[0] === "holographic"));
    assert.ok(params.some((p) => Array.isArray(p) && p.includes("holo") && p.includes("holographic")));
    // finishes=Shimmer,cream → any-of canonical [shimmer, creme]; legacy column also matches "cream"
    assert.ok(params.some((p) => Array.isArray(p) && p.join(",") === "shimmer,creme"));
    assert.ok(params.some((p) => Array.isArray(p) && p.includes("cream") && p.includes("creme")));
  });

  it("filters the list by a runtime-only finish type (finishes=chrome, alias mirror)", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const listCalls = [];
    queryMock = async (text, params) => {
      if (text.includes("FROM app_user")) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (text.includes("FROM finish_normalization")) {
        return { rows: aliasRows({ withChrome: true }) };
      }
      if (text.includes("COUNT(*) AS total")) {
        return { rows: [{ total: "1" }] };
      }
      listCalls.push({ text, params });
      return {
        rows: [
          { id: "8", brand: "X", name: "Mirror Ball", color: "", finish: "chrome", finishes: ["chrome"], swatchImageUrl: null, totalCount: "1" },
        ],
      };
    };

    const handler = registeredRoutes["polishes-list"].handler;
    const req = fakeRequest({
      url: "http://localhost:7071/api/polishes?finishes=chrome&finish=Mirror",
      headers: { authorization: "Bearer dev:1" },
      params: {},
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody.polishes[0].finishes, ["chrome"]);

    const { text, params } = listCalls[0];
    assert.ok(text.includes("s.finishes, ARRAY[]::text[]) &&"));
    // The legacy single-finish column only matches shades with no finishes array: once a creator
    // replaces ["creme"] with ["glitter"], ?finishes=creme must stop returning that shade.
    assert.match(text, /cardinality\(COALESCE\(s\.finishes, ARRAY\[\]::text\[\]\)\) = 0 AND LOWER\(s\.finish\)/);
    assert.ok(!/OR LOWER\(s\.finish\) = ANY/.test(text), "legacy finish must not match unconditionally");
    // Both filter groups resolve to the runtime finish and are matched against the finishes array.
    // finish=Mirror (alias) → canonical chrome (+ raw legacy value); finishes=chrome → chrome.
    assert.ok(params.some((p) => Array.isArray(p) && p.length === 1 && p[0] === "chrome"));
    assert.ok(params.some((p) => Array.isArray(p) && p.includes("mirror") && p.includes("chrome")));
    assert.equal(
      params.filter((p) => Array.isArray(p) && p.length === 1 && p[0] === "chrome").length,
      3,
      "both groups resolve to chrome (canonical + legacy for the alias group, canonical for finishes=)"
    );
  });

  it("stores a runtime-only finish type on create when finish_type has it", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text) => {
      if (text.includes("FROM app_user")) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (text.includes("FROM finish_normalization")) {
        return { rows: aliasRows({ withChrome: true }) };
      }
      return { rows: [{ id: "57", brand: "OPI", name: "Mirror", finish: "chrome", finishes: ["chrome"], swatchImageUrl: null }] };
    };
    const clientCalls = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          clientCalls.push({ text, params });
          if (text.includes("SELECT brand_id FROM brand")) return { rows: [{ brand_id: 3 }] };
          if (text.includes("AS own_submitted")) return { rows: [] };
          if (text.includes("INSERT INTO shade")) return { rows: [{ shade_id: 57 }] };
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["polishes-create"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/polishes",
      headers: { authorization: "Bearer dev:1" },
      body: { brand: "OPI", name: "Mirror", color: "Silver", finishes: ["chrome", "Mirror"] },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 201);
    const insert = clientCalls.find((c) => c.text.includes("INSERT INTO shade"));
    assert.deepEqual(insert.params[9], ["chrome"]);
    assert.equal(insert.params[2], "chrome", "legacy finish key defaults to the primary finish");
  });

  it("drops a finish that is not in finish_type (no chrome row)", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text) => {
      if (text.includes("FROM app_user")) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (text.includes("FROM finish_normalization")) {
        return { rows: aliasRows() };
      }
      return { rows: [{ id: "58", brand: "OPI", name: "Mirror", finish: "", finishes: [], swatchImageUrl: null }] };
    };
    const clientCalls = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          clientCalls.push({ text, params });
          if (text.includes("SELECT brand_id FROM brand")) return { rows: [{ brand_id: 3 }] };
          if (text.includes("AS own_submitted")) return { rows: [] };
          if (text.includes("INSERT INTO shade")) return { rows: [{ shade_id: 58 }] };
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["polishes-create"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/polishes",
      headers: { authorization: "Bearer dev:1" },
      body: { brand: "OPI", name: "Mirror", color: "Silver", finishes: ["chrome"] },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 201);
    const insert = clientCalls.find((c) => c.text.includes("INSERT INTO shade"));
    assert.deepEqual(insert.params[9], []);
  });

  it("creates a new shade with finishes and keeps the legacy finish populated", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text) => {
      if (text.includes("FROM app_user")) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (text.includes("FROM finish_normalization")) {
        return { rows: aliasRows() };
      }
      return {
        rows: [
          {
            id: "55",
            brand: "OPI",
            name: "Prism",
            finish: "shimmer",
            finishes: ["shimmer", "holographic"],
            swatchImageUrl: null,
          },
        ],
      };
    };

    const clientCalls = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          clientCalls.push({ text, params });
          if (text.includes("SELECT brand_id FROM brand")) return { rows: [{ brand_id: 3 }] };
          if (text.includes("AS own_submitted")) return { rows: [] };
          if (text.includes("INSERT INTO shade")) return { rows: [{ shade_id: 55 }] };
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["polishes-create"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/polishes",
      headers: { authorization: "Bearer dev:1" },
      body: {
        brand: "OPI",
        name: "Prism",
        color: "Silver",
        finishes: ["Shimmer", "holo", "not-a-finish"],
        // Finish-like tags must be ignored; only the explicit `finishes` list counts.
        tags: ["finish:glitter", "jelly", "favorite"],
      },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 201);
    assert.deepEqual(res.jsonBody.finishes, ["shimmer", "holographic"]);

    const lookup = clientCalls.find((c) => c.text.includes("AS own_submitted"));
    assert.equal(lookup.params[2], "shimmer", "legacy finish key should be the primary finish");
    const insert = clientCalls.find((c) => c.text.includes("INSERT INTO shade"));
    assert.ok(insert.text.includes("finishes"));
    assert.equal(insert.params[2], "shimmer");
    assert.deepEqual(insert.params[9], ["shimmer", "holographic"]);
  });

  it("does not write finishes from request tags when creating a shade", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let aliasQueries = 0;
    queryMock = async (text) => {
      if (text.includes("FROM app_user")) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (text.includes("FROM finish_normalization")) {
        aliasQueries++;
        return { rows: aliasRows() };
      }
      return { rows: [{ id: "56", brand: "OPI", name: "Tagged", finish: "", finishes: [], swatchImageUrl: null }] };
    };

    const clientCalls = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          clientCalls.push({ text, params });
          if (text.includes("SELECT brand_id FROM brand")) return { rows: [{ brand_id: 3 }] };
          if (text.includes("AS own_submitted")) return { rows: [] };
          if (text.includes("INSERT INTO shade")) return { rows: [{ shade_id: 56 }] };
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["polishes-create"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/polishes",
      headers: { authorization: "Bearer dev:1" },
      body: { brand: "OPI", name: "Tagged", tags: ["holographic", "finish:shimmer"] },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 201);
    assert.equal(aliasQueries, 0, "tags-only request carries no finish data");
    const insert = clientCalls.find((c) => c.text.includes("INSERT INTO shade"));
    assert.deepEqual(insert.params[9], [], "shade.finishes must stay empty");
    assert.equal(insert.params[2], null, "legacy finish must not be derived from tags");
  });

  it("does not touch shade.finishes when an update only carries finish-like tags", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text) => {
      if (text.includes("FROM app_user")) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      return { rows: [{ id: "9", brand: "OPI", name: "X", finish: "creme", finishes: ["creme"] }] };
    };

    const clientCalls = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          clientCalls.push({ text, params });
          if (text.includes("INSERT INTO user_inventory_item")) return { rows: [{ inventoryItemId: "1" }] };
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["polishes-mutate"].handler;
    const req = fakeRequest({
      method: "PUT",
      url: "http://localhost:7071/api/polishes/9",
      headers: { authorization: "Bearer dev:1" },
      params: { id: "9" },
      body: { tags: ["holographic", "finish:shimmer"] },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);
    assert.ok(
      !clientCalls.some((c) => /SET finishes|finishes = ARRAY/.test(c.text)),
      "no shade.finishes write expected"
    );
    // The user's own inventory tags are still saved.
    const inv = clientCalls.find((c) => c.text.includes("INSERT INTO user_inventory_item"));
    assert.ok(inv.params.some((p) => Array.isArray(p) && p.includes("holographic")));
  });

  it("replaces finishes on the caller's own submitted shade when only finishes are updated", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text) => {
      if (text.includes("FROM app_user")) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (text.includes("FROM finish_normalization")) {
        return { rows: aliasRows() };
      }
      return {
        rows: [{ id: "9", ownSubmitted: true, brand: "OPI", name: "X", finish: "creme", finishes: ["creme", "shimmer"] }],
      };
    };

    const clientCalls = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          clientCalls.push({ text, params });
          if (text.includes("INSERT INTO user_inventory_item")) return { rows: [{ inventoryItemId: "1" }] };
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["polishes-mutate"].handler;
    const req = fakeRequest({
      method: "PUT",
      url: "http://localhost:7071/api/polishes/9",
      headers: { authorization: "Bearer dev:1" },
      params: { id: "9" },
      body: { finishes: ["cream", "shimmer"] },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);

    const replace = clientCalls.find((c) => c.text.includes("SET finishes = $2::text[]"));
    assert.ok(replace, "should replace shade.finishes");
    assert.equal(replace.params[0], 9);
    assert.deepEqual(replace.params[1], ["creme", "shimmer"]);
  });

  it("never writes finishes or colors on an existing shared shade (catalog write rule, #224)", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text) => {
      if (text.includes("FROM app_user")) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (text.includes("FROM finish_normalization")) {
        return { rows: aliasRows() };
      }
      // getVisibleShade on an active catalog shade: ownSubmitted false.
      return { rows: [{ id: "9", ownSubmitted: false, brand: "OPI", name: "X", finish: "creme", finishes: [] }] };
    };

    const clientCalls = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          clientCalls.push({ text, params });
          if (text.includes("INSERT INTO user_inventory_item")) return { rows: [{ inventoryItemId: "1" }] };
          return { rows: [] };
        },
      });

    for (const [route, method, extra] of [
      ["polishes-mutate", "PUT", {}],
      ["polishes-create", "POST", { shadeId: "9" }],
    ]) {
      const handler = registeredRoutes[route].handler;
      const req = fakeRequest({
        method,
        url: method === "PUT" ? "http://localhost:7071/api/polishes/9" : "http://localhost:7071/api/polishes",
        headers: { authorization: "Bearer dev:1" },
        params: method === "PUT" ? { id: "9" } : {},
        body: { ...extra, finishes: ["glitter"], vendorHex: "#000000", detectedHex: "#000000", color: "Black", quantity: 1 },
      });
      const res = await handler(req, fakeContext());
      assert.ok(res.status < 300, `${method} failed: ${res.status}`);
    }

    assert.deepEqual(
      clientCalls.filter((c) => /UPDATE\s+shade\b/i.test(c.text)).map((c) => c.text),
      [],
      "an existing shared shade must not be written"
    );
    assert.equal(clientCalls.filter((c) => c.text.includes("INSERT INTO user_inventory_item")).length, 2);
  });

  it("does not touch finishes when the update carries no finish data", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let aliasQueries = 0;
    queryMock = async (text) => {
      if (text.includes("FROM app_user")) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (text.includes("FROM finish_normalization")) {
        aliasQueries++;
        return { rows: aliasRows() };
      }
      return { rows: [{ id: "9", brand: "OPI", name: "X", finish: "creme", finishes: ["creme"] }] };
    };

    const clientCalls = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          clientCalls.push({ text, params });
          if (text.includes("INSERT INTO user_inventory_item")) return { rows: [{ inventoryItemId: "1" }] };
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["polishes-mutate"].handler;
    const req = fakeRequest({
      method: "PUT",
      url: "http://localhost:7071/api/polishes/9",
      headers: { authorization: "Bearer dev:1" },
      params: { id: "9" },
      body: { quantity: 3 },
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);
    assert.equal(aliasQueries, 0);
    assert.ok(!clientCalls.some((c) => c.text.includes("finishes")));
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
  // voice-process requires auth; authenticate as dev user 1 for validation tests.
  const authenticateAsDevUser = () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({
      rows: [{ user_id: 1, external_id: "dev-user-1", email: null, role: "user" }],
    });
  };

  it("returns 401 without an Authorization header", async () => {
    authenticateAsDevUser();
    const handler = registeredRoutes["voice-process"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/voice",
      contentType: "audio/wav",
    });
    req.arrayBuffer = async () => new ArrayBuffer(1024);
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 401);
  });

  it("returns 400 for non-audio content type", async () => {
    authenticateAsDevUser();
    const handler = registeredRoutes["voice-process"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/voice",
      headers: { authorization: "Bearer dev:1" },
      contentType: "application/json",
    });
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
    assert.ok(res.jsonBody.error.toLowerCase().includes("content type"));
  });

  it("returns 400 for empty audio body", async () => {
    authenticateAsDevUser();
    const handler = registeredRoutes["voice-process"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/voice",
      headers: { authorization: "Bearer dev:1" },
      contentType: "audio/wav",
    });
    req.arrayBuffer = async () => new ArrayBuffer(0);
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 400);
    assert.ok(res.jsonBody.error.toLowerCase().includes("no audio"));
  });

  it("accepts multipart/form-data content type", async () => {
    authenticateAsDevUser();
    const handler = registeredRoutes["voice-process"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/voice",
      headers: { authorization: "Bearer dev:1" },
      contentType: "multipart/form-data; boundary=---",
    });
    req.arrayBuffer = async () => new ArrayBuffer(1024);
    const res = await handler(req, fakeContext());
    assert.equal(res.status, 200);
  });

  it("returns stub response for valid audio", async () => {
    authenticateAsDevUser();
    const handler = registeredRoutes["voice-process"].handler;
    const req = fakeRequest({
      method: "POST",
      url: "http://localhost:7071/api/voice",
      headers: { authorization: "Bearer dev:1" },
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

  it("strips EXIF from data URL frames before checksum, storage, and AI", async () => {
    process.env.AUTH_DEV_BYPASS = "true";

    // Simulate metadata stripping: client sends bytes "abcdef", stripped to "abc".
    const strippedBytes = Buffer.from("abc");
    const stripCalls = [];
    stripImageMetadataMock = async (bytes) => {
      stripCalls.push(Buffer.from(bytes));
      return strippedBytes;
    };
    // Capture the payload forwarded to OCR to assert it is the stripped data URL.
    const ocrInputs = [];
    extractTextFromImageMock = async (input) => {
      ocrInputs.push(input);
      return null;
    };

    let callCount = 0;
    const imageInsertParams = [];
    const frameInsertParams = [];
    queryMock = async (text) => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      }
      if (callCount === 2) {
        return { rows: [{ id: 10, captureId: "11111111-1111-4111-8111-111111111111", status: "processing", topConfidence: null, acceptedEntityType: null, acceptedEntityId: null, metadata: null }] };
      }
      if (text && text.includes("capture_frame") && text.includes("ORDER BY created_at")) {
        return { rows: [] };
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
            return { rows: [{ frameId: "950" }] };
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
          // base64 of "abcdef" — 6 raw bytes, stripped down to 3.
          imageBlobUrl: "data:image/png;base64,YWJjZGVm",
        },
      }),
      fakeContext()
    );

    assert.equal(res.status, 201);
    // Strip ran on the raw decoded bytes.
    assert.equal(stripCalls.length, 1);
    assert.equal(stripCalls[0].toString(), "abcdef");

    // Checksum + byteSize reflect the STRIPPED bytes, not the original upload.
    const crypto = require("node:crypto");
    const expectedChecksum = crypto.createHash("sha256").update(strippedBytes).digest("hex");
    assert.equal(imageInsertParams[0][2], expectedChecksum);
    assert.equal(frameInsertParams[0][3].ingestion.byteSize, 3);
    assert.equal(frameInsertParams[0][3].ingestion.exifStripped, true);
    assert.ok(imageInsertParams[0][1].endsWith(`${expectedChecksum}.png`));

    // OCR received the stripped payload, never the original EXIF-bearing bytes.
    assert.equal(ocrInputs.length, 1);
    assert.equal(ocrInputs[0], `data:image/png;base64,${strippedBytes.toString("base64")}`);
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

  it("rejects unsupported data URL image mime types", async () => {
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
          imageBlobUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        },
      }),
      fakeContext()
    );

    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /Unsupported image type/i);
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
          if (text.includes("s.created_by_user_id")) return { rows: [{ "?column?": 1 }] }; // shade visible to caller
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
          if (text.includes("s.created_by_user_id")) return { rows: [{ "?column?": 1 }] }; // shade visible to caller
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
          if (text.includes("s.created_by_user_id")) return { rows: [{ "?column?": 1 }] }; // shade visible to caller
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
          if (text.includes("s.created_by_user_id")) return { rows: [{ "?column?": 1 }] }; // shade visible to caller
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

// ═══════════════════════════════════════════════════════════════════════════
// functions/capture — addCaptureFrame AI extraction (OCR + LLM pipeline)
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/capture — addCaptureFrame AI extraction", () => {
  it("persists merged quality_json.extracted and quality_json.ai when OCR + LLM succeed", async () => {
    process.env.AUTH_DEV_BYPASS = "true";

    extractTextFromImageMock = async () => ({
      rawText: "OPI\nBig Apple Red",
      lines: [
        { text: "OPI", confidence: 0.99 },
        { text: "Big Apple Red", confidence: 0.97 },
      ],
      barcodes: [],
      confidence: 0.98,
      provider: "azure-document-intelligence",
    });

    parseLabelTextMock = async () => ({
      brand: "OPI",
      shadeName: "Big Apple Red",
      finish: "creme",
      collection: null,
      gtin: null,
      sizeMl: null,
      confidence: 0.92,
      rawFields: {},
    });

    let callCount = 0;
    queryMock = async (text) => {
      callCount++;
      if (callCount === 1) return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      if (callCount === 2) return { rows: [{ id: 10, captureId: "22222222-2222-4222-8222-222222222222", status: "processing", topConfidence: null, acceptedEntityType: null, acceptedEntityId: null, metadata: null }] };
      // getCaptureFrameEvidence
      if (text && text.includes("capture_frame") && text.includes("ORDER BY created_at")) return { rows: [] };
      return { rows: [] };
    };

    const frameInsertParams = [];
    const sessionUpdateParams = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          if (text.includes("INSERT INTO image_asset")) return { rows: [{ imageId: "500" }] };
          if (text.includes("INSERT INTO capture_frame")) {
            frameInsertParams.push(params);
            return { rows: [{ frameId: "999" }] };
          }
          if (text.includes("UPDATE capture_session")) {
            sessionUpdateParams.push(params);
          }
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["capture-frame"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/22222222-2222-4222-8222-222222222222/frame",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "22222222-2222-4222-8222-222222222222" },
        body: {
          frameType: "label",
          imageBlobUrl: "https://blob.example/label.png",
        },
      }),
      fakeContext()
    );

    assert.equal(res.status, 201);
    assert.ok(frameInsertParams.length > 0, "frame should be inserted");

    const qualityJson = frameInsertParams[0][3];
    assert.ok(qualityJson, "quality_json should be present");
    assert.equal(qualityJson.extracted?.brand, "OPI");
    assert.equal(qualityJson.extracted?.shadeName, "Big Apple Red");
    assert.ok(qualityJson.ai, "quality_json.ai should be present");
    assert.equal(qualityJson.ai.ocrRawText, "OPI\nBig Apple Red");
    assert.ok(typeof qualityJson.ai.ocrConfidence === "number");
    assert.ok(qualityJson.ai.processedAt);

    const metadataPatch = sessionUpdateParams[0]?.[1];
    assert.ok(metadataPatch);
    assert.equal(metadataPatch.pipeline.ingest.lastExtractionSource, "pipeline");
  });

  it("truncates ocrRawText that exceeds MAX_CAPTURE_AI_RAW_TEXT_CHARS", async () => {
    process.env.AUTH_DEV_BYPASS = "true";

    const longRawText = "A".repeat(5000);
    extractTextFromImageMock = async () => ({
      rawText: longRawText,
      lines: [],
      // Include a barcode so extracted is non-empty and runFrameAiExtraction doesn't short-circuit
      barcodes: [{ value: "012345678901", kind: "EAN_13", confidence: 0.97 }],
      confidence: 0.5,
      provider: "azure-document-intelligence",
    });
    parseLabelTextMock = async () => null;

    let callCount = 0;
    queryMock = async (text) => {
      callCount++;
      if (callCount === 1) return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      if (callCount === 2) return { rows: [{ id: 10, captureId: "33333333-3333-4333-8333-333333333333", status: "processing", topConfidence: null, acceptedEntityType: null, acceptedEntityId: null, metadata: null }] };
      if (text && text.includes("capture_frame") && text.includes("ORDER BY created_at")) return { rows: [] };
      return { rows: [] };
    };

    const frameInsertParams = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          if (text.includes("INSERT INTO image_asset")) return { rows: [{ imageId: "501" }] };
          if (text.includes("INSERT INTO capture_frame")) {
            frameInsertParams.push(params);
            return { rows: [{ frameId: "1000" }] };
          }
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["capture-frame"].handler;
    await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/33333333-3333-4333-8333-333333333333/frame",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "33333333-3333-4333-8333-333333333333" },
        body: { frameType: "label", imageBlobUrl: "https://blob.example/label.png" },
      }),
      fakeContext()
    );

    const qualityJson = frameInsertParams[0]?.[3];
    assert.ok(qualityJson?.ai?.ocrRawText, "ocrRawText should be present");
    assert.ok(
      // MAX_CAPTURE_AI_RAW_TEXT_CHARS = 2000 in capture.ts; +1 for the "…" ellipsis character
      qualityJson.ai.ocrRawText.length <= 2001,
      `ocrRawText should be truncated, got length ${qualityJson.ai.ocrRawText.length}`
    );
    assert.ok(qualityJson.ai.ocrRawText.endsWith("…"), "truncated text should end with ellipsis");
  });

  it("skips AI extraction gracefully when OCR returns null", async () => {
    process.env.AUTH_DEV_BYPASS = "true";

    // Both mocks return null (no DI/OpenAI configured)
    extractTextFromImageMock = async () => null;
    parseLabelTextMock = async () => null;

    let callCount = 0;
    queryMock = async () => {
      callCount++;
      if (callCount === 1) return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      if (callCount === 2) return { rows: [{ id: 10, captureId: "44444444-4444-4444-8444-444444444444", status: "processing", topConfidence: null, acceptedEntityType: null, acceptedEntityId: null, metadata: null }] };
      return { rows: [] };
    };

    const frameInsertParams = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          if (text.includes("INSERT INTO image_asset")) return { rows: [{ imageId: "502" }] };
          if (text.includes("INSERT INTO capture_frame")) {
            frameInsertParams.push(params);
            return { rows: [{ frameId: "1001" }] };
          }
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["capture-frame"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/44444444-4444-4444-8444-444444444444/frame",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "44444444-4444-4444-8444-444444444444" },
        body: { frameType: "label", imageBlobUrl: "https://blob.example/label.png" },
      }),
      fakeContext()
    );

    assert.equal(res.status, 201);
    // quality_json.ai should not be set when OCR returned null
    const qualityJson = frameInsertParams[0]?.[3];
    assert.equal(qualityJson?.ai, undefined);
  });

  it("extracts GTIN from OCR barcode and includes in quality_json.extracted", async () => {
    process.env.AUTH_DEV_BYPASS = "true";

    extractTextFromImageMock = async () => ({
      rawText: "",
      lines: [],
      barcodes: [
        { value: "012345678901", kind: "EAN_13", confidence: 0.97 },
      ],
      confidence: 0,
      provider: "azure-document-intelligence",
    });
    parseLabelTextMock = async () => null;

    let callCount = 0;
    queryMock = async (text) => {
      callCount++;
      if (callCount === 1) return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      if (callCount === 2) return { rows: [{ id: 10, captureId: "55555555-5555-4555-8555-555555555555", status: "processing", topConfidence: null, acceptedEntityType: null, acceptedEntityId: null, metadata: null }] };
      if (text && text.includes("capture_frame") && text.includes("ORDER BY created_at")) return { rows: [] };
      return { rows: [] };
    };

    const frameInsertParams = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          if (text.includes("INSERT INTO image_asset")) return { rows: [{ imageId: "503" }] };
          if (text.includes("INSERT INTO capture_frame")) {
            frameInsertParams.push(params);
            return { rows: [{ frameId: "1002" }] };
          }
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["capture-frame"].handler;
    await handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/capture/55555555-5555-4555-8555-555555555555/frame",
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: "55555555-5555-4555-8555-555555555555" },
        body: { frameType: "barcode", imageBlobUrl: "https://blob.example/barcode.png" },
      }),
      fakeContext()
    );

    const qualityJson = frameInsertParams[0]?.[3];
    assert.equal(qualityJson?.extracted?.gtin, "012345678901");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// functions/capture — answerCaptureQuestion re-resolve flow
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/capture — answerCaptureQuestion re-resolve flow", () => {
  const CAPTURE_ID = "66666666-6666-4666-8666-666666666666";
  const SESSION_ID = 20;

  function makeSessionRow(status = "processing") {
    return { id: SESSION_ID, captureId: CAPTURE_ID, status, topConfidence: null, acceptedEntityType: null, acceptedEntityId: null, metadata: null };
  }

  function makeQuestionRow() {
    return { id: "q-1", key: "brand_shade", prompt: "What brand and shade?", type: "text", options: null, status: "open", createdAt: new Date().toISOString() };
  }

  it("re-resolves to 'matched' after brand_shade answer and session becomes matched", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;

    queryMock = async (text) => {
      callCount++;
      // auth
      if (callCount === 1) return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      // getCaptureSession (first call)
      if (callCount === 2) return { rows: [makeSessionRow("processing")] };
      // getOpenQuestion
      if (text && text.includes("capture_question") && text.includes("open")) return { rows: [makeQuestionRow()] };
      // getCaptureSession (refresh after answer)
      if (callCount === 4) return { rows: [makeSessionRow("processing")] };
      // getCaptureFrameEvidence (for re-resolve)
      if (text && text.includes("capture_frame") && text.includes("ORDER BY created_at")) {
        return { rows: [{ frameType: "label", quality: { extracted: { brand: "OPI", shadeName: "Big Apple Red", source: "pipeline" } } }] };
      }
      // resolveShadeCandidates — return a high-confidence match
      if (text && text.includes("similarity")) {
        return { rows: [{ shadeId: "100", brand: "OPI", shadeName: "Big Apple Red", score: 0.97 }] };
      }
      // getOpenQuestion after re-resolve
      return { rows: [] };
    };

    const captureSessionUpdateParams = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          if (text.includes("UPDATE capture_session")) captureSessionUpdateParams.push({ text, params });
          // addToInventoryFromMatch: shade visible to the caller
          if (text.includes("s.created_by_user_id")) return { rows: [{ "?column?": 1 }] };
          // addToInventoryFromMatch: check existing → no results
          if (text.includes("SELECT inventory_item_id")) return { rows: [] };
          // addToInventoryFromMatch: insert new item → return id
          if (text.includes("INSERT INTO user_inventory_item")) return { rows: [{ id: 777 }] };
          // expire open questions
          if (text.includes("UPDATE capture_question")) return { rows: [] };
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["capture-answer"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: `http://localhost:7071/api/capture/${CAPTURE_ID}/answer`,
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: CAPTURE_ID },
        body: { answer: { brand: "OPI", shadeName: "Big Apple Red" }, questionKey: "brand_shade" },
      }),
      fakeContext()
    );

    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "matched");
  });

  it("re-resolves to 'needs_question' when resolver asks a follow-up", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;

    queryMock = async (text) => {
      callCount++;
      if (callCount === 1) return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      if (callCount === 2) return { rows: [makeSessionRow("processing")] };
      if (text && text.includes("capture_question") && text.includes("open") && callCount === 3) return { rows: [makeQuestionRow()] };
      // getCaptureSession (refresh)
      if (callCount === 4) return { rows: [makeSessionRow("processing")] };
      // getCaptureFrameEvidence — no evidence so resolver asks for brand/shade
      if (text && text.includes("capture_frame") && text.includes("ORDER BY created_at")) return { rows: [] };
      // resolveShadeCandidates — no results
      if (text && text.includes("similarity")) return { rows: [] };
      // getOpenQuestion after re-resolve (new question inserted)
      if (text && text.includes("capture_question") && text.includes("open")) {
        return { rows: [{ id: "q-2", key: "brand_shade", prompt: "Which brand and shade?", type: "text", options: null, status: "open", createdAt: new Date().toISOString() }] };
      }
      return { rows: [] };
    };

    transactionMock = async (cb) =>
      cb({
        query: async () => ({ rows: [] }),
      });

    const handler = registeredRoutes["capture-answer"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: `http://localhost:7071/api/capture/${CAPTURE_ID}/answer`,
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: CAPTURE_ID },
        body: { answer: { brand: "OPI", shadeName: "" }, questionKey: "brand_shade" },
      }),
      fakeContext()
    );

    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "needs_question");
  });

  it("re-resolves to 'unmatched' when resolver finds no match", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    let callCount = 0;

    queryMock = async (text) => {
      callCount++;
      if (callCount === 1) return { rows: [{ user_id: 1, external_id: "ext-1", email: null }] };
      if (callCount === 2) return { rows: [makeSessionRow("processing")] };
      if (text && text.includes("capture_question") && text.includes("open") && callCount === 3) return { rows: [makeQuestionRow()] };
      if (callCount === 4) return { rows: [makeSessionRow("processing")] };
      if (text && text.includes("capture_frame") && text.includes("ORDER BY created_at")) {
        // Evidence exists (brand + shadeName)
        return { rows: [{ frameType: "label", quality: { extracted: { brand: "XYZ", shadeName: "No Match", source: "pipeline" } } }] };
      }
      // Shade search returns low-confidence candidates — falls through to unmatched
      if (text && text.includes("similarity")) {
        return { rows: [{ shadeId: "200", brand: "XYZ", shadeName: "No Match", score: 0.3 }] };
      }
      return { rows: [] };
    };

    const captureSessionUpdateParams = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          if (text.includes("UPDATE capture_session")) captureSessionUpdateParams.push({ text, params });
          return { rows: [] };
        },
      });

    const handler = registeredRoutes["capture-answer"].handler;
    const res = await handler(
      fakeRequest({
        method: "POST",
        url: `http://localhost:7071/api/capture/${CAPTURE_ID}/answer`,
        headers: { authorization: "Bearer dev:1" },
        params: { captureId: CAPTURE_ID },
        body: { answer: { brand: "XYZ", shadeName: "No Match" }, questionKey: "brand_shade" },
      }),
      fakeContext()
    );

    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "unmatched");

    const unmatchedUpdate = captureSessionUpdateParams.find((p) => p.text.includes("'unmatched'") || (p.params && Array.isArray(p.params) && p.params.includes("unmatched")));
    assert.ok(unmatchedUpdate, "capture_session should be updated to unmatched");
  });
});
