/**
 * Unit tests for lib/blob-storage — media upload hardening (issue #46)
 *
 * Covers:
 * - validateImageUpload() rejects disallowed MIME types, oversize, and empty payloads
 * - validateImageUpload() accepts and normalizes allowed types
 * - stripImageMetadata() removes EXIF metadata from real image bytes
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const {
  validateImageUpload,
  stripImageMetadata,
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
