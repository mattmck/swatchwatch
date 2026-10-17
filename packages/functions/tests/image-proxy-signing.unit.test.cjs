/**
 * Unit tests for signed image proxy ids (issue #47).
 *
 * Covers:
 * - lib/image-proxy: HMAC-signed encode/decode round trip, tamper rejection, legacy unsigned
 *   ids, wrong-key ids, and missing/short key behavior (fail closed vs. dev-only fallback).
 * - lib/blob-storage readBlobFromStorageUrl: only plain blob reads in allowlisted containers
 *   of the configured account are allowed.
 * - lib/image-proxy v3 (#227): owner-scoped ids for non-catalog URLs, scope errors at mint time,
 *   and rejection of every tampered/transplanted/non-canonical v3 envelope.
 * - functions/images: forged/unsigned ids → 403, valid signed ids → 200, missing key → 500;
 *   owner-scoped v3 ids need the owner's bearer token (401/403 otherwise), may only read
 *   USER_MEDIA_CONTAINER, and are served `Cache-Control: private` with `Vary: Authorization`.
 */
const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { createHmac } = require("node:crypto");

// ---------------------------------------------------------------------------
// Mock @azure/functions so functions/images registers its route with us
// ---------------------------------------------------------------------------

const registeredRoutes = {};
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
  app: {
    http: (name, opts) => {
      registeredRoutes[name] = opts;
    },
  },
});

for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

// lib/auth's dev-bypass user lookup is the only DB access functions/images can make (v3 ids).
// Replace lib/db by its resolved path so no pg pool is ever created; every statement is recorded.
const dbCalls = [];
let dbFailure = null;
const DB_MODULE_PATH = path.resolve(__dirname, "../dist/lib/db.js");
require.cache[DB_MODULE_PATH] = {
  id: DB_MODULE_PATH,
  filename: DB_MODULE_PATH,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      dbCalls.push({ sql, params });
      if (dbFailure) throw dbFailure;
      if (/FROM\s+app_user/i.test(sql)) {
        const userId = Number(params[0]);
        return { rows: [{ user_id: userId, external_id: `ext-${userId}`, email: null, role: "user" }] };
      }
      return { rows: [] };
    },
    transaction: async () => {
      throw new Error("transactions are not expected in image proxy tests");
    },
  },
};

const imageProxy = require("../dist/lib/image-proxy");
const blobStorage = require("../dist/lib/blob-storage");
require("../dist/functions/images");

const originalFetch = globalThis.fetch;

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) {
    delete require.cache[id];
  }
  delete require.cache[DB_MODULE_PATH];
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_KEY = "test-image-proxy-signing-key-0123456789abcdef";
const OTHER_KEY = "another-image-proxy-signing-key-fedcba9876543210";
const ACCOUNT_KEY = Buffer.from("not-a-real-account-key").toString("base64");
const STORAGE_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=swatchtest;AccountKey=${ACCOUNT_KEY};EndpointSuffix=core.windows.net`;
const BLOB_URL = "https://swatchtest.blob.core.windows.net/source-images/holotaco/abc-123.png";
const PRIVATE_URL = "https://swatchtest.blob.core.windows.net/nail-photos/user-7/photo.png";
const OTHER_PRIVATE_URL = "https://swatchtest.blob.core.windows.net/nail-photos/user-8/photo.png";
const OWNER = 7;
const OTHER_USER = 8;

const ENV_KEYS = [
  "IMAGE_PROXY_SIGNING_KEY",
  "IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS",
  "AUTH_DEV_BYPASS",
  "AZURE_STORAGE_CONNECTION",
  "SOURCE_IMAGE_CONTAINER",
  "USER_MEDIA_CONTAINER",
  "AZURE_AD_B2C_TENANT",
  "AZURE_AD_B2C_CLIENT_ID",
];
let savedEnv = {};

function toBase64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Flip one bit of the decoded signature bytes and re-encode. Editing the trailing base64url char
 * is not enough: a 32-byte HMAC is 43 chars, so the last char carries 2 padding bits and some
 * edits decode to the same bytes.
 */
function tamperSignature(encoded, byteIndex = 0) {
  const bytes = Buffer.from(encoded, "base64url");
  bytes[byteIndex] ^= 0x01;
  return bytes.toString("base64url");
}

function hmacBase64Url(key, message) {
  return createHmac("sha256", key).update(message, "utf8").digest("base64url");
}

/** Hand-built v2 id signed with `key` (bypasses the mint-time catalog check). */
function signV2Id(url, key, expiresAt = Math.floor(Date.now() / 1000) + 3600) {
  const sig = hmacBase64Url(key, `swatchwatch:image-proxy:v2:${expiresAt}:${url}`);
  return `v2.${toBase64Url(url)}.${expiresAt.toString(36)}.${sig}`;
}

/**
 * Hand-built v3 id. The HMAC covers `owner` (decimal); `ownerToken` / `expToken` override what is
 * written into the id so non-canonical spellings of a validly signed value can be tested.
 */
function signV3Id(url, key, { owner, expiresAt, ownerToken, expToken }) {
  const sig = hmacBase64Url(key, `swatchwatch:image-proxy:v3:${expiresAt}:${owner}:${url}`);
  return [
    "v3",
    toBase64Url(url),
    expToken ?? expiresAt.toString(36),
    ownerToken ?? owner.toString(36),
    sig,
  ].join(".");
}

function fakeRequest(id, url, headers = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: "GET",
    url: url || `http://localhost:7071/api/images/${id}`,
    params: { id },
    headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
  };
}

