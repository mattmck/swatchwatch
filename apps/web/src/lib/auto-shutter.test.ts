import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  armAutoShutter,
  AUTO_SHUTTER_REGIONS,
  AUTO_SHUTTER_SETTINGS,
  autoShutterBlocker,
  autoShutterScore,
  coarsenLuminance,
  cropLuminance,
  luminanceMotion,
  stepAutoShutter,
  type AutoShutterArrival,
  type AutoShutterSample,
  type AutoShutterState,
  type AutoShutterStatus,
} from "./auto-shutter";

const S = AUTO_SHUTTER_SETTINGS;
const GOOD = { brightness: 0.5, contrast: 0.2, sharpness: 0.03 };
const W = 24;
const H = 24;
const INTERVAL = S.sampleIntervalMs;

/** A 24×24 region of vertical stripes `period` px wide, shifted right by `shift` px. */
function stripes(low: number, high: number, period = 12, shift = 0): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) out[y * W + x] = Math.floor((x + W * period - shift) / period) % 2 === 0 ? low : high;
  }
  return out;
}

/** The guide region before anything is held up: a steady, sharp background. */
const EMPTY = stripes(50, 70);
/** The same region with the bottle in it. */
const BOTTLE = stripes(40, 200);
/** The bottle with a pixel of hand shake. */
const BOTTLE_JITTER = stripes(40, 200, 12, 1);
/** The bottle turned to another side. */
const OTHER_SIDE = stripes(200, 60, 8);

function sample(overrides: Partial<AutoShutterSample> = {}): AutoShutterSample {
  return { luminance: BOTTLE, width: W, height: H, metrics: GOOD, ...overrides };
}

/** Feeds samples one interval apart and records each status. */
function feeder(frameType: "label" | "color" = "label", arm: Parameters<typeof armAutoShutter>[1] = {}, start = 0) {
  let state: AutoShutterState = armAutoShutter(start, arm);
  let now = start;
  const statuses: AutoShutterStatus[] = [];
  const keeps: boolean[] = [];
  return {
    feed(s: AutoShutterSample, times = 1): AutoShutterStatus {
      let last!: AutoShutterStatus;
      for (let i = 0; i < times; i += 1) {
        now += INTERVAL;
        const step = stepAutoShutter(state, s, now, frameType);
        state = step.state;
        statuses.push(step.status);
        keeps.push(step.keep);
        last = step.status;
      }
      return last;
    },
    get state() {
      return state;
    },
    get now() {
      return now;
    },
    statuses,
    keeps,
  };
}

const samplesFor = (ms: number) => Math.ceil(ms / INTERVAL);

describe("coarsenLuminance", () => {
  it("averages each cell, row by row", () => {
    // 4×2 image, 2px cells: [0 2 | 10 10] / [4 6 | 10 10]
    const cells = coarsenLuminance(new Uint8ClampedArray([0, 2, 10, 10, 4, 6, 10, 10]), 4, 2, 2);
    assert.deepEqual([...cells], [3, 10]);
  });

  it("keeps a partial last cell and returns nothing for a bad size", () => {
    assert.equal(coarsenLuminance(new Uint8ClampedArray(9).fill(7), 3, 3, 2).length, 4);
    assert.equal(coarsenLuminance(new Uint8ClampedArray(4), 4, 4, 2).length, 0);
  });
});

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

  it("can ignore the camera adjusting its exposure", () => {
    const a = new Uint8ClampedArray([10, 50, 90, 130]);
    const brighter = new Uint8ClampedArray([40, 80, 120, 160]);
    assert.ok(luminanceMotion(a, brighter) > 0.1);
    assert.equal(luminanceMotion(a, brighter, { ignoreBrightness: true }), 0);
  });

  it("on coarse cells a pixel of jitter on a striped label is far below the motion limit", () => {
    const a = coarsenLuminance(BOTTLE, W, H);
    const b = coarsenLuminance(BOTTLE_JITTER, W, H);
    assert.ok(luminanceMotion(BOTTLE, BOTTLE_JITTER) > 0.04, "the old per-pixel limit read it as movement");
    assert.ok(luminanceMotion(a, b, { ignoreBrightness: true }) < S.rules.label.maxMotion);
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

  it("asks only for rough stillness of a glass (color) shot", () => {
    // A patch of black or white lacquer: dark or bright, flat and without edges.
    const black = { brightness: 0.05, contrast: 0.005, sharpness: 0 };
    const white = { brightness: 0.99, contrast: 0.005, sharpness: 0 };
    assert.equal(autoShutterBlocker(black, 0.05, "color"), null);
    assert.equal(autoShutterBlocker(white, 0.05, "color"), null);
    assert.equal(autoShutterBlocker(black, 0.05, "label"), "too-dark");
    assert.equal(autoShutterBlocker(black, 0.5, "color"), "moving");
  });

  it("relaxes sharpness and motion once the bottle has been in view a while", () => {
    const soft = { ...GOOD, sharpness: S.rules.label.minSharpness * 0.6 };
    assert.equal(autoShutterBlocker(soft, 0, "label"), "blurry");
    assert.equal(autoShutterBlocker(soft, 0, "label", { relaxed: true }), null);
    const wobble = S.rules.label.maxMotion * 1.3;
    assert.equal(autoShutterBlocker(GOOD, wobble, "label"), "moving");
    assert.equal(autoShutterBlocker(GOOD, wobble, "label", { relaxed: true }), null);
  });
});

