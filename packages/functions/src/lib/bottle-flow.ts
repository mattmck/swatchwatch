import {
  BOTTLE_SURFACE_FRAME_TYPE,
  parseBottleSurface,
  type BottleSurface,
  type CaptureFrameRequestReason,
  type CaptureFrameRequestSpec,
  type FrameQualityWarning,
} from "swatchwatch-shared";
import type { ResolverDecision } from "./capture-evidence";

/**
 * Server-driven prompts for the bottle capture flow (Bottle Flow slice A, spec 4.1): which photo
 * to ask for next, planned by a pure function from what the session already knows. Handlers only
 * read state, call the planner and store the counters in `metadata.bottle`.
 */

/** The canonical prompt copy; the client's `DEFAULT_SURFACE_PROMPTS` is kept equal by a test. */
export const SURFACE_PROMPTS: Record<BottleSurface, string> = {
  front: "Show the front of the bottle",
  bottom: "Now the bottom",
  glass: "Turn it so we see the color",
  box: "Have the box? Show the barcode",
};

export const FRONT_BOX_HINT = "No front label? Show the box barcode instead";
export const TIE_BREAK_HINTS = ["Tilt it toward the light", "Hold it against something white"] as const;
export const RETRY_HINTS: Record<FrameQualityWarning, string> = {
  "too-dark": "Looks dark — move into better light",
  "too-bright": "Too bright — move out of the glare",
  blurry: "Looks blurry — hold steady and tap to focus",
};

/** How often one (surface, reason) prompt may be shown in a session. */
export const BOTTLE_MAX_PROMPTS_PER_KEY = 2;

const FRAME_QUALITY_WARNINGS: readonly FrameQualityWarning[] = ["too-dark", "too-bright", "blurry"];

