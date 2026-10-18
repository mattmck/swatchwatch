/**
 * Unit tests for lib/blob-storage — media upload hardening (issue #46)
 *
 * Covers:
 * - validateImageUpload() rejects disallowed MIME types, oversize, and empty payloads
 * - validateImageUpload() accepts and normalizes allowed types
 * - stripImageMetadata() removes EXIF metadata from real image bytes
 * - uploadSourceImageToBlob() skips the PUT when the checksum-named blob already exists
 * - resize-on-ingest: oversize source images are downscaled/re-encoded and stored, downloads are capped
 * - pre-generated thumbnails: uploadSourceImageToBlob() / ensureImageVariants() write the missing
 *   `<blob>.c<n>.w<size>.webp` variants, skip existing ones, and never fail the ingest on a variant error
 * - userMediaContainer() default/override, and readBlobFromStorageUrl() scoped to it (#227)
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const sharp = require("sharp");

const {
  validateImageUpload,
  stripImageMetadata,
  normalizeSourceImage,
  resolveSourceImageLimits,
  uploadSourceImageToBlob,
  ensureImageVariants,
  readBlobFromStorageUrl,
  userMediaContainer,
  BlobAccessDeniedError,
  UPLOAD_LIMITS,
} = require("../dist/lib/blob-storage");

describe("lib/blob-storage — validateImageUpload", () => {
  it("normalizes and accepts an allowed image type within limits", () => {
    assert.equal(validateImageUpload("image/JPEG; charset=binary", 1024), "image/jpeg");
    assert.equal(validateImageUpload("image/png", 5), "image/png");
  });

  it("rejects unsupported MIME types", () => {
    assert.throws(() => validateImageUpload("image/svg+xml", 1024), /Unsupported image type/);
    assert.throws(() => validateImageUpload("application/pdf", 1024), /Unsupported image type/);
    assert.throws(() => validateImageUpload("", 1024), /Unsupported image type/);
  });

  it("rejects empty payloads", () => {
    assert.throws(() => validateImageUpload("image/png", 0), /empty/);
    assert.throws(() => validateImageUpload("image/png", -1), /empty/);
  });

  it("rejects payloads larger than the configured size limit", () => {
    assert.throws(
      () => validateImageUpload("image/png", UPLOAD_LIMITS.maxSizeBytes + 1),
      /too large/i
    );
  });
});

describe("lib/blob-storage — stripImageMetadata", () => {
  async function makeJpegWithExif() {
    return sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .withExif({ IFD0: { Copyright: "SwatchWatch", Make: "TestCam" } })
      .jpeg()
      .toBuffer();
  }

  it("removes EXIF metadata while preserving the image", async () => {
    const withExif = await makeJpegWithExif();
    const before = await sharp(withExif).metadata();
    assert.ok(before.exif, "fixture should contain EXIF metadata before stripping");

    const stripped = await stripImageMetadata(withExif);
    const after = await sharp(stripped).metadata();

    assert.equal(after.exif, undefined, "EXIF metadata should be removed");
    // Image is still a valid, decodable JPEG of the same dimensions.
    assert.equal(after.width, 8);
    assert.equal(after.height, 8);
    assert.equal(after.format, "jpeg");
  });

  it("returns the original bytes for undecodable input (graceful fallback)", async () => {
    const garbage = Buffer.from("not-an-image");
    const result = await stripImageMetadata(garbage);
    assert.ok(Buffer.isBuffer(result));
    assert.equal(result.toString(), "not-an-image");
  });
});

describe("lib/blob-storage — uploadSourceImageToBlob", () => {
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

  const VARIANT = /\.w(\d+)\.webp$/;

  async function runUpload(headStatus, variantHeadStatus = 200) {
    process.env.AZURE_STORAGE_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=${Buffer.from(
      "test-key"
    ).toString("base64")};EndpointSuffix=core.windows.net`;
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const methods = [];
    const variantCalls = [];
    global.fetch = async (url, init = {}) => {
      const method = init.method || "GET";
      const variant = String(url).match(VARIANT);
      if (variant) {
        variantCalls.push({ method, size: Number(variant[1]), body: init.body, headers: init.headers });
        return new Response(null, { status: method === "HEAD" ? variantHeadStatus : 201 });
      }
      methods.push(method);
      if (String(url).startsWith("https://shop.example/")) {
        return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      }
      if (method === "HEAD") {
        return new Response(null, { status: headStatus });
      }
      return new Response(null, { status: 201 });
    };

    const result = await uploadSourceImageToBlob({
      sourceImageUrl: "https://shop.example/p1.png",
      source: "TestShopify",
      externalId: "p1",
      skipContainerEnsure: true,
    });
    return { result, methods, variantCalls };
  }

  it("skips the upload when the blob already exists", async () => {
    const { result, methods } = await runUpload(200);
    assert.deepEqual(methods, ["GET", "HEAD"]);
    assert.match(result.storageUrl, /^https:\/\/testacct\.blob\.core\.windows\.net\/.+\/testshopify\/p1-[0-9a-f]{12}\.png$/);
    assert.match(result.checksumSha256, /^[0-9a-f]{64}$/);
  });

  it("uploads when the blob is missing", async () => {
    const { methods } = await runUpload(404);
    assert.deepEqual(methods, ["GET", "HEAD", "PUT"]);
  });

  it("still uploads when the existence check fails", async () => {
    const { methods } = await runUpload(500);
    assert.deepEqual(methods, ["GET", "HEAD", "PUT"]);
  });

  it("writes every missing thumbnail variant as square cover WebP next to a new blob", async () => {
    const { result, variantCalls } = await runUpload(404, 404);
    const puts = variantCalls.filter((call) => call.method === "PUT");
    assert.deepEqual(puts.map((call) => call.size).sort((a, b) => a - b), [64, 128, 256, 512]);
    for (const put of puts) {
      assert.equal(put.headers["Content-Type"], "image/webp");
      const meta = await sharp(Buffer.from(put.body)).metadata();
      assert.equal(meta.format, "webp");
      // The 4px fixture is never enlarged.
      assert.equal(meta.width, 4);
      assert.equal(meta.height, 4);
    }
    const heads = variantCalls.filter((call) => call.method === "HEAD");
    assert.equal(heads.length, 4);
    assert.match(result.storageUrl, /\.png$/, "the returned URL is still the original");
  });

  it("skips variants that are already stored", async () => {
    const { variantCalls } = await runUpload(404, 200);
    assert.deepEqual(variantCalls.map((call) => call.method), ["HEAD", "HEAD", "HEAD", "HEAD"]);
  });

  it("fills in missing variants when the original was already stored (re-ingest)", async () => {
    const { methods, variantCalls } = await runUpload(200, 404);
    assert.deepEqual(methods, ["GET", "HEAD"]);
    assert.equal(variantCalls.filter((call) => call.method === "PUT").length, 4);
  });

  it("does not fail the ingest when variant uploads fail", async () => {
    process.env.AZURE_STORAGE_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=${Buffer.from(
      "test-key"
    ).toString("base64")};EndpointSuffix=core.windows.net`;
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    global.fetch = async (url, init = {}) => {
      const method = init.method || "GET";
      if (String(url).startsWith("https://shop.example/")) {
        return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      }
      if (VARIANT.test(String(url))) {
        return new Response("boom", { status: method === "HEAD" ? 404 : 500 });
      }
      return new Response(null, { status: method === "HEAD" ? 404 : 201 });
    };
    const result = await uploadSourceImageToBlob({
      sourceImageUrl: "https://shop.example/p1.png",
      source: "TestShopify",
      externalId: "p1",
      skipContainerEnsure: true,
    });
    assert.match(result.storageUrl, /\/testshopify\/p1-[0-9a-f]{12}\.png$/);
  });
});

describe("lib/blob-storage — ensureImageVariants", () => {
  const originalFetch = global.fetch;
  const CONNECTION = `DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=${Buffer.from(
    "test-key"
  ).toString("base64")};EndpointSuffix=core.windows.net`;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockStorage(existing) {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      const method = init.method || "GET";
      const name = decodeURIComponent(new URL(String(url)).pathname);
      calls.push({ method, name, body: init.body });
      if (method === "HEAD") return new Response(null, { status: existing.has(name) ? 200 : 404 });
      return new Response(null, { status: 201 });
    };
    return calls;
  }

  it("does not load the original when every variant exists", async () => {
    const sizes = [64, 128, 256, 512];
    mockStorage(new Set(sizes.map((size) => `/source-images/shop/a.jpg.c1.w${size}.webp`)));
    let loaded = false;
    const result = await ensureImageVariants({
      connectionString: CONNECTION,
      containerName: "source-images",
      blobName: "shop/a.jpg",
      bytes: async () => {
        loaded = true;
        return Buffer.alloc(0);
      },
    });
    assert.equal(loaded, false);
    assert.deepEqual(result, { written: [], existing: sizes, failed: [] });
  });

  it("renders only the missing sizes as squares", async () => {
    const calls = mockStorage(new Set(["/source-images/shop/a.jpg.c1.w64.webp"]));
    const wide = await sharp({
      create: { width: 1200, height: 600, channels: 3, background: { r: 200, g: 40, b: 90 } },
    })
      .jpeg()
      .toBuffer();
    const result = await ensureImageVariants({
      connectionString: CONNECTION,
      containerName: "source-images",
      blobName: "shop/a.jpg",
      bytes: async () => wide,
    });
    assert.deepEqual(result, { written: [128, 256, 512], existing: [64], failed: [] });
    const puts = calls.filter((call) => call.method === "PUT");
    for (const put of puts) {
      const size = Number(put.name.match(/\.w(\d+)\.webp$/)[1]);
      const meta = await sharp(Buffer.from(put.body)).metadata();
      assert.equal(meta.width, size);
      assert.equal(meta.height, size);
    }
  });

  it("reports sizes that fail to render as failed", async () => {
    mockStorage(new Set());
    const result = await ensureImageVariants({
      connectionString: CONNECTION,
      containerName: "source-images",
      blobName: "shop/a.jpg",
      bytes: Buffer.from("not-an-image"),
      sizes: [64, 128],
    });
    assert.deepEqual(result, { written: [], existing: [], failed: [64, 128] });
  });
});

/** Incompressible RGB noise, so encoded size tracks pixel count. */
function noiseImage(width, height) {
  return sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } });
}

