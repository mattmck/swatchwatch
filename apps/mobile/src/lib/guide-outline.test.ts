import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_GUIDE_REGIONS } from "swatchwatch-shared";
import { guideOutlineRect, nativeGuideRegion } from "./guide-outline";

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-3, `expected ${expected}, got ${actual}`);

describe("guideOutlineRect", () => {
  it("draws the shared outline in the preview's own points", () => {
    assert.deepEqual(guideOutlineRect("glass", { width: 400, height: 300 }), { left: 152, top: 114, width: 96, height: 72 });
  });
});

describe("nativeGuideRegion", () => {
  // A 360 × 360 preview of a 1200 × 1600 portrait photo: aspect fill crops the frame's top and
  // bottom, so the preview shows the middle 75% of the frame's height.
  const preview = { width: 360, height: 360 };
  const frame = { width: 1200, height: 1600 };
  const base = { bottleSequence: true, drawn: "glass" as const, surface: "glass" as const, trigger: "shutter" as const, preview, frame };

  it("maps the drawn outline through the aspect-fill crop into the photo", () => {
    const region = nativeGuideRegion(base);
    assert.ok(region);
    const shown = DEFAULT_GUIDE_REGIONS.glass;
    close(region.x, shown.x);
    close(region.w, shown.w);
    // Vertically the preview shows frame rows 12.5%–87.5%, so the outline lies nearer the middle.
    close(region.y, 0.125 + shown.y * 0.75);
    close(region.h, shown.h * 0.75);
  });

  it("no region for a library photo, a live barcode read, another surface or the flag off", () => {
    assert.equal(nativeGuideRegion({ ...base, trigger: "file" }), null);
    assert.equal(nativeGuideRegion({ ...base, trigger: "live-scan", surface: null }), null);
    assert.equal(nativeGuideRegion({ ...base, surface: "bottom" }), null);
    assert.equal(nativeGuideRegion({ ...base, bottleSequence: false }), null);
  });

  it("no region without an outline or a measured preview", () => {
    assert.equal(nativeGuideRegion({ ...base, drawn: null }), null);
    assert.equal(nativeGuideRegion({ ...base, preview: null }), null);
    assert.equal(nativeGuideRegion({ ...base, preview: { width: 0, height: 360 } }), null);
  });

  it("no region for a landscape photo from the portrait-only app (rotation unknown)", () => {
    assert.equal(nativeGuideRegion({ ...base, frame: { width: 1600, height: 1200 } }), null);
  });
});
