import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  armAutoShutter,
  AUTO_SHUTTER_REGIONS,
  AUTO_SHUTTER_SETTINGS,
  autoShutterBlocker,
  coarsenLuminance,
  cropLuminance,
  luminanceMotion,
  skinFraction,
  stepAutoShutter,
  type AutoShutterSample,
  type AutoShutterState,
  type AutoShutterStatus,
  type LuminanceArea,
} from "./auto-shutter";

const S = AUTO_SHUTTER_SETTINGS;
const GOOD = { brightness: 0.5, contrast: 0.2, sharpness: 0.03 };
const W = 24;
const H = 24;
const INTERVAL = S.sampleIntervalMs;

/** A 24×24 area of vertical stripes `period` px wide, shifted right by `shift` px. */
function stripes(low: number, high: number, period = 12, shift = 0): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) out[y * W + x] = Math.floor((x + W * period - shift) / period) % 2 === 0 ? low : high;
  }
  return out;
}
const area = (luminance: Uint8ClampedArray): LuminanceArea => ({ luminance, width: W, height: H });

/** The view before anything is held up. */
const EMPTY = stripes(50, 70);
/** The bottle's first side, held in the outline. */
const SIDE_A = stripes(40, 200);
/** The same side with the hand's normal tremor (far below the limits on coarse cells). */
const SIDE_A_TREMOR = stripes(40, 198);
/** The bottle turned to another side. */
const SIDE_B = stripes(200, 60, 8);
/** The bottle mid-turn. */
const TURNING = stripes(120, 30, 6, 3);

/** One sample: by default the same picture in the outline's region and in the whole view. */
function view(picture: Uint8ClampedArray, overrides: Partial<AutoShutterSample> = {}): AutoShutterSample {
  return { ...area(picture), metrics: GOOD, scene: area(picture), skin: 0.1, ...overrides };
}

