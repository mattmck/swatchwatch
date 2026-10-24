/**
 * Unit tests for lib/fetch-retry — bounded retries for catalog image downloads and blob reads.
 *
 * Covers:
 * - retries a network error (`TypeError: fetch failed` with an ECONNRESET cause) then succeeds
 * - gives up after N attempts and rethrows the last error
 * - no retry on 404 or on a non-network error
 * - honors Retry-After on 429 (capped at maxDelayMs), exponential backoff otherwise
 * - describeFetchError() keeps the undici cause code
 * - uploadSourceImageToBlob() retries a failed source download, also when the body read resets
 * - readBlobFromStorageUrl() retries only when asked (`retry: true`, the variants backfill), body reads included
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const {
  fetchWithRetry,
  isRetryableNetworkError,
  parseRetryAfterMs,
  describeFetchError,
} = require("../dist/lib/fetch-retry");
const { uploadSourceImageToBlob, readBlobFromStorageUrl } = require("../dist/lib/blob-storage");
// Blob Storage requests use lib/storage-http's transport; send them to the stubbed global.fetch.
require("../dist/lib/storage-http").blobStorageTransport.fetch = (url, init) => global.fetch(url, init);

function fetchFailed(code = "ECONNRESET") {
  const cause = Object.assign(new Error(`read ${code}`), { code });
  return new TypeError("fetch failed", { cause });
}

function sequence(steps) {
  let calls = 0;
  const fn = async () => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls += 1;
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step() : step;
  };
  return { fn, calls: () => calls };
}

function recordingSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

describe("lib/fetch-retry — fetchWithRetry", () => {
  it("retries a network error and returns the later success", async () => {
    const { fn, calls } = sequence([fetchFailed(), new Response("ok", { status: 200 })]);
    const { waits, sleep } = recordingSleep();
    const response = await fetchWithRetry(fn, { sleep, baseDelayMs: 100 });
    assert.equal(response.status, 200);
    assert.equal(calls(), 2);
    assert.deepEqual(waits, [100]);
  });

  it("gives up after the configured attempts and rethrows the last error", async () => {
    const { fn, calls } = sequence([fetchFailed("ETIMEDOUT")]);
    const { waits, sleep } = recordingSleep();
    await assert.rejects(fetchWithRetry(fn, { sleep, attempts: 3, baseDelayMs: 100 }), /fetch failed/);
    assert.equal(calls(), 3);
    assert.deepEqual(waits, [100, 200]);
  });

  it("does not retry a 404", async () => {
    const { fn, calls } = sequence([new Response("missing", { status: 404 })]);
    const { waits, sleep } = recordingSleep();
    const response = await fetchWithRetry(fn, { sleep });
    assert.equal(response.status, 404);
    assert.equal(calls(), 1);
    assert.deepEqual(waits, []);
  });

  it("does not retry a non-network error", async () => {
    const { fn, calls } = sequence([new Error("Source image download timed out")]);
    const { sleep } = recordingSleep();
    await assert.rejects(fetchWithRetry(fn, { sleep }), /timed out/);
    assert.equal(calls(), 1);
  });

  it("honors Retry-After on 429, capped at maxDelayMs", async () => {
    const { fn, calls } = sequence([
      () => new Response(null, { status: 429, headers: { "retry-after": "2" } }),
      () => new Response(null, { status: 429, headers: { "retry-after": "120" } }),
      () => new Response("ok", { status: 200 }),
    ]);
    const { waits, sleep } = recordingSleep();
    const response = await fetchWithRetry(fn, { sleep, maxDelayMs: 10_000 });
    assert.equal(response.status, 200);
    assert.equal(calls(), 3);
    assert.deepEqual(waits, [2000, 10_000]);
  });

  it("retries 5xx and returns the last response when attempts run out", async () => {
    const { fn, calls } = sequence([() => new Response(null, { status: 503 })]);
    const { sleep } = recordingSleep();
    const response = await fetchWithRetry(fn, { sleep, attempts: 2 });
    assert.equal(response.status, 503);
    assert.equal(calls(), 2);
  });
});

describe("lib/fetch-retry — helpers", () => {
  it("classifies network errors through the cause chain", () => {
    assert.equal(isRetryableNetworkError(fetchFailed()), true);
    assert.equal(isRetryableNetworkError(Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" })), true);
    assert.equal(isRetryableNetworkError(new Error("Unsupported image type")), false);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    assert.equal(parseRetryAfterMs("3"), 3000);
    assert.equal(parseRetryAfterMs(new Date(10_000).toUTCString(), 4000), 6000);
    assert.equal(parseRetryAfterMs(new Date(1_000).toUTCString(), 4000), null);
    assert.equal(parseRetryAfterMs("0"), 0);
    assert.equal(parseRetryAfterMs("soon"), null);
    assert.equal(parseRetryAfterMs(null), null);
  });

  it("describes undici errors with their cause code", () => {
    assert.equal(describeFetchError(fetchFailed()), "TypeError: fetch failed (read ECONNRESET)");
    const bare = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    assert.equal(
      describeFetchError(new TypeError("fetch failed", { cause: bare })),
      "TypeError: fetch failed (UND_ERR_SOCKET: other side closed)"
    );
    assert.equal(describeFetchError(new Error("plain")), "Error: plain");
  });
});

describe("lib/blob-storage — uploadSourceImageToBlob download retry", () => {
  const originalFetch = global.fetch;
  const originalConnection = process.env.AZURE_STORAGE_CONNECTION;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConnection === undefined) {
      delete process.env.AZURE_STORAGE_CONNECTION;
    } else {
      process.env.AZURE_STORAGE_CONNECTION = originalConnection;
    }
  });

  it("retries a transient source download failure", async () => {
    process.env.AZURE_STORAGE_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=${Buffer.from(
      "test-key"
    ).toString("base64")};EndpointSuffix=core.windows.net`;
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 8, b: 7 } },
    })
      .png()
      .toBuffer();

    let downloads = 0;
    global.fetch = async (url, init = {}) => {
      const method = init.method || "GET";
      if (String(url).startsWith("https://shop.example/")) {
        downloads += 1;
        if (downloads === 1) throw fetchFailed();
        return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      }
      // Blob already stored (HEAD 200) for the original and every variant.
      return new Response(null, { status: method === "HEAD" ? 200 : 201 });
    };

    const result = await uploadSourceImageToBlob({
      sourceImageUrl: "https://shop.example/a.png",
      source: "TestShopify",
      externalId: "retry-1",
      skipContainerEnsure: true,
    });
    assert.equal(downloads, 2);
    assert.ok(result.storageUrl);
  });

  it("readBlobFromStorageUrl retries only with retry: true", async () => {
    process.env.AZURE_STORAGE_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=${Buffer.from(
      "test-key"
    ).toString("base64")};EndpointSuffix=core.windows.net`;
    const url = "https://testacct.blob.core.windows.net/source-images/shop/a.png";
    let reads = 0;
    global.fetch = async () => {
      reads += 1;
      if (reads % 2 === 1) throw fetchFailed();
      return new Response(Buffer.from("bytes"), { status: 200, headers: { "content-type": "image/png" } });
    };

    await assert.rejects(readBlobFromStorageUrl(url), /fetch failed/);
    assert.equal(reads, 1);

    reads = 0;
    const blob = await readBlobFromStorageUrl(url, { retry: true });
    assert.equal(reads, 2);
    assert.equal(blob.bytes.toString(), "bytes");
  });

  function resetMidBody(firstChunk) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(firstChunk));
        controller.error(fetchFailed("ECONNRESET").cause);
      },
    });
  }

  it("retries a source download whose body read resets", async () => {
    process.env.AZURE_STORAGE_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=${Buffer.from(
      "test-key"
    ).toString("base64")};EndpointSuffix=core.windows.net`;
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 7, g: 8, b: 9 } },
    })
      .png()
      .toBuffer();

    let downloads = 0;
    global.fetch = async (url, init = {}) => {
      const method = init.method || "GET";
      if (String(url).startsWith("https://shop.example/")) {
        downloads += 1;
        const body = downloads === 1 ? resetMidBody(png.subarray(0, 8)) : png;
        return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response(null, { status: method === "HEAD" ? 200 : 201 });
    };

    const result = await uploadSourceImageToBlob({
      sourceImageUrl: "https://shop.example/b.png",
      source: "TestShopify",
      externalId: "retry-body",
      skipContainerEnsure: true,
    });
    assert.equal(downloads, 2);
    assert.ok(result.storageUrl);
  });

  it("readBlobFromStorageUrl with retry: true retries a body read that resets", async () => {
    process.env.AZURE_STORAGE_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=${Buffer.from(
      "test-key"
    ).toString("base64")};EndpointSuffix=core.windows.net`;
    let reads = 0;
    global.fetch = async () => {
      reads += 1;
      const body = reads === 1 ? resetMidBody(Buffer.from("by")) : Buffer.from("bytes");
      return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
    };

    const blob = await readBlobFromStorageUrl(
      "https://testacct.blob.core.windows.net/source-images/shop/a.png",
      { retry: true }
    );
    assert.equal(reads, 2);
    assert.equal(blob.bytes.toString(), "bytes");
    assert.equal(blob.contentType, "image/png");
  });
});
