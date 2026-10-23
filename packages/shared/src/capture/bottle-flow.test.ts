import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CaptureFrameRequestSpec } from "../types/capture";
import {
  BOTTLE_DEFAULT_SURFACE_ORDER,
  bottleFlowReducer,
  DEFAULT_SURFACE_PROMPTS,
  deriveBottleCameraView,
  INITIAL_BOTTLE_FLOW_STATE,
  shouldAutoCheck,
  surfaceFromQuality,
  type BottleFlowClientState,
} from "./bottle-flow";

const serverSpec: CaptureFrameRequestSpec = {
  surface: "glass",
  frameType: "color",
  prompt: "Turn it so we see the color",
  hint: "Hold it up to the light",
  reason: "need_color",
  optional: true,
};

describe("constants", () => {
  it("pins the default order and the client prompts", () => {
    assert.deepEqual([...BOTTLE_DEFAULT_SURFACE_ORDER], ["front", "bottom", "glass"]);
    assert.deepEqual(DEFAULT_SURFACE_PROMPTS, {
      front: "Show the front of the bottle",
      bottom: "Now the bottom",
      glass: "Turn it so we see the color",
      box: "Have the box? Show the barcode",
    });
  });
});

describe("surfaceFromQuality", () => {
  it("reads a valid surface", () => {
    assert.equal(surfaceFromQuality({ surface: "bottom" }), "bottom");
  });

  it("returns null for anything else", () => {
    assert.equal(surfaceFromQuality({ surface: "side" }), null);
    assert.equal(surfaceFromQuality({ surface: 3 }), null);
    assert.equal(surfaceFromQuality({}), null);
    assert.equal(surfaceFromQuality(null), null);
    assert.equal(surfaceFromQuality(undefined), null);
  });
});

describe("bottleFlowReducer", () => {
  it("session_started with no nextFrame marks the session started with a null nextFrame", () => {
    const next = bottleFlowReducer(INITIAL_BOTTLE_FLOW_STATE, { type: "session_started" });
    assert.equal(next.sessionStarted, true);
    assert.equal(next.nextFrame, null);
    assert.equal(next.brandEcho, null);
  });

  it("session_started stores the brand echo and first frame", () => {
    const echo = { raw: "loud", brandId: "7", name: "Loud Lacquer" };
    const next = bottleFlowReducer(INITIAL_BOTTLE_FLOW_STATE, {
      type: "session_started",
      brandHint: echo,
      nextFrame: serverSpec,
    });
    assert.deepEqual(next.brandEcho, echo);
    assert.deepEqual(next.nextFrame, serverSpec);
  });

  it("frame_uploaded appends the surface once", () => {
    let state = bottleFlowReducer(INITIAL_BOTTLE_FLOW_STATE, { type: "frame_uploaded", surface: "glass" });
    state = bottleFlowReducer(state, { type: "frame_uploaded", surface: "glass" });
    assert.deepEqual(state.captured, ["glass"]);
  });

  it("frame_uploaded with a null surface leaves captured alone and replaces nextFrame", () => {
    const start = { ...INITIAL_BOTTLE_FLOW_STATE, nextFrame: serverSpec };
    const next = bottleFlowReducer(start, { type: "frame_uploaded", surface: null });
    assert.deepEqual(next.captured, []);
    assert.equal(next.nextFrame, null);
  });

  it("surface_skipped adds to skipped once", () => {
    let state = bottleFlowReducer(INITIAL_BOTTLE_FLOW_STATE, { type: "surface_skipped", surface: "box" });
    state = bottleFlowReducer(state, { type: "surface_skipped", surface: "box" });
    assert.deepEqual(state.skipped, ["box"]);
  });

  it("check_received stores the brand conflict and nextFrame", () => {
    const conflict = {
      hinted: { brandId: null, name: "Loud", source: "hint" as const },
      read: { brandId: "3", name: "Zoya", source: "read" as const },
    };
    const next = bottleFlowReducer(INITIAL_BOTTLE_FLOW_STATE, {
      type: "check_received",
      nextFrame: serverSpec,
      brandConflict: conflict,
    });
    assert.deepEqual(next.brandConflict, conflict);
    assert.deepEqual(next.nextFrame, serverSpec);
  });

  it("check_received without a conflict clears a stale one", () => {
    const stale = bottleFlowReducer(INITIAL_BOTTLE_FLOW_STATE, {
      type: "check_received",
      brandConflict: {
        hinted: { brandId: null, name: "a", source: "hint" },
        read: { brandId: null, name: "b", source: "read" },
      },
    });
    assert.equal(bottleFlowReducer(stale, { type: "check_received" }).brandConflict, null);
  });

  it("reset returns the initial state", () => {
    const busy = bottleFlowReducer(INITIAL_BOTTLE_FLOW_STATE, { type: "frame_uploaded", surface: "front" });
    assert.deepEqual(bottleFlowReducer(busy, { type: "reset" }), INITIAL_BOTTLE_FLOW_STATE);
  });
});