describe("lib/blob-storage — resolveSourceImageLimits", () => {
  const saved = {};
  const names = ["SOURCE_IMAGE_MAX_EDGE_PX", "SOURCE_IMAGE_MAX_DOWNLOAD_BYTES"];
  beforeEach(() => {
    for (const name of names) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("defaults to a 2048px long edge and a 25 MB download cap", () => {
    assert.deepEqual(resolveSourceImageLimits(), {
      maxEdgePx: 2048,
      maxDownloadBytes: 25 * 1024 * 1024,
    });
  });

  it("honours overrides and clamps them", () => {
    process.env.SOURCE_IMAGE_MAX_EDGE_PX = "1024";
    process.env.SOURCE_IMAGE_MAX_DOWNLOAD_BYTES = String(40 * 1024 * 1024);
    assert.deepEqual(resolveSourceImageLimits(), { maxEdgePx: 1024, maxDownloadBytes: 40 * 1024 * 1024 });

    process.env.SOURCE_IMAGE_MAX_EDGE_PX = "10";
    process.env.SOURCE_IMAGE_MAX_DOWNLOAD_BYTES = "1";
    assert.deepEqual(resolveSourceImageLimits(), {
      maxEdgePx: 256,
      maxDownloadBytes: UPLOAD_LIMITS.maxSizeBytes,
    });

    process.env.SOURCE_IMAGE_MAX_EDGE_PX = "999999";
    process.env.SOURCE_IMAGE_MAX_DOWNLOAD_BYTES = "nope";
    assert.deepEqual(resolveSourceImageLimits(), { maxEdgePx: 8192, maxDownloadBytes: 25 * 1024 * 1024 });
  });
});

describe("lib/blob-storage — normalizeSourceImage", () => {
  it("downscales an image whose long edge exceeds the limit, keeping its format and aspect", async () => {
    const jpeg = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: { r: 200, g: 40, b: 90 } },
    })
      .withExif({ IFD0: { Make: "TestCam" } })
      .jpeg()
      .toBuffer();

    const result = await normalizeSourceImage(jpeg, "image/jpeg", { maxEdgePx: 2048 });
    const meta = await sharp(result.bytes).metadata();
    assert.equal(result.resized, true);
    assert.equal(result.contentType, "image/jpeg");
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 2048);
    assert.equal(meta.height, 683);
    assert.equal(meta.exif, undefined, "metadata is still stripped");
  });

  it("leaves images within the limit at their size and matches stripImageMetadata byte-for-byte", async () => {
    const png = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const result = await normalizeSourceImage(png, "image/png", { maxEdgePx: 2048 });
    assert.equal(result.resized, false);
    assert.equal(result.contentType, "image/png");
    // Unchanged pipeline keeps checksums (and so checksum-named blobs) stable across releases.
    assert.ok(result.bytes.equals(await stripImageMetadata(png)));
  });

  it("re-encodes as WebP when the format-preserving output is still over the stored-size guard", async () => {
    const png = await noiseImage(300, 300).png().toBuffer();
    const maxStoredBytes = Math.floor(png.length * 0.8);

    const result = await normalizeSourceImage(png, "image/png", { maxEdgePx: 2048, maxStoredBytes });
    assert.equal(result.contentType, "image/webp");
    assert.equal((await sharp(result.bytes).metadata()).format, "webp");
    assert.ok(result.bytes.length <= maxStoredBytes);
  });

  it("returns the original bytes when the image cannot be decoded", async () => {
    const garbage = Buffer.from("not-an-image");
    const result = await normalizeSourceImage(garbage, "image/jpeg", { maxEdgePx: 2048 });
    assert.equal(result.resized, false);
    assert.equal(result.contentType, "image/jpeg");
    assert.equal(result.bytes.toString(), "not-an-image");
  });
});

