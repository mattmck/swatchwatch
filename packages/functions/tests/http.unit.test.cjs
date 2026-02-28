const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// Mock @azure/functions before loading the module
// ---------------------------------------------------------------------------

const mockModules = {};
function registerMock(id, exports) {
  mockModules[id] = exports;
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) {
      return key;
    }
  }
  return originalResolve.call(this, request, parent, ...rest);
};

registerMock("@azure/functions", {
  app: { http: () => {} },
});

for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fakeRequest({ method = "GET", headers = {} } = {}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) {
    headerMap.set(k.toLowerCase(), v);
  }
  return {
    method,
    headers: {
      get: (name) => headerMap.get(name.toLowerCase()) || null,
    },
  };
}

function fakeContext() {
  return { log: () => {} };
}

// Store original env values to restore after tests
const originalEnv = {};

describe("lib/http — withCors", () => {
  let httpModule;

  beforeEach(() => {
    // Clear module cache to re-read env vars
    const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
    delete require.cache[modulePath];

    // Store and clear env
    originalEnv.CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS;
    originalEnv.CORS_ALLOWED_HEADERS = process.env.CORS_ALLOWED_HEADERS;
    originalEnv.CORS_ALLOWED_METHODS = process.env.CORS_ALLOWED_METHODS;
    originalEnv.CORS_SUPPORT_CREDENTIALS = process.env.CORS_SUPPORT_CREDENTIALS;
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_ALLOWED_HEADERS;
    delete process.env.CORS_ALLOWED_METHODS;
    delete process.env.CORS_SUPPORT_CREDENTIALS;
  });

  afterEach(() => {
    // Restore original env
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe("OPTIONS preflight requests", () => {
    it("returns 204 with CORS headers for allowed origin", async () => {
      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 200,
        jsonBody: { ok: true },
      }));

      const req = fakeRequest({
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.status, 204);
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "http://localhost:3000");
      assert.ok(res.headers.get("Access-Control-Allow-Headers"));
      assert.ok(res.headers.get("Access-Control-Allow-Methods"));
    });

    it("returns 204 without CORS headers for disallowed origin", async () => {
      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 200,
        jsonBody: { ok: true },
      }));

      const req = fakeRequest({
        method: "OPTIONS",
        headers: { origin: "http://malicious-site.com" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.status, 204);
      assert.equal(res.headers, undefined);
    });

    it("returns 204 without CORS headers when no origin header", async () => {
      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 200,
        jsonBody: { ok: true },
      }));

      const req = fakeRequest({ method: "OPTIONS" });
      const res = await handler(req, fakeContext());
      assert.equal(res.status, 204);
      assert.equal(res.headers, undefined);
    });
  });

  describe("regular requests with allowed origins", () => {
    it("adds CORS headers for localhost:3000 (default allowed)", async () => {
      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 200,
        jsonBody: { message: "hello" },
      }));

      const req = fakeRequest({
        method: "GET",
        headers: { origin: "http://localhost:3000" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "http://localhost:3000");
      assert.equal(res.headers.get("Vary"), "Origin");
    });

    it("adds CORS headers for Azure Static Web Apps wildcard pattern", async () => {
      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 200,
        jsonBody: { ok: true },
      }));

      const req = fakeRequest({
        method: "GET",
        headers: { origin: "https://my-app.azurestaticapps.net" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://my-app.azurestaticapps.net");
    });

    it("does not add CORS headers for disallowed origin", async () => {
      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 200,
        jsonBody: { secret: "data" },
      }));

      const req = fakeRequest({
        method: "GET",
        headers: { origin: "http://evil.com" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.status, 200);
      assert.deepEqual(res.jsonBody, { secret: "data" });
      // Response should not have CORS headers added
      assert.equal(res.headers, undefined);
    });
  });

  describe("custom CORS configuration via env vars", () => {
    it("uses CORS_ALLOWED_ORIGINS env var", async () => {
      process.env.CORS_ALLOWED_ORIGINS = "https://custom-origin.com,https://another.com";

      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      delete require.cache[modulePath];
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 200,
        jsonBody: { ok: true },
      }));

      // Should allow custom-origin.com
      const req1 = fakeRequest({
        method: "GET",
        headers: { origin: "https://custom-origin.com" },
      });
      const res1 = await handler(req1, fakeContext());
      assert.equal(res1.headers.get("Access-Control-Allow-Origin"), "https://custom-origin.com");

      // Should NOT allow localhost:3000 anymore (overridden defaults)
      const req2 = fakeRequest({
        method: "GET",
        headers: { origin: "http://localhost:3000" },
      });
      const res2 = await handler(req2, fakeContext());
      assert.equal(res2.headers, undefined);
    });

    it("uses wildcard origin when configured", async () => {
      process.env.CORS_ALLOWED_ORIGINS = "*";

      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      delete require.cache[modulePath];
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 200,
        jsonBody: { ok: true },
      }));

      const req = fakeRequest({
        method: "GET",
        headers: { origin: "http://any-origin.com" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    });

    it("uses CORS_ALLOWED_HEADERS env var", async () => {
      process.env.CORS_ALLOWED_HEADERS = "X-Custom-Header, X-Another";

      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      delete require.cache[modulePath];
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 200,
        jsonBody: { ok: true },
      }));

      const req = fakeRequest({
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.headers.get("Access-Control-Allow-Headers"), "X-Custom-Header, X-Another");
    });

    it("uses CORS_ALLOWED_METHODS env var", async () => {
      process.env.CORS_ALLOWED_METHODS = "GET,POST";

      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      delete require.cache[modulePath];
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 200,
        jsonBody: { ok: true },
      }));

      const req = fakeRequest({
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.headers.get("Access-Control-Allow-Methods"), "GET,POST");
    });

    it("adds credentials header when CORS_SUPPORT_CREDENTIALS is true", async () => {
      process.env.CORS_SUPPORT_CREDENTIALS = "true";

      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      delete require.cache[modulePath];
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 200,
        jsonBody: { ok: true },
      }));

      const req = fakeRequest({
        method: "GET",
        headers: { origin: "http://localhost:3000" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.headers.get("Access-Control-Allow-Credentials"), "true");
    });

    it("does not add credentials header for wildcard origin", async () => {
      process.env.CORS_ALLOWED_ORIGINS = "*";
      process.env.CORS_SUPPORT_CREDENTIALS = "true";

      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      delete require.cache[modulePath];
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 200,
        jsonBody: { ok: true },
      }));

      const req = fakeRequest({
        method: "GET",
        headers: { origin: "http://any-site.com" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
      assert.equal(res.headers.get("Access-Control-Allow-Credentials"), null);
    });
  });

  describe("response passthrough", () => {
    it("preserves existing response headers", async () => {
      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      httpModule = require(modulePath);

      const existingHeaders = new Headers();
      existingHeaders.set("X-Custom", "value");
      existingHeaders.set("Content-Type", "application/json");

      const handler = httpModule.withCors(async () => ({
        status: 200,
        headers: existingHeaders,
        jsonBody: { ok: true },
      }));

      const req = fakeRequest({
        method: "GET",
        headers: { origin: "http://localhost:3000" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.headers.get("X-Custom"), "value");
      assert.equal(res.headers.get("Content-Type"), "application/json");
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "http://localhost:3000");
    });

    it("passes through response body and status", async () => {
      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 201,
        jsonBody: { id: 42, created: true },
      }));

      const req = fakeRequest({
        method: "POST",
        headers: { origin: "http://localhost:3000" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.status, 201);
      assert.deepEqual(res.jsonBody, { id: 42, created: true });
    });

    it("handles error responses", async () => {
      const modulePath = path.resolve(__dirname, "../dist/lib/http.js");
      httpModule = require(modulePath);

      const handler = httpModule.withCors(async () => ({
        status: 500,
        jsonBody: { error: "Internal server error" },
      }));

      const req = fakeRequest({
        method: "GET",
        headers: { origin: "http://localhost:3000" },
      });

      const res = await handler(req, fakeContext());
      assert.equal(res.status, 500);
      assert.deepEqual(res.jsonBody, { error: "Internal server error" });
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "http://localhost:3000");
    });
  });
});
