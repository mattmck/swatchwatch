import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HexLabel, HexLabelSaveResponse } from "swatchwatch-shared";
import {
  averageRegion,
  clientToPixel,
  hexLabelKeyAction,
  labelProgress,
  normalizeHexInput,
  planUndo,
  readableTextColor,
  rgbToHexString,
  stepSampleSize,
  toSamplePoint,
} from "./hex-sampling";

/** RGBA buffer filled by `pixel(x, y)`. */
function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  return data;
}

describe("averageRegion", () => {
  it("returns the exact colour of a single pixel (size 1)", () => {
    const data = image(3, 3, (x, y) => (x === 1 && y === 1 ? [34, 186, 204, 255] : [0, 0, 0, 255]));
    assert.deepEqual(averageRegion(data, 3, 3, 1, 1, 1), { r: 34, g: 186, b: 204, hex: "#22BACC", count: 1 });
  });

  it("averages a centred window", () => {
    // Left column red, rest blue: a 3×3 window at the centre has 3 red + 6 blue pixels.
    const data = image(3, 3, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const sample = averageRegion(data, 3, 3, 1, 1, 3);
    assert.equal(sample?.count, 9);
    assert.equal(sample?.hex, rgbToHexString(85, 0, 170));
  });

  it("ignores fully transparent pixels but keeps partially transparent ones", () => {
    const data = image(3, 1, (x) => (x === 0 ? [255, 255, 255, 0] : x === 1 ? [100, 100, 100, 255] : [200, 200, 200, 10]));
    const sample = averageRegion(data, 3, 1, 1, 0, 3);
    assert.equal(sample?.count, 2);
    assert.equal(sample?.hex, "#969696");
  });

  it("returns null when every pixel in the window is transparent", () => {
    const data = image(2, 2, () => [10, 20, 30, 0]);
    assert.equal(averageRegion(data, 2, 2, 0, 0, 9), null);
  });

  it("clamps the window at image edges and corners", () => {
    const data = image(4, 4, (x, y) => (x <= 1 && y <= 1 ? [0, 255, 0, 255] : [0, 0, 0, 255]));
    // 5×5 at (0,0) only covers the 3×3 pixels that exist: 4 green + 5 black.
    const corner = averageRegion(data, 4, 4, 0, 0, 5);
    assert.equal(corner?.count, 9);
    assert.equal(corner?.g, Math.round((4 * 255) / 9));
    // A centre outside the image is clamped onto it rather than reading out of bounds.
    const outside = averageRegion(data, 4, 4, 10, 10, 1);
    assert.equal(outside, null);
    const far = averageRegion(data, 4, 4, 4, 3, 3);
    assert.equal(far?.count, 2);
  });

  it("rejects empty/short buffers", () => {
    assert.equal(averageRegion(new Uint8ClampedArray(0), 0, 0, 0, 0, 1), null);
    assert.equal(averageRegion(new Uint8ClampedArray(8), 2, 2, 0, 0, 1), null);
  });

  it("treats an even size as the next odd window so it stays centred", () => {
    const data = image(5, 5, () => [10, 10, 10, 255]);
    assert.equal(averageRegion(data, 5, 5, 2, 2, 4)?.count, 25);
  });
});

describe("pointer mapping", () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };

  it("maps CSS pixels to canvas pixels for a scaled canvas", () => {
    assert.deepEqual(clientToPixel(100, 50, rect, 1000, 500), { x: 0, y: 0 });
    assert.deepEqual(clientToPixel(200, 100, rect, 1000, 500), { x: 500, y: 250 });
    assert.deepEqual(clientToPixel(300, 150, rect, 1000, 500), { x: 999, y: 499 }, "right/bottom edge clamps");
  });

  it("returns null outside the canvas or for degenerate sizes", () => {
    assert.equal(clientToPixel(99, 60, rect, 1000, 500), null);
    assert.equal(clientToPixel(150, 151, rect, 1000, 500), null);
    assert.equal(clientToPixel(150, 60, { ...rect, width: 0 }, 1000, 500), null);
  });

  it("normalizes the sample point to the pixel centre", () => {
    assert.deepEqual(toSamplePoint({ x: 0, y: 499 }, 5, 1000, 500), {
      x: 0.0005,
      y: 0.999,
      size: 5,
      imageWidth: 1000,
      imageHeight: 500,
    });
  });
});