describe("deriveBottleCameraView", () => {
  it("starts at the front of three when the brand is unknown", () => {
    const view = deriveBottleCameraView(INITIAL_BOTTLE_FLOW_STATE, { brandKnown: false });
    assert.ok(view);
    assert.equal(view.surface, "front");
    assert.equal(view.frameType, "label");
    assert.equal(view.prompt, DEFAULT_SURFACE_PROMPTS.front);
    assert.equal(view.step, 1);
    assert.equal(view.total, 3);
    assert.equal(view.hint, null);
    assert.equal(view.reason, null);
    assert.equal(view.optional, false);
  });

  it("moves on past captured surfaces", () => {
    const view = deriveBottleCameraView({ ...INITIAL_BOTTLE_FLOW_STATE, captured: ["front"] }, { brandKnown: false });
    assert.equal(view?.surface, "bottom");
    assert.equal(view?.step, 2);
  });

  it("skips the front when the brand is known", () => {
    const view = deriveBottleCameraView(INITIAL_BOTTLE_FLOW_STATE, { brandKnown: true });
    assert.equal(view?.surface, "bottom");
    assert.equal(view?.step, 1);
    assert.equal(view?.total, 2);
  });

  it("returns null when everything was skipped before the session started", () => {
    const state: BottleFlowClientState = { ...INITIAL_BOTTLE_FLOW_STATE, skipped: ["front", "bottom", "glass"] };
    assert.equal(deriveBottleCameraView(state, { brandKnown: false }), null);
  });

  it("returns null once the session started and the server asked for nothing", () => {
    const state: BottleFlowClientState = { ...INITIAL_BOTTLE_FLOW_STATE, sessionStarted: true, nextFrame: null };
    assert.equal(deriveBottleCameraView(state, { brandKnown: false }), null);
  });

  it("lets the server nextFrame win and keeps its hint, reason and optional", () => {
    const state: BottleFlowClientState = { ...INITIAL_BOTTLE_FLOW_STATE, sessionStarted: true, nextFrame: serverSpec };
    const view = deriveBottleCameraView(state, { brandKnown: false });
    assert.deepEqual(view && { ...view }, {
      surface: "glass",
      frameType: "color",
      prompt: "Turn it so we see the color",
      hint: "Hold it up to the light",
      reason: "need_color",
      optional: true,
      step: 3,
      total: 3,
    });
  });
});

describe("shouldAutoCheck", () => {
  const started: BottleFlowClientState = { ...INITIAL_BOTTLE_FLOW_STATE, sessionStarted: true, nextFrame: null };

  it("is true when the server asked for nothing and a frame is uploaded", () => {
    assert.equal(shouldAutoCheck(started, 1), true);
  });

  it("is false with no uploaded frames", () => {
    assert.equal(shouldAutoCheck(started, 0), false);
  });

  it("is false while the server wants another frame", () => {
    assert.equal(shouldAutoCheck({ ...started, nextFrame: serverSpec }, 2), false);
  });

  it("is false before the session started", () => {
    assert.equal(shouldAutoCheck(INITIAL_BOTTLE_FLOW_STATE, 1), false);
  });
});
