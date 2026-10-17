/**
 * Unit tests for lib/nail-photo-image (#270): upload parsing + privacy normalization.
 *
 * Uses real sharp: the point is to prove that GPS/EXIF/XMP/ICC metadata does not survive, that
 * the EXIF orientation is applied to the pixels, and that non-images and oversize uploads are
 * refused (fail closed) rather than stored as-is.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const {
  NailPhotoInputError,
  parseNailPhotoDataUrl,
  normalizeNailPhoto,
  NAIL_PHOTO_OUTPUT_CONTENT_TYPE,
  NAIL_PHOTO_MAX_INPUT_PIXELS,
  NAIL_PHOTO_MAX_CONCURRENT_DECODES,
} = require("../dist/lib/nail-photo-image");
const zlib = require("node:zlib");

/** A PNG whose header claims width×height but carries almost no pixel data (decode-bomb shape). */
function pngHeaderClaiming(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.alloc(16))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const { NAIL_PHOTO_MAX_UPLOAD_BYTES, NAIL_PHOTO_MAX_EDGE } = require("swatchwatch-shared");

function dataUrl(type, bytes) {
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** A JPEG carrying GPS coordinates, camera make/model, an XMP packet, an ICC profile and orientation 6. */
async function makeTaggedJpeg({ width = 40, height = 20 } = {}) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 90 } } })
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: "LeakyPhone", Model: "Model X", Copyright: "Jane Doe" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "0/1 7/1 0/1" },
    })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Jane Doe"/></rdf:RDF></x:xmpmeta>')
    .jpeg()
    .toBuffer();
}

function assertInputError(error, status, pattern) {
  assert.ok(error instanceof NailPhotoInputError, `expected NailPhotoInputError, got ${error}`);
  assert.equal(error.status, status);
  if (pattern) assert.match(error.message, pattern);
  return true;
}

describe("lib/nail-photo-image — parseNailPhotoDataUrl", () => {
  it("accepts jpeg/png/webp/heic/heif data URLs and returns the decoded bytes", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "IMAGE/JPEG"]) {
      const parsed = parseNailPhotoDataUrl(dataUrl(type, "abc"));
      assert.equal(parsed.declaredType, type.toLowerCase());
      assert.equal(parsed.bytes.toString(), "abc");
    }
  });

  it("tolerates whitespace inside the base64 payload", () => {
    const parsed = parseNailPhotoDataUrl("data:image/png;base64,YW\nJj");
    assert.equal(parsed.bytes.toString(), "abc");
  });

  it("rejects non-strings, non-data URLs and remote URLs (400)", () => {
    for (const value of [undefined, null, 42, {}, "", "https://example.com/a.jpg", "blob:http://x/1"]) {
      assert.throws(() => parseNailPhotoDataUrl(value), (e) => assertInputError(e, 400));
    }
  });

  it("rejects unsupported declared types such as gif and svg (415)", () => {
    for (const type of ["image/gif", "image/svg+xml", "text/plain", "application/octet-stream"]) {
      assert.throws(() => parseNailPhotoDataUrl(dataUrl(type, "abc")), (e) => assertInputError(e, 415));
    }
  });

  it("rejects non-base64 data URLs and malformed base64 (400)", () => {
    assert.throws(() => parseNailPhotoDataUrl("data:image/png,abc"), (e) => assertInputError(e, 400, /base64/));
    assert.throws(() => parseNailPhotoDataUrl("data:image/png;base64,ab$c"), (e) => assertInputError(e, 400));
    assert.throws(() => parseNailPhotoDataUrl("data:image/png;base64,abc"), (e) => assertInputError(e, 400));
    assert.throws(() => parseNailPhotoDataUrl("data:image/png;base64,"), (e) => assertInputError(e, 400, /empty/));
  });

  it("rejects payloads over the size limit before decoding them (413)", () => {
    const tooBig = "A".repeat(Math.ceil(NAIL_PHOTO_MAX_UPLOAD_BYTES / 3) * 4 + 4);
    assert.throws(() => parseNailPhotoDataUrl(`data:image/jpeg;base64,${tooBig}`), (e) => assertInputError(e, 413));
    assert.throws(() => parseNailPhotoDataUrl(dataUrl("image/jpeg", "x".repeat(11)), 10), (e) => assertInputError(e, 413));
  });
});

