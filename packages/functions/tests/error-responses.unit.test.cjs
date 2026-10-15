/**
 * Error-response hardening (issue #47, F6): unexpected failures must produce a generic 500 body
 * (no `details`, no internal error text) while the full error is logged server-side and sent to
 * telemetry. Handler modules are loaded from dist/ with the DB replaced by a fake that throws a
 * Postgres-looking error for every handler query.
 */
const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

for (const name of ["WEBSITE_INSTANCE_ID", "WEBSITE_SITE_NAME", "WEBSITE_HOSTNAME", "REDIS_URL", "REDIS_KEY"]) {
  delete process.env[name];
}
process.env.IMAGE_PROXY_SIGNING_KEY = "error-responses-unit-test-signing-key-0123456789";

const SECRET = 'relation "secret_table" does not exist';
const USER_ID = 1;

const registeredRoutes = {};
const mockModules = {};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) return key;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

function registerMock(id, exports) {
  mockModules[id] = exports;
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

registerMock("@azure/functions", {
  app: { http: (name, opts) => (registeredRoutes[name] = opts), storageQueue: () => {}, timer: () => {} },
  output: { storageQueue: (opts) => ({ __type: "storageQueue", ...opts }) },
});
registerMock("jose", { createRemoteJWKSet: () => {}, jwtVerify: async () => { throw new Error("unused"); } });

const USER_ROW = { user_id: USER_ID, external_id: "ext", email: "u@test.dev", role: "user" };
async function fakeQuery(sql) {
  if (/FROM\s+app_user/i.test(String(sql)) && /WHERE\s+user_id\s*=\s*\$1/i.test(String(sql))) {
    return { rows: [USER_ROW], rowCount: 1 };
  }
  throw new Error(`${SECRET} (SQLSTATE 42P01)`);
}
const dbMock = {
  query: fakeQuery,
  transaction: async (cb) => cb({ query: fakeQuery }),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);

const tracked = [];
registerMock(path.resolve(__dirname, "../dist/lib/telemetry.js"), {
  trackEvent: () => {},
  trackMetric: () => {},
  trackException: (error, props) => tracked.push({ error, props }),
});
registerMock("../lib/telemetry", require.cache[path.resolve(__dirname, "../dist/lib/telemetry.js")].exports);

registerMock("../lib/ocr", { extractTextFromImage: async () => null });
registerMock("../lib/ocr-parser", { parseLabelText: async () => null });
registerMock("../lib/ai-color-detection", { detectHexWithAzureOpenAI: async () => null });

function fakeRequest({ method = "GET", url = "http://localhost:7071/api/test", params = {}, body } = {}) {
  const headers = new Map([["authorization", `Bearer dev:${USER_ID}`]]);
  return {
    method,
    url,
    headers: { get: (name) => headers.get(name.toLowerCase()) || null },
    params,
    query: new URL(url).searchParams,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function fakeContext() {
  const errors = [];
  return {
    invocationId: "inv-test-123",
    errors,
    log: () => {},
    warn: () => {},
    error: (...args) => errors.push(args),
    extraOutputs: { set: () => {}, get: () => undefined },
  };
}

async function invoke(routeName, request) {
  const route = registeredRoutes[routeName];
  assert.ok(route, `route ${routeName} should be registered`);
  const context = fakeContext();
  const response = await route.handler(
    fakeRequest({ method: route.methods.find((m) => m !== "OPTIONS"), ...request }),
    context
  );
  return { response, context };
}

function assertGenericServerError({ response, context }, expectedMessage) {
  assert.equal(response.status, 500);
  assert.equal(response.jsonBody.error, expectedMessage);
  assert.equal(response.jsonBody.details, undefined, "no details field");
  assert.equal(response.jsonBody.requestId, "inv-test-123");
  const serialized = JSON.stringify(response.jsonBody);
  assert.ok(!serialized.includes("secret_table"), `body leaked internal message: ${serialized}`);
  assert.ok(!serialized.includes("42P01"), "body leaked SQLSTATE");

  assert.ok(context.errors.length > 0, "context.error should be called");
  assert.ok(
    context.errors.some((args) => args.some((a) => a instanceof Error && a.message.includes("secret_table"))),
    "context.error receives the full error"
  );
  assert.ok(
    tracked.some((t) => t.error instanceof Error && t.error.message.includes("secret_table")),
    "trackException should receive the error"
  );
  assert.ok(tracked.every((t) => typeof t.props.handler === "string"));
}

describe("generic 500 responses", () => {
  before(() => {
    process.env.AUTH_DEV_BYPASS = "true";
    require("../dist/functions/polishes.js");
    require("../dist/functions/catalog.js");
    require("../dist/functions/capture.js");
    require("../dist/functions/ingestion.js");
  });
  beforeEach(() => {
    process.env.AUTH_DEV_BYPASS = "true";
    tracked.length = 0;
  });
  afterEach(() => {
    delete process.env.AUTH_DEV_BYPASS;
  });

  it("polishes list", async () => {
    assertGenericServerError(await invoke("polishes-list"), "Failed to fetch polishes");
  });

  it("polishes detail", async () => {
    assertGenericServerError(
      await invoke("polishes-list", { params: { id: "5" }, url: "http://localhost:7071/api/polishes/5" }),
      "Failed to fetch polish"
    );
  });

  it("polishes delete", async () => {
    const route = registeredRoutes["polishes-mutate"];
    assert.ok(route.methods.includes("DELETE"));
    const context = fakeContext();
    const response = await route.handler(
      fakeRequest({ method: "DELETE", params: { id: "5" }, url: "http://localhost:7071/api/polishes/5" }),
      context
    );
    assertGenericServerError({ response, context }, "Failed to delete polish");
  });

  it("catalog search", async () => {
    assertGenericServerError(
      await invoke("catalog-search", { url: "http://localhost:7071/api/catalog/search?q=ruby" }),
      "Failed to search catalog"
    );
  });

  it("catalog shade", async () => {
    assertGenericServerError(
      await invoke("catalog-shade", { params: { id: "5" }, url: "http://localhost:7071/api/catalog/shade/5" }),
      "Failed to fetch shade"
    );
  });

  it("capture start", async () => {
    assertGenericServerError(await invoke("capture-start", { body: {} }), "Failed to start capture");
  });

  it("capture status", async () => {
    assertGenericServerError(
      await invoke("capture-status", {
        params: { captureId: "11111111-1111-4111-8111-111111111111" },
      }),
      "Failed to fetch capture status"
    );
  });
});