describe("autoShutterScore", () => {
  it("prefers sharp and still", () => {
    const sharpStill = autoShutterScore(GOOD, 0, "label");
    assert.ok(sharpStill > autoShutterScore({ ...GOOD, sharpness: 0.004 }, 0, "label"));
    assert.ok(sharpStill > autoShutterScore(GOOD, 0.06, "label"));
    assert.ok(sharpStill > autoShutterScore({ ...GOOD, brightness: 0.99 }, 0, "label"));
  });

  it("does not ask a glass shot to be sharp", () => {
    assert.equal(autoShutterScore({ ...GOOD, sharpness: 0 }, 0, "color"), 1);
  });
});

describe("stepAutoShutter: the first photo (arrival empty)", () => {
  it("never fires on a steady scene that nothing was brought into", () => {
    const f = feeder();
    f.feed(sample({ luminance: EMPTY }), samplesFor(S.bestAfterMs * 3));
    assert.ok(f.statuses.every((s) => s.phase === "waiting" && s.blocker === "unchanged"));
    assert.equal(f.statuses[1].stalled, false);
    assert.equal(f.statuses.at(-1)?.stalled, true, "after a while it says what it is waiting for");
    assert.ok(f.keeps.every((k) => !k));
  });

  it("fires once, soon after the bottle is brought in and held, then stays done", () => {
    const f = feeder();
    f.feed(sample({ luminance: EMPTY }));
    f.feed(sample(), samplesFor(S.steadyMs) + 4);
    assert.equal(f.statuses[0].blocker, "unchanged", "the first sample is the reference scene");
    assert.equal(f.statuses[1].blocker, "moving", "the bottle arriving is motion");
    const fireAt = f.statuses.findIndex((s) => s.phase === "fire");
    assert.ok(fireAt > 1);
    assert.equal(f.statuses.filter((s) => s.phase === "fire").length, 1);
    assert.equal(f.statuses[fireAt].useBest, false, "a steady shot is the live frame");
    assert.ok(f.statuses.slice(2, fireAt).every((s) => s.phase === "steadying"));
    assert.ok(f.statuses.slice(fireAt + 1).every((s) => s.phase === "done"));
    // Within about a second of settling, not the old 1 s of perfect stillness plus resets.
    assert.ok((fireAt - 2) * INTERVAL >= S.steadyMs);
    assert.ok((fireAt - 1) * INTERVAL <= 1000);
  });

  it("fires through a pixel of hand shake on every sample", () => {
    const f = feeder();
    f.feed(sample({ luminance: EMPTY }));
    for (let i = 0; i < samplesFor(S.steadyMs) + 4; i += 1) f.feed(sample({ luminance: i % 2 ? BOTTLE : BOTTLE_JITTER }));
    assert.equal(f.statuses.filter((s) => s.phase === "fire").length, 1);
    assert.equal(f.statuses.find((s) => s.phase === "fire")?.settling, false, "before any relaxing");
  });

  it("forgives one wobble but never shoots on it, and starts over on a second", () => {
    const wobble = stripes(40, 200, 12, 2);
    const f = feeder();
    f.feed(sample({ luminance: EMPTY }));
    f.feed(sample(), 3);
    const run = f.state.goodSince;
    assert.notEqual(run, null);
    const first = f.feed(sample({ luminance: wobble }));
    assert.equal(first.phase, "steadying");
    assert.equal(f.state.goodSince, run, "the run goes on");
    assert.equal(f.state.wobbleUsed, true);
    // Back from the wobble is one too, and that is the second in this run.
    const second = f.feed(sample());
    assert.equal(second.phase, "waiting");
    assert.equal(second.blocker, "moving");
    assert.equal(f.state.goodSince, null);
  });

  it("starts over at once when the bottle is swung away", () => {
    const f = feeder();
    f.feed(sample({ luminance: EMPTY }));
    f.feed(sample(), 3);
    const moved = f.feed(sample({ luminance: OTHER_SIDE }));
    assert.equal(moved.phase, "waiting");
    assert.equal(moved.blocker, "moving");
    assert.equal(f.state.goodSince, null);
  });

  it("waits for armDelayMs even when the frame is good at once", () => {
    let state = armAutoShutter(0, { arrival: "none" });
    const cells = coarsenLuminance(BOTTLE, W, H);
    // Pretend a good run started before arming, so only the arm delay holds the shot.
    state = { ...state, previous: cells, arrivedAt: 0, goodSince: -10_000 };
    const early = stepAutoShutter(state, sample(), S.armDelayNoneMs - 1, "label");
    assert.equal(early.status.phase, "steadying");
    const late = stepAutoShutter(early.state, sample(), S.armDelayNoneMs, "label");
    assert.equal(late.status.phase, "fire");
  });
});

