/**
 * Unit tests for signed image proxy ids (issue #47).
 *
 * Covers:
 * - lib/image-proxy: HMAC-signed encode/decode round trip, tamper rejection, legacy unsigned
 *   ids, wrong-key ids, and missing/short key behavior (fail closed vs. dev-only fallback).
 * - lib/blob-storage readBlobFromStorageUrl: only plain blob reads in allowlisted containers
 *   of the configured account are allowed.
 * - functions/images: forged/unsigned ids → 403, valid signed ids → 200, missing key → 500.
 */
const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

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

const imageProxy = require("../dist/lib/image-proxy");
const blobStorage = require("../dist/lib/blob-storage");
require("../dist/functions/images");

const originalFetch = globalThis.fetch;

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) {
    delete require.cache[id];
  }
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

const ENV_KEYS = [
  "IMAGE_PROXY_SIGNING_KEY",
  "AUTH_DEV_BYPASS",
  "AZURE_STORAGE_CONNECTION",
  "SOURCE_IMAGE_CONTAINER",
];
let savedEnv = {};

function toBase64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function flipLastChar(value) {
  const last = value[value.length - 1];
  return value.slice(0, -1) + (last === "A" ? "B" : "A");
}

function fakeRequest(id, url) {
  return {
    method: "GET",
    url: url || `http://localhost:7071/api/images/${id}`,
    params: { id },
    headers: { get: () => null },
  };
}

function fakeContext() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

function mockBlobFetch() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(Buffer.from("fake-image-bytes"), {
      status: 200,
      headers: { "content-type": "image/png", etag: '"etag-1"' },
    });
  };
  return calls;
}

beforeEach(() => {
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
    assert.match(id, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
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
    const [, signature] = imageProxy.encodeImageProxyId(BLOB_URL).split(".");
    const otherUrl = "https://swatchtest.blob.core.windows.net/source-images/other-user/secret.png";
    const forged = `${toBase64Url(otherUrl)}.${signature}`;
    assert.throws(() => imageProxy.decodeImageProxyId(forged), imageProxy.ImageProxyTokenError);
  });

  it("rejects an id with a tampered signature", () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const [urlPart, signature] = imageProxy.encodeImageProxyId(BLOB_URL).split(".");
    assert.throws(
      () => imageProxy.decodeImageProxyId(`${urlPart}.${flipLastChar(signature)}`),
      imageProxy.ImageProxyTokenError
    );
    assert.throws(
      () => imageProxy.decodeImageProxyId(`${urlPart}.${signature.slice(0, 10)}`),
      imageProxy.ImageProxyTokenError
    );
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
    const [, signature] = imageProxy.encodeImageProxyId(BLOB_URL).split(".");
    const forged = `${toBase64Url(
      "https://swatchtest.blob.core.windows.net/source-images/someone-else.png"
    )}.${signature}`;
    const res = await handler()(fakeRequest(forged), fakeContext());
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it("returns 403 for a signed id that points outside the readable container", async () => {
    process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;
    const calls = mockBlobFetch();
    const id = imageProxy.encodeImageProxyId(
      "https://swatchtest.blob.core.windows.net/connector-raw/run-1.json.gz"
    );
    const res = await handler()(fakeRequest(id), fakeContext());
    assert.equal(res.status, 403);
    assert.deepEqual(res.jsonBody, { error: "Forbidden" });
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