describe("lib/nail-photo-image — normalizeNailPhoto", () => {
  it("removes EXIF (incl. GPS), XMP and ICC metadata and applies the orientation", async () => {
    const input = await makeTaggedJpeg({ width: 40, height: 20 });
    const before = await sharp(input).metadata();
    assert.ok(before.exif && before.xmp && before.icc, "fixture must carry metadata");
    assert.equal(before.orientation, 6);
    assert.ok(input.includes(Buffer.from("LeakyPhone")), "fixture must contain the camera make");

    const out = await normalizeNailPhoto(input);
    assert.equal(out.contentType, NAIL_PHOTO_OUTPUT_CONTENT_TYPE);
    const after = await sharp(out.bytes).metadata();
    assert.equal(after.format, "jpeg");
    assert.equal(after.exif, undefined);
    assert.equal(after.xmp, undefined);
    assert.equal(after.iptc, undefined);
    assert.equal(after.icc, undefined);
    assert.equal(after.orientation, undefined);
    // Orientation 6 = rotate 90°: the stored pixels are upright (portrait).
    assert.equal(out.width, 20);
    assert.equal(out.height, 40);
    assert.equal(after.width, 20);
    assert.equal(after.height, 40);
    for (const needle of ["LeakyPhone", "Model X", "Jane Doe", "Exif", "GPS"]) {
      assert.ok(!out.bytes.includes(Buffer.from(needle)), `output still contains ${needle}`);
    }
    assert.match(out.checksumSha256, /^[0-9a-f]{64}$/);
  });

  it("re-encodes PNG and WebP to JPEG, flattening transparency onto white", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    const fromPng = await normalizeNailPhoto(png);
    const { data } = await sharp(fromPng.bytes).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[0] > 240 && data[1] > 240 && data[2] > 240, "transparent pixels become white");

    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#3366ff" } }).webp().toBuffer();
    const fromWebp = await normalizeNailPhoto(webp);
    assert.equal((await sharp(fromWebp.bytes).metadata()).format, "jpeg");
  });

  it("downscales to the max edge and never upscales", async () => {
    const big = await sharp({ create: { width: 300, height: 120, channels: 3, background: "#ff00aa" } }).jpeg().toBuffer();
    const scaled = await normalizeNailPhoto(big, { maxEdge: 100 });
    assert.equal(scaled.width, 100);
    assert.equal(scaled.height, 40);
    const small = await normalizeNailPhoto(big);
    assert.ok(NAIL_PHOTO_MAX_EDGE >= 300);
    assert.equal(small.width, 300);
    assert.equal(small.height, 120);
  });

  it("refuses bytes that are not an image, whatever type was declared (415)", async () => {
    await assert.rejects(normalizeNailPhoto(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), (e) =>
      assertInputError(e, 415)
    );
    await assert.rejects(normalizeNailPhoto(Buffer.from("definitely not an image")), (e) => assertInputError(e, 415));
  });

  it("refuses decodable formats outside the allowlist, e.g. GIF and TIFF (415)", async () => {
    const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#00ff00" } }).gif().toBuffer();
    await assert.rejects(normalizeNailPhoto(gif), (e) => assertInputError(e, 415));
    const tiff = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#00ff00" } }).tiff().toBuffer();
    await assert.rejects(normalizeNailPhoto(tiff), (e) => assertInputError(e, 415));
  });

  it("refuses a truncated JPEG instead of storing it (fail closed, 415)", async () => {
    const jpeg = await makeTaggedJpeg();
    await assert.rejects(normalizeNailPhoto(jpeg.subarray(0, Math.floor(jpeg.length / 2))), (e) => assertInputError(e, 415));
  });

  it("caps decoded pixels at 36 MP by default: a 48 MP header is refused before any decode (413)", async () => {
    assert.equal(NAIL_PHOTO_MAX_INPUT_PIXELS, 36_000_000);
    const started = Date.now();
    await assert.rejects(normalizeNailPhoto(pngHeaderClaiming(8000, 6000)), (e) => assertInputError(e, 413));
    assert.ok(Date.now() - started < 2000, "refused from the header, without decoding 48 MP");
  });

  it("limits concurrent decodes and still completes every queued upload", async () => {
    assert.equal(NAIL_PHOTO_MAX_CONCURRENT_DECODES, 2);
    const jpeg = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    const results = await Promise.all(Array.from({ length: 6 }, () => normalizeNailPhoto(jpeg)));
    assert.equal(results.length, 6);
    for (const result of results) assert.equal(result.width, 64);
  });

  it("refuses images over the decoded-pixel cap (413)", async () => {
    const jpeg = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    await assert.rejects(normalizeNailPhoto(jpeg, { maxInputPixels: 1000 }), (e) => assertInputError(e, 413));
  });
});