describe("stepAutoShutter: a photo is always taken", () => {
  it("relaxes for a label that will not get sharp, then takes it", () => {
    // Held closer than the lens can focus: half the sharpness a label should have.
    const soft = { ...GOOD, sharpness: S.rules.label.minSharpness * 0.6 };
    const f = feeder();
    f.feed(sample({ luminance: EMPTY }));
    f.feed(sample({ metrics: soft }), samplesFor(S.relaxAfterMs + S.relax.steadyMs) + 3);
    const fireAt = f.statuses.findIndex((s) => s.phase === "fire");
    assert.ok(fireAt > 0, "fired");
    assert.equal(f.statuses[fireAt].settling, true);
    assert.ok(f.statuses.slice(2, samplesFor(S.relaxAfterMs) - 1).every((s) => s.blocker === "blurry"));
    assert.ok(fireAt * INTERVAL < S.bestAfterMs, "before the last-resort fallback");
  });

  it("takes the best frame seen when nothing ever passes", () => {
    const blurry = { ...GOOD, sharpness: 0.001 };
    const lessBlurry = { ...GOOD, sharpness: 0.005 };
    const f = feeder();
    f.feed(sample({ luminance: EMPTY }));
    f.feed(sample({ metrics: blurry }), 4);
    f.feed(sample({ metrics: lessBlurry }), samplesFor(S.bestAfterMs) - 12);
    f.feed(sample({ metrics: blurry }), 12);
    const fireAt = f.statuses.findIndex((s) => s.phase === "fire");
    assert.ok(fireAt > 0, "fired although every sample was blurry");
    assert.equal(f.statuses[fireAt].useBest, true, "the less blurry frame kept earlier, not the live one");
    assert.ok(f.keeps.some((k) => k));
    // From the bottle arriving (the second sample) to the shot: bestAfterMs, give or take a sample.
    assert.ok(Math.abs((fireAt - 1) * INTERVAL - S.bestAfterMs) <= INTERVAL);
  });

  it("uses the live frame at the fallback when it is the best one", () => {
    const blurry = { ...GOOD, sharpness: 0.001 };
    const f = feeder();
    f.feed(sample({ luminance: EMPTY }));
    f.feed(sample({ metrics: blurry }), samplesFor(S.bestAfterMs) - 4);
    f.feed(sample({ metrics: { ...GOOD, sharpness: 0.009 } }), 6);
    const fired = f.statuses.find((s) => s.phase === "fire");
    assert.ok(fired, "fired");
    assert.equal(fired.useBest, false);
  });

  it("uses the live frame when the kept one is no better", () => {
    const blurry = { ...GOOD, sharpness: 0.001 };
    const f = feeder();
    f.feed(sample({ luminance: EMPTY }));
    f.feed(sample({ metrics: blurry }), samplesFor(S.bestAfterMs) + 2);
    assert.equal(f.statuses.find((s) => s.phase === "fire")?.useBest, false);
  });

  it("forgets a best frame older than bestWindowMs", () => {
    const f = feeder();
    f.feed(sample({ luminance: EMPTY }));
    f.feed(sample({ metrics: { ...GOOD, sharpness: 0.011 } }), 2);
    const kept = f.state.best;
    assert.ok(kept);
    f.feed(sample({ metrics: { ...GOOD, sharpness: 0.001 } }), samplesFor(S.bestWindowMs) + 2);
    assert.ok(f.state.best && f.state.best.at > kept.at, "a newer, worse frame replaced the stale one");
  });

  it("fires on a flat, dark glass close-up", () => {
    const flat = new Uint8ClampedArray(W * H).fill(12);
    const f = feeder("color");
    f.feed(sample({ luminance: EMPTY }));
    f.feed(sample({ luminance: flat, metrics: { brightness: 0.05, contrast: 0.002, sharpness: 0 } }), samplesFor(S.steadyMs) + 4);
    assert.equal(f.statuses.filter((s) => s.phase === "fire").length, 1);
  });
});

