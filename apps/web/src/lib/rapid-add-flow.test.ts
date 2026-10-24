import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_STICKY_HINTS, type CaptureQuestion, type StickyHints } from "swatchwatch-shared";
import type { ScannedBarcode } from "./barcode-scan";
import {
  buildFrameQuality,
  buildQuestionView,
  buildStartMetadata,
  canAddFrame,
  canCheck,
  canCheckBarcodeFromMetadata,
  canFinalize,
  framesReducer,
  INITIAL_SESSION_STATE,
  MAX_CAPTURE_FRAMES,
  planLiveBarcode,
  rapidAddPhase,
  scanBadge,
  sessionReducer,
  shouldCheckBarcodeFrame,
  stillFrameTarget,
  summarizeFrames,
  type CaptureFrameEntry,
  type RapidAddSessionState,
} from "./rapid-add-flow";

const barcode: ScannedBarcode = { gtin: "4006381333931", format: "ean_13", engine: "native" };

function frame(localId: string) {
  return { localId, frameType: "label" as const, dataUrl: "data:image/jpeg;base64,AA==", quality: {} };
}

function question(overrides: Partial<CaptureQuestion>): CaptureQuestion {
  return {
    id: "q1",
    key: "candidate_select",
    prompt: "Pick one",
    type: "single_select",
    status: "open",
    createdAt: "2026-10-17T00:00:00Z",
    ...overrides,
  };
}

describe("framesReducer", () => {
  it("adds frames as uploading and tracks success", () => {
    let state = framesReducer([], { type: "added", frame: frame("a") });
    assert.equal(state[0].status, "uploading");
    assert.equal(state[0].attempts, 1);
    state = framesReducer(state, { type: "upload_succeeded", localId: "a", frameId: "f1" });
    assert.equal(state[0].status, "uploaded");
    assert.equal(state[0].frameId, "f1");
  });

  it("keeps failed frames for retry and counts attempts", () => {
    let state = framesReducer([], { type: "added", frame: frame("a") });
    state = framesReducer(state, { type: "upload_failed", localId: "a", error: "offline" });
    assert.equal(state[0].status, "failed");
    assert.equal(state[0].error, "offline");
    state = framesReducer(state, { type: "upload_started", localId: "a" });
    assert.equal(state[0].status, "uploading");
    assert.equal(state[0].attempts, 2);
    assert.equal(state[0].error, undefined);
  });

  it("only retries failed frames and only removes failed frames", () => {
    let state = framesReducer([], { type: "added", frame: frame("a") });
    state = framesReducer(state, { type: "upload_succeeded", localId: "a", frameId: "f1" });
    assert.equal(framesReducer(state, { type: "upload_started", localId: "a" })[0].attempts, 1);
    assert.equal(framesReducer(state, { type: "removed", localId: "a" }).length, 1);
    state = framesReducer(state, { type: "added", frame: frame("b") });
    state = framesReducer(state, { type: "upload_failed", localId: "b", error: "x" });
    assert.deepEqual(
      framesReducer(state, { type: "removed", localId: "b" }).map((f) => f.localId),
      ["a"],
    );
  });

  it("ignores duplicates and frames beyond the limit", () => {
    let state: CaptureFrameEntry[] = [];
    for (let i = 0; i < MAX_CAPTURE_FRAMES + 2; i += 1) {
      state = framesReducer(state, { type: "added", frame: frame(String(i)) });
    }
    assert.equal(state.length, MAX_CAPTURE_FRAMES);
    assert.equal(canAddFrame(state), false);
    assert.equal(framesReducer(state, { type: "added", frame: frame("0") }).length, MAX_CAPTURE_FRAMES);
    assert.deepEqual(framesReducer(state, { type: "reset" }), []);
  });

  it("summarizes upload states", () => {
    let state = framesReducer([], { type: "added", frame: frame("a") });
    state = framesReducer(state, { type: "added", frame: frame("b") });
    state = framesReducer(state, { type: "added", frame: frame("c") });
    state = framesReducer(state, { type: "upload_succeeded", localId: "a", frameId: "1" });
    state = framesReducer(state, { type: "upload_failed", localId: "b", error: "x" });
    assert.deepEqual(summarizeFrames(state), { total: 3, uploading: 1, uploaded: 1, failed: 1 });
  });
});