function fakeContext() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

function mockBlobFetch({ body = Buffer.from("fake-image-bytes"), headers = {} } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "image/png", etag: '"etag-1"', ...headers },
    });
  };
  return calls;
}

beforeEach(() => {
  dbCalls.length = 0;
  dbFailure = null;
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  imageProxy.resetImageProxySigningStateForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  imageProxy.resetImageProxySigningStateForTests();
  globalThis.fetch = originalFetch;
});

// ═══════════════════════════════════════════════════════════════════════════
// lib/image-proxy
// ═══════════════════════════════════════════════════════════════════════════

describe("lib/image-proxy — signed ids", () => {
  it("round-trips a storage URL through encode/decode", () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    assert.match(id, /^v2\.[A-Za-z0-9_-]+\.[0-9a-z]+\.[A-Za-z0-9_-]+$/);
    assert.equal(imageProxy.decodeImageProxyId(id), BLOB_URL);
  });

  it("produces the same id for the same URL and key (stable for caching)", () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    assert.equal(imageProxy.encodeImageProxyId(BLOB_URL), imageProxy.encodeImageProxyId(BLOB_URL));
  });

  it("builds proxy URLs with the signed id under /api/images/", () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const url = imageProxy.toImageProxyUrl("https://api.example.com/api/polishes?page=1", BLOB_URL);
    const prefix = "https://api.example.com/api/images/";
    assert.ok(url.startsWith(prefix), url);
    assert.equal(imageProxy.decodeImageProxyId(url.slice(prefix.length)), BLOB_URL);
  });

  it("rejects an id whose URL part was swapped for another blob", () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const [version, , exp, signature] = imageProxy.encodeImageProxyId(BLOB_URL).split(".");
    const otherUrl = "https://swatchtest.blob.core.windows.net/source-images/other-user/secret.png";
    const forged = `${version}.${toBase64Url(otherUrl)}.${exp}.${signature}`;
    assert.throws(() => imageProxy.decodeImageProxyId(forged), imageProxy.ImageProxyTokenError);
  });

  it("rejects an id with a tampered signature", () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const [version, urlPart, exp, signature] = imageProxy.encodeImageProxyId(BLOB_URL).split(".");
    for (const byteIndex of [0, 15, 31]) {
      const tampered = tamperSignature(signature, byteIndex);
      assert.notEqual(tampered, signature);
      assert.throws(
        () => imageProxy.decodeImageProxyId(`${version}.${urlPart}.${exp}.${tampered}`),
        imageProxy.ImageProxyTokenError,
        `byte ${byteIndex}`
      );
    }
    assert.throws(
      () => imageProxy.decodeImageProxyId(`${version}.${urlPart}.${exp}.${signature.slice(0, 10)}`),
      imageProxy.ImageProxyTokenError
    );
  });

  it("rejects a tampered signature regardless of which day the id was minted", () => {
    // Ids are bucketed by UTC day, so the signature changes daily. Sweep a range of days that
    // includes 2026-10-16, whose signature ends in "A" and broke the old last-char tamper helper.
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const start = Date.UTC(2026, 0, 1, 12);
    for (let day = 0; day < 400; day += 1) {
      const nowMs = start + day * 24 * 60 * 60 * 1000;
      const [version, urlPart, exp, signature] = imageProxy
        .encodeImageProxyId(BLOB_URL, nowMs)
        .split(".");
      assert.equal(imageProxy.decodeImageProxyId(`${version}.${urlPart}.${exp}.${signature}`, nowMs), BLOB_URL);
      assert.throws(
        () => imageProxy.decodeImageProxyId(`${version}.${urlPart}.${exp}.${tamperSignature(signature, 31)}`, nowMs),
        imageProxy.ImageProxyTokenError,
        new Date(nowMs).toISOString()
      );
    }
  });

  it("rejects legacy unsigned ids (bare base64url of the URL)", () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    assert.throws(
      () => imageProxy.decodeImageProxyId(toBase64Url(BLOB_URL)),
      imageProxy.ImageProxyTokenError
    );
  });

  it("rejects malformed ids", () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    for (const bad of ["", ".", `${id}.extra`, `${id.replace(".", "!")}`, "a+b.c/d"]) {
      assert.throws(() => imageProxy.decodeImageProxyId(bad), imageProxy.ImageProxyTokenError, bad);
    }
  });

  it("rejects ids signed with a different key", () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = OTHER_KEY;
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    assert.throws(() => imageProxy.decodeImageProxyId(id), imageProxy.ImageProxyTokenError);
  });

  it("refuses to sign non-http(s) URLs", () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    assert.throws(() => imageProxy.encodeImageProxyId("file:///etc/passwd"));
  });
});

