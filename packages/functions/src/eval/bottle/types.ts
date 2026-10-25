import type { BottleSurface, CaptureFrameType } from "swatchwatch-shared";

/**
 * Bottle recognition eval (`npm run eval:bottle`): replays each admin-labelled bottle eval sample
 * (`bottle_eval_sample` / `bottle_eval_frame`) through the live capture API (start → frame per
 * frame → read-only check) and scores the verdict against the label.
 */

/** One labelled bottle with its frames in shooting order. */
export interface EvalSample {
  sampleId: number;
  /** Catalog shade the bottle is; `null` = a bottle that is not in the catalog (typed brand + shade). */
  shadeId: number | null;
  brand: string;
  shadeName: string;
  /**
   * Finish family of the shade's primary finish: `finish_type.family`, else the built-in
   * `DUPE_FINISH_FAMILIES` by finish name, else `"unknown"` (always `"unknown"` for external samples).
   */
  finishFamily: string;
  frames: { frameId: number; surface: BottleSurface; frameType: CaptureFrameType; storageUrl: string }[];
}

/**
 * - `matched_correct`: catalog bottle, the resolver matched its shade.
 * - `matched_wrong`: the resolver matched a different shade, or matched a bottle that is not in the catalog
 *   (both are confident wrong answers, counted in `falseConfident`).
 * - `asked_has_correct` / `asked_no_correct`: catalog bottle, the resolver would ask a question; its
 *   candidates do / do not include the right shade.
 * - `unmatched`: catalog bottle, the resolver found nothing.
 * - `rejected_correct`: bottle not in the catalog, the resolver did not claim a match (asked or unmatched).
 * - `skipped_no_frames`: the sample has no frames; no API call was made.
 * - `error`: the API or a blob read failed for this sample.
 */
export type Outcome =
  | "matched_correct"
  | "matched_wrong"
  | "asked_has_correct"
  | "asked_no_correct"
  | "unmatched"
  | "rejected_correct"
  | "skipped_no_frames"
  | "error";

export interface SampleResult {
  sampleId: number;
  brand: string;
  shadeName: string;
  inCatalog: boolean;
  outcome: Outcome;
  /** The check's resolver verdict (`matched` / `needs_question` / `unmatched`), or `skipped` / `error`. */
  status: string;
  /** Shade the top answer resolves to (the match, else the first candidate); `null` when none. */
  topEntityId: number | null;
  /** Shades the ranked candidates resolve to, in rank order (SKUs without a shade left out). */
  candidateIds: number[];
  /** Frames sent. */
  frames: number;
  /** Wall-clock time of the whole session (start, frames, check). */
  ms: number;
  /** The sample's finish family (see `EvalSample.finishFamily`). */
  finishFamily: string;
  /** Model calls the resolver made (`metadata.resolver.modelCalls` of the session); `null` when not reported or unreadable. */
  modelCalls: number | null;
  /** Frames sent because the server asked for their surface (`nextFrame`); 0 when the replay was not adaptive. */
  promptsFollowed: number;
  /** The server returned a `nextFrame` on start, so the frames were sent as it asked. */
  adaptive: boolean;
  /** The check carried a `suggestedShade`, i.e. the app would show a create card. */
  createCard: boolean;
  error?: string;
}

export interface EvalSummary {
  samples: number;
  byOutcome: Record<Outcome, number>;
  /** `matched_correct` / scored catalog samples (0 when there are none). */
  matchRate: number;
  /** (`asked_has_correct` + `asked_no_correct`) / scored catalog samples (0 when there are none). */
  askRate: number;
  /** Count of `matched_wrong`. */
  falseConfident: number;
  /** Median session time of the scored samples (0 when there are none). */
  medianMs: number;
  byBrand: Record<string, Record<Outcome, number>>;
  /** Outcome counts per `SampleResult.finishFamily`. */
  byFinishFamily: Record<string, Record<Outcome, number>>;
  /** Model calls per bottle over scored samples that reported a number (zeros when none did). */
  modelCalls: { mean: number; median: number; samples: number };
  /** Median frames sent over the scored samples (0 when there are none). */
  medianFramesNeeded: number;
  /** Scored not-in-catalog samples whose check carried a create card / scored not-in-catalog samples (0 when there are none). */
  createCardRate: number;
}
