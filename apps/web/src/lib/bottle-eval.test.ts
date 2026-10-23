import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BOTTLE_EVAL_MAX_FRAMES, type BottleSurface } from "swatchwatch-shared";
import { getTabFromQuery } from "./admin-tabs";
import {
  BOTTLE_EVAL_SHOTS,
  bottleEvalReducer,
  canFinish,
  frameTypeForSurface,
  INITIAL_BOTTLE_EVAL_STATE,
  nextShot,
  type BottleEvalSessionState,
  type ShotEntry,
} from "./bottle-eval";

const NONE: ReadonlySet<BottleSurface> = new Set();

function shooting(shots: ShotEntry[] = []): BottleEvalSessionState {
  return {
    ...INITIAL_BOTTLE_EVAL_STATE,
    phase: "shooting",
    label: { kind: "external", brandText: "Holo Taco", shadeText: "Rainbow Taco" },
    sampleId: "s1",
    shots,
  };
}

function shot(localId: string, surface: BottleSurface, status: ShotEntry["status"]): ShotEntry {
  return {
    localId,
    surface,
    dataUrl: "data:image/jpeg;base64,AA==",
    status,
    ...(status === "uploaded" ? { frameId: `f-${localId}` } : {}),
  };
}

describe("BOTTLE_EVAL_SHOTS", () => {
  it("lists front, bottom, glass, then the optional box", () => {
    assert.deepEqual(
      BOTTLE_EVAL_SHOTS.map((s) => [s.surface, s.optional]),
      [
        ["front", false],
        ["bottom", false],
        ["glass", false],
        ["box", true],
      ]
    );
  });
});

describe("nextShot", () => {
  it("starts with the front on a fresh shooting state", () => {
    assert.equal(nextShot(shooting(), NONE)?.surface, "front");
  });

  it("asks for the glass after front and bottom are uploaded", () => {
    const state = shooting([shot("a", "front", "uploaded"), shot("b", "bottom", "uploaded")]);
    assert.equal(nextShot(state, NONE)?.surface, "glass");
  });

  it("asks for the box after the glass", () => {
    const state = shooting([
      shot("a", "front", "uploaded"),
      shot("b", "bottom", "uploaded"),
      shot("c", "glass", "uploaded"),
    ]);
    assert.equal(nextShot(state, NONE)?.surface, "box");
  });

  it("returns null when the box is skipped", () => {
    const state = shooting([
      shot("a", "front", "uploaded"),
      shot("b", "bottom", "uploaded"),
      shot("c", "glass", "uploaded"),
    ]);
    assert.equal(nextShot(state, new Set<BottleSurface>(["box"])), null);
  });

  it("returns null with all four uploaded", () => {
    const state = shooting([
      shot("a", "front", "uploaded"),
      shot("b", "bottom", "uploaded"),
      shot("c", "glass", "uploaded"),
      shot("d", "box", "uploaded"),
    ]);
    assert.equal(nextShot(state, NONE), null);
  });

  it("counts an uploading shot as done but not a failed one", () => {
    assert.equal(nextShot(shooting([shot("a", "front", "uploading")]), NONE)?.surface, "bottom");
    assert.equal(nextShot(shooting([shot("a", "front", "failed")]), NONE)?.surface, "front");
  });
});