export interface BottleFlowState {
  /** Times each `${surface}:${reason}` prompt was shown. */
  prompts: Record<string, number>;
  skipped: BottleSurface[];
  /** The newest frame that was too poor to read and added no evidence. */
  lastRejected: { surface: BottleSurface; warning: FrameQualityWarning } | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseWarning(value: unknown): FrameQualityWarning | null {
  return typeof value === "string" && (FRAME_QUALITY_WARNINGS as readonly string[]).includes(value)
    ? (value as FrameQualityWarning)
    : null;
}

/** The flow state stored under `metadata.bottle`; anything malformed reads as empty. */
export function readBottleFlowState(metadata: Record<string, unknown> | null | undefined): BottleFlowState {
  const bottle = asRecord(metadata?.bottle);

  const prompts: Record<string, number> = {};
  for (const [key, count] of Object.entries(asRecord(bottle.prompts))) {
    if (typeof count === "number" && Number.isInteger(count) && count > 0) prompts[key] = count;
  }

  const skipped: BottleSurface[] = [];
  if (Array.isArray(bottle.skipped)) {
    for (const value of bottle.skipped) {
      const surface = parseBottleSurface(value);
      if (surface && !skipped.includes(surface)) skipped.push(surface);
    }
  }

  const rejected = asRecord(bottle.lastRejected);
  const rejectedSurface = parseBottleSurface(rejected.surface);
  const rejectedWarning = parseWarning(rejected.warning);
  const lastRejected = rejectedSurface && rejectedWarning ? { surface: rejectedSurface, warning: rejectedWarning } : null;

  return { prompts, skipped, lastRejected };
}

const REASONS: readonly CaptureFrameRequestReason[] = [
  "need_brand",
  "need_name",
  "need_color",
  "tie_break",
  "retry_quality",
];

/** The last ask stored by `bottleFlowMetadataPatch`, or null when none (or it is malformed). */
export function readLastNextFrame(metadata: Record<string, unknown> | null | undefined): CaptureFrameRequestSpec | null {
  const raw = asRecord(asRecord(metadata?.bottle).lastNextFrame);
  const surface = parseBottleSurface(raw.surface);
  const reason = REASONS.find((r) => r === raw.reason);
  if (!surface || !reason || typeof raw.prompt !== "string" || typeof raw.optional !== "boolean") return null;
  return {
    surface,
    frameType: BOTTLE_SURFACE_FRAME_TYPE[surface],
    prompt: raw.prompt,
    ...(typeof raw.hint === "string" ? { hint: raw.hint } : {}),
    reason,
    optional: raw.optional,
  };
}

export function promptKey(spec: Pick<CaptureFrameRequestSpec, "surface" | "reason">): string {
  return `${spec.surface}:${spec.reason}`;
}

export type PlanDecision = "barcode_matched" | "matched" | "candidates" | "candidates_tied" | "create_card" | "unmatched" | "none";

export interface PlanNextFrameInput {
  state: BottleFlowState;
  frameCount: number;
  maxFrames: number;
  /** Frames per photographed surface. */
  surfaces: Partial<Record<BottleSurface, number>>;
  brandKnown: boolean;
  nameRead: boolean;
  glassHex: boolean;
  /** A barcode GTIN is known (decoded or read), matched or not. */
  gtinRead?: boolean;
  decision: PlanDecision;
}

function spec(
  surface: BottleSurface,
  reason: CaptureFrameRequestReason,
  extra: { hint?: string; optional?: boolean } = {}
): CaptureFrameRequestSpec {
  return {
    surface,
    frameType: BOTTLE_SURFACE_FRAME_TYPE[surface],
    prompt: SURFACE_PROMPTS[surface],
    ...(extra.hint ? { hint: extra.hint } : {}),
    reason,
    optional: extra.optional ?? false,
  };
}

/** Whether a photo of `surface` could have produced the evidence that surface exists to gather. */
function surfaceProducedEvidence(surface: BottleSurface, input: PlanNextFrameInput): boolean {
  switch (surface) {
    case "front":
      return input.brandKnown;
    case "box":
      // The box is for its barcode: a GTIN read off it is evidence even when it matches nothing.
      return input.brandKnown || Boolean(input.gtinRead);
    case "bottom":
      return input.nameRead;
    case "glass":
      return input.glassHex;
  }
}

/**
 * The photos every bottle is walked through, in order, before the session is compared: the
 * front for the brand (only while it is unknown), the bottom for the name, the glass for the
 * color, and the box for its barcode (only while no GTIN is known).
 */
const SEQUENCE: ReadonlyArray<{ surface: BottleSurface; reason: CaptureFrameRequestReason; optional: boolean }> = [
  { surface: "front", reason: "need_brand", optional: false },
  { surface: "bottom", reason: "need_name", optional: false },
  { surface: "glass", reason: "need_color", optional: true },
  { surface: "box", reason: "need_name", optional: true },
];

/**
 * The next photo to ask for, or null when there is nothing (more) to ask. A candidate ask is
 * dropped when the frame cap is reached, its prompt was already shown
 * `BOTTLE_MAX_PROMPTS_PER_KEY` times, or its surface was skipped; the first remaining candidate
 * of the first row that has one wins. A name match does not end the walk: only a barcode match
 * identifies the bottle exactly, so every other session sees each photo of `SEQUENCE` taken or
 * skipped before it is compared.
 */
export function planNextFrame(input: PlanNextFrameInput): CaptureFrameRequestSpec | null {
  const { state } = input;
  if (input.frameCount >= input.maxFrames) return null;

  const usable = (candidate: CaptureFrameRequestSpec): boolean =>
    !state.skipped.includes(candidate.surface) && (state.prompts[promptKey(candidate)] ?? 0) < BOTTLE_MAX_PROMPTS_PER_KEY;
  const firstUsable = (...candidates: CaptureFrameRequestSpec[]) => candidates.find(usable) ?? null;

  // 1. A barcode match: the flow is over, whatever the last photo looked like.
  if (input.decision === "barcode_matched") return null;

  // 2. A poor photo that produced nothing: the same surface again.
  const rejected = state.lastRejected;
  if (rejected && !surfaceProducedEvidence(rejected.surface, input)) {
    const retry = firstUsable(spec(rejected.surface, "retry_quality", { hint: RETRY_HINTS[rejected.warning] }));
    if (retry) return retry;
  }

  // 3. No brand: the front, else the box barcode.
  if (!input.brandKnown) {
    const ask = firstUsable(
      spec("front", "need_brand", { hint: FRONT_BOX_HINT }),
      spec("box", "need_brand", { optional: true })
    );
    if (ask) return ask;
  }

  // 4. Brand known, no name read: the bottom sticker.
  if (input.brandKnown && !input.nameRead) {
    const ask = firstUsable(spec("bottom", "need_name"));
    if (ask) return ask;
  }

  // 5. The walk: the first surface of the sequence not yet photographed (nor skipped, nor at
  // its cap) that could still add something.
  const wanted: Record<BottleSurface, boolean> = {
    front: !input.brandKnown,
    bottom: true,
    glass: true,
    box: !input.gtinRead,
  };
  for (const { surface, reason, optional } of SEQUENCE) {
    if (!wanted[surface] || (input.surfaces[surface] ?? 0) > 0) continue;
    const ask = firstUsable(spec(surface, reason, { optional }));
    if (ask) return ask;
  }

  // 6. Candidates the color could not separate: look at the glass again, differently.
  if (input.decision === "candidates_tied") {
    const count = input.state.prompts[promptKey({ surface: "glass", reason: "tie_break" })] ?? 0;
    const ask = firstUsable(
      spec("glass", "tie_break", { hint: TIE_BREAK_HINTS[Math.min(count, TIE_BREAK_HINTS.length - 1)], optional: true })
    );
    if (ask) return ask;
  }

  // 7. Nothing left to ask.
  return null;
}

export function recordPrompt(state: BottleFlowState, asked: CaptureFrameRequestSpec): BottleFlowState {
  const key = promptKey(asked);
  return { ...state, prompts: { ...state.prompts, [key]: (state.prompts[key] ?? 0) + 1 } };
}

export function recordSkip(state: BottleFlowState, surface: BottleSurface): BottleFlowState {
  return state.skipped.includes(surface) ? state : { ...state, skipped: [...state.skipped, surface] };
}

export function recordRejected(state: BottleFlowState, rejected: BottleFlowState["lastRejected"]): BottleFlowState {
  return { ...state, lastRejected: rejected };
}

/**
 * The `metadata` patch to merge with jsonb `||` (a shallow merge replaces `bottle` whole), so
 * `existing` — the session's current `metadata.bottle` — is carried over to keep `brand`. The
 * keys the flow owns always come from `state`.
 */
export function bottleFlowMetadataPatch(
  state: BottleFlowState,
  nextFrame: CaptureFrameRequestSpec | null,
  existing: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    bottle: {
      ...existing,
      prompts: state.prompts,
      skipped: state.skipped,
      lastRejected: state.lastRejected,
      lastNextFrame: nextFrame,
    },
  };
}

/** What the planner needs to know about the resolver's verdict. */
export function decisionForPlan(decision: ResolverDecision): PlanDecision {
  if (decision.status === "matched") return decision.barcodeVia ? "barcode_matched" : "matched";
  if (decision.status === "needs_question") {
    const resolver = asRecord(decision.metadataPatch.resolver);
    if (resolver.step === "awaiting_frames") return "none";
    if (decision.question.key === "candidate_select" && decision.candidates.length > 0) {
      return decision.bottle?.tie ? "candidates_tied" : "candidates";
    }
    return "unmatched";
  }
  return decision.bottle?.suggestedShade ? "create_card" : "unmatched";
}
