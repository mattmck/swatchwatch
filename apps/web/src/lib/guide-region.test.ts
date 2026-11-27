import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GUIDE_CROP_FACTOR, GUIDE_LABEL_SLACK, planGuideCrop, regionWithinCrop, scaleRegion } from "./guide-region";

// guideRegionInFrame / guideRegionForFrame are shared with the Expo app and tested in
// packages/shared/src/capture/guide-region.test.ts; this file covers the web's photo cut.

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-3, `expected ${expected}, got ${actual}`);

function assertRegion(
  region: ReturnType<typeof scaleRegion> | null,
  expected: { x: number; y: number; w: number; h: number },
) {
  assert.ok(region, "expected a region");
  close(region.x, expected.x);
  close(region.y, expected.y);
  close(region.w, expected.w);
  close(region.h, expected.h);
  assert.ok(region.x + region.w <= 1 + 1e-6 && region.y + region.h <= 1 + 1e-6);
}

describe("scaleRegion", () => {
  it("scales about the centre", () => {
    const scaled = scaleRegion({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 2);
    for (const [key, want] of Object.entries({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 })) {
      assert.ok(Math.abs(scaled[key as keyof typeof scaled] - want) < 1e-9, key);
    }
  });

  it("clips to the frame", () => {
    assertRegion(scaleRegion({ x: 0, y: 0.4, w: 0.5, h: 0.2 }, 4), { x: 0, y: 0.1, w: 1, h: 0.8 });
  });
});

describe("regionWithinCrop", () => {
  it("re-expresses a region in fractions of the crop", () => {
    const crop = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    assert.deepEqual(regionWithinCrop({ x: 0.35, y: 0.35, w: 0.3, h: 0.3 }, crop), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  });

  it("clips a region that overhangs the crop and drops one that is gone", () => {
    const crop = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    assert.deepEqual(regionWithinCrop({ x: 0, y: 0, w: 1, h: 1 }, crop), { x: 0, y: 0, w: 1, h: 1 });
    assert.equal(regionWithinCrop({ x: 0, y: 0, w: 0.1, h: 0.1 }, crop), null);
    assert.equal(regionWithinCrop({ x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, { x: 0, y: 0, w: 0, h: 0 }), null);
  });
});

describe("planGuideCrop (how a photo is cut around the outline)", () => {
  // The small bottom circle in the middle of a portrait camera frame.
  const outline = { x: 0.37, y: 0.43, w: 0.26, h: 0.14 };

  it("keeps a margin around a label outline and reports the outline with slack, inside the cut", () => {
    const { crop, region } = planGuideCrop("bottom", outline);
    assert.ok(crop && region);
    assert.ok(Math.abs(crop.w - outline.w * GUIDE_CROP_FACTOR.bottom) < 1e-9);
    assert.ok(Math.abs(crop.h - outline.h * GUIDE_CROP_FACTOR.bottom) < 1e-9);
    // The reported region is the outline × slack, centred in the cut.
    const want = GUIDE_LABEL_SLACK / GUIDE_CROP_FACTOR.bottom;
    assert.ok(Math.abs(region.w - want) < 1e-3 && Math.abs(region.h - want) < 1e-3);
    assert.ok(Math.abs(region.x + region.w / 2 - 0.5) < 1e-3 && Math.abs(region.y + region.h / 2 - 0.5) < 1e-3);
  });

  it("reports the exact outline for the glass, where the color is measured", () => {
    const glass = { x: 0.38, y: 0.43, w: 0.24, h: 0.14 };
    const { crop, region } = planGuideCrop("glass", glass);
    assert.ok(crop && region);
    const want = 1 / GUIDE_CROP_FACTOR.glass;
    assert.ok(Math.abs(region.w - want) < 1e-3 && Math.abs(region.h - want) < 1e-3);
  });

  it("clips the cut at the edge of the camera frame and keeps the region inside it", () => {
    const tall = { x: 0.3, y: 0.2, w: 0.4, h: 0.6 };
    const { crop, region } = planGuideCrop("front", tall);
    assert.ok(crop && region);
    assert.ok(crop.y >= 0 && crop.y + crop.h <= 1 && crop.x >= 0 && crop.x + crop.w <= 1);
    assert.ok(region.x >= 0 && region.y >= 0 && region.x + region.w <= 1 && region.y + region.h <= 1);
  });

  it("does not cut a barcode frame", () => {
    assert.equal(planGuideCrop("barcode", outline).crop, null);
  });
});