describe("lib/image-proxy — owner-scoped v3 ids (#227)", () => {
  const V3_PATTERN = /^v3\.[A-Za-z0-9_-]+\.[0-9a-z]+\.[0-9a-z]+\.[A-Za-z0-9_-]+$/;

  beforeEach(() => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
  });

  function assertRejected(id, label) {
    assert.throws(() => imageProxy.decodeImageProxyIdWithExpiry(id), imageProxy.ImageProxyTokenError, label);
    assert.throws(() => imageProxy.decodeImageProxyId(id), imageProxy.ImageProxyTokenError, label);
  }

  it("mints a v3 id for a non-catalog URL with an owner and round-trips it", () => {
    const nowMs = Date.now();
    const id = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER, nowMs });
    assert.match(id, V3_PATTERN);
    assert.equal(id.split(".")[3], OWNER.toString(36));
    const decoded = imageProxy.decodeImageProxyIdWithExpiry(id, nowMs);
    assert.equal(decoded.url, PRIVATE_URL);
    assert.equal(decoded.scope, "private");
    assert.equal(decoded.ownerUserId, OWNER);
    const remaining = decoded.expiresAt - Math.floor(nowMs / 1000);
    assert.ok(remaining >= 3600 && remaining <= 3600 + 900, `remaining ${remaining}`);
    assert.equal(imageProxy.decodeImageProxyId(id, nowMs), PRIVATE_URL);
  });

  it("encodes large owner ids in canonical lowercase base36", () => {
    const owner = Number.MAX_SAFE_INTEGER;
    const id = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: owner });
    assert.match(id, V3_PATTERN);
    assert.equal(id.split(".")[3], owner.toString(36));
    assert.equal(imageProxy.decodeImageProxyIdWithExpiry(id).ownerUserId, owner);
  });

  it("keeps minting public v2 ids for catalog URLs even when an owner is given", () => {
    for (const id of [
      imageProxy.encodeImageProxyId(BLOB_URL, { ownerUserId: OWNER }),
      imageProxy.encodeImageProxyId(BLOB_URL),
    ]) {
      assert.match(id, /^v2\.[A-Za-z0-9_-]+\.[0-9a-z]+\.[A-Za-z0-9_-]+$/);
      const decoded = imageProxy.decodeImageProxyIdWithExpiry(id);
      assert.equal(decoded.url, BLOB_URL);
      assert.equal(decoded.scope, "public");
      assert.equal(decoded.ownerUserId, undefined);
      assert.ok(!Object.hasOwn(decoded, "ownerUserId"));
    }
    assert.equal(
      imageProxy.encodeImageProxyId(BLOB_URL, { ownerUserId: OWNER }),
      imageProxy.encodeImageProxyId(BLOB_URL)
    );
  });

  it("accepts nowMs either as a number or in the options object", () => {
    const nowMs = Date.UTC(2026, 3, 1, 9, 7);
    assert.equal(imageProxy.encodeImageProxyId(BLOB_URL, nowMs), imageProxy.encodeImageProxyId(BLOB_URL, { nowMs }));
  });

  it("throws ImageProxyScopeError for a non-catalog URL without a valid owner (fail closed)", () => {
    const bad = [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "7", null];
    assert.throws(() => imageProxy.encodeImageProxyId(PRIVATE_URL), imageProxy.ImageProxyScopeError);
    assert.throws(() => imageProxy.encodeImageProxyId(PRIVATE_URL, Date.now()), imageProxy.ImageProxyScopeError);
    for (const ownerUserId of bad) {
      assert.throws(
        () => imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId }),
        (error) => error instanceof imageProxy.ImageProxyScopeError && error.name === "ImageProxyScopeError",
        String(ownerUserId)
      );
    }
    // Any non-catalog container counts as private, not just USER_MEDIA_CONTAINER.
    assert.throws(
      () => imageProxy.encodeImageProxyId("https://swatchtest.blob.core.windows.net/connector-raw/run-1.json.gz"),
      imageProxy.ImageProxyScopeError
    );
    assert.ok(new imageProxy.ImageProxyScopeError() instanceof Error);
  });

  it("passes mint options through toImageProxyUrl and toImageProxyUrlFromOrigin", () => {
    const prefix = "https://api.example.com/api/images/";
    const viaRequest = imageProxy.toImageProxyUrl("https://api.example.com/api/polishes/1", PRIVATE_URL, {
      ownerUserId: OWNER,
    });
    const viaOrigin = imageProxy.toImageProxyUrlFromOrigin("https://api.example.com", PRIVATE_URL, {
      ownerUserId: OWNER,
    });
    for (const url of [viaRequest, viaOrigin]) {
      assert.ok(url.startsWith(prefix), url);
      const decoded = imageProxy.decodeImageProxyIdWithExpiry(url.slice(prefix.length));
      assert.equal(decoded.scope, "private");
      assert.equal(decoded.ownerUserId, OWNER);
      assert.equal(decoded.url, PRIVATE_URL);
    }
    assert.throws(
      () => imageProxy.toImageProxyUrl("https://api.example.com/api/polishes/1", PRIVATE_URL),
      imageProxy.ImageProxyScopeError
    );
    assert.throws(
      () => imageProxy.toImageProxyUrlFromOrigin("https://api.example.com", PRIVATE_URL),
      imageProxy.ImageProxyScopeError
    );
  });

  it("accepts a hand-built v3 id signed with the real key (control for the forgeries below)", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const decoded = imageProxy.decodeImageProxyIdWithExpiry(
      signV3Id(PRIVATE_URL, TEST_KEY, { owner: OWNER, expiresAt })
    );
    assert.deepEqual(decoded, { url: PRIVATE_URL, expiresAt, scope: "private", ownerUserId: OWNER });
  });

  it("rejects a v3 id whose owner was swapped for another user", () => {
    const [v, u, exp, , sig] = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER }).split(".");
    for (const owner of [OTHER_USER, 1, OWNER + 36, 123456789]) {
      assertRejected(`${v}.${u}.${exp}.${owner.toString(36)}.${sig}`, `owner ${owner}`);
    }
  });

  it("rejects non-canonical or out-of-range owner encodings even when the HMAC matches", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const cases = [
      ["leading zero", OWNER, `0${OWNER.toString(36)}`],
      ["double leading zero", OWNER, `00${OWNER.toString(36)}`],
      ["uppercase", 10, "A"],
      ["zero", 0, "0"],
      ["empty", OWNER, ""],
      ["sign", OWNER, `+${OWNER}`],
      ["beyond MAX_SAFE_INTEGER", Number.parseInt("zzzzzzzzzzzz", 36), "zzzzzzzzzzzz"],
      ["too long", OWNER, `${"0".repeat(12)}${OWNER}`],
    ];
    for (const [label, owner, ownerToken] of cases) {
      assertRejected(signV3Id(PRIVATE_URL, TEST_KEY, { owner, expiresAt, ownerToken }), label);
    }
  });

  it("rejects a non-canonical expiry encoding even when the HMAC matches", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    assertRejected(
      signV3Id(PRIVATE_URL, TEST_KEY, { owner: OWNER, expiresAt, expToken: `0${expiresAt.toString(36)}` }),
      "leading zero exp"
    );
  });

  it("rejects an extended expiry", () => {
    const [v, u, exp, owner, sig] = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER }).split(".");
    for (const delta of [1, 3600, 365 * 86400]) {
      const extended = (Number.parseInt(exp, 36) + delta).toString(36);
      assertRejected(`${v}.${u}.${extended}.${owner}.${sig}`, `+${delta}s`);
    }
    assertRejected(`${v}.${u}.zzzzzzzzzzzzz.${owner}.${sig}`, "overlong exp");
  });

  it("rejects a v3 id whose URL payload was swapped", () => {
    const [v, , exp, owner, sig] = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER }).split(".");
    for (const url of [OTHER_PRIVATE_URL, BLOB_URL, `${PRIVATE_URL}?x=1`]) {
      assertRejected(`${v}.${toBase64Url(url)}.${exp}.${owner}.${sig}`, url);
    }
  });

  it("rejects v3 ids signed with a different key", () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = OTHER_KEY;
    const id = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER });
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    assertRejected(id, "minted with OTHER_KEY");
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    assertRejected(signV3Id(PRIVATE_URL, "attacker-key", { owner: OWNER, expiresAt }), "attacker key");
  });

  it("rejects truncated, garbage, tampered and non-canonical v3 signatures", () => {
    const [v, u, exp, owner, sig] = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER }).split(".");
    const envelope = (signature) => `${v}.${u}.${exp}.${owner}.${signature}`;

    // Non-canonical spelling: the last of 43 chars carries 2 unused bits, so flipping its lowest
    // bit decodes to the very same MAC bytes. It must still be refused.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const nonCanonical = sig.slice(0, -1) + alphabet[alphabet.indexOf(sig.at(-1)) ^ 1];
    assert.ok(Buffer.from(nonCanonical, "base64url").equals(Buffer.from(sig, "base64url")));
    assert.notEqual(nonCanonical, sig);

    const bad = {
      empty: "",
      truncated: sig.slice(0, 10),
      "one char short": sig.slice(0, -1),
      "one char long": `${sig}A`,
      garbage: toBase64Url("not-a-real-mac"),
      "invalid chars": `${sig.slice(0, -2)}+/`,
      "padded": `${sig}=`,
      "non-canonical": nonCanonical,
      "byte 0 tampered": tamperSignature(sig, 0),
      "byte 15 tampered": tamperSignature(sig, 15),
      "byte 31 tampered": tamperSignature(sig, 31),
    };
    for (const [label, signature] of Object.entries(bad)) {
      assertRejected(envelope(signature), label);
    }
    assert.equal(imageProxy.decodeImageProxyId(envelope(sig)), PRIVATE_URL);
  });

  it("parses v3 only with exactly five parts and v2 only with exactly four", () => {
    const [v, u, exp, owner, sig] = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER }).split(".");
    const [, cu, cexp, csig] = imageProxy.encodeImageProxyId(BLOB_URL).split(".");
    assertRejected(`${v}.${u}.${exp}.${sig}`, "v3 with 4 parts");
    assertRejected(`${v}.${u}.${exp}.${owner}.${sig}.x`, "v3 with 6 parts");
    assertRejected(`${v}.${u}.${exp}.${owner}`, "v3 without signature");
    assertRejected(`v2.${cu}.${cexp}.${owner}.${csig}`, "v2 with 5 parts");
    assertRejected(`V3.${u}.${exp}.${owner}.${sig}`, "uppercase version prefix");
    assertRejected(`v4.${u}.${exp}.${owner}.${sig}`, "unknown version prefix");
  });

  it("rejects signatures transplanted between v2 and v3 envelopes", () => {
    const [, u, exp, owner, v3sig] = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER }).split(".");
    const [, cu, cexp, v2sig] = imageProxy.encodeImageProxyId(BLOB_URL).split(".");
    // v3 signature on a v2 envelope (would make a private blob public if accepted).
    assertRejected(`v2.${u}.${exp}.${v3sig}`, "v3 sig on v2 envelope");
    // v2 signature on a v3 envelope, for the catalog URL and for the private URL.
    assertRejected(`v3.${cu}.${cexp}.${owner}.${v2sig}`, "v2 sig on v3 envelope (catalog URL)");
    assertRejected(`v3.${u}.${exp}.${owner}.${v2sig}`, "v2 sig on v3 envelope (private URL)");
    // A v2 MAC computed with the real key over the private URL is still not a v3 MAC.
    const expiresAt = Number.parseInt(exp, 36);
    const v2MacOverPrivate = hmacBase64Url(TEST_KEY, `swatchwatch:image-proxy:v2:${expiresAt}:${PRIVATE_URL}`);
    assertRejected(`v3.${u}.${exp}.${owner}.${v2MacOverPrivate}`, "real-key v2 MAC on v3 envelope");
  });

  it("rejects a tampered v3 signature regardless of which day the id was minted", () => {
    // Same sweep as the #245 regression test for v2, over 400 consecutive days.
    const start = Date.UTC(2026, 0, 1, 12);
    for (let day = 0; day < 400; day += 1) {
      const nowMs = start + day * 24 * 60 * 60 * 1000;
      const [v, u, exp, owner, sig] = imageProxy
        .encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER, nowMs })
        .split(".");
      assert.equal(imageProxy.decodeImageProxyId(`${v}.${u}.${exp}.${owner}.${sig}`, nowMs), PRIVATE_URL);
      assert.throws(
        () => imageProxy.decodeImageProxyId(`${v}.${u}.${exp}.${owner}.${tamperSignature(sig, 31)}`, nowMs),
        imageProxy.ImageProxyTokenError,
        new Date(nowMs).toISOString()
      );
    }
  });
});