describe("sessionReducer / rapidAddPhase", () => {
  it("walks collecting → resolving → verdict", () => {
    let state = sessionReducer(INITIAL_SESSION_STATE, { type: "barcode_detected", barcode });
    assert.equal(state.barcode?.gtin, barcode.gtin);
    state = sessionReducer(state, { type: "busy", busy: "starting" });
    state = sessionReducer(state, { type: "session_started", captureId: "c1", status: "processing" });
    assert.equal(state.busy, null);
    assert.equal(rapidAddPhase(state), "collecting");

    state = sessionReducer(state, { type: "busy", busy: "finalizing" });
    state = sessionReducer(state, { type: "status_received", status: "matched" });
    assert.equal(state.busy, "resolving");
    assert.equal(rapidAddPhase(state), "resolving");

    state = sessionReducer(state, {
      type: "verdict_resolved",
      verdict: { kind: "added", display: "X", priorOwnership: "none" },
    });
    assert.equal(rapidAddPhase(state), "verdict");
    assert.equal(state.busy, null);
  });

  it("enters the question phase and leaves it after a skip", () => {
    let state = sessionReducer(
      { ...INITIAL_SESSION_STATE, captureId: "c1", status: "processing" },
      { type: "status_received", status: "needs_question", question: question({}) },
    );
    assert.equal(rapidAddPhase(state), "question");
    state = sessionReducer(state, { type: "status_received", status: "processing" });
    assert.equal(state.question, null);
    assert.equal(rapidAddPhase(state), "collecting");
  });

  it("ignores new barcodes once a session has finished", () => {
    const finished: RapidAddSessionState = { ...INITIAL_SESSION_STATE, status: "matched" };
    assert.equal(sessionReducer(finished, { type: "barcode_detected", barcode }), finished);
  });

  it("records failures, clears them on the next action, and resets", () => {
    let state = sessionReducer(INITIAL_SESSION_STATE, { type: "busy", busy: "finalizing" });
    state = sessionReducer(state, { type: "failed", error: "nope" });
    assert.equal(state.busy, null);
    assert.equal(state.error, "nope");
    state = sessionReducer(state, { type: "busy", busy: "finalizing" });
    assert.equal(state.error, null);
    assert.equal(sessionReducer(state, { type: "reset" }), INITIAL_SESSION_STATE);
  });

  it("marks the quantity undo", () => {
    const state = sessionReducer({ ...INITIAL_SESSION_STATE, busy: "undoing" }, { type: "quantity_restored" });
    assert.equal(state.quantityRestored, true);
    assert.equal(state.busy, null);
  });
});

describe("canFinalize", () => {
  const ready: RapidAddSessionState = { ...INITIAL_SESSION_STATE, captureId: "c1", status: "processing" };
  const uploaded = framesReducer(framesReducer([], { type: "added", frame: frame("a") }), {
    type: "upload_succeeded",
    localId: "a",
    frameId: "1",
  });

  it("needs evidence: an uploaded frame, a barcode or hints", () => {
    assert.equal(canFinalize({ frames: [], session: INITIAL_SESSION_STATE, hasHints: false }), false);
    assert.equal(canFinalize({ frames: [], session: INITIAL_SESSION_STATE, hasHints: true }), true);
    assert.equal(canFinalize({ frames: uploaded, session: ready, hasHints: false }), true);
    assert.equal(
      canFinalize({ frames: [], session: { ...INITIAL_SESSION_STATE, barcode }, hasHints: false }),
      true,
    );
  });

  it("waits for uploads and busy requests, and stops after a verdict", () => {
    const uploading = framesReducer(uploaded, { type: "added", frame: frame("b") });
    assert.equal(canFinalize({ frames: uploading, session: ready, hasHints: false }), false);
    assert.equal(canFinalize({ frames: uploaded, session: { ...ready, busy: "finalizing" }, hasHints: false }), false);
    assert.equal(
      canFinalize({
        frames: uploaded,
        session: { ...ready, status: "matched", verdict: { kind: "add", evidence: {} } },
        hasHints: false,
      }),
      false,
    );
  });
});