describe("lib/blob-storage — uploadSourceImageToBlob size handling", () => {
  const originalFetch = global.fetch;
  const originalConnection = process.env.AZURE_STORAGE_CONNECTION;
  const originalCap = process.env.SOURCE_IMAGE_MAX_DOWNLOAD_BYTES;

  beforeEach(() => {
    process.env.AZURE_STORAGE_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=${Buffer.from(
      "test-key"
    ).toString("base64")};EndpointSuffix=core.windows.net`;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [name, value] of [
      ["AZURE_STORAGE_CONNECTION", originalConnection],
      ["SOURCE_IMAGE_MAX_DOWNLOAD_BYTES", originalCap],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** Serves `image` for the source URL and records the blob PUT. */
  function mockFetch(makeSourceResponse) {
    const calls = { methods: [], putBody: null, putHeaders: null, variantPuts: 0 };
    global.fetch = async (url, init = {}) => {
      const method = init.method || "GET";
      if (/\.w\d+\.webp$/.test(String(url))) {
        if (method === "PUT") calls.variantPuts += 1;
        return new Response(null, { status: method === "HEAD" ? 404 : 201 });
      }
      calls.methods.push(method);
      if (String(url).startsWith("https://shop.example/")) return makeSourceResponse();
      if (method === "HEAD") return new Response(null, { status: 404 });
      if (method === "PUT") {
        calls.putBody = Buffer.from(init.body);
        calls.putHeaders = init.headers;
        calls.putUrl = String(url);
      }
      return new Response(null, { status: 201 });
    };
    return calls;
  }

  const upload = (name = "big.png") =>
    uploadSourceImageToBlob({
      sourceImageUrl: `https://shop.example/${name}`,
      source: "TestShopify",
      externalId: "p1",
      skipContainerEnsure: true,
    });

  it("stores an image over 5 MB instead of rejecting it", async () => {
    // ~6.75 MB of noise as PNG: within the 2048px edge, so only the size guard forces a re-encode.
    const png = await noiseImage(1500, 1500).png().toBuffer();
    assert.ok(png.length > UPLOAD_LIMITS.maxSizeBytes, "fixture must exceed the old 5 MB limit");
    const calls = mockFetch(() => new Response(png, { status: 200, headers: { "content-type": "image/png" } }));

    const result = await upload();
    assert.deepEqual(calls.methods, ["GET", "HEAD", "PUT"]);
    assert.ok(calls.putBody.length <= UPLOAD_LIMITS.maxSizeBytes);
    assert.equal(result.contentType, "image/webp");
    assert.equal(result.sizeBytes, calls.putBody.length);
    assert.equal(calls.putHeaders["Content-Type"], "image/webp");
    assert.match(calls.putUrl, /\/testshopify\/p1-[0-9a-f]{12}\.webp$/);
  });

  it("stores a downscaled copy of an image whose long edge exceeds the limit", async () => {
    const jpeg = await sharp({
      create: { width: 3000, height: 3000, channels: 3, background: { r: 30, g: 60, b: 90 } },
    })
      .jpeg()
      .toBuffer();
    const calls = mockFetch(() => new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }));

    const result = await upload("big.jpg");
    const meta = await sharp(calls.putBody).metadata();
    assert.equal(meta.width, 2048);
    assert.equal(meta.height, 2048);
    assert.equal(result.contentType, "image/jpeg");
  });

  it("refuses a download whose Content-Length exceeds the download cap", async () => {
    process.env.SOURCE_IMAGE_MAX_DOWNLOAD_BYTES = String(UPLOAD_LIMITS.maxSizeBytes);
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const calls = mockFetch(
      () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": String(UPLOAD_LIMITS.maxSizeBytes + 1) },
        })
    );

    await assert.rejects(upload(), /too large to download/i);
    assert.deepEqual(calls.methods, ["GET"]);
    assert.equal(cancelled, true, "the body stream is cancelled, not drained");
  });

  it("stops reading a body without Content-Length once it passes the download cap", async () => {
    process.env.SOURCE_IMAGE_MAX_DOWNLOAD_BYTES = String(UPLOAD_LIMITS.maxSizeBytes);
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        sent += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const calls = mockFetch(() => new Response(body, { status: 200, headers: { "content-type": "image/jpeg" } }));

    await assert.rejects(upload(), /too large to download/i);
    assert.deepEqual(calls.methods, ["GET"]);
    assert.ok(sent <= UPLOAD_LIMITS.maxSizeBytes + 2 * 1024 * 1024, `read ${sent} bytes before stopping`);
  });
});

