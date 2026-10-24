import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  armAutoShutter,
  AUTO_SHUTTER_SETTINGS,
  autoShutterBlocker,
  luminanceMotion,
  stepAutoShutter,
  type AutoShutterSample,
} from "./auto-shutter";

const GOOD = { brightness: 0.5, contrast: 0.2, sharpness: 0.03 };
const STILL = new Uint8ClampedArray(64).fill(120);

function sample(overrides: Partial<AutoShutterSample> = {}): AutoShutterSample {
  return { luminance: STILL, metrics: GOOD, ...overrides };
}

/** Feed `count` samples `interval` ms apart starting at `start`; returns the phases seen. */
function run(count: number, make: (i: number) => AutoShutterSample, start = 0, interval = 150) {
  let state = armAutoShutter(start);
  const phases: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const step = stepAutoShutter(state, make(i), start + (i + 1) * interval, "label");
    state = step.state;
    phases.push(step.status.phase);
  }
  return phases;
}

describe("luminanceMotion", () => {
  it("is 0 for identical frames and 1 for frames that can't be compared", () => {
    assert.equal(luminanceMotion(STILL, STILL), 0);
    assert.equal(luminanceMotion(null, STILL), 1);
    assert.equal(luminanceMotion(new Uint8ClampedArray(10), STILL), 1);
  });

  it("is the mean absolute change on a 0–1 scale", () => {
    const a = new Uint8ClampedArray([0, 0, 0, 0]);
    const b = new Uint8ClampedArray([255, 255, 0, 0]);
    assert.equal(luminanceMotion(a, b), 0.5);
  });
});

describe("autoShutterBlocker", () => {
  it("passes a steady, sharp, well-exposed frame", () => {
    assert.equal(autoShutterBlocker(GOOD, 0, "label"), null);
  });

  it("names the first problem", () => {
    assert.equal(autoShutterBlocker({ ...GOOD, brightness: 0.05 }, 0, "label"), "too-dark");
    assert.equal(autoShutterBlocker({ ...GOOD, brightness: 0.98 }, 0, "label"), "too-bright");
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
  it("fires once after the frame has been good for steadyMs, then stays done", () => {
    const needed = Math.ceil(AUTO_SHUTTER_SETTINGS.steadyMs / 150) + 1;
    const phases = run(needed + 3, () => sample());
    // The first sample has nothing to compare against, so it counts as moving.
    assert.equal(phases[0], "waiting");
    assert.equal(phases.filter((p) => p === "fire").length, 1);
    const fireAt = phases.indexOf("fire");
    assert.ok(phases.slice(1, fireAt).every((p) => p === "steadying"));
    assert.ok(phases.slice(fireAt + 1).every((p) => p === "done"));
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
    feed(sample());
    for (let i = 0; i < 3; i += 1) feed(sample());
    const moved = feed(sample({ luminance: new Uint8ClampedArray(64).fill(200) }));
    assert.equal(moved.phase, "waiting");
    assert.equal(moved.blocker, "moving");
    assert.equal(state.goodSince, null);
    const next = feed(sample({ luminance: new Uint8ClampedArray(64).fill(200) }));
    assert.equal(next.phase, "steadying");
    assert.equal(next.progress, 0);
  });

  it("never fires on a blurry frame", () => {
    const phases = run(20, () => sample({ metrics: { ...GOOD, sharpness: 0.001 } }));
    assert.ok(phases.every((p) => p === "waiting"));
  });

  it("waits for armDelayMs even when the frame is good at once", () => {
    let state = armAutoShutter(0);
    // Pretend a good run started before arming, so only the arm delay holds the shot.
    state = { ...state, previous: STILL, goodSince: -10_000 };
    const early = stepAutoShutter(state, sample(), AUTO_SHUTTER_SETTINGS.armDelayMs - 1, "label");
    assert.equal(early.status.phase, "steadying");
    const late = stepAutoShutter(early.state, sample(), AUTO_SHUTTER_SETTINGS.armDelayMs, "label");
    assert.equal(late.status.phase, "fire");
  });
});