describe("lib/image-proxy — signing key configuration", () => {
  it("fails closed when the key is missing outside dev bypass", () => {
    process.env.AUTH_DEV_BYPASS = "false";
    assert.throws(() => imageProxy.encodeImageProxyId(BLOB_URL), imageProxy.ImageProxyConfigError);
    assert.throws(
      () => imageProxy.decodeImageProxyId("aaaa.bbbb"),
      imageProxy.ImageProxyConfigError
    );
  });

  it("fails closed when the key is missing and AUTH_DEV_BYPASS is unset", () => {
    assert.throws(() => imageProxy.encodeImageProxyId(BLOB_URL), imageProxy.ImageProxyConfigError);
  });

  it("treats a whitespace-only key as missing", () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = "   ";
    assert.throws(() => imageProxy.encodeImageProxyId(BLOB_URL), imageProxy.ImageProxyConfigError);
  });

  it("rejects keys shorter than the minimum length even in dev bypass", () => {
    process.env.AUTH_DEV_BYPASS = "true";
    process.env.IMAGE_PROXY_SIGNING_KEY = "too-short";
    assert.throws(() => imageProxy.encodeImageProxyId(BLOB_URL), imageProxy.ImageProxyConfigError);
  });

  it("uses an ephemeral per-process key in dev bypass mode when the key is missing", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    process.env.AUTH_DEV_BYPASS = "true";
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    assert.equal(imageProxy.decodeImageProxyId(id), BLOB_URL);
    assert.equal(imageProxy.decodeImageProxyId(imageProxy.encodeImageProxyId(BLOB_URL)), BLOB_URL);
    assert.equal(warn.mock.callCount(), 1, "warns exactly once about the dev-only key");

    // A fresh process (simulated) gets a new random key; old ids no longer verify.
    imageProxy.resetImageProxySigningStateForTests();
    assert.throws(() => imageProxy.decodeImageProxyId(id), imageProxy.ImageProxyTokenError);
  });

  it("does not accept dev-key ids once a real key is configured", (t) => {
    t.mock.method(console, "warn", () => {});
    process.env.AUTH_DEV_BYPASS = "true";
    const devId = imageProxy.encodeImageProxyId(BLOB_URL);
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    assert.throws(() => imageProxy.decodeImageProxyId(devId), imageProxy.ImageProxyTokenError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// lib/blob-storage — readBlobFromStorageUrl access restrictions
// ═══════════════════════════════════════════════════════════════════════════

describe("lib/blob-storage — readBlobFromStorageUrl access restrictions", () => {
  beforeEach(() => {
    process.env.AZURE_STORAGE_CONNECTION = STORAGE_CONNECTION;
  });

  const denied = [
    ["another host", "https://evil.example.com/source-images/a.png"],
    ["another storage account", "https://otheraccount.blob.core.windows.net/source-images/a.png"],
    ["a non-allowlisted container", "https://swatchtest.blob.core.windows.net/connector-raw/run-1.json.gz"],
    ["a container listing query", "https://swatchtest.blob.core.windows.net/source-images?restype=container&comp=list"],
    ["a blob URL with a query string", "https://swatchtest.blob.core.windows.net/source-images/a.png?comp=metadata"],
    ["embedded credentials", "https://user:pass@swatchtest.blob.core.windows.net/source-images/a.png"],
    ["a protocol downgrade", "http://swatchtest.blob.core.windows.net/source-images/a.png"],
    ["a container without a blob", "https://swatchtest.blob.core.windows.net/source-images/"],
  ];

  for (const [label, url] of denied) {
    it(`denies ${label} without making a request`, async () => {
      const calls = mockBlobFetch();
      await assert.rejects(blobStorage.readBlobFromStorageUrl(url), blobStorage.BlobAccessDeniedError);
      assert.equal(calls.length, 0);
    });
  }

  it("allows a plain blob read in the source image container", async () => {
    const calls = mockBlobFetch();
    const result = await blobStorage.readBlobFromStorageUrl(BLOB_URL);
    assert.equal(result.contentType, "image/png");
    assert.equal(result.bytes.toString(), "fake-image-bytes");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, BLOB_URL);
  });

  it("honors SOURCE_IMAGE_CONTAINER when choosing the readable container", async () => {
    process.env.SOURCE_IMAGE_CONTAINER = "custom-images";
    mockBlobFetch();
    await assert.rejects(blobStorage.readBlobFromStorageUrl(BLOB_URL), blobStorage.BlobAccessDeniedError);
    const result = await blobStorage.readBlobFromStorageUrl(
      "https://swatchtest.blob.core.windows.net/custom-images/a.png"
    );
    assert.equal(result.contentType, "image/png");
  });

  it("supports path-style endpoints (Azurite) and rejects paths outside the account prefix", async () => {
    process.env.AZURE_STORAGE_CONNECTION =
      `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${ACCOUNT_KEY};` +
      "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
    mockBlobFetch();
    const ok = await blobStorage.readBlobFromStorageUrl(
      "http://127.0.0.1:10000/devstoreaccount1/source-images/a.png"
    );
    assert.equal(ok.contentType, "image/png");
    await assert.rejects(
      blobStorage.readBlobFromStorageUrl("http://127.0.0.1:10000/otheraccount/source-images/a.png"),
      blobStorage.BlobAccessDeniedError
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// functions/images — GET /api/images/{id}
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/images — signed id enforcement", () => {
  beforeEach(() => {
    process.env.AZURE_STORAGE_CONNECTION = STORAGE_CONNECTION;
  });

  const handler = () => registeredRoutes.images.handler;

  it("registers the anonymous GET route", () => {
    assert.ok(registeredRoutes.images);
    assert.equal(registeredRoutes.images.route, "images/{id}");
    assert.equal(registeredRoutes.images.authLevel, "anonymous");
  });

  it("serves a blob for a validly signed id", async () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const calls = mockBlobFetch();
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    const res = await handler()(fakeRequest(id), fakeContext());
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(res.body).toString(), "fake-image-bytes");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, BLOB_URL);
  });

  it("returns 403 for a legacy unsigned id without touching storage", async () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const calls = mockBlobFetch();
    const res = await handler()(fakeRequest(toBase64Url(BLOB_URL)), fakeContext());
    assert.equal(res.status, 403);
    assert.deepEqual(res.jsonBody, { error: "Forbidden" });
    assert.equal(calls.length, 0);
  });

  it("returns 403 for a forged id pointing at another blob", async () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const calls = mockBlobFetch();
    const [version, , exp, signature] = imageProxy.encodeImageProxyId(BLOB_URL).split(".");
    const forged = `${version}.${toBase64Url(
      "https://swatchtest.blob.core.windows.net/source-images/someone-else.png"
    )}.${exp}.${signature}`;
    const res = await handler()(fakeRequest(forged), fakeContext());
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it("returns 403 for a signed id that points outside the readable container", async () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const calls = mockBlobFetch();
    // encodeImageProxyId refuses to mint a public id for a non-catalog URL (#227), so build the
    // v2 id by hand with the real key: the read allowlist must still refuse it.
    const id = signV2Id("https://swatchtest.blob.core.windows.net/connector-raw/run-1.json.gz", TEST_KEY);
    const res = await handler()(fakeRequest(id), fakeContext());
    assert.equal(res.status, 403);
    assert.deepEqual(res.jsonBody, { error: "Forbidden" });
    assert.equal(calls.length, 0);
  });

  it("returns 403 for forged v3 ids without touching storage", async () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const calls = mockBlobFetch();
    const [v, u, exp, owner, sig] = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER }).split(".");
    const forgeries = [
      `${v}.${u}.${exp}.${OTHER_USER.toString(36)}.${sig}`,
      `${v}.${u}.${exp}.0${owner}.${sig}`,
      `${v}.${toBase64Url(BLOB_URL)}.${exp}.${owner}.${sig}`,
      `v2.${u}.${exp}.${sig}`,
      `${v}.${u}.${exp}.${owner}.${tamperSignature(sig, 31)}`,
      signV3Id(BLOB_URL, OTHER_KEY, { owner: OWNER, expiresAt: Number.parseInt(exp, 36) }),
    ];
    for (const id of forgeries) {
      const res = await handler()(fakeRequest(id), fakeContext());
      assert.equal(res.status, 403, id);
      assert.deepEqual(res.jsonBody, { error: "Forbidden" });
    }
    assert.equal(calls.length, 0);
  });

  it("returns a generic 500 (and never serves) when the signing key is missing in production", async () => {
    process.env.AUTH_DEV_BYPASS = "false";
    const calls = mockBlobFetch();
    const res = await handler()(fakeRequest(toBase64Url(BLOB_URL)), fakeContext());
    assert.equal(res.status, 500);
    assert.deepEqual(res.jsonBody, { error: "Failed to serve image" });
    assert.equal(calls.length, 0);
  });
});

