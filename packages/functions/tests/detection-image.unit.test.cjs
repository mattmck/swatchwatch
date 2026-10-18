const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

// A real signing key so the proxy-id round trip (mint in ingestion, decode in the loader) is exercised.
const TEST_KEY = "detection-image-test-signing-key-0123456789";
const previousKey = process.env.IMAGE_PROXY_SIGNING_KEY;
process.env.IMAGE_PROXY_SIGNING_KEY = TEST_KEY;

const imageProxy = require("../dist/lib/image-proxy");
const {
  decodeDataUri,
  imageProxyIdFromUrl,
  loadDetectionImageBytes,
  DETECTION_IMAGE_MAX_BYTES,
} = require("../dist/lib/detection-image");

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeResponse({ ok = true, status = 200, statusText = "OK", bytes = PNG_HEADER, contentLength } = {}) {
  return {
    ok,
    status,
    statusText,
    headers: { get: (name) => (name.toLowerCase() === "content-length" && contentLength !== undefined ? String(contentLength) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

describe("lib/detection-image", () => {
  before(() => imageProxy.resetImageProxySigningStateForTests());
  after(() => {
    if (previousKey === undefined) delete process.env.IMAGE_PROXY_SIGNING_KEY;
    else process.env.IMAGE_PROXY_SIGNING_KEY = previousKey;
    imageProxy.resetImageProxySigningStateForTests();
  });

  it("decodes base64 data URIs and rejects everything else", () => {
    assert.deepEqual(decodeDataUri(`data:image/png;base64,${PNG_HEADER.toString("base64")}`), PNG_HEADER);
    assert.equal(decodeDataUri("https://img.example/a.png"), null);
    assert.equal(decodeDataUri("not a uri"), null);
  });

  it("extracts the signed id from a Functions image-proxy URL only", () => {
    assert.equal(imageProxyIdFromUrl("https://api.example/api/images/v2.abc.def.ghi"), "v2.abc.def.ghi");
    assert.equal(imageProxyIdFromUrl("https://api.example/api/images/v2.abc?w=512"), "v2.abc");
    assert.equal(imageProxyIdFromUrl("https://cdn.shopify.com/s/files/p.png"), null);
    assert.equal(imageProxyIdFromUrl("ftp://api.example/api/images/v2.abc"), null);
    assert.equal(imageProxyIdFromUrl("garbage"), null);
  });

  it("returns the bytes of a data URI without any network or blob access", async () => {
    const bytes = await loadDetectionImageBytes(`data:image/png;base64,${PNG_HEADER.toString("base64")}`, {
      fetchImpl: async () => { throw new Error("fetch must not be called"); },
      readBlob: async () => { throw new Error("blob read must not be called"); },
    });
    assert.deepEqual(bytes, PNG_HEADER);
    await assert.rejects(loadDetectionImageBytes("data:image/png;base64,"), /no payload/);
  });

  it("decodes a proxy URL with the signing key and reads the blob it points at", async () => {
    const storageUrl = "https://acct.blob.core.windows.net/source-images/holo/p1.png";
    const proxyUrl = imageProxy.toImageProxyUrlFromOrigin("https://api.example", storageUrl);
    const readUrls = [];
    const bytes = await loadDetectionImageBytes(proxyUrl, {
      fetchImpl: async () => { throw new Error("fetch must not be called for proxy URLs"); },
      readBlob: async (url) => {
        readUrls.push(url);
        return { bytes: PNG_HEADER };
      },
    });
    assert.deepEqual(readUrls, [storageUrl]);
    assert.deepEqual(bytes, PNG_HEADER);
  });

  it("rejects a forged proxy id instead of fetching it", async () => {
    await assert.rejects(
      loadDetectionImageBytes("https://api.example/api/images/v2.forged.id.sig", {
        fetchImpl: async () => { throw new Error("fetch must not be called"); },
        readBlob: async () => ({ bytes: PNG_HEADER }),
      })
    );
  });

  it("fetches plain http(s) URLs and enforces status and size", async () => {
    const seen = [];
    const ok = await loadDetectionImageBytes("https://cdn.shopify.com/s/files/p.png", {
      fetchImpl: async (url, init) => {
        seen.push({ url, hasSignal: Boolean(init?.signal) });
        return fakeResponse();
      },
    });
    assert.deepEqual(ok, PNG_HEADER);
    assert.deepEqual(seen, [{ url: "https://cdn.shopify.com/s/files/p.png", hasSignal: true }]);

    await assert.rejects(
      loadDetectionImageBytes("https://cdn.shopify.com/missing.png", {
        fetchImpl: async () => fakeResponse({ ok: false, status: 404, statusText: "Not Found" }),
      }),
      /404/
    );
    await assert.rejects(
      loadDetectionImageBytes("https://cdn.shopify.com/empty.png", {
        fetchImpl: async () => fakeResponse({ bytes: Buffer.alloc(0) }),
      }),
      /empty body/
    );
    await assert.rejects(
      loadDetectionImageBytes("https://cdn.shopify.com/huge.png", {
        fetchImpl: async () => fakeResponse({ contentLength: DETECTION_IMAGE_MAX_BYTES + 1 }),
      }),
      /too large/
    );
  });

  it("rejects unsupported references", async () => {
    await assert.rejects(loadDetectionImageBytes("   "), /empty/);
    await assert.rejects(loadDetectionImageBytes("file:///etc/passwd"), /Unsupported/);
  });
});