describe("bottleEvalReducer", () => {
  it("moves from label to shooting once a label is chosen and the sample created", () => {
    let state = bottleEvalReducer(INITIAL_BOTTLE_EVAL_STATE, {
      type: "label_chosen",
      label: { kind: "catalog", shadeId: "42", brand: "Holo Taco", shadeName: "Rainbow Taco" },
    });
    assert.equal(state.phase, "label");
    assert.equal(state.label?.kind, "catalog");
    state = bottleEvalReducer(state, { type: "sample_created", sampleId: "s9" });
    assert.equal(state.phase, "shooting");
    assert.equal(state.sampleId, "s9");
  });

  it("adds shots as uploading and tracks upload results", () => {
    let state = bottleEvalReducer(shooting(), {
      type: "shot_added",
      shot: { localId: "a", surface: "front", dataUrl: "data:image/jpeg;base64,AA==" },
    });
    assert.equal(state.shots[0].status, "uploading");
    state = bottleEvalReducer(state, { type: "shot_uploaded", localId: "a", frameId: "f1" });
    assert.equal(state.shots[0].status, "uploaded");
    assert.equal(state.shots[0].frameId, "f1");

    state = bottleEvalReducer(state, {
      type: "shot_added",
      shot: { localId: "b", surface: "bottom", dataUrl: "data:image/jpeg;base64,AA==" },
    });
    state = bottleEvalReducer(state, { type: "shot_failed", localId: "b", error: "offline" });
    assert.equal(state.shots[1].status, "failed");
    assert.equal(state.shots[1].error, "offline");
  });

  it(`ignores shot_added past ${BOTTLE_EVAL_MAX_FRAMES} frames`, () => {
    const full = shooting(
      Array.from({ length: BOTTLE_EVAL_MAX_FRAMES }, (_, i) => shot(`s${i}`, "front", "uploaded"))
    );
    const next = bottleEvalReducer(full, {
      type: "shot_added",
      shot: { localId: "extra", surface: "box", dataUrl: "data:image/jpeg;base64,AA==" },
    });
    assert.equal(next, full);
    assert.equal(next.shots.length, BOTTLE_EVAL_MAX_FRAMES);
  });

  it("shot_removed only removes a failed entry", () => {
    const state = shooting([shot("a", "front", "uploaded"), shot("b", "bottom", "failed")]);
    const afterFailed = bottleEvalReducer(state, { type: "shot_removed", localId: "b" });
    assert.deepEqual(
      afterFailed.shots.map((s) => s.localId),
      ["a"]
    );
    const afterUploaded = bottleEvalReducer(afterFailed, { type: "shot_removed", localId: "a" });
    assert.deepEqual(
      afterUploaded.shots.map((s) => s.localId),
      ["a"]
    );
  });

  it("keeps notes", () => {
    const state = bottleEvalReducer(shooting(), { type: "notes_changed", notes: "glare on cap" });
    assert.equal(state.notes, "glare on cap");
  });

  it("finished moves to saved and reset returns the initial state", () => {
    const saved = bottleEvalReducer(shooting([shot("a", "front", "uploaded")]), { type: "finished" });
    assert.equal(saved.phase, "saved");
    assert.deepEqual(bottleEvalReducer(saved, { type: "reset" }), INITIAL_BOTTLE_EVAL_STATE);
  });
});

describe("canFinish", () => {
  it("is false while any shot is uploading", () => {
    assert.equal(canFinish(shooting([shot("a", "front", "uploaded"), shot("b", "bottom", "uploading")])), false);
  });

  it("is false with zero uploaded", () => {
    assert.equal(canFinish(shooting()), false);
    assert.equal(canFinish(shooting([shot("a", "front", "failed")])), false);
  });

  it("is true with one uploaded and a sampleId", () => {
    assert.equal(canFinish(shooting([shot("a", "front", "uploaded")])), true);
  });

  it("is false without a sampleId or outside the shooting phase", () => {
    assert.equal(canFinish({ ...shooting([shot("a", "front", "uploaded")]), sampleId: null }), false);
    assert.equal(canFinish({ ...shooting([shot("a", "front", "uploaded")]), phase: "saved" }), false);
  });
});

describe("frameTypeForSurface", () => {
  it("maps the glass to color and the box to label", () => {
    assert.equal(frameTypeForSurface("glass"), "color");
    assert.equal(frameTypeForSurface("box"), "label");
  });
});

describe("admin tabs", () => {
  it("knows the bottle-eval tab", () => {
    assert.equal(getTabFromQuery("bottle-eval"), "bottle-eval");
  });
});