describe("functions/images — owner-scoped v3 ids (#227)", () => {
  beforeEach(() => {
    process.env.AZURE_STORAGE_CONNECTION = STORAGE_CONNECTION;
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    process.env.AUTH_DEV_BYPASS = "true";
  });

  const handler = () => registeredRoutes.images.handler;
  const asUser = (userId) => ({ authorization: `Bearer dev:${userId}` });
  const varyTokens = (res) =>
    (res.headers?.get?.("Vary") || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);

  it("serves the owner with Cache-Control: private (<=300s) and Vary: Authorization", async () => {
    // The blob's own header must be ignored for private media.
    const calls = mockBlobFetch({ headers: { "cache-control": "public, max-age=31536000" } });
    const id = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER });
    const res = await handler()(fakeRequest(id, undefined, asUser(OWNER)), fakeContext());
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(res.body).toString(), "fake-image-bytes");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, PRIVATE_URL);
    const cacheControl = res.headers.get("Cache-Control");
    assert.match(cacheControl, /^private, max-age=(\d+)$/);
    assert.ok(Number(cacheControl.match(/max-age=(\d+)/)[1]) <= 300);
    assert.deepEqual(varyTokens(res), ["authorization"]);
  });

  it("keeps transforms working for private images", async () => {
    const sharp = require("sharp");
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 20, b: 120 } },
    }).png().toBuffer();
    const calls = mockBlobFetch({ body: png });
    const id = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER });
    const res = await handler()(
      fakeRequest(id, `http://localhost:7071/api/images/${id}?w=16&fm=webp`, asUser(OWNER)),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "image/webp");
    assert.equal(res.headers.get("Cache-Control"), "private, max-age=300");
    assert.deepEqual(varyTokens(res), ["authorization"]);
    assert.equal(calls.length, 1);
  });

  it("returns 401 without a token and 403 for another user, without touching storage", async () => {
    const calls = mockBlobFetch();
    const id = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER });

    const anonymous = await handler()(fakeRequest(id), fakeContext());
    assert.equal(anonymous.status, 401);
    assert.deepEqual(anonymous.jsonBody, { error: "Unauthorized" });

    const malformed = await handler()(fakeRequest(id, undefined, { authorization: "Basic abc" }), fakeContext());
    assert.equal(malformed.status, 401);

    const otherUser = await handler()(fakeRequest(id, undefined, asUser(OTHER_USER)), fakeContext());
    assert.equal(otherUser.status, 403);
    assert.deepEqual(otherUser.jsonBody, { error: "Forbidden" });

    assert.equal(calls.length, 0);
  });

  it("turns an unexpected auth failure into 401, never 500", async () => {
    const calls = mockBlobFetch();
    // The user lookup itself blows up (not an AuthError), e.g. the database is unreachable.
    dbFailure = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const id = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER });
    const res = await handler()(fakeRequest(id, undefined, asUser(OWNER)), fakeContext());
    assert.equal(res.status, 401);
    assert.deepEqual(res.jsonBody, { error: "Unauthorized" });
    assert.equal(dbCalls.length, 1, "the failure came from the auth lookup");
    assert.equal(calls.length, 0);
  });

  it("rejects a forged v3 id with 403 before any auth lookup", async () => {
    const calls = mockBlobFetch();
    const [v, u, exp, , sig] = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER }).split(".");
    const forged = `${v}.${u}.${exp}.${OTHER_USER.toString(36)}.${sig}`;
    // Even without any Authorization header, a bad signature is a 403, not a 401.
    const res = await handler()(fakeRequest(forged), fakeContext());
    assert.equal(res.status, 403);
    assert.deepEqual(dbCalls, []);
    assert.equal(calls.length, 0);
  });

  it("refuses a validly signed v3 id outside USER_MEDIA_CONTAINER, even for its owner", async () => {
    const calls = mockBlobFetch();
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    for (const url of [BLOB_URL, "https://swatchtest.blob.core.windows.net/connector-raw/run-1.json.gz"]) {
      const id = signV3Id(url, TEST_KEY, { owner: OWNER, expiresAt });
      const res = await handler()(fakeRequest(id, undefined, asUser(OWNER)), fakeContext());
      assert.equal(res.status, 403, url);
      assert.deepEqual(res.jsonBody, { error: "Forbidden" });
    }
    assert.equal(calls.length, 0);
  });

  it("honours USER_MEDIA_CONTAINER overrides for v3 reads", async () => {
    process.env.USER_MEDIA_CONTAINER = "custom-media";
    const calls = mockBlobFetch();
    const customUrl = "https://swatchtest.blob.core.windows.net/custom-media/user-7/photo.png";
    const ok = await handler()(
      fakeRequest(imageProxy.encodeImageProxyId(customUrl, { ownerUserId: OWNER }), undefined, asUser(OWNER)),
      fakeContext()
    );
    assert.equal(ok.status, 200);
    const denied = await handler()(
      fakeRequest(imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER }), undefined, asUser(OWNER)),
      fakeContext()
    );
    assert.equal(denied.status, 403);
    assert.deepEqual(calls.map((c) => c.url), [customUrl]);
  });

  it("public v2 ids stay anonymous: no auth lookup and no Vary: Authorization", async () => {
    mockBlobFetch();
    const res = await handler()(fakeRequest(imageProxy.encodeImageProxyId(BLOB_URL)), fakeContext());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Cache-Control"), /^public, /);
    assert.deepEqual(varyTokens(res), []);
    assert.deepEqual(dbCalls, []);
  });

  it("adds Cache-Control: no-store to every private-id error response, and only to those", async () => {
    const id = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER });
    mockBlobFetch();
    for (const [headers, status] of [[{}, 401], [asUser(OTHER_USER), 403]]) {
      const res = await handler()(fakeRequest(id, undefined, headers), fakeContext());
      assert.equal(res.status, status);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
    }

    // 404 is heuristically cacheable; a private miss must not be.
    globalThis.fetch = async () => new Response("missing", { status: 404 });
    const missing = await handler()(fakeRequest(id, undefined, asUser(OWNER)), fakeContext());
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("Cache-Control"), "no-store");

    // Public responses are unchanged: a public 404 gets no added header.
    const publicMissing = await handler()(fakeRequest(imageProxy.encodeImageProxyId(BLOB_URL)), fakeContext());
    assert.equal(publicMissing.status, 404);
    assert.equal(publicMissing.headers?.get?.("Cache-Control") ?? null, null);
  });

  it("treats jose JWT errors as ordinary 401s, not unexpected exceptions", async () => {
    process.env.AUTH_DEV_BYPASS = "false";
    process.env.AZURE_AD_B2C_TENANT = "swatchtest";
    process.env.AZURE_AD_B2C_CLIENT_ID = "client-id";
    const calls = mockBlobFetch(); // OIDC metadata lookup gets a non-JSON body and falls back
    const logged = [];
    const context = { log: () => {}, warn: () => {}, error: (...args) => logged.push(args) };
    const id = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER });
    // A malformed compact JWS makes the real jose throw JWSInvalid (a JOSEError subclass).
    const res = await handler()(fakeRequest(id, undefined, { authorization: "Bearer not-a-jwt" }), context);
    assert.equal(res.status, 401);
    assert.deepEqual(res.jsonBody, { error: "Unauthorized" });
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.ok(calls.some((c) => c.url.includes("ciamlogin.com")), "JWT validation was reached");
    assert.deepEqual(logged, [], "a bad JWT is not an unexpected auth error");
    assert.ok(!calls.some((c) => c.url === PRIVATE_URL), "no blob read");
  });

  it("logs a genuinely unexpected auth failure (contrast with jose errors)", async () => {
    mockBlobFetch();
    dbFailure = new Error("connection refused");
    const logged = [];
    const context = { log: () => {}, warn: () => {}, error: (...args) => logged.push(args) };
    const id = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER });
    const res = await handler()(fakeRequest(id, undefined, asUser(OWNER)), context);
    assert.equal(res.status, 401);
    assert.equal(logged.length, 1);
  });

  it("refuses hand-signed v3 ids that disguise the container (percent-encoding, dot segments)", async () => {
    const calls = mockBlobFetch();
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const disguised = [
      // Azure would decode this to nail-photos, but the allowlist compares the literal segment.
      "https://swatchtest.blob.core.windows.net/nail%2Dphotos/user-7/photo.png",
      // Dot segments are resolved when the URL is parsed; they cannot escape the private container.
      "https://swatchtest.blob.core.windows.net/nail-photos/../source-images/holotaco/abc-123.png",
      "https://swatchtest.blob.core.windows.net/nail-photos/%2e%2e/connector-raw/run-1.json.gz",
    ];
    for (const url of disguised) {
      const id = signV3Id(url, TEST_KEY, { owner: OWNER, expiresAt });
      const res = await handler()(fakeRequest(id, undefined, asUser(OWNER)), fakeContext());
      assert.equal(res.status, 403, url);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
    }
    assert.equal(calls.length, 0);
  });

  it("fails closed (500, no fetch) when USER_MEDIA_CONTAINER equals SOURCE_IMAGE_CONTAINER", async () => {
    const calls = mockBlobFetch();
    const id = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER });
    process.env.USER_MEDIA_CONTAINER = "source-images";
    const res = await handler()(fakeRequest(id, undefined, asUser(OWNER)), fakeContext());
    assert.equal(res.status, 500);
    assert.deepEqual(res.jsonBody, { error: "Failed to serve image" });
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(calls.length, 0);
  });
});