describe("stepAutoShutter: later photos", () => {
  const lastShot: AutoShutterSample = sample();

  it("with nothing to compare, a changed arrival only waits out the arm delay", () => {
    assert.equal(armAutoShutter(0, { arrival: "changed" }).arrival, "none");
    assert.equal(armAutoShutter(0, { arrival: "changed", reference: lastShot }).arrival, "changed");
  });

  it("fires at once on a bottle already turned to the next side when the prompt arms", () => {
    const f = feeder("label", { arrival: "changed", reference: lastShot });
    f.feed(sample({ luminance: OTHER_SIDE }), samplesFor(Math.max(S.steadyMs, S.armDelayMs)) + 3);
    const fireAt = f.statuses.findIndex((s) => s.phase === "fire");
    assert.ok(fireAt > 0, "no need to take the bottle out and bring it back");
    assert.ok(f.statuses.every((s) => s.blocker !== "unchanged" || s === f.statuses[0]));
  });

  it("never shoots the side already photographed as the next side, however long it is held", () => {
    const f = feeder("label", { arrival: "changed", reference: lastShot });
    f.feed(sample(), samplesFor(S.bestAfterMs * 4));
    assert.ok(f.statuses.every((s) => s.phase === "waiting" && s.blocker === "unchanged"));
    assert.equal(f.statuses[2].stalled, false);
    assert.equal(f.statuses.at(-1)?.stalled, true, "after a while it says what it is waiting for");
    // Turned at last: the shot follows.
    f.feed(sample({ luminance: OTHER_SIDE }), samplesFor(S.steadyMs) + 4);
    assert.equal(f.statuses.filter((s) => s.phase === "fire").length, 1);
  });

  it("hand shake on the side already photographed is not a turn", () => {
    const f = feeder("label", { arrival: "changed", reference: lastShot });
    for (let i = 0; i < samplesFor(S.bestAfterMs * 2); i += 1) {
      f.feed(sample({ luminance: stripes(40, 200, 12, i % 3) }));
    }
    assert.ok(f.statuses.every((s) => s.phase === "waiting" && s.blocker === "unchanged"));
  });

  it("a turned bottle near the limit does not flip in and out of view", () => {
    // Two views of the next side: one just over the arrival limit from the last photo, one just under.
    const reference = new Uint8ClampedArray(W * H).fill(100);
    const over = new Uint8ClampedArray(W * H).fill(100 + Math.ceil(255 * S.minArrivalChange.changed) + 2);
    const under = new Uint8ClampedArray(W * H).fill(100 + Math.floor(255 * S.minArrivalChange.changed) - 6);
    const f = feeder("label", { arrival: "changed", reference: { luminance: reference, width: W, height: H } });
    f.feed(sample({ luminance: under }), 3);
    assert.equal(f.state.arrivedAt, null, "under the limit nothing has arrived");
    f.feed(sample({ luminance: over }));
    const arrivedAt = f.state.arrivedAt;
    assert.notEqual(arrivedAt, null);
    f.feed(sample({ luminance: under }), 2);
    assert.equal(f.state.arrivedAt, arrivedAt, "once arrived it stays arrived just under the limit");
    f.feed(sample({ luminance: reference }));
    assert.equal(f.state.arrivedAt, null, "back to the last photo's view: gone again");
  });

  it("a reference of another size (another outline) counts as changed", () => {
    const other: AutoShutterSample = { luminance: new Uint8ClampedArray(36).fill(90), width: 6, height: 6, metrics: GOOD };
    const f = feeder("label", { arrival: "changed", reference: other });
    f.feed(sample(), samplesFor(Math.max(S.steadyMs, S.armDelayMs)) + 3);
    assert.equal(f.statuses.filter((s) => s.phase === "fire").length, 1);
  });

  it("arrival none shoots a bottle that never moved (a barcode was just read off it)", () => {
    const arrival: AutoShutterArrival = "none";
    const f = feeder("label", { arrival });
    f.feed(sample(), samplesFor(S.armDelayNoneMs) + 3);
    assert.equal(f.statuses[0].blocker, null);
    assert.equal(f.statuses.filter((s) => s.phase === "fire").length, 1);
    // Not before the longer arm delay: time to read the prompt and adjust.
    const fireAt = f.statuses.findIndex((s) => s.phase === "fire");
    assert.ok((fireAt + 1) * INTERVAL >= S.armDelayNoneMs);
  });
});
