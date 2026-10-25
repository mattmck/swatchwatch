/**
 * Pure state for the Rapid Add page: the capture-frame upload queue, the capture-session
 * state machine, and how adaptive questions render. No DOM or network here; the page
 * wires these reducers to the camera, the barcode scanner and the capture API.
 */
import {
  hintsToStartMetadata,
  type BottleSurface,
  type CaptureFrameType,
  type CaptureQuestion,
  type CaptureStatus,
  type StickyHints,
} from "swatchwatch-shared";
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
  /** Which side of the bottle this frame shows (bottle flow). */
  surface?: BottleSurface | null;
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
  if (input.surface) quality.surface = input.surface;
  return quality;
}

// ---------------------------------------------------------------------------
// Capture session
// ---------------------------------------------------------------------------

export type RapidAddBusy =
  | "starting"
  | "checking"
  | "finalizing"
  | "answering"
  | "resolving"
  | "undoing"
  | "wishlisting"
  | "skipping"
  | "creating";

export interface RapidAddSessionState {
  captureId: string | null;
  status: CaptureStatus | null;
  question: CaptureQuestion | null;
  barcode: ScannedBarcode | null;
  outcome: CaptureOutcome | null;
  verdict: CaptureVerdict | null;
  /** Set once the "I didn't buy another" quantity undo has been applied. */
  quantityRestored: boolean;
  /** The barcode was unknown and the user chose to photograph the label (same session). */
  labelRequested: boolean;
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
  labelRequested: false,
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
  | { type: "label_requested" }
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
    case "label_requested":
      // Unknown barcode → label photo: same session, so the GTIN is learned on the match.
      return { ...state, verdict: null, labelRequested: true, busy: null, error: null };
    case "failed":
      return { ...state, busy: null, error: action.error };
    case "error_dismissed":
      return { ...state, error: null };
    case "reset":
      return INITIAL_SESSION_STATE;
  }
}

export type RapidAddPhase = "collecting" | "question" | "resolving" | "verdict";

export function rapidAddPhase(
  state: Pick<RapidAddSessionState, "verdict" | "status" | "question">,
): RapidAddPhase {
  if (state.verdict) return "verdict";
  if (isFinished(state.status)) return "resolving";
  if (state.status === "needs_question" && state.question) return "question";
  return "collecting";
}

/**
 * A freshly decoded barcode is checked right away (its frame's upload response carries the
 * verdict, no OCR; without a frame, one `check` call). Not once a verdict is showing or the
 * user is photographing the label for an unknown barcode, and never in the guided bottle
 * sequence: there the barcode is one more piece of evidence and the server's `nextFrame` decides
 * whether to ask for another photo or to check (a catalog match ends the sequence by itself).
 */
export function shouldCheckBarcodeFrame(
  session: Pick<RapidAddSessionState, "labelRequested" | "verdict">,
  barcode: ScannedBarcode | null,
  opts: { bottleSequence: boolean },
): barcode is ScannedBarcode {
  return Boolean(barcode) && !opts.bottleSequence && !session.labelRequested && !session.verdict;
}

/**
 * The frame type and bottle surface a captured photo is sent as. In the bottle sequence a photo
 * the user took (shutter, auto-shutter or an upload) is the prompted surface's frame even when a
 * barcode is in view (a bottle's bottom often has its sticker), so the label is still read; the
 * barcode rides along in its quality. A live read off the preview stays a barcode frame.
 */
export function stillFrameTarget(
  event: { frameType: CaptureFrameType; barcode: ScannedBarcode | null; trigger: "live-scan" | "shutter" | "auto" | "file" },
  view: { surface: BottleSurface; frameType: CaptureFrameType } | null,
): { frameType: CaptureFrameType; surface: BottleSurface | null } {
  if (view && event.trigger !== "live-scan") return { frameType: view.frameType, surface: view.surface };
  return { frameType: event.frameType, surface: event.barcode ? null : (view?.surface ?? null) };
}

/**
 * A live barcode read with no snapshot can only be checked from the session metadata, and only a
 * session that read starts carries the GTIN there (`buildStartMetadata`). For an existing session
 * (e.g. a label photo came first) the check would report a false "unknown barcode", so skip it.
 * In the bottle sequence the read is only kept: the first photo's session start sends it along.
 */
export function canCheckBarcodeFromMetadata(
  session: Pick<RapidAddSessionState, "captureId" | "labelRequested" | "verdict">,
  barcode: ScannedBarcode | null,
  opts: { bottleSequence: boolean } = { bottleSequence: false },
): barcode is ScannedBarcode {
  return shouldCheckBarcodeFrame(session, barcode, opts) && session.captureId === null;
}

/**
 * What a barcode read off the live preview should do, given the scan in progress:
 * - `scan`: nothing scanned yet, so this barcode starts (or joins) the scan;
 * - `repeat`: the barcode this scan already read, so just say so (no new frame);
 * - `next_scan`: a different barcode while a verdict is showing, so start the next bottle;
 * - `wait`: a request is in flight, so ignore it for now;
 * - `finish_first`: a different barcode mid-scan (this one already has a barcode), or while a
 *   pick list or create card waits for the user, so it is only offered, never switched to.
 */
export type LiveBarcodeAction = "scan" | "repeat" | "next_scan" | "wait" | "finish_first";

export function planLiveBarcode(
  session: Pick<RapidAddSessionState, "barcode" | "verdict" | "status" | "question" | "busy">,
  gtin: string,
): LiveBarcodeAction {
  const phase = rapidAddPhase(session);
  if (session.barcode?.gtin === gtin) return session.busy ? "wait" : "repeat";
  if (session.busy || phase === "resolving") return "wait";
  if (phase === "verdict") {
    const kind = session.verdict?.kind;
    return kind === "pick" || kind === "create_card" ? "finish_first" : "next_scan";
  }
  if (session.barcode) return "finish_first";
  return "scan";
}

/**
 * The "scanned ✓" pill: the barcode was read on the device, and whether the server is still
 * checking it. Null until a barcode is read.
 */
export function scanBadge(state: RapidAddSessionState): { gtin: string; checking: boolean } | null {
  if (!state.barcode) return null;
  return { gtin: state.barcode.gtin, checking: state.busy === "checking" || state.busy === "starting" };
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

/**
 * A check (read-only) can run as soon as there is something to match on, in the collecting
 * phase: the same rule as `canFinalize`, so the bottle flow never checks half-uploaded frames.
 */
export function canCheck(input: {
  frames: readonly CaptureFrameEntry[];
  session: RapidAddSessionState;
  hasHints: boolean;
}): boolean {
  return canFinalize(input);
}

/**
 * Metadata for `POST /api/capture/start`: a scanned GTIN is the strongest evidence. Sticky
 * (batch) hints fill the brand, finish and collection a bottle's own hint leaves empty.
 */
export function buildStartMetadata(input: {
  barcode: ScannedBarcode | null;
  hints: { brand?: string; shadeName?: string; finish?: string; collection?: string };
  sticky?: StickyHints | null;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = { source: "web-rapid-add" };
  const trimmed = (value?: string) => (value && value.trim() ? value.trim() : undefined);
  const sticky = input.sticky ? hintsToStartMetadata(input.sticky) : {};
  const brand = trimmed(input.hints.brand) ?? sticky.brand;
  const shadeName = trimmed(input.hints.shadeName);
  const finish = trimmed(input.hints.finish) ?? sticky.finish;
  const collection = trimmed(input.hints.collection) ?? sticky.collection;
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
