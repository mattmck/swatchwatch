/**
 * Pure state for the Rapid Add page: the capture-frame upload queue, the capture-session
 * state machine, and how adaptive questions render. No DOM or network here; the page
 * wires these reducers to the camera, the barcode scanner and the capture API.
 */
import type { CaptureFrameType, CaptureQuestion, CaptureStatus } from "swatchwatch-shared";
import type { ScannedBarcode } from "./barcode-scan";
import type { FrameQualityMetrics } from "./camera";
import type { CaptureOutcome, CaptureVerdict } from "./capture-verdict";
import { candidateOptionLabel } from "./capture-verdict";

/** Matches the capture API's `guidanceConfig.maxFrames`. */
export const MAX_CAPTURE_FRAMES = 6;

// ---------------------------------------------------------------------------
// Frame upload queue
// ---------------------------------------------------------------------------

export type FrameUploadStatus = "uploading" | "uploaded" | "failed";

export type FrameSource = "web-camera" | "web-file-input";

export interface CaptureFrameEntry {
  localId: string;
  frameType: CaptureFrameType;
  /** JPEG data URL; also used as the thumbnail. */
  dataUrl: string;
  quality: Record<string, unknown>;
  status: FrameUploadStatus;
  attempts: number;
  frameId?: string;
  error?: string;
}

export type FramesAction =
  | {
      type: "added";
      frame: Pick<CaptureFrameEntry, "localId" | "frameType" | "dataUrl" | "quality">;
    }
  | { type: "upload_started"; localId: string }
  | { type: "upload_succeeded"; localId: string; frameId: string }
  | { type: "upload_failed"; localId: string; error: string }
  | { type: "removed"; localId: string }
  | { type: "reset" };

/**
 * New frames start "uploading" (they are sent immediately). A failed frame stays in the
 * list with its error so the user can retry it; only failed frames can be removed, since
 * an uploaded frame is already part of the server-side session.
 */
export function framesReducer(
  state: readonly CaptureFrameEntry[],
  action: FramesAction,
): CaptureFrameEntry[] {
  switch (action.type) {
    case "added":
      if (state.length >= MAX_CAPTURE_FRAMES || state.some((f) => f.localId === action.frame.localId)) {
        return [...state];
      }
      return [...state, { ...action.frame, status: "uploading", attempts: 1 }];
    case "upload_started":
      return state.map((frame) =>
        frame.localId === action.localId && frame.status === "failed"
          ? { ...frame, status: "uploading", attempts: frame.attempts + 1, error: undefined }
          : frame,
      );
    case "upload_succeeded":
      return state.map((frame) =>
        frame.localId === action.localId
          ? { ...frame, status: "uploaded", frameId: action.frameId, error: undefined }
          : frame,
      );
    case "upload_failed":
      return state.map((frame) =>
        frame.localId === action.localId ? { ...frame, status: "failed", error: action.error } : frame,
      );
    case "removed":
      return state.filter((frame) => !(frame.localId === action.localId && frame.status === "failed"));
    case "reset":
      return [];
  }
}

export interface FrameSummary {
  total: number;
  uploading: number;
  uploaded: number;
  failed: number;
}

export function summarizeFrames(frames: readonly CaptureFrameEntry[]): FrameSummary {
  return frames.reduce<FrameSummary>(
    (acc, frame) => {
      acc.total += 1;
      acc[frame.status] += 1;
      return acc;
    },
    { total: 0, uploading: 0, uploaded: 0, failed: 0 },
  );
}

export function canAddFrame(frames: readonly CaptureFrameEntry[]): boolean {
  return frames.length < MAX_CAPTURE_FRAMES;
}

