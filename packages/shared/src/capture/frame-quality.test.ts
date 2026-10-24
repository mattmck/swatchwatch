import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessFrameQuality,
  FRAME_QUALITY_THRESHOLDS,
  frameQualityWarningsFromQuality,
} from "./frame-quality";

describe("assessFrameQuality", () => {
  it("flags a dark frame", () => {
    assert.deepEqual(assessFrameQuality({ brightness: 0.1, contrast: 0.2, sharpness: 0.05 }), ["too-dark"]);
  });

  it("flags a washed-out and a soft frame together", () => {
    assert.deepEqual(assessFrameQuality({ brightness: 0.95, contrast: 0.1, sharpness: 0.001 }), [
      "too-bright",
      "blurry",
    ]);
  });

  it("passes a well-exposed sharp frame", () => {
    assert.deepEqual(assessFrameQuality({ brightness: 0.5, contrast: 0.2, sharpness: 0.05 }), []);
  });

  it("keeps the thresholds the web camera used", () => {
    assert.deepEqual(FRAME_QUALITY_THRESHOLDS, { minBrightness: 0.15, maxBrightness: 0.92, minSharpness: 0.012 });
  });
});

describe("frameQualityWarningsFromQuality", () => {
  it("reads brightness and sharpness from a frame's quality object", () => {
    assert.deepEqual(frameQualityWarningsFromQuality({ brightness: 0.5, sharpness: 0.001 }), ["blurry"]);
  });

  it("returns no warnings when either metric is missing (mobile frames carry none)", () => {
    assert.deepEqual(frameQualityWarningsFromQuality({ source: "mobile-camera" }), []);
    assert.deepEqual(frameQualityWarningsFromQuality({ brightness: 0.01 }), []);
    assert.deepEqual(frameQualityWarningsFromQuality({ sharpness: 0.001 }), []);
  });

  it("ignores non-numeric metrics", () => {
    assert.deepEqual(frameQualityWarningsFromQuality({ brightness: "0.01", sharpness: "0" }), []);
    assert.deepEqual(frameQualityWarningsFromQuality({ brightness: Number.NaN, sharpness: 0.5 }), []);
  });

  it("returns no warnings for null or undefined", () => {
    assert.deepEqual(frameQualityWarningsFromQuality(null), []);
    assert.deepEqual(frameQualityWarningsFromQuality(undefined), []);
  });
});
