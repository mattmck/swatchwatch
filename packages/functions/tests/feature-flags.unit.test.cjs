/** Feature-flag registry (#313, D22): parsing, fail-closed, and the public flags endpoint. */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const routes = {};
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@azure/functions") {
    return { app: { http: (name, opts) => { routes[name] = opts; } } };
  }
  return originalLoad.call(this, request, ...rest);
};
void originalResolve;

const { FEATURE_FLAGS, isFeatureEnabled, listPublicFeatureFlags, parseFlagValue } = require("../dist/lib/feature-flags");
require("../dist/functions/config-flags");
Module._load = originalLoad;
const { FEATURE_FLAG_NAMES } = require("swatchwatch-shared");

describe("lib/feature-flags", () => {
  it("is on only for the exact value true (trimmed, any case)", () => {
    for (const raw of [undefined, "", "  ", "false", "0", "1", "yes", "on", "truee", "enabled"]) {
      assert.equal(parseFlagValue(raw), false, JSON.stringify(raw));
      assert.equal(isFeatureEnabled("shareableLooks", { SHAREABLE_LOOKS_ENABLED: raw }), false);
    }
    for (const raw of ["true", " TRUE ", "True"]) {
      assert.equal(isFeatureEnabled("shareableLooks", { SHAREABLE_LOOKS_ENABLED: raw }), true);
    }
  });

  it("keeps the batch flag's lenient spellings and no other flag's", () => {
    for (const raw of ["1", "yes", "on", "true"]) {
      assert.equal(isFeatureEnabled("hexDetectionBatch", { HEX_DETECTION_BATCH_ENABLED: raw }), true, raw);
    }
    assert.equal(isFeatureEnabled("hexDetectionSnap", { HEX_DETECTION_SNAP_ENABLED: "1" }), false);
    assert.equal(isFeatureEnabled("hexDetectionSnap", { HEX_DETECTION_SNAP_ENABLED: "true" }), true);
  });

  it("reads each flag from its own env var and defaults off", () => {
    assert.equal(isFeatureEnabled("shareableWishlist", { SHAREABLE_LOOKS_ENABLED: "true" }), false);
    for (const name of Object.keys(FEATURE_FLAGS)) assert.equal(isFeatureEnabled(name, {}), false);
  });

  it("public flags are exactly FEATURE_FLAG_NAMES and all registered as public", () => {
    for (const name of FEATURE_FLAG_NAMES) assert.equal(FEATURE_FLAGS[name].public, true);
    const publicNames = Object.keys(FEATURE_FLAGS).filter((n) => FEATURE_FLAGS[n].public).sort();
    assert.deepEqual(publicNames, [...FEATURE_FLAG_NAMES].sort());
    assert.deepEqual(listPublicFeatureFlags({ SHAREABLE_LOOKS_ENABLED: "true" }), {
      shareableWishlist: false,
      shareableLooks: true,
    });
  });
});

describe("GET /api/config/flags", () => {
  it("is anonymous, cacheable, and hides internal flags", async () => {
    const route = routes["config-flags"];
    assert.equal(route.authLevel, "anonymous");
    assert.equal(route.route, "config/flags");
    assert.ok(route.methods.includes("GET"));
    const saved = { ...process.env };
    process.env.SHAREABLE_WISHLIST_ENABLED = "true";
    process.env.HEX_DETECTION_BATCH_ENABLED = "true";
    process.env.HEX_DETECTION_SNAP_ENABLED = "true";
    try {
      const res = await route.handler({ method: "GET", headers: { get: () => null }, url: "http://x/api/config/flags" }, { log() {}, error() {} });
      assert.equal(res.status, 200);
      assert.equal(res.headers["Cache-Control"], "public, max-age=60");
      assert.deepEqual(res.jsonBody, { flags: { shareableWishlist: true, shareableLooks: false } });
      assert.doesNotMatch(JSON.stringify(res.jsonBody), /hex|ENABLED/i);
    } finally {
      process.env = saved;
    }
  });
});

describe("function registration", () => {
  it("src/index.ts re-exports the config-flags module (otherwise the route is never loaded)", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/index.ts"), "utf8");
    assert.match(src, /export \* from ['"]\.\/functions\/config-flags['"]/);
  });
});
