import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessFrameQuality,
  buildCameraConstraints,
  CAMERA_ERROR_COPY,
  classifyCameraError,
  computeFrameQuality,
  getCameraAvailability,
  rgbaToLuminance,
  shouldRetryWithoutConstraints,
} from "./camera";

function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe("getCameraAvailability", () => {
  it("reports an insecure context before missing getUserMedia", () => {
    assert.equal(getCameraAvailability({ isSecureContext: false, hasGetUserMedia: false }), "insecure-context");
    assert.equal(getCameraAvailability({ isSecureContext: true, hasGetUserMedia: false }), "unsupported");
    assert.equal(getCameraAvailability({ isSecureContext: true, hasGetUserMedia: true }), "available");
  });
});

describe("classifyCameraError", () => {
  it("maps getUserMedia rejections to actionable kinds", () => {
    assert.equal(classifyCameraError(domError("NotAllowedError")), "permission-denied");
    assert.equal(classifyCameraError(domError("SecurityError")), "permission-denied");
    assert.equal(classifyCameraError(domError("NotFoundError")), "no-camera");
    assert.equal(classifyCameraError(domError("OverconstrainedError")), "no-camera");
    assert.equal(classifyCameraError(domError("NotReadableError")), "camera-in-use");
    assert.equal(classifyCameraError(new TypeError("no mediaDevices")), "unsupported");
    assert.equal(classifyCameraError("boom"), "unknown");
    assert.equal(classifyCameraError(null), "unknown");
  });

  it("has copy for every kind", () => {
    for (const kind of ["permission-denied", "no-camera", "camera-in-use", "insecure-context", "unsupported", "unknown"] as const) {
      assert.ok(CAMERA_ERROR_COPY[kind].title.length > 0);
      assert.ok(CAMERA_ERROR_COPY[kind].description.length > 0);
    }
  });
});

describe("buildCameraConstraints", () => {
  it("prefers the rear camera without requiring it", () => {
    const constraints = buildCameraConstraints("rear");
    assert.equal(constraints.audio, false);
    assert.deepEqual((constraints.video as MediaTrackConstraints).facingMode, { ideal: "environment" });
  });

  it("drops all constraints on the retry", () => {
    assert.deepEqual(buildCameraConstraints("any"), { video: true, audio: false });
  });

  it("only retries constraint failures, not a missing camera or a denial", () => {
    const over = domError("OverconstrainedError");
    assert.equal(shouldRetryWithoutConstraints(classifyCameraError(over), over), true);
    const missing = domError("NotFoundError");
    assert.equal(shouldRetryWithoutConstraints(classifyCameraError(missing), missing), false);
    const denied = domError("NotAllowedError");
    assert.equal(shouldRetryWithoutConstraints(classifyCameraError(denied), denied), false);
  });
});

describe("rgbaToLuminance", () => {
  it("weights channels and composites transparency over white", () => {
    const rgba = new Uint8ClampedArray([
      255, 255, 255, 255, // white
      0, 0, 0, 255, // black
      255, 0, 0, 255, // red
      0, 0, 0, 0, // transparent → white
    ]);
    assert.deepEqual(Array.from(rgbaToLuminance(rgba, 4, 1)), [255, 0, 76, 255]);
  });
});

describe("computeFrameQuality / assessFrameQuality", () => {
  it("flags a flat dark frame as dark and blurry", () => {
    const flat = new Uint8ClampedArray(16 * 16).fill(10);
    const metrics = computeFrameQuality(flat, 16, 16);
    assert.ok(metrics.brightness < 0.05);
    assert.equal(metrics.sharpness, 0);
    assert.deepEqual(assessFrameQuality(metrics), ["too-dark", "blurry"]);
  });

  it("passes a mid-gray frame with hard edges", () => {
    const width = 16;
    const height = 16;
    const checker = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        checker[y * width + x] = (x + y) % 2 === 0 ? 60 : 200;
      }
    }
    const metrics = computeFrameQuality(checker, width, height);
    assert.ok(metrics.brightness > 0.4 && metrics.brightness < 0.6);
    assert.ok(metrics.contrast > 0.2);
    assert.ok(metrics.sharpness > 0.1);
    assert.deepEqual(assessFrameQuality(metrics), []);
  });

  it("flags a blown-out frame", () => {
    const white = new Uint8ClampedArray(8 * 8).fill(250);
    assert.ok(assessFrameQuality(computeFrameQuality(white, 8, 8)).includes("too-bright"));
  });

  it("handles empty input", () => {
    assert.deepEqual(computeFrameQuality(new Uint8ClampedArray(0), 0, 0), {
      brightness: 0,
      contrast: 0,
      sharpness: 0,
    });
  });
});
