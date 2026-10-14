import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeScaledSize, outputMimeTypeFor } from "./image-downscale";

describe("computeScaledSize", () => {
  it("scales the longest edge down to maxEdge, preserving aspect ratio", () => {
    assert.deepEqual(computeScaledSize(4032, 3024, 640), { width: 640, height: 480 });
    assert.deepEqual(computeScaledSize(3024, 4032, 640), { width: 480, height: 640 });
  });

  it("never upscales small images", () => {
    assert.deepEqual(computeScaledSize(300, 200, 640), { width: 300, height: 200 });
  });

  it("keeps extreme aspect ratios at least 1px", () => {
    assert.deepEqual(computeScaledSize(10000, 2, 640), { width: 640, height: 1 });
  });

  it("guards against zero/invalid dimensions", () => {
    assert.deepEqual(computeScaledSize(0, 0, 640), { width: 1, height: 1 });
    assert.deepEqual(computeScaledSize(Number.NaN, 100, 640), { width: 1, height: 1 });
  });
});

describe("outputMimeTypeFor", () => {
  it("keeps PNG for formats that may have transparency", () => {
    assert.equal(outputMimeTypeFor("image/png"), "image/png");
    assert.equal(outputMimeTypeFor("image/GIF"), "image/png");
    assert.equal(outputMimeTypeFor("image/webp"), "image/png");
  });

  it("uses JPEG for photos", () => {
    assert.equal(outputMimeTypeFor("image/jpeg"), "image/jpeg");
    assert.equal(outputMimeTypeFor("image/heic"), "image/jpeg");
  });
});