describe("buildStartMetadata / buildFrameQuality", () => {
  it("puts the scanned GTIN and trimmed hints in the session metadata", () => {
    assert.deepEqual(
      buildStartMetadata({ barcode, hints: { brand: " OPI ", shadeName: "", finish: "creme" } }),
      {
        source: "web-rapid-add",
        brand: "OPI",
        finish: "creme",
        gtin: "4006381333931",
        barcodeFormat: "ean_13",
        barcodeDecoder: "native",
      },
    );
    assert.deepEqual(buildStartMetadata({ barcode: null, hints: {} }), { source: "web-rapid-add" });
  });

  it("sends frame metrics and the barcode as quality", () => {
    const quality = buildFrameQuality({
      source: "web-file-input",
      width: 1200,
      height: 1600,
      sourceWidth: 3024,
      sourceHeight: 4032,
      metrics: { brightness: 0.5, contrast: 0.2, sharpness: 0.05 },
      barcode,
      fileName: "bottle.jpg",
      mimeType: "image/jpeg",
      fileSize: 123,
    });
    assert.equal(quality.gtin, "4006381333931");
    assert.equal(quality.barcodeDecoder, "native");
    assert.equal(quality.sharpness, 0.05);
    assert.equal(quality.fileName, "bottle.jpg");
    const noBarcode = buildFrameQuality({
      source: "web-camera",
      width: 1,
      height: 1,
      sourceWidth: 1,
      sourceHeight: 1,
      metrics: { brightness: 0, contrast: 0, sharpness: 0 },
    });
    assert.equal("gtin" in noBarcode, false);
    assert.equal("fileName" in noBarcode, false);
  });
});

describe("buildQuestionView", () => {
  it("turns frame requests into camera actions with a skip", () => {
    const view = buildQuestionView(
      question({ key: "capture_frame", options: ["scan_barcode", "upload_label_photo", "skip"] }),
    );
    assert.deepEqual(
      view.choices.map((c) => (c.kind === "action" ? c.action : c.value)),
      ["scan_barcode", "upload_label_photo"],
    );
    assert.equal(view.canSkip, true);
    assert.equal(view.allowsFreeText, false);
  });

  it("offers free text for brand + shade", () => {
    const view = buildQuestionView(
      question({ key: "brand_shade", type: "free_text", options: ["brand + shade", "upload_label_photo", "skip"] }),
    );
    assert.equal(view.allowsFreeText, true);
    assert.deepEqual(view.choices, [{ kind: "action", label: "Add a label photo", action: "upload_label_photo" }]);
  });

  it("renders candidates with readable labels and the raw value as the answer", () => {
    const view = buildQuestionView(question({ options: ["42: OPI — Big Apple Red", "skip"] }));
    assert.deepEqual(view.choices, [{ kind: "answer", label: "OPI — Big Apple Red", value: "42: OPI — Big Apple Red" }]);
  });
});

describe("barcode check flow", () => {
  const started: RapidAddSessionState = {
    ...INITIAL_SESSION_STATE,
    captureId: "c1",
    status: "processing",
    barcode,
  };

  it("shows the barcode as read (✓) while the server is checking, then plainly read", () => {
    assert.equal(scanBadge(INITIAL_SESSION_STATE), null);
    assert.deepEqual(scanBadge({ ...started, busy: "checking" }), { gtin: barcode.gtin, checking: true });
    assert.deepEqual(scanBadge(started), { gtin: barcode.gtin, checking: false });
  });

  it("a check verdict is shown while the session stays open (nothing finalized)", () => {
    const state = sessionReducer(
      { ...started, busy: "checking" },
      { type: "verdict_resolved", verdict: { kind: "unknown_barcode", gtin: barcode.gtin } },
    );
    assert.equal(rapidAddPhase(state), "verdict");
    assert.equal(state.status, "processing");
    assert.equal(state.busy, null);
  });

  it("'Photograph the label' leaves the verdict and keeps the session and barcode for the label frame", () => {
    const withVerdict = sessionReducer(started, {
      type: "verdict_resolved",
      verdict: { kind: "unknown_barcode", gtin: barcode.gtin },
    });
    const next = sessionReducer(withVerdict, { type: "label_requested" });
    assert.equal(next.verdict, null);
    assert.equal(next.captureId, "c1");
    assert.deepEqual(next.barcode, barcode);
    assert.equal(next.labelRequested, true);
    assert.equal(rapidAddPhase(next), "collecting");
    assert.equal(canFinalize({ frames: [], session: next, hasHints: false }), true);
  });

  it("a reset clears the label request", () => {
    const next = sessionReducer({ ...started, labelRequested: true }, { type: "reset" });
    assert.equal(next.labelRequested, false);
  });
});

