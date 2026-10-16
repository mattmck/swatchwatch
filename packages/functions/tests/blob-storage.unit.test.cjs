/**
 * Unit tests for lib/blob-storage — media upload hardening (issue #46)
 *
 * Covers:
 * - validateImageUpload() rejects disallowed MIME types, oversize, and empty payloads
 * - validateImageUpload() accepts and normalizes allowed types
 * - stripImageMetadata() removes EXIF metadata from real image bytes
 * - uploadSourceImageToBlob() skips the PUT when the checksum-named blob already exists
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const {
  validateImageUpload,
  stripImageMetadata,
  uploadSourceImageToBlob,
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

  async function runUpload(headStatus) {
    process.env.AZURE_STORAGE_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=${Buffer.from(
      "test-key"
    ).toString("base64")};EndpointSuffix=core.windows.net`;
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const methods = [];
    global.fetch = async (url, init = {}) => {
      const method = init.method || "GET";
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
    return { result, methods };
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
});
