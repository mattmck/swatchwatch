import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cropPixels } from "./frame-capture";

describe("cropPixels", () => {
  const size = { width: 1080, height: 1920 };

  it("is the whole frame without a crop", () => {
    assert.deepEqual(cropPixels(size, null), { sx: 0, sy: 0, sw: 1080, sh: 1920 });
  });

  it("covers the cropped part in whole pixels", () => {
    assert.deepEqual(cropPixels(size, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }), { sx: 270, sy: 480, sw: 540, sh: 960 });
  });

  it("stays inside the frame and is never empty", () => {
    assert.deepEqual(cropPixels(size, { x: 0.9, y: -1, w: 0.5, h: 1.2 }), { sx: 972, sy: 0, sw: 108, sh: 384 });
    const tiny = cropPixels(size, { x: 1, y: 1, w: 0, h: 0 });
    assert.ok(tiny.sw >= 1 && tiny.sh >= 1 && tiny.sx + tiny.sw <= 1080 && tiny.sy + tiny.sh <= 1920);
  });
});