describe("canCheckBarcodeFromMetadata", () => {
  it("only a session this read starts carries the GTIN in its metadata", () => {
    assert.equal(canCheckBarcodeFromMetadata(INITIAL_SESSION_STATE, barcode), true);
  });

  it("not in the bottle sequence: the barcode rides along in the start metadata instead", () => {
    assert.equal(canCheckBarcodeFromMetadata(INITIAL_SESSION_STATE, barcode, { bottleSequence: true }), false);
  });

  it("an already started session (label photo first) never learns it from a frameless read", () => {
    assert.equal(canCheckBarcodeFromMetadata({ ...INITIAL_SESSION_STATE, captureId: "c1" }, barcode), false);
  });

  it("not while photographing the label for an unknown barcode, after a verdict, or without a barcode", () => {
    assert.equal(canCheckBarcodeFromMetadata({ ...INITIAL_SESSION_STATE, labelRequested: true }, barcode), false);
    assert.equal(
      canCheckBarcodeFromMetadata({ ...INITIAL_SESSION_STATE, verdict: { kind: "unknown_barcode", gtin: barcode.gtin } }, barcode),
      false,
    );
    assert.equal(canCheckBarcodeFromMetadata(INITIAL_SESSION_STATE, null), false);
  });
});

describe("shouldCheckBarcodeFrame", () => {
  const afterFront: RapidAddSessionState = { ...INITIAL_SESSION_STATE, captureId: "c1", status: "processing" };

  it("a decoded barcode is checked at once outside the bottle sequence", () => {
    assert.equal(shouldCheckBarcodeFrame(afterFront, barcode, { bottleSequence: false }), true);
  });

  it("not in the bottle sequence: a barcode read while turning to the bottom keeps the server's nextFrame", () => {
    // Regression: after the front photo, the bottom's (or side's) barcode was checked as a plain
    // barcode scan and the verdict replaced the "Now the bottom" prompt before it was taken.
    assert.equal(shouldCheckBarcodeFrame(afterFront, barcode, { bottleSequence: true }), false);
    assert.equal(shouldCheckBarcodeFrame(INITIAL_SESSION_STATE, barcode, { bottleSequence: true }), false);
  });

  it("not while photographing the label for an unknown barcode, after a verdict, or without a barcode", () => {
    const opts = { bottleSequence: false };
    assert.equal(shouldCheckBarcodeFrame({ ...afterFront, labelRequested: true }, barcode, opts), false);
    assert.equal(
      shouldCheckBarcodeFrame({ ...afterFront, verdict: { kind: "unknown_barcode", gtin: barcode.gtin } }, barcode, opts),
      false,
    );
    assert.equal(shouldCheckBarcodeFrame(afterFront, null, opts), false);
  });
});

describe("stillFrameTarget", () => {
  const bottom = { surface: "bottom" as const, frameType: "label" as const };

  it("a bottle photo with a barcode in view stays the prompted surface's frame", () => {
    // Regression: the bottom's barcode sticker turned the bottom photo into a barcode frame with
    // no surface, so it skipped OCR and the sticker read and the bottom was never counted.
    for (const trigger of ["shutter", "auto", "file"] as const) {
      assert.deepEqual(stillFrameTarget({ frameType: "barcode", barcode, trigger }, bottom), {
        frameType: "label",
        surface: "bottom",
      });
    }
  });

  it("a live barcode read is a barcode frame with no surface", () => {
    assert.deepEqual(stillFrameTarget({ frameType: "barcode", barcode, trigger: "live-scan" }, bottom), {
      frameType: "barcode",
      surface: null,
    });
  });

  it("outside the bottle sequence the camera's frame type is kept", () => {
    assert.deepEqual(stillFrameTarget({ frameType: "barcode", barcode, trigger: "shutter" }, null), {
      frameType: "barcode",
      surface: null,
    });
    assert.deepEqual(stillFrameTarget({ frameType: "label", barcode: null, trigger: "shutter" }, null), {
      frameType: "label",
      surface: null,
    });
  });
});

