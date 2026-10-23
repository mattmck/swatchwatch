import {
  BOTTLE_EVAL_MAX_FRAMES,
  BOTTLE_SURFACE_FRAME_TYPE,
  type BottleSurface,
  type CaptureFrameType,
} from "swatchwatch-shared";

/**
 * Pure state for the admin Bottle eval tab: label a bottle, then photograph its surfaces
 * (front, bottom, glass, optional box) as one eval sample.
 */

export type BottleEvalLabel =
  | { kind: "catalog"; shadeId: string; brand: string; shadeName: string }
  | { kind: "external"; brandText: string; shadeText: string };

/** Shooting order and prompts shown in the tab; box is optional. */
export const BOTTLE_EVAL_SHOTS: readonly { surface: BottleSurface; prompt: string; optional: boolean }[] = [
  { surface: "front", prompt: "Show the front of the bottle", optional: false },
  { surface: "bottom", prompt: "Now the bottom", optional: false },
  { surface: "glass", prompt: "Turn it so we see the color", optional: false },
  { surface: "box", prompt: "Have the box? Show the barcode", optional: true },
];

export interface ShotEntry {
  localId: string;
  surface: BottleSurface;
  dataUrl: string;
  status: "uploading" | "uploaded" | "failed";
  frameId?: string;
  error?: string;
}

export interface BottleEvalSessionState {
  phase: "label" | "shooting" | "saved";
  label: BottleEvalLabel | null;
  sampleId: string | null;
  shots: ShotEntry[];
  notes: string;
}

export const INITIAL_BOTTLE_EVAL_STATE: BottleEvalSessionState = {
  phase: "label",
  label: null,
  sampleId: null,
  shots: [],
  notes: "",
};

export type BottleEvalAction =
  | { type: "label_chosen"; label: BottleEvalLabel }
  | { type: "sample_created"; sampleId: string }
  | { type: "shot_added"; shot: Pick<ShotEntry, "localId" | "surface" | "dataUrl"> }
  | { type: "shot_uploaded"; localId: string; frameId: string }
  | { type: "shot_failed"; localId: string; error: string }
  | { type: "shot_removed"; localId: string }
  | { type: "notes_changed"; notes: string }
  | { type: "finished" }
  | { type: "reset" };

function updateShot(
  state: BottleEvalSessionState,
  localId: string,
  patch: (shot: ShotEntry) => ShotEntry
): BottleEvalSessionState {
  return { ...state, shots: state.shots.map((shot) => (shot.localId === localId ? patch(shot) : shot)) };
}

export function bottleEvalReducer(state: BottleEvalSessionState, action: BottleEvalAction): BottleEvalSessionState {
  switch (action.type) {
    case "label_chosen":
      return { ...state, label: action.label };
    case "sample_created":
      return { ...state, sampleId: action.sampleId, phase: "shooting" };
    case "shot_added":
      // The server holds at most BOTTLE_EVAL_MAX_FRAMES frames per sample.
      if (state.shots.length >= BOTTLE_EVAL_MAX_FRAMES) return state;
      return { ...state, shots: [...state.shots, { ...action.shot, status: "uploading" }] };
    case "shot_uploaded":
      return updateShot(state, action.localId, (shot) => ({
        ...shot,
        status: "uploaded",
        frameId: action.frameId,
        error: undefined,
      }));
    case "shot_failed":
      return updateShot(state, action.localId, (shot) => ({ ...shot, status: "failed", error: action.error }));
    case "shot_removed":
      // Only a failed shot is local-only; uploaded frames live on the server.
      return {
        ...state,
        shots: state.shots.filter((shot) => shot.localId !== action.localId || shot.status !== "failed"),
      };
    case "notes_changed":
      return { ...state, notes: action.notes };
    case "finished":
      return { ...state, phase: "saved" };
    case "reset":
      return INITIAL_BOTTLE_EVAL_STATE;
  }
}

/** First shot in BOTTLE_EVAL_SHOTS with no uploaded/uploading entry; null when every non-optional one is done and box is done or skipped. */
export function nextShot(
  state: BottleEvalSessionState,
  skipped: ReadonlySet<BottleSurface>
): (typeof BOTTLE_EVAL_SHOTS)[number] | null {
  const done = new Set(
    state.shots.filter((shot) => shot.status === "uploading" || shot.status === "uploaded").map((shot) => shot.surface)
  );
  return BOTTLE_EVAL_SHOTS.find((shot) => !done.has(shot.surface) && !skipped.has(shot.surface)) ?? null;
}

/** Shooting with a sample, at least one uploaded frame and nothing still uploading. */
export function canFinish(state: BottleEvalSessionState): boolean {
  return (
    state.phase === "shooting" &&
    state.sampleId !== null &&
    state.shots.some((shot) => shot.status === "uploaded") &&
    !state.shots.some((shot) => shot.status === "uploading")
  );
}

export function frameTypeForSurface(surface: BottleSurface): CaptureFrameType {
  return BOTTLE_SURFACE_FRAME_TYPE[surface];
}
