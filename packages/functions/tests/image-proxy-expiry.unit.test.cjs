/**
 * Unit tests for expiring image proxy ids and cache scoping (issue #47, F5).
 */
const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { createHmac } = require("node:crypto");

const mockModules = {
  "@azure/functions": { app: { http: () => {} } },
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key) return key;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const imageProxy = require("../dist/lib/image-proxy");
const images = require("../dist/functions/images");

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) delete require.cache[id];
});

const KEY = "test-image-proxy-signing-key-0123456789abcdef";
const URL_ = "https://swatchtest.blob.core.windows.net/source-images/holotaco/a.png";
const DAY = 86400;
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0); // ms

const ENV_KEYS = [
  "IMAGE_PROXY_SIGNING_KEY",
  "IMAGE_PROXY_ID_TTL_SECONDS",
  "IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL",
  "AUTH_DEV_BYPASS",
  "SOURCE_IMAGE_CONTAINER",
];
let saved = {};
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.IMAGE_PROXY_SIGNING_KEY = KEY;
  imageProxy.resetImageProxySigningStateForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const b64u = (v) =>
  Buffer.from(v).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const legacyId = (url, key = KEY) =>
  `${b64u(url)}.${b64u(createHmac("sha256", key).update("swatchwatch:image-proxy:v1:" + url).digest())}`;

describe("image proxy v2 ids", () => {
  it("round-trips and exposes expiry of at least the TTL (default 3 days)", () => {
    const id = imageProxy.encodeImageProxyId(URL_, T0);
    const decoded = imageProxy.decodeImageProxyIdWithExpiry(id, T0);
    assert.equal(decoded.url, URL_);
    const remaining = decoded.expiresAt - Math.floor(T0 / 1000);
    assert.ok(remaining >= 3 * DAY, `remaining ${remaining}`);
    assert.ok(remaining <= 4 * DAY, `remaining ${remaining}`);
    assert.equal(imageProxy.decodeImageProxyId(id, T0), URL_);
  });

  it("stays valid beyond the 24h batch window but not past expiry", () => {
    const id = imageProxy.encodeImageProxyId(URL_, T0);
    assert.equal(imageProxy.decodeImageProxyId(id, T0 + 2 * DAY * 1000), URL_);
    const { expiresAt } = imageProxy.decodeImageProxyIdWithExpiry(id, T0);
    assert.throws(
      () => imageProxy.decodeImageProxyId(id, (expiresAt + 61) * 1000),
      imageProxy.ImageProxyTokenError
    );
    // within the clock-skew allowance
    assert.equal(imageProxy.decodeImageProxyId(id, (expiresAt + 30) * 1000), URL_);
  });

  it("rejects a tampered (extended) expiry", () => {
    const [v, u, exp, sig] = imageProxy.encodeImageProxyId(URL_, T0).split(".");
    const extended = (Number.parseInt(exp, 36) + 365 * DAY).toString(36);
    assert.throws(
      () => imageProxy.decodeImageProxyId(`${v}.${u}.${extended}.${sig}`, T0),
      imageProxy.ImageProxyTokenError
    );
    assert.throws(
      () => imageProxy.decodeImageProxyId(`${v}.${u}.zzzzzzzzzzzzz.${sig}`, T0),
      imageProxy.ImageProxyTokenError
    );
  });

  it("is stable within a bucket and changes across buckets", () => {
    const a = imageProxy.encodeImageProxyId(URL_, T0);
    const sameBucket = imageProxy.encodeImageProxyId(URL_, T0 + 60 * 1000);
    assert.equal(a, sameBucket);
    const nextBucket = imageProxy.encodeImageProxyId(URL_, T0 + DAY * 1000);
    assert.notEqual(a, nextBucket);
  });

  it("honors IMAGE_PROXY_ID_TTL_SECONDS with clamping", () => {
    process.env.IMAGE_PROXY_ID_TTL_SECONDS = "7200";
    let { expiresAt } = imageProxy.decodeImageProxyIdWithExpiry(
      imageProxy.encodeImageProxyId(URL_, T0),
      T0
    );
    let remaining = expiresAt - Math.floor(T0 / 1000);
    assert.ok(remaining >= 7200 && remaining <= 14400, String(remaining));

    process.env.IMAGE_PROXY_ID_TTL_SECONDS = "1";
    ({ expiresAt } = imageProxy.decodeImageProxyIdWithExpiry(imageProxy.encodeImageProxyId(URL_, T0), T0));
    remaining = expiresAt - Math.floor(T0 / 1000);
    assert.ok(remaining >= 3600 && remaining <= 7200, `min clamp ${remaining}`);

    process.env.IMAGE_PROXY_ID_TTL_SECONDS = String(365 * DAY);
    ({ expiresAt } = imageProxy.decodeImageProxyIdWithExpiry(imageProxy.encodeImageProxyId(URL_, T0), T0));
    remaining = expiresAt - Math.floor(T0 / 1000);
    assert.ok(remaining >= 30 * DAY && remaining <= 31 * DAY, `max clamp ${remaining}`);
  });
});