describe("lib/blob-storage — userMediaContainer (#227)", () => {
  const ENV_KEYS = ["AZURE_STORAGE_CONNECTION", "USER_MEDIA_CONTAINER", "SOURCE_IMAGE_CONTAINER"];
  const ACCOUNT_KEY = Buffer.from("test-key").toString("base64");
  const originalFetch = global.fetch;
  let savedEnv = {};
  let fetchCalls = [];

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    fetchCalls = [];
    global.fetch = async (url, init = {}) => {
      fetchCalls.push({ url: String(url), method: init.method || "GET" });
      return new Response(Buffer.from("private-bytes"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function useAccountEndpoint() {
    process.env.AZURE_STORAGE_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=${ACCOUNT_KEY};EndpointSuffix=core.windows.net`;
  }

  function useAzuriteEndpoint() {
    process.env.AZURE_STORAGE_CONNECTION =
      `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${ACCOUNT_KEY};` +
      "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
  }

  function readScoped(url) {
    return readBlobFromStorageUrl(url, { allowedContainers: [userMediaContainer()] });
  }

  it("defaults to nail-photos", () => {
    assert.equal(userMediaContainer(), "nail-photos");
  });

  it("honours USER_MEDIA_CONTAINER", () => {
    process.env.USER_MEDIA_CONTAINER = "custom-media";
    assert.equal(userMediaContainer(), "custom-media");
  });

  it("trims and lowercases the override, falling back to nail-photos when blank", () => {
    process.env.USER_MEDIA_CONTAINER = "  Custom-Media  ";
    assert.equal(userMediaContainer(), "custom-media");
    process.env.USER_MEDIA_CONTAINER = "   ";
    assert.equal(userMediaContainer(), "nail-photos");
  });

  it("throws ImageProxyConfigError when it equals SOURCE_IMAGE_CONTAINER (fail closed)", () => {
    const { ImageProxyConfigError } = require("../dist/lib/image-proxy");
    process.env.USER_MEDIA_CONTAINER = "source-images";
    assert.throws(() => userMediaContainer(), ImageProxyConfigError);
    process.env.USER_MEDIA_CONTAINER = " Catalog ";
    process.env.SOURCE_IMAGE_CONTAINER = "catalog";
    assert.throws(() => userMediaContainer(), ImageProxyConfigError);
    delete process.env.USER_MEDIA_CONTAINER;
    process.env.SOURCE_IMAGE_CONTAINER = "nail-photos";
    assert.throws(() => userMediaContainer(), ImageProxyConfigError);
  });

  it("isUserMediaStorageUrl matches only the user-media container (virtual-host and path-style)", () => {
    const { isUserMediaStorageUrl } = require("../dist/lib/blob-storage");
    assert.equal(isUserMediaStorageUrl("https://testacct.blob.core.windows.net/nail-photos/users/42/a.jpg"), true);
    assert.equal(isUserMediaStorageUrl("https://testacct.blob.core.windows.net/NAIL-PHOTOS/users/42/a.jpg"), true);
    assert.equal(isUserMediaStorageUrl("http://127.0.0.1:10000/devstoreaccount1/nail-photos/users/42/a.jpg"), true);
    assert.equal(isUserMediaStorageUrl("http://127.0.0.1:10000/nail-photos/a.jpg"), false);
    assert.equal(isUserMediaStorageUrl("https://testacct.blob.core.windows.net/source-images/a.jpg"), false);
    assert.equal(isUserMediaStorageUrl("https://testacct.blob.core.windows.net/nail%2Dphotos/a.jpg"), false);
    assert.equal(isUserMediaStorageUrl("https://testacct.blob.core.windows.net/"), false);
    assert.equal(isUserMediaStorageUrl("not a url"), false);
    process.env.USER_MEDIA_CONTAINER = "custom-media";
    assert.equal(isUserMediaStorageUrl("https://testacct.blob.core.windows.net/custom-media/a.jpg"), true);
    assert.equal(isUserMediaStorageUrl("https://testacct.blob.core.windows.net/nail-photos/a.jpg"), false);
  });

  it("is independent of SOURCE_IMAGE_CONTAINER", () => {
    process.env.SOURCE_IMAGE_CONTAINER = "catalog";
    assert.equal(userMediaContainer(), "nail-photos");
  });

  it("allows a read inside the user-media container", async () => {
    useAccountEndpoint();
    const url = "https://testacct.blob.core.windows.net/nail-photos/users/42/a.jpg";
    const result = await readScoped(url);
    assert.equal(result.bytes.toString(), "private-bytes");
    assert.equal(result.contentType, "image/jpeg");
    assert.deepEqual(fetchCalls, [{ url, method: "GET" }]);
  });

  it("denies a catalog blob when scoped to the user-media container", async () => {
    useAccountEndpoint();
    await assert.rejects(
      readScoped("https://testacct.blob.core.windows.net/source-images/brand/a.png"),
      BlobAccessDeniedError
    );
    assert.equal(fetchCalls.length, 0);
  });

  it("follows the USER_MEDIA_CONTAINER override", async () => {
    useAccountEndpoint();
    process.env.USER_MEDIA_CONTAINER = "custom-media";
    await readScoped("https://testacct.blob.core.windows.net/custom-media/users/42/a.jpg");
    await assert.rejects(
      readScoped("https://testacct.blob.core.windows.net/nail-photos/users/42/a.jpg"),
      BlobAccessDeniedError
    );
    assert.equal(fetchCalls.length, 1);
  });

  it("works with path-style (Azurite) endpoints", async () => {
    useAzuriteEndpoint();
    const url = "http://127.0.0.1:10000/devstoreaccount1/nail-photos/users/42/a.jpg";
    await readScoped(url);
    assert.deepEqual(fetchCalls, [{ url, method: "GET" }]);
    await assert.rejects(
      readScoped("http://127.0.0.1:10000/devstoreaccount1/source-images/brand/a.png"),
      BlobAccessDeniedError
    );
    assert.equal(fetchCalls.length, 1);
  });
});

describe("lib/blob-storage — deleteBlobFromStorageUrl (#270)", () => {
  const { deleteBlobFromStorageUrl } = require("../dist/lib/blob-storage");
  const ENV_KEYS = ["AZURE_STORAGE_CONNECTION", "USER_MEDIA_CONTAINER", "SOURCE_IMAGE_CONTAINER"];
  const ACCOUNT_KEY = Buffer.from("test-key").toString("base64");
  const originalFetch = global.fetch;
  let savedEnv = {};
  let fetchCalls = [];
  let nextStatus = 202;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.AZURE_STORAGE_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=${ACCOUNT_KEY};EndpointSuffix=core.windows.net`;
    fetchCalls = [];
    nextStatus = 202;
    global.fetch = async (url, init = {}) => {
      fetchCalls.push({ url: String(url), method: init.method || "GET", auth: init.headers?.Authorization });
      return new Response(null, { status: nextStatus });
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const PHOTO_URL = "https://testacct.blob.core.windows.net/nail-photos/1/7001/a.jpg";

  it("sends a signed DELETE for a blob inside the allowed container", async () => {
    assert.equal(await deleteBlobFromStorageUrl(PHOTO_URL, { allowedContainers: [userMediaContainer()] }), true);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].method, "DELETE");
    assert.equal(fetchCalls[0].url, PHOTO_URL);
    assert.match(fetchCalls[0].auth, /^SharedKey testacct:/);
  });

  it("returns false for a blob that is already gone (404)", async () => {
    nextStatus = 404;
    assert.equal(await deleteBlobFromStorageUrl(PHOTO_URL, { allowedContainers: ["nail-photos"] }), false);
  });

  it("throws on other storage errors", async () => {
    nextStatus = 500;
    await assert.rejects(deleteBlobFromStorageUrl(PHOTO_URL, { allowedContainers: ["nail-photos"] }), /Blob delete failed/);
  });

  it("refuses catalog blobs, other accounts, query strings and container-level URLs before any request", async () => {
    const scoped = { allowedContainers: ["nail-photos"] };
    for (const url of [
      "https://testacct.blob.core.windows.net/source-images/brand/a.png",
      "https://otheracct.blob.core.windows.net/nail-photos/1/7001/a.jpg",
      `${PHOTO_URL}?comp=metadata`,
      "https://testacct.blob.core.windows.net/nail-photos",
      "http://testacct.blob.core.windows.net/nail-photos/1/7001/a.jpg",
    ]) {
      await assert.rejects(deleteBlobFromStorageUrl(url, scoped), BlobAccessDeniedError, url);
    }
    assert.equal(fetchCalls.length, 0);
  });
});
