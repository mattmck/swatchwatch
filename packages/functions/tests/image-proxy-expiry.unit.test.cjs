/**
 * Unit tests for expiring image proxy ids and cache scoping (issue #47, F5), including the
 * short-lived owner-scoped v3 ids for private media (#227).
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
const blobStorage = require("../dist/lib/blob-storage");
const images = require("../dist/functions/images");

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) delete require.cache[id];
});

const KEY = "test-image-proxy-signing-key-0123456789abcdef";
const URL_ = "https://swatchtest.blob.core.windows.net/source-images/holotaco/a.png";
const PRIVATE_URL_ = "https://swatchtest.blob.core.windows.net/nail-photos/user-7/a.png";
const DAY = 86400;
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0); // ms

const ENV_KEYS = [
  "IMAGE_PROXY_SIGNING_KEY",
  "IMAGE_PROXY_ID_TTL_SECONDS",
  "IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS",
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

describe("image proxy v3 (owner-scoped) ids", () => {
  const T0S = Math.floor(T0 / 1000); // 12:00:00 UTC, aligned to every bucket size used here
  const mint = (nowMs = T0, ownerUserId = 7) =>
    imageProxy.encodeImageProxyId(PRIVATE_URL_, { ownerUserId, nowMs });
  const remainingAt = (id, nowMs = T0) =>
    imageProxy.decodeImageProxyIdWithExpiry(id, nowMs).expiresAt - Math.floor(nowMs / 1000);

  it("round-trips with scope, owner and a 1h default TTL", () => {
    const decoded = imageProxy.decodeImageProxyIdWithExpiry(mint(), T0);
    assert.equal(decoded.url, PRIVATE_URL_);
    assert.equal(decoded.scope, "private");
    assert.equal(decoded.ownerUserId, 7);
    const remaining = decoded.expiresAt - T0S;
    assert.ok(remaining >= 3600 && remaining <= 3600 + 900, `remaining ${remaining}`);
  });

  it("keeps the remaining lifetime within [ttl, ttl + 15 min] at any mint time", () => {
    for (let offset = 0; offset < 1800; offset += 37) {
      const nowMs = T0 + offset * 1000;
      const remaining = remainingAt(mint(nowMs), nowMs);
      assert.ok(remaining >= 3600 && remaining <= 4500, `offset ${offset}: ${remaining}`);
    }
  });

  it("is rejected once expired, but tolerated within the clock-skew allowance", () => {
    const id = mint();
    const { expiresAt } = imageProxy.decodeImageProxyIdWithExpiry(id, T0);
    assert.equal(imageProxy.decodeImageProxyId(id, expiresAt * 1000), PRIVATE_URL_);
    assert.equal(imageProxy.decodeImageProxyId(id, (expiresAt + 30) * 1000), PRIVATE_URL_);
    assert.equal(imageProxy.decodeImageProxyId(id, (expiresAt + 60) * 1000), PRIVATE_URL_);
    for (const late of [61, 3600, 7 * DAY]) {
      assert.throws(
        () => imageProxy.decodeImageProxyIdWithExpiry(id, (expiresAt + late) * 1000),
        imageProxy.ImageProxyTokenError,
        `+${late}s`
      );
    }
    // Minted two hours ago with the default TTL: already past expiry + skew.
    assert.throws(
      () => imageProxy.decodeImageProxyId(mint(T0 - 2 * 3600 * 1000), T0 + 901 * 1000),
      imageProxy.ImageProxyTokenError
    );
  });

  it("is stable within a 15-minute bucket and changes across buckets", () => {
    const a = mint(T0);
    assert.equal(mint(T0 + 60 * 1000), a);
    assert.equal(mint(T0 + 899 * 1000), a);
    const next = mint(T0 + 900 * 1000);
    assert.notEqual(next, a);
    assert.equal(remainingAt(next, T0 + 900 * 1000), 900 + 3600);
    assert.notEqual(mint(T0, 8), a, "different owner, different id");
  });

  it("clamps IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS to 300..86400 and defaults to 3600", () => {
    const idWithTtl = (raw) => {
      if (raw === undefined) delete process.env.IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS;
      else process.env.IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS = raw;
      return mint();
    };
    assert.equal(idWithTtl("299"), idWithTtl("300"));
    assert.equal(remainingAt(idWithTtl("299")), 300 + 300); // bucket = min(ttl, 900) = 300
    assert.equal(idWithTtl("1000000"), idWithTtl("86400"));
    assert.equal(remainingAt(idWithTtl("1000000")), 900 + 86400);
    assert.equal(idWithTtl("7200"), idWithTtl(" 7200 "));
    assert.equal(remainingAt(idWithTtl("7200")), 900 + 7200);
    for (const garbage of ["garbage", "", "   ", "NaN"]) {
      assert.equal(idWithTtl(garbage), idWithTtl(undefined), JSON.stringify(garbage));
    }
    assert.equal(remainingAt(idWithTtl(undefined)), 900 + 3600);
  });

  it("uses its own TTL, independent of IMAGE_PROXY_ID_TTL_SECONDS", () => {
    process.env.IMAGE_PROXY_ID_TTL_SECONDS = String(7 * DAY);
    assert.equal(remainingAt(mint()), 900 + 3600);
    process.env.IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS = "600";
    assert.equal(remainingAt(mint()), 600 + 600);
    const v2Remaining =
      imageProxy.decodeImageProxyIdWithExpiry(imageProxy.encodeImageProxyId(URL_, T0), T0).expiresAt - T0S;
    assert.ok(v2Remaining >= 7 * DAY && v2Remaining <= 8 * DAY, `v2 ${v2Remaining}`);
  });

  it("reports scope \"public\" for v2 ids", () => {
    const decoded = imageProxy.decodeImageProxyIdWithExpiry(imageProxy.encodeImageProxyId(URL_, T0), T0);
    assert.equal(decoded.scope, "public");
    assert.equal(decoded.ownerUserId, undefined);
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
    assert.equal(decoded.scope, "public");
    assert.equal(decoded.ownerUserId, undefined);
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

  it("lib/blob-storage isCatalogStorageUrl detects catalog blobs by container", () => {
    assert.equal(blobStorage.isCatalogStorageUrl(URL_), true);
    assert.equal(blobStorage.isCatalogStorageUrl("https://swatchtest.blob.core.windows.net/user-media/1/a.png"), false);
    assert.equal(blobStorage.isCatalogStorageUrl(PRIVATE_URL_), false);
    assert.equal(blobStorage.isCatalogStorageUrl("https://swatchtest.blob.core.windows.net/SOURCE-IMAGES/a.png"), true);
    assert.equal(blobStorage.isCatalogStorageUrl("http://127.0.0.1:10000/devstoreaccount1/source-images/a.png"), true);
    assert.equal(blobStorage.isCatalogStorageUrl("http://127.0.0.1:10000/devstoreaccount1/user-media/a.png"), false);
    assert.equal(blobStorage.isCatalogStorageUrl("http://127.0.0.1:10000/source-images/a.png"), false);
    assert.equal(blobStorage.isCatalogStorageUrl("https://swatchtest.blob.core.windows.net/"), false);
    assert.equal(blobStorage.isCatalogStorageUrl("not a url"), false);
    assert.equal(blobStorage.isCatalogStorageUrl(""), false);
    process.env.SOURCE_IMAGE_CONTAINER = "custom-images";
    assert.equal(blobStorage.isCatalogStorageUrl(URL_), false);
    assert.equal(blobStorage.isCatalogStorageUrl("https://swatchtest.blob.core.windows.net/custom-images/a.png"), true);
  });

  it("functions/images re-exports the helper as isCatalogImageUrl", () => {
    assert.equal(images.isCatalogImageUrl, blobStorage.isCatalogStorageUrl);
  });

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
    // max-age + stale-while-revalidate together must not outlive the id.
    assert.equal(
      select({ blobCacheControl: "private, max-age=600, stale-while-revalidate=600", expiresAt: nowS + 600 }),
      "private, max-age=600"
    );
    assert.equal(
      select({ blobCacheControl: "private, max-age=300, stale-while-revalidate=600", expiresAt: nowS + 600 }),
      "private, max-age=300, stale-while-revalidate=300"
    );
    // Quoted arguments (RFC 9111) are capped too; an unparseable lifetime fails closed to 0.
    assert.equal(
      select({ blobCacheControl: 'private, max-age="3600"', expiresAt: nowS + 60 }),
      "private, max-age=60"
    );
    assert.equal(select({ blobCacheControl: "private, max-age=soon", expiresAt: nowS + 60 }), "private, max-age=0");
    // stale-if-error is a stale window too: capped after freshness, dropped when none is left.
    assert.equal(
      select({ blobCacheControl: "private, max-age=600, stale-if-error=3600", expiresAt: nowS + 60 }),
      "private, max-age=60"
    );
    assert.equal(
      select({ blobCacheControl: "private, max-age=60, stale-if-error=3600", expiresAt: nowS + 600 }),
      "private, max-age=60, stale-if-error=540"
    );
    assert.equal(
      select({ blobCacheControl: "no-cache, max-age=120", expiresAt: nowS + 600 }),
      "no-cache, max-age=120"
    );
  });
});