/** Feeds samples one interval apart and records each status. */
function feeder(frameType: "label" | "color" = "label", arm: Parameters<typeof armAutoShutter>[1] = {}, start = 0) {
  let state: AutoShutterState = armAutoShutter(start, arm);
  let now = start;
  const statuses: AutoShutterStatus[] = [];
  return {
    feed(s: AutoShutterSample, times = 1): AutoShutterStatus {
      let last!: AutoShutterStatus;
      for (let i = 0; i < times; i += 1) {
        now += INTERVAL;
        const step = stepAutoShutter(state, s, now, frameType);
        state = step.state;
        statuses.push(step.status);
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
    fires: () => statuses.filter((s) => s.phase === "fire").length,
    fireAt: () => statuses.findIndex((s) => s.phase === "fire"),
    statuses,
  };
}

const samplesFor = (ms: number) => Math.ceil(ms / INTERVAL);
const HOLD = samplesFor(S.steadyMs) + 2;

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
    assert.equal(luminanceMotion(SIDE_A, SIDE_A), 0);
    assert.equal(luminanceMotion(null, SIDE_A), 1);
    assert.equal(luminanceMotion(new Uint8ClampedArray(10), SIDE_A), 1);
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

describe("skinFraction", () => {
  // A 4×2 RGBA thumbnail: the left half skin tone, the right half the purple of a polish bottle.
  const px = (r: number, g: number, b: number) => [r, g, b, 255];
  const skin = px(224, 172, 140);
  const purple = px(110, 60, 160);
  const rgba = new Uint8ClampedArray([...skin, ...skin, ...purple, ...purple, ...skin, ...skin, ...purple, ...purple]);

  it("is the share of skin-tone pixels in the region", () => {
    assert.equal(skinFraction(rgba, 4, 2, { x: 0, y: 0, w: 1, h: 1 }), 0.5);
    assert.equal(skinFraction(rgba, 4, 2, { x: 0, y: 0, w: 0.5, h: 1 }), 1);
    assert.equal(skinFraction(rgba, 4, 2, { x: 0.5, y: 0, w: 0.5, h: 1 }), 0);
  });

  it("does not take black, white or grey for skin, and is 0 for a bad size", () => {
    const grey = new Uint8ClampedArray([...px(0, 0, 0), ...px(255, 255, 255), ...px(128, 128, 128), ...px(40, 40, 40)]);
    assert.equal(skinFraction(grey, 4, 1, { x: 0, y: 0, w: 1, h: 1 }), 0);
    assert.equal(skinFraction(rgba, 9, 9, { x: 0, y: 0, w: 1, h: 1 }), 0);
  });
});

describe("autoShutterBlocker", () => {
  it("passes a still, sharp, well-exposed frame", () => {
    assert.equal(autoShutterBlocker(GOOD, 0, "label"), null);
    assert.equal(autoShutterBlocker(GOOD, 0.01, "label", { sceneMotion: 0.01, skin: 0.4 }), null);
  });

  it("names the first problem", () => {
    assert.equal(autoShutterBlocker(GOOD, 0, "label", { skin: 0.9 }), "hand");
    assert.equal(autoShutterBlocker({ ...GOOD, brightness: 0.05 }, 0, "label"), "too-dark");
    assert.equal(autoShutterBlocker({ ...GOOD, brightness: 0.98 }, 0, "label"), "too-bright");
    assert.equal(autoShutterBlocker(GOOD, 0.2, "label"), "moving");
    assert.equal(autoShutterBlocker({ ...GOOD, contrast: 0.01 }, 0, "label"), "empty");
    assert.equal(autoShutterBlocker({ ...GOOD, sharpness: 0.008 }, 0, "label"), "blurry");
  });

  it("counts the whole view moving although the outline's region is still", () => {
    assert.equal(autoShutterBlocker(GOOD, 0, "label", { sceneMotion: S.maxSceneMotion * 1.2 }), "moving");
  });

  it("asks only for stillness of a glass (color) shot, but still refuses a hand", () => {
    // A patch of black or white lacquer: dark or bright, flat and without edges.
    const black = { brightness: 0.05, contrast: 0.005, sharpness: 0 };
    const white = { brightness: 0.99, contrast: 0.005, sharpness: 0 };
    assert.equal(autoShutterBlocker(black, 0.02, "color"), null);
    assert.equal(autoShutterBlocker(white, 0.02, "color"), null);
    assert.equal(autoShutterBlocker(black, 0.02, "label"), "too-dark");
    assert.equal(autoShutterBlocker(black, 0.5, "color"), "moving");
    assert.equal(autoShutterBlocker(black, 0.02, "color", { skin: 0.92 }), "hand");
  });
});

describe("stepAutoShutter: the first photo (arrival empty)", () => {
  it("never photographs a view that nothing was brought into, and says what it waits for", () => {
    const f = feeder();
    f.feed(view(EMPTY), samplesFor(10_000));
    assert.equal(f.fires(), 0);
    assert.ok(f.statuses.every((s) => s.blocker === "unchanged"));
    assert.equal(f.statuses[1].stalled, false);
    assert.equal(f.statuses.at(-1)?.stalled, true);
  });

  it("photographs a bottle once it is brought in and held still for steadyMs, then stays done", () => {
    const f = feeder();
    f.feed(view(EMPTY), 2);
    f.feed(view(SIDE_A), HOLD + 3);
    assert.equal(f.fires(), 1);
    const fireAt = f.fireAt();
    // The hold starts with the sample after the bottle arrived (the arrival itself is movement).
    assert.ok((fireAt - 3) * INTERVAL >= S.steadyMs, "not before a full hold");
    assert.ok((fireAt - 3) * INTERVAL <= S.steadyMs + 2 * INTERVAL, "and right after it");
    assert.ok(f.statuses.slice(fireAt + 1).every((s) => s.phase === "done"));
  });

  it("takes no photo while the bottle is still being moved into place", () => {
    // What the first version did: a change of view, a short pause, a photo.
    const f = feeder();
    f.feed(view(EMPTY), 2);
    for (let i = 0; i < 6; i += 1) {
      f.feed(view(SIDE_A), samplesFor(S.steadyMs) - 3);
      f.feed(view(TURNING));
    }
    assert.equal(f.fires(), 0);
  });

  it("holds through the normal tremor of a hand", () => {
    const f = feeder();
    f.feed(view(EMPTY), 2);
    for (let i = 0; i < HOLD + 3; i += 1) f.feed(view(i % 2 ? SIDE_A : SIDE_A_TREMOR));
    assert.equal(f.fires(), 1);
  });

  it("forgives a twitch now and then, never shoots on one, and starts over on twitches in a row", () => {
    // The outline's region twitches (a label shifting a little) while the whole view stays still.
    const held = view(stripes(40, 150), { scene: area(SIDE_A) });
    const twitch = view(stripes(40, 150, 12, 2), { scene: area(SIDE_A) });
    const f = feeder();
    f.feed(view(EMPTY), 2);
    f.feed(held, 3);
    const started = f.state.steadySince;
    assert.notEqual(started, null);
    assert.equal(f.feed(twitch).phase, "steadying");
    assert.equal(f.state.steadySince, started, "the hold goes on");
    // Coming back from the twitch is a second one right away: the hold starts over.
    assert.equal(f.feed(held).blocker, "moving");
    assert.equal(f.state.steadySince, null);

    // Twitches spaced apart are forgiven, the photo is never taken on one, and it follows the hold.
    const g = feeder();
    g.feed(view(EMPTY), 2);
    g.feed(held, 2);
    const hold = g.state.steadySince;
    const spaced = samplesFor(S.wobbleEveryMs) + 1;
    g.feed(twitch);
    g.feed(twitch, spaced);
    assert.equal(g.state.steadySince, hold, "one twitch, then stillness: the hold goes on");
    g.feed(twitch, HOLD);
    assert.equal(g.fires(), 1);
  });

  it("does not photograph a hand held in the outline", () => {
    const f = feeder();
    f.feed(view(EMPTY), 2);
    f.feed(view(SIDE_A, { skin: 0.9 }), samplesFor(10_000));
    assert.equal(f.fires(), 0);
    assert.ok(f.statuses.slice(4).every((s) => s.blocker === "hand"));
  });

  it("does not photograph a view without label detail, however long it is held (no relaxing, no fallback)", () => {
    // A seat cushion after the phone was swung onto it: it moved, it is still, it is not a label.
    const seat = { ...GOOD, sharpness: S.rules.label.minSharpness * 0.8 };
    const f = feeder();
    f.feed(view(EMPTY), 2);
    f.feed(view(SIDE_B, { metrics: seat }), samplesFor(15_000));
    assert.equal(f.fires(), 0);
    assert.ok(f.statuses.slice(4).every((s) => s.blocker === "blurry"));
  });

  it("waits for the arm delay even when the view is good at once", () => {
    const f = feeder("label", { arrival: "none" });
    f.feed(view(SIDE_A), samplesFor(S.armDelayMs.none) + 2);
    assert.equal(f.fires(), 1);
    assert.ok((f.fireAt() + 1) * INTERVAL >= S.armDelayMs.none);
  });

  it("photographs a flat, dark glass close-up", () => {
    const flat = new Uint8ClampedArray(W * H).fill(12);
    const f = feeder("color");
    f.feed(view(EMPTY), 2);
    f.feed(view(flat, { metrics: { brightness: 0.05, contrast: 0.002, sharpness: 0 } }), HOLD + 3);
    assert.equal(f.fires(), 1);
  });
});

describe("stepAutoShutter: a later side (arrival changed)", () => {
  const lastShot = { scene: area(SIDE_A), region: area(SIDE_A) };
  const later = () => feeder("label", { arrival: "changed", reference: lastShot });

  it("never photographs the side already taken, however long it is held", () => {
    const f = later();
    f.feed(view(SIDE_A), samplesFor(12_000));
    assert.equal(f.fires(), 0);
    assert.ok(f.statuses.every((s) => s.blocker === "unchanged"));
    assert.equal(f.statuses.at(-1)?.stalled, true);
  });

  it("does not take a label shifting in the outline for a turn of the bottle", () => {
    // What the first version did (a phone recording, 2026-11-28): a second after the front photo
    // it photographed the same front as the bottom, because the small outline region had changed.
    const f = later();
    for (let i = 0; i < samplesFor(8000); i += 1) {
      f.feed(view(stripes(40, 200, 12, i % 4), { scene: area(SIDE_A) }));
    }
    assert.equal(f.fires(), 0);
  });

  it("does not photograph a bottle that was moved and brought back to the same side", () => {
    const f = later();
    f.feed(view(SIDE_A), 2);
    f.feed(view(TURNING), 2);
    f.feed(view(SIDE_A), samplesFor(8000));
    assert.equal(f.fires(), 0);
  });

  it("photographs the next side once the bottle was turned and held, not before the arm delay", () => {
    const f = later();
    f.feed(view(SIDE_A));
    f.feed(view(TURNING), 2);
    f.feed(view(SIDE_B), samplesFor(S.armDelayMs.changed) + HOLD);
    assert.equal(f.fires(), 1);
    assert.ok((f.fireAt() + 1) * INTERVAL >= S.armDelayMs.changed, "time to see the last photo confirmed and turn the bottle");
  });

  it("sees a turn of a bottle that is small in the view: the outline's region changes, the whole view hardly", () => {
    const background = stripes(60, 64);
    const f = feeder("label", { arrival: "changed", reference: { scene: area(background), region: area(SIDE_A) } });
    f.feed(view(SIDE_A, { scene: area(background) }), samplesFor(3000));
    assert.equal(f.fires(), 0, "the side already taken");
    f.feed(view(TURNING, { scene: area(background) }), 2);
    f.feed(view(SIDE_B, { scene: area(background) }), samplesFor(S.armDelayMs.changed) + HOLD);
    assert.equal(f.fires(), 1);
  });

  it("with nothing to compare (the last photo was an upload) it goes by the turn alone", () => {
    const f = feeder("label", { arrival: "changed" });
    f.feed(view(SIDE_A), samplesFor(4000));
    assert.equal(f.fires(), 0, "no movement yet");
    f.feed(view(TURNING), 2);
    f.feed(view(SIDE_B), samplesFor(S.armDelayMs.changed) + HOLD);
    assert.equal(f.fires(), 1);
  });

  it("a view just past the limit does not flip in and out", () => {
    const reference = new Uint8ClampedArray(W * H).fill(100);
    const over = new Uint8ClampedArray(W * H).fill(100 + Math.ceil(255 * S.minArrivalChange.scene.changed) + 2);
    const under = new Uint8ClampedArray(W * H).fill(100 + Math.floor(255 * S.minArrivalChange.scene.changed) - 6);
    const f = feeder("label", { arrival: "changed", reference: { scene: area(reference), region: area(reference) } });
    f.feed(view(under), 3);
    assert.equal(f.state.differs, false);
    f.feed(view(over));
    assert.equal(f.state.differs, true);
    f.feed(view(under), 2);
    assert.equal(f.state.differs, true, "once different it stays different just under the limit");
    f.feed(view(reference));
    assert.equal(f.state.differs, false, "back to the last photo's view");
  });
});

describe("stepAutoShutter: the same side again (arrival none)", () => {
  it("photographs a bottle that never moved, after the arm delay and a hold", () => {
    const f = feeder("label", { arrival: "none" });
    f.feed(view(SIDE_A), samplesFor(S.armDelayMs.none) + HOLD);
    assert.equal(f.statuses[0].blocker, null);
    assert.equal(f.fires(), 1);
  });
});
