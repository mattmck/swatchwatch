import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guideRegionInFrame, guideRegionForFrame } from "./guide-region";

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-3, `expected ${expected}, got ${actual}`);

function assertRegion(
  region: ReturnType<typeof guideRegionInFrame>,
  expected: { x: number; y: number; w: number; h: number },
) {
  assert.ok(region, "expected a region");
  close(region.x, expected.x);
  close(region.y, expected.y);
  close(region.w, expected.w);
  close(region.h, expected.h);
  assert.ok(region.x + region.w <= 1 + 1e-6 && region.y + region.h <= 1 + 1e-6);
}

// The front outline on a 300×400 (3:4) preview: h 80 % of the box, aspect 1:2, centred.
const PORTRAIT_BOX = { width: 300, height: 400 };
const FRONT_IN_PORTRAIT = { left: 70, top: 40, width: 160, height: 320 };

describe("guideRegionInFrame (object-cover preview → frame fractions)", () => {
  it("maps exactly when the preview and the video have the same aspect", () => {
    assertRegion(
      guideRegionInFrame({
        guide: { left: 160, top: 36, width: 160, height: 288 },
        element: { width: 640, height: 360 },
        frame: { width: 1280, height: 720 },
      }),
      { x: 0.25, y: 0.1, w: 0.25, h: 0.8 },
    );
  });

  it("portrait video taller than a 3:4 preview: the top and bottom are cropped", () => {
    // 720×1280 scaled to 300×533.3, 66.7 px cut off top and bottom.
    assertRegion(
      guideRegionInFrame({ guide: FRONT_IN_PORTRAIT, element: PORTRAIT_BOX, frame: { width: 720, height: 1280 } }),
      { x: 70 / 300, y: (40 + 400 / 6) / (1600 / 3), w: 160 / 300, h: 320 / (1600 / 3) },
    );
  });

  it("landscape video in a portrait preview: the sides are cropped", () => {
    // 1280×720 scaled to 711.1×400, 205.6 px cut off left and right.
    const dw = 1280 * (400 / 720);
    assertRegion(
      guideRegionInFrame({ guide: FRONT_IN_PORTRAIT, element: PORTRAIT_BOX, frame: { width: 1280, height: 720 } }),
      { x: (70 + (dw - 300) / 2) / dw, y: 0.1, w: 160 / dw, h: 0.8 },
    );
  });

  it("4:3 video in a wider 16:9 preview: the top and bottom are cropped", () => {
    // 640×480 scaled to 640×480 in a 640×360 box, 60 px cut off top and bottom.
    assertRegion(
      guideRegionInFrame({
        guide: { left: 257, top: 117, width: 126, height: 126 }, // glass: 35 % of 360
        element: { width: 640, height: 360 },
        frame: { width: 640, height: 480 },
      }),
      { x: 257 / 640, y: (117 + 60) / 480, w: 126 / 640, h: 126 / 480 },
    );
  });

  it("portrait video in a wider 16:9 preview (phone rotated, desktop layout)", () => {
    // 720×1280 in 640×360: scale 640/720, displayed 640×1137.8, 388.9 px cut top and bottom.
    const dh = 1280 * (640 / 720);
    assertRegion(
      guideRegionInFrame({
        guide: { left: 194, top: 36, width: 252, height: 288 },
        element: { width: 640, height: 360 },
        frame: { width: 720, height: 1280 },
      }),
      { x: 194 / 640, y: (36 + (dh - 360) / 2) / dh, w: 252 / 640, h: 288 / dh },
    );
  });

  it("does not depend on the uploaded size: fractions hold for any uniform downscale", () => {
    const a = guideRegionInFrame({ guide: FRONT_IN_PORTRAIT, element: PORTRAIT_BOX, frame: { width: 1080, height: 1920 } });
    const b = guideRegionInFrame({ guide: FRONT_IN_PORTRAIT, element: PORTRAIT_BOX, frame: { width: 900, height: 1600 } });
    assert.deepEqual(a, b);
  });

  it("mirrored preview flips x", () => {
    assertRegion(
      guideRegionInFrame({
        guide: { left: 64, top: 36, width: 160, height: 288 },
        element: { width: 640, height: 360 },
        frame: { width: 1280, height: 720 },
        mirrored: true,
      }),
      { x: 1 - (64 + 160) / 640, y: 0.1, w: 0.25, h: 0.8 },
    );
  });

  it("sends nothing for a guide outside the preview, a degenerate one or missing sizes", () => {
    const frame = { width: 1280, height: 720 };
    const element = { width: 640, height: 360 };
    assert.equal(guideRegionInFrame({ guide: { left: -40, top: 36, width: 160, height: 288 }, element, frame }), null);
    assert.equal(guideRegionInFrame({ guide: { left: 600, top: 36, width: 160, height: 288 }, element, frame }), null);
    assert.equal(guideRegionInFrame({ guide: { left: 10, top: 10, width: 10, height: 288 }, element, frame }), null);
    assert.equal(guideRegionInFrame({ guide: FRONT_IN_PORTRAIT, element: { width: 0, height: 400 }, frame }), null);
    assert.equal(guideRegionInFrame({ guide: FRONT_IN_PORTRAIT, element: PORTRAIT_BOX, frame: { width: 0, height: 0 } }), null);
    assert.equal(
      guideRegionInFrame({ guide: { left: Number.NaN, top: 0, width: 100, height: 100 }, element, frame }),
      null,
    );
  });

  it("tolerates sub-pixel overhang from layout rounding and clamps it", () => {
    const region = guideRegionInFrame({
      guide: { left: -0.4, top: 0, width: 640.6, height: 360.3 },
      element: { width: 640, height: 360 },
      frame: { width: 1280, height: 720 },
    });
    assertRegion(region, { x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("guideRegionForFrame (which frames get a region)", () => {
  const region = { x: 0.3, y: 0.15, w: 0.4, h: 0.7 };
  const shown = { guide: "front" as const, region };

  it("sends the outline for a bottle surface photo taken with the shutter or auto-shutter", () => {
    for (const trigger of ["shutter", "auto"] as const) {
      assert.deepEqual(guideRegionForFrame({ bottleCapture: true, surface: "front", trigger, shown }), region);
    }
  });

  it("sends nothing while the flag is off, for a non-surface frame, an upload or a live scan", () => {
    assert.equal(guideRegionForFrame({ bottleCapture: false, surface: "front", trigger: "shutter", shown }), null);
    assert.equal(guideRegionForFrame({ bottleCapture: true, surface: null, trigger: "shutter", shown }), null);
    assert.equal(guideRegionForFrame({ bottleCapture: true, surface: "front", trigger: "file", shown }), null);
    assert.equal(guideRegionForFrame({ bottleCapture: true, surface: "front", trigger: "live-scan", shown }), null);
  });

  it("sends nothing when the outline shown was not the surface's own, or none was measured", () => {
    assert.equal(guideRegionForFrame({ bottleCapture: true, surface: "glass", trigger: "shutter", shown }), null);
    assert.equal(
      guideRegionForFrame({ bottleCapture: true, surface: "front", trigger: "shutter", shown: { guide: "label", region } }),
      null,
    );
    assert.equal(guideRegionForFrame({ bottleCapture: true, surface: "front", trigger: "shutter", shown: null }), null);
  });
});
