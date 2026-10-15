/**
 * Unit tests for the AUTH_DEV_BYPASS hosted-in-Azure guard (issue #47, F4).
 *
 * - lib/runtime-env: hosted detection (Azure App Service markers vs. Core Tools localhost) and
 *   the dev-bypass gate.
 * - lib/auth authenticateRequest: `Bearer dev:<id>` works locally but is refused (and never
 *   reaches the DB) when hosted, even with AUTH_DEV_BYPASS=true.
 * - lib/image-proxy: the ephemeral signing key is not generated when hosted.
 */
const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const mockModules = {};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) return key;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

let dbQueries = [];
mockModules["./db"] = {
  query: async (sql, params) => {
    dbQueries.push({ sql, params });
    return {
      rows: [{ user_id: 1, external_id: "ext-1", email: "u@test.dev", role: "admin" }],
    };
  },
  transaction: async () => {
    throw new Error("transaction should not be used by dev bypass");
  },
};
mockModules["jose"] = {
  createRemoteJWKSet: () => () => {},
  jwtVerify: async () => {
    throw new Error("invalid JWT");
  },
};
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const runtimeEnv = require("../dist/lib/runtime-env");
const auth = require("../dist/lib/auth");
const imageProxy = require("../dist/lib/image-proxy");

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) delete require.cache[id];
});

const ENV_KEYS = [
  "AUTH_DEV_BYPASS",
  "WEBSITE_INSTANCE_ID",
  "WEBSITE_SITE_NAME",
  "WEBSITE_HOSTNAME",
  "AZURE_AD_B2C_TENANT",
  "AZURE_AD_B2C_CLIENT_ID",
  "IMAGE_PROXY_SIGNING_KEY",
];
let saved = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dbQueries = [];
  runtimeEnv.resetRuntimeEnvStateForTests();
  imageProxy.resetImageProxySigningStateForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const request = (token) => ({
  headers: { get: (n) => (n.toLowerCase() === "authorization" ? `Bearer ${token}` : null) },
});
const context = { log: () => {}, warn: () => {}, error: () => {} };

describe("lib/runtime-env — isHostedInAzure", () => {
  it("is false with no Azure markers", () => {
    assert.equal(runtimeEnv.isHostedInAzure({}), false);
  });

  it("is true when WEBSITE_INSTANCE_ID is set", () => {
    assert.equal(runtimeEnv.isHostedInAzure({ WEBSITE_INSTANCE_ID: "abc123" }), true);
  });

  it("ignores blank markers", () => {
    assert.equal(runtimeEnv.isHostedInAzure({ WEBSITE_INSTANCE_ID: "  ", WEBSITE_HOSTNAME: " " }), false);
  });

  it("is true for a non-local WEBSITE_HOSTNAME", () => {
    assert.equal(runtimeEnv.isHostedInAzure({ WEBSITE_HOSTNAME: "swatch-dev.azurewebsites.net" }), true);
  });

  for (const host of ["localhost:7071", "localhost", "127.0.0.1:7071", "[::1]:7071", "LOCALHOST:7071"]) {
    it(`treats WEBSITE_HOSTNAME=${host} (Core Tools) as local`, () => {
      assert.equal(runtimeEnv.isHostedInAzure({ WEBSITE_HOSTNAME: host }), false);
    });
  }
});

describe("lib/runtime-env — isDevBypassEnabled", () => {
  it("requires AUTH_DEV_BYPASS=true", () => {
    assert.equal(runtimeEnv.isDevBypassEnabled({}), false);
    assert.equal(runtimeEnv.isDevBypassEnabled({ AUTH_DEV_BYPASS: "false" }), false);
    assert.equal(runtimeEnv.isDevBypassEnabled({ AUTH_DEV_BYPASS: "TRUE" }), false);
    assert.equal(runtimeEnv.isDevBypassEnabled({ AUTH_DEV_BYPASS: "true" }), true);
  });

  it("works under Core Tools (localhost WEBSITE_HOSTNAME)", () => {
    assert.equal(
      runtimeEnv.isDevBypassEnabled({ AUTH_DEV_BYPASS: "true", WEBSITE_HOSTNAME: "localhost:7071" }),
      true
    );
  });

  it("is refused when hosted, with no override", () => {
    assert.equal(
      runtimeEnv.isDevBypassEnabled({ AUTH_DEV_BYPASS: "true", WEBSITE_INSTANCE_ID: "x" }),
      false
    );
    assert.equal(
      runtimeEnv.isDevBypassEnabled({ AUTH_DEV_BYPASS: "true", WEBSITE_HOSTNAME: "a.azurewebsites.net" }),
      false
    );
  });
});

describe("lib/auth — dev bypass guard", () => {
  it("accepts dev tokens locally", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const result = await auth.authenticateRequest(request("dev:1"), context);
    assert.equal(result.userId, 1);
    assert.equal(dbQueries.length, 1);
  });

  it("accepts dev tokens under Core Tools (WEBSITE_HOSTNAME=localhost:7071)", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    process.env.WEBSITE_HOSTNAME = "localhost:7071";
    const result = await auth.authenticateRequest(request("dev:1"), context);
    assert.equal(result.userId, 1);
  });

  for (const [label, key, value] of [
    ["WEBSITE_INSTANCE_ID", "WEBSITE_INSTANCE_ID", "instance-1"],
    ["a hosted WEBSITE_HOSTNAME", "WEBSITE_HOSTNAME", "swatch-prod.azurewebsites.net"],
  ]) {
    it(`refuses dev tokens when hosted (${label}) and never queries the DB`, async (t) => {
      const err = t.mock.method(console, "error", () => {});
      process.env.AUTH_DEV_BYPASS = "true";
      process.env[key] = value;
      await assert.rejects(auth.authenticateRequest(request("dev:1"), context), auth.AuthError);
      await assert.rejects(auth.authenticateRequest(request("dev:99"), context), auth.AuthError);
      assert.deepEqual(dbQueries, []);
      assert.equal(err.mock.callCount(), 1, "refusal is logged once per process");
    });
  }

  it("does not log a refusal when the bypass flag is off", async (t) => {
    const err = t.mock.method(console, "error", () => {});
    process.env.WEBSITE_INSTANCE_ID = "instance-1";
    await assert.rejects(auth.authenticateRequest(request("dev:1"), context), auth.AuthError);
    assert.equal(err.mock.callCount(), 0);
  });
});

describe("lib/image-proxy — ephemeral key guard", () => {
  const URL_ = "https://swatchtest.blob.core.windows.net/source-images/a.png";

  it("uses the ephemeral key locally", (t) => {
    t.mock.method(console, "warn", () => {});
    process.env.AUTH_DEV_BYPASS = "true";
    assert.ok(imageProxy.encodeImageProxyId(URL_));
  });

  it("refuses the ephemeral key when hosted", () => {
    process.env.AUTH_DEV_BYPASS = "true";
    process.env.WEBSITE_INSTANCE_ID = "instance-1";
    assert.throws(() => imageProxy.encodeImageProxyId(URL_), imageProxy.ImageProxyConfigError);
  });
});
