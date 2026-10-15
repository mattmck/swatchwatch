const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const zlib = require("node:zlib");

// ---------------------------------------------------------------------------
// Mock ../lib/blob-storage with an in-memory store before loading the cache module
// ---------------------------------------------------------------------------

let blobs = new Map();
let uploads = [];
let failUploads = false;
let failReads = false;

const blobStoragePath = path.resolve(__dirname, "../dist/lib/blob-storage.js");
require.cache[blobStoragePath] = {
  id: blobStoragePath,
  filename: blobStoragePath,
  loaded: true,
  exports: {
    uploadBytesToBlob: async ({ containerName, blobName, bytes, contentType }) => {
      if (failUploads) throw new Error("upload boom");
      const url = `https://acct.blob.core.windows.net/${containerName}/${blobName}`;
      blobs.set(url, bytes);
      uploads.push({ url, contentType });
      return url;
    },
    // Mirrors the real allowlist: reads default to the source-image container only.
    readBlobFromStorageUrl: async (url, options = {}) => {
      const container = new URL(url).pathname.split("/")[1];
      const allowed = options.allowedContainers ?? ["source-images"];
      if (!allowed.includes(container)) {
        throw new Error(`Blob container '${container}' is not readable through the API`);
      }
      if (failReads || !blobs.has(url)) throw new Error("read boom");
      return { bytes: blobs.get(url) };
    },
  },
};

const {
  createIngestionCatalogCache,
  readCatalogSnapshotFromMetrics,
} = require("../dist/lib/ingestion-catalog-cache");
const { loadCatalogWithCache } = require("../dist/lib/connectors/types");

const ENV_KEYS = ["CONNECTOR_RAW_CONTAINER", "RAW_SNAPSHOT_CONTAINER", "AZURE_STORAGE_CONNECTION"];
const savedEnv = {};

beforeEach(() => {
  blobs = new Map();
  uploads = [];
  failUploads = false;
  failReads = false;
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.CONNECTOR_RAW_CONTAINER = "connector-raw";
  process.env.AZURE_STORAGE_CONNECTION = "UseDevelopmentStorage=true";
  delete process.env.RAW_SNAPSHOT_CONTAINER;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function countingFetcher(products) {
  const fetcher = async () => {
    fetcher.calls += 1;
    return products;
  };
  fetcher.calls = 0;
  return fetcher;
}

describe("loadCatalogWithCache", () => {
  it("fetches once without a cache", async () => {
    const fetcher = countingFetcher([{ id: 1 }]);
    assert.deepEqual(await loadCatalogWithCache(undefined, fetcher), [{ id: 1 }]);
    assert.equal(fetcher.calls, 1);
  });

  it("reuses the in-memory catalog for later pages of the same invocation", async () => {
    const cache = createIngestionCatalogCache({ jobId: 7, source: "MooncatShopify", snapshot: null });
    const fetcher = countingFetcher([{ id: 1 }, { id: 2 }]);

    await loadCatalogWithCache(cache, fetcher);
    const second = await loadCatalogWithCache(cache, fetcher);

    assert.equal(fetcher.calls, 1);
    assert.equal(second.length, 2);
  });
});

describe("createIngestionCatalogCache", () => {
  it("saves a gzipped snapshot and reports where it lives", async () => {
    const saved = [];
    const cache = createIngestionCatalogCache({
      jobId: 7,
      source: "MooncatShopify",
      snapshot: null,
      onSnapshotSaved: (snapshot) => saved.push(snapshot),
    });

    await cache.save([{ id: 1 }, { id: 2 }]);

    assert.equal(uploads.length, 1);
    assert.match(uploads[0].url, /connector-raw\/catalog-cache\/MooncatShopify\/7\.json\.gz$/);
    assert.equal(uploads[0].contentType, "application/gzip");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].productCount, 2);
    const roundTrip = JSON.parse(zlib.gunzipSync(blobs.get(saved[0].url)).toString("utf-8"));
    assert.deepEqual(roundTrip, [{ id: 1 }, { id: 2 }]);
  });

  it("lets a continuation invocation reuse the snapshot instead of re-downloading", async () => {
    let snapshot = null;
    const first = createIngestionCatalogCache({
      jobId: 7,
      source: "MooncatShopify",
      snapshot: null,
      onSnapshotSaved: (s) => (snapshot = s),
    });
    await loadCatalogWithCache(first, countingFetcher([{ id: 1 }]));

    const fetcher = countingFetcher([{ id: "fresh" }]);
    const continuation = createIngestionCatalogCache({ jobId: 7, source: "MooncatShopify", snapshot });
    const products = await loadCatalogWithCache(continuation, fetcher);

    assert.equal(fetcher.calls, 0);
    assert.deepEqual(products, [{ id: 1 }]);
  });

  it("treats an empty snapshot as a miss and refetches", async () => {
    const emptyCache = { load: async () => [], save: async () => {} };
    const fetcher = countingFetcher([{ id: "fresh" }]);

    assert.deepEqual(await loadCatalogWithCache(emptyCache, fetcher), [{ id: "fresh" }]);
    assert.equal(fetcher.calls, 1);
  });

  it("falls back to a fresh download when the snapshot is unreadable", async () => {
    failReads = true;
    const logs = [];
    const cache = createIngestionCatalogCache({
      jobId: 7,
      source: "MooncatShopify",
      snapshot: { url: "https://acct/missing", productCount: 1, savedAt: "2026-10-14T00:00:00Z" },
      log: (level, message) => logs.push({ level, message }),
    });
    const fetcher = countingFetcher([{ id: "fresh" }]);

    assert.deepEqual(await loadCatalogWithCache(cache, fetcher), [{ id: "fresh" }]);
    assert.equal(fetcher.calls, 1);
    assert.ok(logs.some((entry) => entry.level === "warn"));
  });

  it("keeps working in memory when the snapshot upload fails", async () => {
    failUploads = true;
    const saved = [];
    const cache = createIngestionCatalogCache({
      jobId: 7,
      source: "MooncatShopify",
      snapshot: null,
      onSnapshotSaved: (s) => saved.push(s),
    });
    const fetcher = countingFetcher([{ id: 1 }]);

    await loadCatalogWithCache(cache, fetcher);
    await loadCatalogWithCache(cache, fetcher);

    assert.equal(fetcher.calls, 1);
    assert.equal(saved.length, 0);
  });

  it("skips blob storage entirely when no raw container is configured", async () => {
    delete process.env.CONNECTOR_RAW_CONTAINER;
    const cache = createIngestionCatalogCache({ jobId: 7, source: "MooncatShopify", snapshot: null });

    await cache.save([{ id: 1 }]);

    assert.equal(uploads.length, 0);
    assert.deepEqual(await cache.load(), [{ id: 1 }]);
  });
});

describe("readCatalogSnapshotFromMetrics", () => {
  it("reads a valid pointer and rejects malformed ones", () => {
    const snapshot = { url: "https://x", productCount: 3, savedAt: "2026-10-14T00:00:00Z" };
    assert.deepEqual(readCatalogSnapshotFromMetrics({ catalogSnapshot: snapshot }), snapshot);
    assert.equal(readCatalogSnapshotFromMetrics({ catalogSnapshot: { url: 5 } }), null);
    assert.equal(readCatalogSnapshotFromMetrics({}), null);
    assert.equal(readCatalogSnapshotFromMetrics(null), null);
  });
});