describe("legacy v1 ids", () => {
  it("is rejected by default", () => {
    assert.throws(() => imageProxy.decodeImageProxyId(legacyId(URL_), T0), imageProxy.ImageProxyTokenError);
  });

  it("is accepted only inside IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL", () => {
    process.env.IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL = new Date(T0 + DAY * 1000).toISOString();
    const id = legacyId(URL_);
    const decoded = imageProxy.decodeImageProxyIdWithExpiry(id, T0);
    assert.equal(decoded.url, URL_);
    assert.equal(decoded.expiresAt, Math.floor((T0 + DAY * 1000) / 1000));
    assert.throws(
      () => imageProxy.decodeImageProxyId(id, T0 + 2 * DAY * 1000),
      imageProxy.ImageProxyTokenError
    );
  });

  it("still requires a valid signature and ignores an unparsable window", () => {
    process.env.IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL = new Date(T0 + DAY * 1000).toISOString();
    assert.throws(
      () => imageProxy.decodeImageProxyId(legacyId(URL_, "x".repeat(40)), T0),
      imageProxy.ImageProxyTokenError
    );
    process.env.IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL = "not-a-date";
    assert.throws(() => imageProxy.decodeImageProxyId(legacyId(URL_), T0), imageProxy.ImageProxyTokenError);
  });

  it("is never minted", () => {
    assert.match(imageProxy.encodeImageProxyId(URL_, T0), /^v2\./);
  });
});

describe("images cache headers", () => {
  const NOW = 1_000_000 * 1000;
  const nowS = 1_000_000;

  it("detects catalog blobs by container (virtual-host and path-style)", () => {
    assert.equal(images.isCatalogImageUrl(URL_), true);
    assert.equal(
      images.isCatalogImageUrl("https://swatchtest.blob.core.windows.net/user-media/1/a.png"),
      false
    );
    assert.equal(images.isCatalogImageUrl("http://127.0.0.1:10000/devstoreaccount1/source-images/a.png"), true);
    assert.equal(images.isCatalogImageUrl("http://127.0.0.1:10000/devstoreaccount1/user-media/a.png"), false);
    assert.equal(images.isCatalogImageUrl("not a url"), false);
    process.env.SOURCE_IMAGE_CONTAINER = "custom-images";
    assert.equal(images.isCatalogImageUrl(URL_), false);
    assert.equal(
      images.isCatalogImageUrl("https://swatchtest.blob.core.windows.net/custom-images/a.png"),
      true
    );
  });

  const select = (over) =>
    images.selectImageCacheControl({
      catalog: true,
      transformed: false,
      expiresAt: nowS + 30 * DAY,
      nowMs: NOW,
      ...over,
    });

  it("catalog: public with defaults and SWR for transforms", () => {
    assert.equal(select({}), "public, max-age=3600");
    assert.equal(
      select({ transformed: true }),
      "public, max-age=86400, stale-while-revalidate=604800"
    );
    assert.equal(select({ blobCacheControl: "public, max-age=120" }), "public, max-age=120");
  });

  it("non-catalog: private only, never public or SWR, blob header ignored", () => {
    assert.equal(select({ catalog: false, blobCacheControl: "public, max-age=999999" }), "private, max-age=3600");
    assert.equal(select({ catalog: false, transformed: true }), "private, max-age=86400");
  });

  it("caps max-age and SWR at the id's remaining lifetime", () => {
    assert.equal(select({ expiresAt: nowS + 600 }), "public, max-age=600");
    assert.equal(select({ catalog: false, expiresAt: nowS + 600 }), "private, max-age=600");
    assert.equal(
      select({ transformed: true, expiresAt: nowS + 90000 }),
      "public, max-age=86400, stale-while-revalidate=3600"
    );
    assert.equal(select({ transformed: true, expiresAt: nowS + 100 }), "public, max-age=100");
    assert.equal(select({ expiresAt: nowS - 5 }), "public, max-age=0");
  });

  it("caps lifetimes in a passed-through private/no-cache catalog header too", () => {
    assert.equal(
      select({ blobCacheControl: "private, max-age=31536000", expiresAt: nowS + 600 }),
      "private, max-age=600"
    );
    assert.equal(select({ blobCacheControl: "no-store" }), "no-store");
    assert.equal(
      select({ blobCacheControl: "no-cache, max-age=120", expiresAt: nowS + 600 }),
      "no-cache, max-age=120"
    );
  });
});