describe("lib/image-proxy — hardening after review (#227)", () => {
  beforeEach(() => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
  });

  it("rejects a v2 id whose expiry has a leading zero (non-canonical base36)", () => {
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    const [v, u, exp, sig] = id.split(".");
    assert.equal(imageProxy.decodeImageProxyIdWithExpiry(id).url, BLOB_URL, "control");
    assert.throws(
      () => imageProxy.decodeImageProxyIdWithExpiry(`${v}.${u}.0${exp}.${sig}`),
      imageProxy.ImageProxyTokenError
    );
    assert.throws(
      () => imageProxy.decodeImageProxyIdWithExpiry(`${v}.${u}.${exp.toUpperCase()}.${sig}`),
      imageProxy.ImageProxyTokenError
    );
  });

  it("refuses to mint anything (never a public v2 id) when the two containers coincide", () => {
    for (const env of [
      { USER_MEDIA_CONTAINER: "source-images" },
      { SOURCE_IMAGE_CONTAINER: "nail-photos" },
      { SOURCE_IMAGE_CONTAINER: "Shared", USER_MEDIA_CONTAINER: " shared " },
    ]) {
      delete process.env.SOURCE_IMAGE_CONTAINER;
      delete process.env.USER_MEDIA_CONTAINER;
      Object.assign(process.env, env);
      assert.throws(
        () => imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: OWNER }),
        imageProxy.ImageProxyConfigError,
        JSON.stringify(env)
      );
      assert.throws(() => imageProxy.encodeImageProxyId(BLOB_URL), imageProxy.ImageProxyConfigError, JSON.stringify(env));
      assert.throws(() => blobStorage.userMediaContainer(), imageProxy.ImageProxyConfigError);
    }
  });
});