describe("hex input", () => {
  it("normalizes typed hexes", () => {
    assert.equal(normalizeHexInput("22bacc"), "#22BACC");
    assert.equal(normalizeHexInput("  #22BaCc "), "#22BACC");
    assert.equal(normalizeHexInput("#abc"), "#AABBCC");
    for (const bad of ["", "#12345", "#1234567", "zzzzzz", "rgb(0,0,0)", null, undefined]) {
      assert.equal(normalizeHexInput(bad), null, String(bad));
    }
  });

  it("picks readable text on swatches", () => {
    assert.equal(readableTextColor("#FFFFFF"), "#000000");
    assert.equal(readableTextColor("#000000"), "#FFFFFF");
    assert.equal(readableTextColor("#22BACC"), "#000000");
    assert.equal(readableTextColor("#4B0082"), "#FFFFFF");
  });

  it("rgbToHexString rounds and clamps", () => {
    assert.equal(rgbToHexString(-5, 127.6, 300), "#0080FF");
  });
});

describe("keyboard shortcuts", () => {
  const free = { inTextField: false };
  it("maps the documented keys", () => {
    assert.deepEqual(hexLabelKeyAction({ key: "Enter" }, free), { type: "save" });
    assert.deepEqual(hexLabelKeyAction({ key: "s" }, free), { type: "skip" });
    assert.deepEqual(hexLabelKeyAction({ key: "N" }, free), { type: "next" });
    assert.deepEqual(hexLabelKeyAction({ key: "ArrowRight" }, free), { type: "next" });
    assert.deepEqual(hexLabelKeyAction({ key: "ArrowLeft" }, free), { type: "prev" });
    assert.deepEqual(hexLabelKeyAction({ key: "3" }, free), { type: "image", index: 2 });
    assert.deepEqual(hexLabelKeyAction({ key: "u" }, free), { type: "undo" });
    assert.deepEqual(hexLabelKeyAction({ key: "z", metaKey: true }, free), { type: "undo" });
    assert.deepEqual(hexLabelKeyAction({ key: "e" }, free), { type: "eyedropper" });
    assert.deepEqual(hexLabelKeyAction({ key: "]" }, free), { type: "sample-size", delta: 1 });
    assert.equal(hexLabelKeyAction({ key: "0" }, free), null);
    assert.equal(hexLabelKeyAction({ key: "s", ctrlKey: true }, free), null, "browser shortcuts are left alone");
  });

  it("only handles Enter-in-hex-input while typing", () => {
    assert.equal(hexLabelKeyAction({ key: "s" }, { inTextField: true }), null);
    assert.equal(hexLabelKeyAction({ key: "Enter" }, { inTextField: true }), null, "Enter in the note does not save");
    assert.deepEqual(hexLabelKeyAction({ key: "Enter" }, { inTextField: true, inHexInput: true }), { type: "save" });
  });

  it("steps sample sizes within 1/3/5/9", () => {
    assert.equal(stepSampleSize(5, 1), 9);
    assert.equal(stepSampleSize(9, 1), 9);
    assert.equal(stepSampleSize(3, -1), 1);
    assert.equal(stepSampleSize(1, -1), 1);
  });
});

describe("undo planning and progress", () => {
  const label = (overrides: Partial<HexLabel> = {}): HexLabel => ({
    trainingSampleId: "900",
    shadeId: "10",
    hex: "#22BACC",
    unreliable: false,
    imageId: "500",
    note: null,
    method: "canvas",
    samplePoint: { x: 0.5, y: 0.5, size: 5, imageWidth: 10, imageHeight: 10 },
    labeledByUserId: "2",
    labeledAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  });

  it("deletes a brand-new label", () => {
    const saved: HexLabelSaveResponse = { label: label(), previous: null };
    assert.deepEqual(planUndo(saved), { kind: "delete", trainingSampleId: "900", shadeId: "10" });
  });

  it("restores the label a save replaced", () => {
    const previous = label({ hex: "#000000", method: "eyedropper", samplePoint: null, note: "old" });
    const plan = planUndo({ label: label(), previous });
    assert.equal(plan.kind, "restore");
    assert.deepEqual(plan.kind === "restore" ? plan.request : null, {
      shadeId: "10",
      hex: "#000000",
      imageId: "500",
      unreliable: false,
      note: "old",
      method: "eyedropper",
      samplePoint: null,
    });
  });

  it("computes progress safely", () => {
    assert.deepEqual(labelProgress(12, 340), { labeled: 12, total: 340, percent: 3.5 });
    assert.deepEqual(labelProgress(0, 0), { labeled: 0, total: 0, percent: 0 });
    assert.deepEqual(labelProgress(5, 3), { labeled: 3, total: 3, percent: 100 });
  });
});
