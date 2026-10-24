import {
  BOTTLE_SURFACE_FRAME_TYPE,
  parseBottleSurface,
  type BottleSurface,
  type CaptureBrandConflict,
  type CaptureBrandHintEcho,
  type CaptureFrameRequestReason,
  type CaptureFrameRequestSpec,
  type CaptureFrameType,
} from "../types/capture";

/** Surfaces to photograph, in order, when the server has not asked for anything specific. */
export const BOTTLE_DEFAULT_SURFACE_ORDER: readonly BottleSurface[] = ["front", "bottom", "glass"];

/** Client copy used only before the server has spoken; the server's copy (Task 9) is canonical and a test keeps them equal. */
export const DEFAULT_SURFACE_PROMPTS: Record<BottleSurface, string> = {
  front: "Show the front of the bottle",
  bottom: "Now the bottom",
  glass: "Turn it so we see the color",
  box: "Have the box? Show the barcode",
};

/** The surface a frame's `quality` object names, or `null`. */
export function surfaceFromQuality(quality: Record<string, unknown> | null | undefined): BottleSurface | null {
  return parseBottleSurface(quality?.surface);
}

export interface BottleFlowClientState {
  sessionStarted: boolean;
  /** The server's latest ask; `null` = it asked for nothing more. Only meaningful once `sessionStarted`. */
  nextFrame: CaptureFrameRequestSpec | null;
  captured: BottleSurface[];
  skipped: BottleSurface[];
  brandEcho: CaptureBrandHintEcho | null;
  brandConflict: CaptureBrandConflict | null;
}

export const INITIAL_BOTTLE_FLOW_STATE: BottleFlowClientState = {
  sessionStarted: false,
  nextFrame: null,
  captured: [],
  skipped: [],
  brandEcho: null,
  brandConflict: null,
};

export type BottleFlowAction =
  | { type: "session_started"; brandHint?: CaptureBrandHintEcho | null; nextFrame?: CaptureFrameRequestSpec | null }
  | { type: "frame_uploaded"; surface: BottleSurface | null; nextFrame?: CaptureFrameRequestSpec | null }
  | { type: "surface_skipped"; surface: BottleSurface; nextFrame?: CaptureFrameRequestSpec | null }
  | { type: "check_received"; nextFrame?: CaptureFrameRequestSpec | null; brandConflict?: CaptureBrandConflict | null }
  | { type: "reset" };

function withSurface(list: BottleSurface[], surface: BottleSurface | null): BottleSurface[] {
  return surface === null || list.includes(surface) ? list : [...list, surface];
}

/** An `undefined` nextFrame in an action means "the server sent none" and becomes `null`. */
export function bottleFlowReducer(state: BottleFlowClientState, action: BottleFlowAction): BottleFlowClientState {
  switch (action.type) {
    case "session_started":
      return {
        ...state,
        sessionStarted: true,
        brandEcho: action.brandHint ?? null,
        nextFrame: action.nextFrame ?? null,
      };
    case "frame_uploaded":
      return {
        ...state,
        captured: withSurface(state.captured, action.surface),
        nextFrame: action.nextFrame ?? null,
      };
    case "surface_skipped":
      return {
        ...state,
        skipped: withSurface(state.skipped, action.surface),
        nextFrame: action.nextFrame ?? null,
      };
    case "check_received":
      return {
        ...state,
        nextFrame: action.nextFrame ?? null,
        brandConflict: action.brandConflict ?? null,
      };
    case "reset":
      return INITIAL_BOTTLE_FLOW_STATE;
  }
}

export interface BottleCameraView {
  surface: BottleSurface;
  frameType: CaptureFrameType;
  prompt: string;
  hint: string | null;
  reason: CaptureFrameRequestReason | null;
  optional: boolean;
  step: number;
  total: number;
}

/**
 * What the camera screen shows: the server's nextFrame when there is one; before the session
 * starts, the first surface of the local order not yet captured or skipped (["bottom","glass"]
 * when `brandKnown`, else the default order). `null` = nothing left to ask, so call check.
 */
export function deriveBottleCameraView(
  state: BottleFlowClientState,
  opts: { brandKnown: boolean },
): BottleCameraView | null {
  const order: BottleSurface[] = opts.brandKnown
    ? BOTTLE_DEFAULT_SURFACE_ORDER.filter((surface) => surface !== "front")
    : [...BOTTLE_DEFAULT_SURFACE_ORDER];

  if (state.sessionStarted) {
    const spec = state.nextFrame;
    if (!spec) return null;
    // A surface outside the local order (the box) counts as one extra step.
    const steps = order.includes(spec.surface) ? order : [...order, spec.surface];
    return {
      surface: spec.surface,
      frameType: spec.frameType,
      prompt: spec.prompt,
      hint: spec.hint ?? null,
      reason: spec.reason,
      optional: spec.optional,
      step: steps.indexOf(spec.surface) + 1,
      total: steps.length,
    };
  }

  const surface = order.find((s) => !state.captured.includes(s) && !state.skipped.includes(s));
  if (!surface) return null;
  return {
    surface,
    frameType: BOTTLE_SURFACE_FRAME_TYPE[surface],
    prompt: DEFAULT_SURFACE_PROMPTS[surface],
    hint: null,
    reason: null,
    optional: false,
    step: order.indexOf(surface) + 1,
    total: order.length,
  };
}

/** True right after a frame upload when the server asked for nothing more and at least one frame is uploaded. */
export function shouldAutoCheck(state: BottleFlowClientState, uploadedFrames: number): boolean {
  return state.sessionStarted && state.nextFrame === null && uploadedFrames >= 1;
}
