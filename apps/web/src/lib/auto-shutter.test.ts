import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  armAutoShutter,
  AUTO_SHUTTER_REGIONS,
  AUTO_SHUTTER_SETTINGS,
  autoShutterBlocker,
  cropLuminance,
  luminanceMotion,
  stepAutoShutter,
  type AutoShutterSample,
} from "./auto-shutter";

const GOOD = { brightness: 0.5, contrast: 0.2, sharpness: 0.03 };
/** The guide region before anything is held up: a sharp, steady background. */
const EMPTY = new Uint8ClampedArray(64).fill(60);
/** The same region with the bottle in it. */
const BOTTLE = new Uint8ClampedArray(64).fill(140);

function sample(overrides: Partial<AutoShutterSample> = {}): AutoShutterSample {
  return { luminance: BOTTLE, metrics: GOOD, ...overrides };
}

/** Feed samples `interval` ms apart from `start`; returns the statuses seen. */
function run(samples: AutoShutterSample[], start = 0, interval = 150) {
  let state = armAutoShutter(start);
  return samples.map((s, i) => {
    const step = stepAutoShutter(state, s, start + (i + 1) * interval, "label");
    state = step.state;
    return step.status;
  });
}

const stepsToFire = Math.ceil(Math.max(AUTO_SHUTTER_SETTINGS.steadyMs, AUTO_SHUTTER_SETTINGS.armDelayMs) / 150) + 3;

describe("luminanceMotion", () => {
  it("is 0 for identical frames and 1 for frames that can't be compared", () => {
    assert.equal(luminanceMotion(BOTTLE, BOTTLE), 0);
    assert.equal(luminanceMotion(null, BOTTLE), 1);
    assert.equal(luminanceMotion(new Uint8ClampedArray(10), BOTTLE), 1);
  });

  it("is the mean absolute change on a 0–1 scale", () => {
    const a = new Uint8ClampedArray([0, 0, 0, 0]);
    const b = new Uint8ClampedArray([255, 255, 0, 0]);
    assert.equal(luminanceMotion(a, b), 0.5);
  });
});

describe("cropLuminance", () => {
  it("copies the region's pixels row by row", () => {
    // 4×2 image: row 0 = 0 1 2 3, row 1 = 4 5 6 7
    const lum = new Uint8ClampedArray([0, 1, 2, 3, 4, 5, 6, 7]);
    const crop = cropLuminance(lum, 4, 2, { x: 0.25, y: 0, w: 0.5, h: 1 });
    assert.deepEqual({ ...crop, luminance: [...crop.luminance] }, { luminance: [1, 2, 5, 6], width: 2, height: 2 });
  });

  it("clamps a region outside the frame to at least one pixel", () => {
    const crop = cropLuminance(new Uint8ClampedArray([9, 9, 9, 9]), 2, 2, { x: 1.2, y: -1, w: 0.5, h: 0.1 });
    assert.equal(crop.luminance.length, 1);
  });

  it("every guide has a region inside the frame", () => {
    for (const region of Object.values(AUTO_SHUTTER_REGIONS)) {
      assert.ok(region.x >= 0 && region.y >= 0 && region.x + region.w <= 1 && region.y + region.h <= 1);
    }
  });
});

describe("autoShutterBlocker", () => {
  it("passes a steady, sharp, well-exposed frame of something new", () => {
    assert.equal(autoShutterBlocker(GOOD, 0, "label", 0.3), null);
  });

  it("names the first problem", () => {
    assert.equal(autoShutterBlocker({ ...GOOD, brightness: 0.05 }, 0, "label"), "too-dark");
    assert.equal(autoShutterBlocker({ ...GOOD, brightness: 0.98 }, 0, "label"), "too-bright");
    assert.equal(autoShutterBlocker(GOOD, 0, "label", 0.01), "unchanged");
    assert.equal(autoShutterBlocker(GOOD, 0.2, "label"), "moving");
    assert.equal(autoShutterBlocker({ ...GOOD, contrast: 0.01 }, 0, "label"), "empty");
    assert.equal(autoShutterBlocker({ ...GOOD, sharpness: 0.008 }, 0, "label"), "blurry");
  });

  it("accepts softer glass close-ups than labels", () => {
    const soft = { ...GOOD, sharpness: 0.008 };
    assert.equal(autoShutterBlocker(soft, 0, "color"), null);
    assert.equal(autoShutterBlocker(soft, 0, "label"), "blurry");
  });
});

describe("stepAutoShutter", () => {
  it("never fires on a sharp, steady scene that nothing was brought into", () => {
    const statuses = run(Array.from({ length: 40 }, () => sample({ luminance: EMPTY })));
    assert.ok(statuses.every((s) => s.phase === "waiting"));
    assert.ok(statuses.every((s) => s.blocker === "unchanged"));
  });

  it("fires once after the bottle is brought in and held for steadyMs, then stays done", () => {
    const samples = [sample({ luminance: EMPTY }), ...Array.from({ length: stepsToFire }, () => sample())];
    const statuses = run(samples);
    assert.equal(statuses[0].blocker, "unchanged", "the first sample is the reference scene");
    assert.equal(statuses[1].blocker, "moving", "the bottle arriving is motion");
    assert.equal(statuses.filter((s) => s.phase === "fire").length, 1);
    const fireAt = statuses.findIndex((s) => s.phase === "fire");
    assert.ok(statuses.slice(2, fireAt).every((s) => s.phase === "steadying"));
    assert.ok(statuses.slice(fireAt + 1).every((s) => s.phase === "done"));
    // Held for at least steadyMs after it settled.
    assert.ok((fireAt - 2) * 150 >= AUTO_SHUTTER_SETTINGS.steadyMs);
  });

  it("starts over when the camera moves", () => {
    let state = armAutoShutter(0);
    let now = 0;
    const feed = (s: AutoShutterSample) => {
      now += 150;
      const step = stepAutoShutter(state, s, now, "label");
      state = step.state;
      return step.status;
    };
    feed(sample({ luminance: EMPTY }));
    for (let i = 0; i < 3; i += 1) feed(sample());
    const moved = feed(sample({ luminance: new Uint8ClampedArray(64).fill(220) }));
    assert.equal(moved.phase, "waiting");
    assert.equal(moved.blocker, "moving");
    assert.equal(state.goodSince, null);
    const next = feed(sample({ luminance: new Uint8ClampedArray(64).fill(220) }));
    assert.equal(next.phase, "steadying");
    assert.equal(next.progress, 0);
  });

  it("never fires on a blurry frame", () => {
    const blurry = { ...GOOD, sharpness: 0.001 };
    const statuses = run([sample({ luminance: EMPTY }), ...Array.from({ length: 20 }, () => sample({ metrics: blurry }))]);
    assert.ok(statuses.every((s) => s.phase === "waiting"));
  });

  it("waits for armDelayMs even when the frame is good at once", () => {
    let state = armAutoShutter(0);
    // Pretend a good run started before arming, so only the arm delay holds the shot.
    state = { ...state, reference: EMPTY, previous: BOTTLE, goodSince: -10_000 };
    const early = stepAutoShutter(state, sample(), AUTO_SHUTTER_SETTINGS.armDelayMs - 1, "label");
    assert.equal(early.status.phase, "steadying");
    const late = stepAutoShutter(early.state, sample(), AUTO_SHUTTER_SETTINGS.armDelayMs, "label");
    assert.equal(late.status.phase, "fire");
  });
});
