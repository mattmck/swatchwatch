import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CaptureQuestion } from "swatchwatch-shared";
import type { ScannedBarcode } from "./barcode-scan";
import {
  buildFrameQuality,
  buildQuestionView,
  buildStartMetadata,
  canAddFrame,
  canFinalize,
  framesReducer,
  INITIAL_SESSION_STATE,
  MAX_CAPTURE_FRAMES,
  rapidAddPhase,
  sessionReducer,
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
