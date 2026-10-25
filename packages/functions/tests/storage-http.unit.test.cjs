/**
 * Unit tests for blob storage connections (lib/storage-http, lib/blob-storage, lib/image-store-error)
 *
 * Covers:
 * - BLOB_STORAGE_MAX_CONNECTIONS parsing and clamping
 * - the default transport (undici's fetch + pooled Agent) works on this Node, against a loopback server
 * - every storage request goes through the shared pooled Agent; source downloads do not
 * - blob PUT and metadata (existence) GETs are retried on connect timeouts / refused connections, DELETE is not
 * - non-GET response bodies are consumed so sockets return to the pool
 * - variants are written one at a time
 * - uploadSourceImageToBlob failures name the failed step and host (SourceImageUploadError)
 *
 * No network: global.fetch is stubbed (and the storage transport pointed at it); one test uses loopback.
 */
const { describe, it, afterEach, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const {
  resolveBlobStorageMaxConnections,
  getBlobStorageDispatcher,
  resetBlobStorageDispatcherForTests,
  blobStorageRetry,
  blobStorageTransport,
  BLOB_STORAGE_HTTP_DEFAULTS,
} = require("../dist/lib/storage-http");
const {
  uploadBytesToBlob,
  uploadSourceImageToBlob,
  ensureImageVariants,
  deleteBlobFromStorageUrl,
  SourceImageUploadError,
} = require("../dist/lib/blob-storage");
const { describeImageStoreFailure } = require("../dist/lib/image-store-error");

blobStorageRetry.baseDelayMs = 0;
const defaultTransportFetch = blobStorageTransport.fetch;
// Storage requests go to the stubbed global.fetch below (lib/storage-http's test seam).
blobStorageTransport.fetch = (url, init) => global.fetch(url, init);

const CONNECTION = `DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=${Buffer.from(
  "test-key"
).toString("base64")};EndpointSuffix=core.windows.net`;
const BLOB_HOST = "testacct.blob.core.windows.net";

function connectTimeout() {
  const cause = new Error(`Connect Timeout Error (attempted address: ${BLOB_HOST}:443, timeout: 10000ms)`);
  cause.code = "UND_ERR_CONNECT_TIMEOUT";
  return new TypeError("fetch failed", { cause });
}

function connectRefused() {
  const cause = new Error("connect ECONNREFUSED 10.0.0.1:443");
  cause.code = "ECONNREFUSED";
  return new TypeError("fetch failed", { cause });
}

async function tinyPng() {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toBuffer();
}

describe("lib/storage-http — resolveBlobStorageMaxConnections", () => {
  it("defaults to 16", () => {
    assert.equal(resolveBlobStorageMaxConnections({}), 16);
    assert.equal(resolveBlobStorageMaxConnections({ BLOB_STORAGE_MAX_CONNECTIONS: "" }), 16);
    assert.equal(resolveBlobStorageMaxConnections({ BLOB_STORAGE_MAX_CONNECTIONS: "lots" }), 16);
  });

  it("reads and clamps the env value", () => {
    assert.equal(resolveBlobStorageMaxConnections({ BLOB_STORAGE_MAX_CONNECTIONS: " 8 " }), 8);
    assert.equal(resolveBlobStorageMaxConnections({ BLOB_STORAGE_MAX_CONNECTIONS: "2.9" }), 2);
    assert.equal(resolveBlobStorageMaxConnections({ BLOB_STORAGE_MAX_CONNECTIONS: "0" }), 1);
    assert.equal(
      resolveBlobStorageMaxConnections({ BLOB_STORAGE_MAX_CONNECTIONS: "5000" }),
      BLOB_STORAGE_HTTP_DEFAULTS.maxConnectionsLimit
    );
  });
});

describe("lib/storage-http — dispatcher", () => {
  afterEach(() => resetBlobStorageDispatcherForTests());

  it("sends real requests through undici's fetch and the pooled Agent, not global.fetch", async () => {
    // Loopback only: proves undici's fetch + Agent work on this Node version (Node 22 and 24
    // bundle different undici majors) without going through the stubbed global fetch.
    const http = require("node:http");
    const server = http.createServer((req, res) => {
      res.writeHead(201, { "x-method": req.method });
      res.end("created");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const stubbedFetch = global.fetch;
    let globalCalls = 0;
    global.fetch = async () => {
      globalCalls += 1;
      throw new Error("global fetch must not be used");
    };
    try {
      const { port } = server.address();
      const response = await defaultTransportFetch(`http://127.0.0.1:${port}/c/b`, {
        method: "PUT",
        body: new Uint8Array([1, 2, 3]),
        dispatcher: getBlobStorageDispatcher(20000),
      });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("x-method"), "PUT");
      assert.equal(await response.text(), "created");
      assert.equal(globalCalls, 0);
    } finally {
      global.fetch = stubbedFetch;
      await resetBlobStorageDispatcherForTests();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("is one shared Agent until reset", async () => {
    const first = getBlobStorageDispatcher(20000);
    assert.equal(getBlobStorageDispatcher(20000), first);
    await resetBlobStorageDispatcherForTests();
    assert.notEqual(getBlobStorageDispatcher(20000), first);
  });
});

describe("lib/blob-storage — pooled requests and connect retries", () => {
  const originalFetch = global.fetch;
  const originalConnection = process.env.AZURE_STORAGE_CONNECTION;

  beforeEach(() => {
    process.env.AZURE_STORAGE_CONNECTION = CONNECTION;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    if (originalConnection === undefined) delete process.env.AZURE_STORAGE_CONNECTION;
    else process.env.AZURE_STORAGE_CONNECTION = originalConnection;
    await resetBlobStorageDispatcherForTests();
  });

  it("sends storage requests through the pooled Agent and source downloads through the default dispatcher", async () => {
    const png = await tinyPng();
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ host: new URL(String(url)).host, dispatcher: init.dispatcher });
      if (String(url).startsWith("https://shop.example/")) {
        return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response(null, { status: String(url).includes("comp=metadata") ? 404 : 201 });
    };
    await uploadSourceImageToBlob({
      sourceImageUrl: "https://shop.example/p1.png",
      source: "TestShopify",
      externalId: "p1",
      skipContainerEnsure: true,
    });
    const agent = getBlobStorageDispatcher(20000);
    const storageCalls = calls.filter((call) => call.host === BLOB_HOST);
    assert.ok(storageCalls.length >= 2);
    assert.ok(storageCalls.every((call) => call.dispatcher === agent));
    assert.equal(calls.find((call) => call.host === "shop.example").dispatcher, undefined);
  });

  it("retries a blob PUT after a connect timeout and a refused connection", async () => {
    const outcomes = [connectTimeout(), connectRefused()];
    let attempts = 0;
    global.fetch = async () => {
      attempts += 1;
      const next = outcomes.shift();
      if (next) throw next;
      return new Response(null, { status: 201 });
    };
    const url = await uploadBytesToBlob({
      connectionString: CONNECTION,
      containerName: "source-images",
      blobName: "shop/a.jpg",
      bytes: Buffer.from("abc"),
      contentType: "image/jpeg",
      skipContainerEnsure: true,
    });
    assert.equal(attempts, 3);
    assert.equal(url, `https://${BLOB_HOST}/source-images/shop/a.jpg`);
  });

  it("re-signs each PUT attempt", async () => {
    const dates = [];
    let first = true;
    global.fetch = async (_url, init) => {
      dates.push(init.headers["x-ms-date"]);
      assert.match(init.headers.Authorization, /^SharedKey testacct:/);
      if (first) {
        first = false;
        throw connectTimeout();
      }
      return new Response(null, { status: 201 });
    };
    await uploadBytesToBlob({
      connectionString: CONNECTION,
      containerName: "source-images",
      blobName: "shop/b.jpg",
      bytes: Buffer.from("abc"),
      contentType: "image/jpeg",
      skipContainerEnsure: true,
    });
    assert.equal(dates.length, 2);
  });

  it("gives up after the configured attempts and rethrows the connect error", async () => {
    let attempts = 0;
    global.fetch = async () => {
      attempts += 1;
      throw connectTimeout();
    };
    await assert.rejects(
      uploadBytesToBlob({
        connectionString: CONNECTION,
        containerName: "source-images",
        blobName: "shop/c.jpg",
        bytes: Buffer.from("abc"),
        contentType: "image/jpeg",
        skipContainerEnsure: true,
      }),
      (error) => error.cause?.code === "UND_ERR_CONNECT_TIMEOUT"
    );
    assert.equal(attempts, blobStorageRetry.attempts);
  });

  it("does not retry DELETE", async () => {
    let attempts = 0;
    global.fetch = async () => {
      attempts += 1;
      throw connectTimeout();
    };
    await assert.rejects(
      deleteBlobFromStorageUrl(`https://${BLOB_HOST}/nail-photos/1/a.jpg`, { allowedContainers: ["nail-photos"] })
    );
    assert.equal(attempts, 1);
  });

  it("consumes PUT response bodies", async () => {
    const bodies = [];
    global.fetch = async () => {
      const response = new Response("<ok/>", { status: 201 });
      bodies.push(response);
      return response;
    };
    await uploadBytesToBlob({
      connectionString: CONNECTION,
      containerName: "source-images",
      blobName: "shop/d.jpg",
      bytes: Buffer.from("abc"),
      contentType: "image/jpeg",
      skipContainerEnsure: true,
    });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].bodyUsed, true);
  });

  it("writes thumbnail variants one at a time", async () => {
    let inFlight = 0;
    let maxInFlightPuts = 0;
    global.fetch = async (url) => {
      if (String(url).includes("comp=metadata")) return new Response(null, { status: 404 });
      inFlight += 1;
      maxInFlightPuts = Math.max(maxInFlightPuts, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(null, { status: 201 });
    };
    const result = await ensureImageVariants({
      connectionString: CONNECTION,
      containerName: "source-images",
      blobName: "shop/e.png",
      bytes: await tinyPng(),
    });
    assert.deepEqual(result.written, [64, 128, 256, 512]);
    assert.equal(maxInFlightPuts, 1);
  });
});

describe("lib/blob-storage — uploadSourceImageToBlob failure steps", () => {
  const originalFetch = global.fetch;
  const originalConnection = process.env.AZURE_STORAGE_CONNECTION;

  beforeEach(() => {
    process.env.AZURE_STORAGE_CONNECTION = CONNECTION;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    if (originalConnection === undefined) delete process.env.AZURE_STORAGE_CONNECTION;
    else process.env.AZURE_STORAGE_CONNECTION = originalConnection;
    await resetBlobStorageDispatcherForTests();
  });

  const upload = () =>
    uploadSourceImageToBlob({
      sourceImageUrl: "https://cdn.shop.example/p1.png",
      source: "TestShopify",
      externalId: "p1",
      skipContainerEnsure: true,
    });

  it("names the blob PUT and the storage host when the upload cannot connect", async () => {
    const png = await tinyPng();
    global.fetch = async (url, init = {}) => {
      if (String(url).startsWith("https://cdn.shop.example/")) {
        return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      }
      if (String(url).includes("comp=metadata")) return new Response(null, { status: 404 });
      throw connectTimeout();
    };
    await assert.rejects(upload(), (error) => {
      assert.ok(error instanceof SourceImageUploadError);
      assert.equal(error.step, "blob_put");
      assert.equal(error.host, BLOB_HOST);
      assert.match(error.message, /^blob PUT \(testacct\.blob\.core\.windows\.net\) failed: TypeError: fetch failed \(UND_ERR_CONNECT_TIMEOUT/);
      const failure = describeImageStoreFailure(error);
      assert.equal(failure.stepLabel, "blob PUT");
      assert.match(failure.error, /^TypeError: fetch failed \(UND_ERR_CONNECT_TIMEOUT/);
      return true;
    });
  });

  it("names the source download and the vendor host when the download fails", async () => {
    global.fetch = async () => new Response("nope", { status: 403, statusText: "Forbidden" });
    await assert.rejects(upload(), (error) => {
      assert.equal(error.step, "source_download");
      assert.equal(error.host, "cdn.shop.example");
      assert.match(error.message, /403 Forbidden/);
      return true;
    });
  });

  it("names image processing when the downloaded image cannot be stored", async () => {
    // Undecodable, so it cannot be downscaled, and over the 5 MB stored-size limit.
    const oversize = Buffer.alloc(6 * 1024 * 1024, 1);
    global.fetch = async () => new Response(oversize, { status: 200, headers: { "content-type": "image/png" } });
    await assert.rejects(upload(), (error) => {
      assert.equal(error.step, "image_processing");
      assert.equal(error.host, null);
      assert.match(error.message, /too large/i);
      return true;
    });
  });

  it("describes errors without a step as an image store failure", () => {
    assert.deepEqual(describeImageStoreFailure(new Error("boom")), {
      step: "unknown",
      stepLabel: "image store",
      host: null,
      error: "Error: boom",
    });
  });
});