export interface FrameQualityInput {
  source: FrameSource;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  metrics: FrameQualityMetrics;
  barcode?: ScannedBarcode | null;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

/**
 * The `quality` object sent with a frame. A detected barcode is included as `gtin`, which
 * the capture API reads as request-supplied evidence when its own OCR finds none.
 */
export function buildFrameQuality(input: FrameQualityInput): Record<string, unknown> {
  const quality: Record<string, unknown> = {
    source: input.source,
    width: input.width,
    height: input.height,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    brightness: input.metrics.brightness,
    contrast: input.metrics.contrast,
    sharpness: input.metrics.sharpness,
  };
  if (input.barcode) {
    quality.gtin = input.barcode.gtin;
    quality.barcodeFormat = input.barcode.format;
    quality.barcodeDecoder = input.barcode.engine;
  }
  if (input.fileName !== undefined) quality.fileName = input.fileName;
  if (input.mimeType !== undefined) quality.mimeType = input.mimeType;
  if (input.fileSize !== undefined) quality.fileSize = input.fileSize;
  return quality;
}

// ---------------------------------------------------------------------------
// Capture session
// ---------------------------------------------------------------------------

export type RapidAddBusy = "starting" | "finalizing" | "answering" | "resolving" | "undoing";

export interface RapidAddSessionState {
  captureId: string | null;
  status: CaptureStatus | null;
  question: CaptureQuestion | null;
  barcode: ScannedBarcode | null;
  outcome: CaptureOutcome | null;
  verdict: CaptureVerdict | null;
  /** Set once the "I didn't buy another" quantity undo has been applied. */
  quantityRestored: boolean;
  busy: RapidAddBusy | null;
  error: string | null;
}

export const INITIAL_SESSION_STATE: RapidAddSessionState = {
  captureId: null,
  status: null,
  question: null,
  barcode: null,
  outcome: null,
  verdict: null,
  quantityRestored: false,
  busy: null,
  error: null,
};

export type SessionAction =
  | { type: "barcode_detected"; barcode: ScannedBarcode }
  | { type: "busy"; busy: RapidAddBusy }
  | { type: "session_started"; captureId: string; status: CaptureStatus }
  | { type: "status_received"; status: CaptureStatus; question?: CaptureQuestion | null }
  | { type: "outcome_received"; outcome: CaptureOutcome }
  | { type: "verdict_resolved"; verdict: CaptureVerdict | null }
  | { type: "quantity_restored" }
  | { type: "failed"; error: string }
  | { type: "error_dismissed" }
  | { type: "reset" };

function isFinished(status: CaptureStatus | null): boolean {
  return status === "matched" || status === "unmatched" || status === "cancelled";
}

export function sessionReducer(state: RapidAddSessionState, action: SessionAction): RapidAddSessionState {
  switch (action.type) {
    case "barcode_detected":
      // Once a session has an answer, a new barcode belongs to the next scan (after reset).
      if (isFinished(state.status)) return state;
      if (state.barcode?.gtin === action.barcode.gtin) return state;
      return { ...state, barcode: action.barcode };
    case "busy":
      return { ...state, busy: action.busy, error: null };
    case "session_started":
      return { ...state, captureId: action.captureId, status: action.status, busy: null };
    case "status_received":
      return {
        ...state,
        status: action.status,
        question: action.status === "needs_question" ? action.question ?? null : null,
        busy: isFinished(action.status) ? "resolving" : null,
      };
    case "outcome_received":
      return { ...state, outcome: action.outcome, status: action.outcome.status };
    case "verdict_resolved":
      return { ...state, verdict: action.verdict, busy: null };
    case "quantity_restored":
      return { ...state, quantityRestored: true, busy: null };
    case "failed":
      return { ...state, busy: null, error: action.error };
    case "error_dismissed":
      return { ...state, error: null };
    case "reset":
      return INITIAL_SESSION_STATE;
  }
}

export type RapidAddPhase = "collecting" | "question" | "resolving" | "verdict";

export function rapidAddPhase(state: RapidAddSessionState): RapidAddPhase {
  if (state.verdict) return "verdict";
  if (isFinished(state.status)) return "resolving";
  if (state.status === "needs_question" && state.question) return "question";
  return "collecting";
}

/**
 * Finalize needs something to match on: an uploaded frame, a scanned barcode, or typed
 * hints. It waits while any frame is still uploading so the resolver sees every frame.
 */
export function canFinalize(input: {
  frames: readonly CaptureFrameEntry[];
  session: RapidAddSessionState;
  hasHints: boolean;
}): boolean {
  if (input.session.busy) return false;
  if (rapidAddPhase(input.session) !== "collecting") return false;
  const summary = summarizeFrames(input.frames);
  if (summary.uploading > 0) return false;
  return summary.uploaded > 0 || Boolean(input.session.barcode) || input.hasHints;
}

/** Metadata for `POST /api/capture/start`: a scanned GTIN is the strongest evidence. */
export function buildStartMetadata(input: {
  barcode: ScannedBarcode | null;
  hints: { brand?: string; shadeName?: string; finish?: string; collection?: string };
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = { source: "web-rapid-add" };
  const trimmed = (value?: string) => (value && value.trim() ? value.trim() : undefined);
  const brand = trimmed(input.hints.brand);
  const shadeName = trimmed(input.hints.shadeName);
  const finish = trimmed(input.hints.finish);
  const collection = trimmed(input.hints.collection);
  if (brand) metadata.brand = brand;
  if (shadeName) metadata.shadeName = shadeName;
  if (finish) metadata.finish = finish;
  if (collection) metadata.collection = collection;
  if (input.barcode) {
    metadata.gtin = input.barcode.gtin;
    metadata.barcodeFormat = input.barcode.format;
    metadata.barcodeDecoder = input.barcode.engine;
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// Adaptive questions
// ---------------------------------------------------------------------------

export type QuestionAction = "scan_barcode" | "upload_label_photo";

export type QuestionChoice =
  | { kind: "answer"; label: string; value: string }
  | { kind: "action"; label: string; action: QuestionAction };

export interface QuestionView {
  prompt: string;
  choices: QuestionChoice[];
  allowsFreeText: boolean;
  canSkip: boolean;
}

const ACTION_LABELS: Record<QuestionAction, string> = {
  scan_barcode: "Scan the barcode",
  upload_label_photo: "Add a label photo",
};

/**
 * Turn a capture question's raw options into buttons. `skip` becomes the skip control,
 * `scan_barcode` / `upload_label_photo` become camera actions, `brand + shade` is only a
 * free-text hint, and candidate options ("123: Brand — Shade") become answer buttons.
 */
export function buildQuestionView(question: CaptureQuestion): QuestionView {
  const choices: QuestionChoice[] = [];
  let canSkip = false;
  for (const option of question.options ?? []) {
    const normalized = option.trim();
    if (!normalized) continue;
    if (normalized === "skip") {
      canSkip = true;
    } else if (normalized === "scan_barcode" || normalized === "upload_label_photo") {
      choices.push({ kind: "action", label: ACTION_LABELS[normalized], action: normalized });
    } else if (normalized === "brand + shade") {
      continue;
    } else {
      choices.push({ kind: "answer", label: candidateOptionLabel(normalized), value: normalized });
    }
  }
  return {
    prompt: question.prompt,
    choices,
    allowsFreeText: question.type === "free_text",
    canSkip,
  };
}
