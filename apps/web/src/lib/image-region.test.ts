import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MIN_REGION_FRACTION, regionFromDrag, regionStyle, regionToPixels } from "./image-region";

describe("image-region", () => {
  it("normalizes a drag in any direction to image fractions", () => {
    assert.deepEqual(regionFromDrag({ x: 300, y: 150 }, { x: 100, y: 50 }, 400, 200), {
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });
  });

  it("clamps drags that leave the image", () => {
    assert.deepEqual(regionFromDrag({ x: -50, y: -10 }, { x: 500, y: 100 }, 400, 200), {
      x: 0,
      y: 0,
      width: 1,
      height: 0.5,
    });
  });

  it("treats tiny boxes (a click) and zero-size elements as no selection", () => {
    assert.equal(regionFromDrag({ x: 10, y: 10 }, { x: 12, y: 80 }, 400, 200), null);
    assert.equal(MIN_REGION_FRACTION > 0, true);
    assert.equal(regionFromDrag({ x: 0, y: 0 }, { x: 10, y: 10 }, 0, 200), null);
  });

  it("maps a region to an in-bounds pixel rectangle", () => {
    assert.deepEqual(regionToPixels({ x: 0.25, y: 0.5, width: 0.5, height: 0.5 }, 640, 480), {
      sx: 160,
      sy: 240,
      sw: 320,
      sh: 240,
    });
    const edge = regionToPixels({ x: 0.999, y: 0.999, width: 0.5, height: 0.5 }, 100, 100);
    assert.ok(edge.sx + edge.sw <= 100 && edge.sy + edge.sh <= 100 && edge.sw >= 1 && edge.sh >= 1);
  });

  it("formats CSS percentages", () => {
    assert.deepEqual(regionStyle({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }), {
      left: "10.00%",
      top: "20.00%",
      width: "30.00%",
      height: "40.00%",
    });
  });
});