describe("bottle flow additions", () => {
  const baseQuality = {
    source: "web-camera" as const,
    width: 1,
    height: 1,
    sourceWidth: 1,
    sourceHeight: 1,
    metrics: { brightness: 0, contrast: 0, sharpness: 0 },
  };

  it("adds the surface to frame quality only when set", () => {
    assert.equal(buildFrameQuality({ ...baseQuality, surface: "glass" }).surface, "glass");
    assert.equal("surface" in buildFrameQuality(baseQuality), false);
    assert.equal("surface" in buildFrameQuality({ ...baseQuality, surface: null }), false);
  });

  it("fills start metadata from sticky hints when the per-bottle hint is empty", () => {
    const sticky: StickyHints = {
      ...EMPTY_STICKY_HINTS,
      brand: "loud",
      brandCanonical: "Loud Lacquer",
      finish: "creme",
    };
    const metadata = buildStartMetadata({ barcode: null, hints: {}, sticky });
    assert.equal(metadata.brand, "Loud Lacquer");
    assert.equal(metadata.finish, "creme");
    assert.equal("collection" in metadata, false);
  });

  it("lets a typed per-bottle hint beat the sticky one", () => {
    const sticky: StickyHints = { ...EMPTY_STICKY_HINTS, brand: "loud", brandCanonical: "Loud Lacquer", finish: "creme" };
    const metadata = buildStartMetadata({ barcode: null, hints: { brand: "OPI", finish: "glitter" }, sticky });
    assert.equal(metadata.brand, "OPI");
    assert.equal(metadata.finish, "glitter");
  });

  it("ignores null sticky hints", () => {
    assert.deepEqual(buildStartMetadata({ barcode: null, hints: {}, sticky: null }), { source: "web-rapid-add" });
  });

  describe("canCheck", () => {
    const collecting: RapidAddSessionState = { ...INITIAL_SESSION_STATE, captureId: "c1", status: "processing" };
    const one = framesReducer([], { type: "added", frame: frame("a") });
    const uploaded = framesReducer(one, { type: "upload_succeeded", localId: "a", frameId: "1" });

    it("is false while a frame uploads and true once one is uploaded", () => {
      assert.equal(canCheck({ frames: one, session: collecting, hasHints: false }), false);
      assert.equal(canCheck({ frames: uploaded, session: collecting, hasHints: false }), true);
    });

    it("is false without evidence or while busy", () => {
      assert.equal(canCheck({ frames: [], session: INITIAL_SESSION_STATE, hasHints: false }), false);
      assert.equal(canCheck({ frames: [], session: INITIAL_SESSION_STATE, hasHints: true }), true);
      assert.equal(canCheck({ frames: uploaded, session: { ...collecting, busy: "checking" }, hasHints: false }), false);
    });

    it("is allowed in the collecting phase but not in a question", () => {
      const asking: RapidAddSessionState = {
        ...collecting,
        status: "needs_question",
        question: question({}),
      };
      assert.equal(canCheck({ frames: uploaded, session: asking, hasHints: false }), false);
    });
  });
});

describe("planLiveBarcode", () => {
  const other = "0123456789012";
  const checked = { kind: "checked", relationship: "owned", shadeId: "1" } as unknown as RapidAddSessionState["verdict"];

  it("starts a scan when nothing has been read", () => {
    assert.equal(planLiveBarcode(INITIAL_SESSION_STATE, barcode.gtin), "scan");
  });

  it("calls the same code a repeat, or waits while it is being checked", () => {
    const read = { ...INITIAL_SESSION_STATE, barcode };
    assert.equal(planLiveBarcode(read, barcode.gtin), "repeat");
    assert.equal(planLiveBarcode({ ...read, busy: "checking" }, barcode.gtin), "wait");
    assert.equal(planLiveBarcode({ ...read, verdict: checked }, barcode.gtin), "repeat");
  });

  it("starts the next bottle on a new code while a verdict shows", () => {
    assert.equal(planLiveBarcode({ ...INITIAL_SESSION_STATE, barcode, verdict: checked }, other), "next_scan");
    assert.equal(
      planLiveBarcode({ ...INITIAL_SESSION_STATE, barcode, verdict: checked, busy: "wishlisting" }, other),
      "wait",
    );
  });

  it("only offers a new code mid-scan or while a pick list or create card waits", () => {
    assert.equal(planLiveBarcode({ ...INITIAL_SESSION_STATE, barcode }, other), "finish_first");
    for (const kind of ["pick", "create_card"]) {
      const verdict = { kind } as unknown as RapidAddSessionState["verdict"];
      assert.equal(planLiveBarcode({ ...INITIAL_SESSION_STATE, verdict }, other), "finish_first");
    }
  });

  it("waits while a finished session resolves", () => {
    assert.equal(planLiveBarcode({ ...INITIAL_SESSION_STATE, status: "matched" }, other), "wait");
  });
});
