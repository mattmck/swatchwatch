/**
 * Pure state for the native Rapid Add tab: barcode normalization, the frame upload queue
 * (same rules as the web's `lib/rapid-add-flow.ts`), and the verdict derived from the
 * read-only `POST /api/capture/{captureId}/check`. No React or network here.
 *
 * Unlike the web, which finalizes (adding the match to the collection) and offers an undo,
 * mobile asks `check` first: the shopper sees "you own it" / "on your wishlist" / "near-dupe"
 * / "new to you" without anything being written, and only an explicit tap adds it.
 */
import type {
  BottleSurface,
  CaptureBrandConflict,
  CaptureCheckCandidate,
  CaptureCheckResponse,
  CaptureFrameType,
  CreateCardModel,
  NormalizedBarcode,
  PolishDupesResponse,
  StickyHints,
} from "swatchwatch-shared";
import { deriveCreateCard, hintsToStartMetadata, normalizeScannedBarcode } from "swatchwatch-shared";

/** Matches the capture API's `guidanceConfig.maxFrames`. */
export const MAX_CAPTURE_FRAMES = 6;

/** expo-camera barcode types to scan (retail GTINs only). */
export const NATIVE_BARCODE_TYPES = ["ean13", "ean8", "upc_a", "upc_e"] as const;

export interface ScannedBarcode extends NormalizedBarcode {
  engine: "expo-camera";
}

/**
 * Normalize an expo-camera scan. iOS (AVFoundation) reports a UPC-A as a 13-digit EAN-13
 * with a leading 0; the capture API looks GTINs up exactly as printed, so it becomes the
 * 12-digit UPC-A the web scanner (and the label OCR) would read.
 */
export function normalizeNativeBarcode(raw: { data: string; type: string }): ScannedBarcode | null {
  let rawValue = raw.data.trim();
  let format = raw.type;
  if (/^ean[-_]?13$/i.test(format) && /^0\d{12}$/.test(rawValue)) {
    rawValue = rawValue.slice(1);
    format = "upc_a";
  }
  const normalized = normalizeScannedBarcode({ rawValue, format });
  return normalized ? { ...normalized, engine: "expo-camera" } : null;
}

// ---------------------------------------------------------------------------
// Frame upload queue
// ---------------------------------------------------------------------------

export type FrameUploadStatus = "uploading" | "uploaded" | "failed";

export interface CaptureFrameEntry {
  localId: string;
  frameType: CaptureFrameType;
  /** `data:image/jpeg;base64,…`, also used as the thumbnail. */
  dataUrl: string;
  quality: Record<string, unknown>;
  status: FrameUploadStatus;
  attempts: number;
  frameId?: string;
  error?: string;
}

export type FramesAction =
  | { type: "added"; frame: Pick<CaptureFrameEntry, "localId" | "frameType" | "dataUrl" | "quality"> }
  | { type: "upload_started"; localId: string }
  | { type: "upload_succeeded"; localId: string; frameId: string }
  | { type: "upload_failed"; localId: string; error: string }
  | { type: "removed"; localId: string }
  | { type: "reset" };

/** Same semantics as the web reducer: failed frames stay with their error until retried or removed. */
export function framesReducer(state: readonly CaptureFrameEntry[], action: FramesAction): CaptureFrameEntry[] {
  switch (action.type) {
    case "added":
      if (state.length >= MAX_CAPTURE_FRAMES || state.some((f) => f.localId === action.frame.localId)) {
        return [...state];
      }
      return [...state, { ...action.frame, status: "uploading", attempts: 1 }];
    case "upload_started":
      return state.map((frame) =>
        frame.localId === action.localId && frame.status !== "uploading"
          ? { ...frame, status: "uploading", attempts: frame.attempts + 1, error: undefined }
          : frame,
      );
    case "upload_succeeded":
      return state.map((frame) =>
        frame.localId === action.localId ? { ...frame, status: "uploaded", frameId: action.frameId, error: undefined } : frame,
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

/**
 * Automatic retries for one upload: network failures (status 0), 408, 429 and 5xx are
 * retried after these delays; anything else (e.g. 400 "image too large") fails at once.
 */
export const UPLOAD_RETRY_DELAYS_MS = [1000, 3000] as const;

export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export interface FrameQualityInput {
  source: "mobile-camera" | "mobile-library";
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  barcode?: ScannedBarcode | null;
  /** Which side of the bottle this photo shows (bottle flow). */
  surface?: BottleSurface | null;
}

/** The `quality` object sent with a frame; a scanned barcode rides along as `gtin` (web parity). */
export function buildFrameQuality(input: FrameQualityInput): Record<string, unknown> {
  const quality: Record<string, unknown> = {
    source: input.source,
    width: input.width,
    height: input.height,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
  };
  if (input.barcode) {
    quality.gtin = input.barcode.gtin;
    quality.barcodeFormat = input.barcode.format;
    quality.barcodeDecoder = input.barcode.engine;
  }
  if (input.surface) quality.surface = input.surface;
  return quality;
}

export interface CaptureHints {
  brand?: string;
  shadeName?: string;
}

/**
 * Metadata for `POST /api/capture/start`: a scanned GTIN is the strongest evidence. The sticky
 * "going through this brand" hints fill in whatever the shopper did not type for this scan.
 */
export function buildStartMetadata(input: {
  barcode: ScannedBarcode | null;
  hints: CaptureHints;
  sticky?: StickyHints | null;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = { source: "mobile-rapid-add", ...(input.sticky ? hintsToStartMetadata(input.sticky) : {}) };
  const brand = input.hints.brand?.trim();
  const shadeName = input.hints.shadeName?.trim();
  if (brand) metadata.brand = brand;
  if (shadeName) metadata.shadeName = shadeName;
  if (input.barcode) {
    metadata.gtin = input.barcode.gtin;
    metadata.barcodeFormat = input.barcode.format;
    metadata.barcodeDecoder = input.barcode.engine;
  }
  return metadata;
}

/** Check needs evidence (a frame, a barcode or typed hints) and waits for in-flight uploads. */
export function canCheck(input: {
  frames: readonly CaptureFrameEntry[];
  hasBarcode: boolean;
  hasHints: boolean;
  busy: boolean;
}): boolean {
  if (input.busy) return false;
  const summary = summarizeFrames(input.frames);
  if (summary.uploading > 0) return false;
  return summary.uploaded > 0 || input.hasBarcode || input.hasHints;
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** You own it: nothing was added; `quantity` is the owned bottle count. */
export interface OwnedVerdict {
  kind: "owned";
  candidate: CaptureCheckCandidate;
  quantity: number;
}

/** It's on your wishlist: offer "I bought it". */
export interface WishlistedVerdict {
  kind: "wishlisted";
  candidate: CaptureCheckCandidate;
}

/** New to you, but you own something very close (#265). */
export interface NearDupeVerdict {
  kind: "near-dupe";
  candidate: CaptureCheckCandidate;
  dupes: PolishDupesResponse;
}

/** Matched and new to you: offer Add / Wishlist. */
export interface AddVerdict {
  kind: "add";
  candidate: CaptureCheckCandidate;
}

/** Several candidates and no confident match: let the shopper pick. */
export interface PickVerdict {
  kind: "pick";
  candidates: CaptureCheckCandidate[];
  /** The typed brand disagrees with the brand read off the bottle (bottle flow). */
  brandConflict?: CaptureBrandConflict | null;
}

/** Nothing in the catalog matched: add the bottle as new from the prefilled card. */
export interface CreateVerdict {
  kind: "create";
  card: CreateCardModel;
  brandConflict: CaptureBrandConflict | null;
}

/** No catalog match. */
export interface NotFoundVerdict {
  kind: "not-found";
  gtin?: string;
}

/** After the shopper added it. */
export interface AddedVerdict {
  kind: "added";
  candidate: CaptureCheckCandidate;
  status: "owned" | "wishlist";
  /** Bottles owned after the action (owned only). */
  quantity?: number;
}

export type RapidAddVerdict =
  | OwnedVerdict
  | WishlistedVerdict
  | NearDupeVerdict
  | AddVerdict
  | PickVerdict
  | NotFoundVerdict
  | CreateVerdict
  | AddedVerdict;

/** Verdict for one candidate, before the near-dupe upgrade. */
export function verdictForCandidate(candidate: CaptureCheckCandidate): OwnedVerdict | WishlistedVerdict | AddVerdict {
  switch (candidate.ownership.relationship) {
    case "owned":
      return { kind: "owned", candidate, quantity: candidate.ownership.quantity ?? 1 };
    case "wishlisted":
      return { kind: "wishlisted", candidate };
    case "notOwned":
      return { kind: "add", candidate };
  }
}

/** Base verdict for a check response. Candidates with no catalog id are not pickable. */
export function deriveVerdict(check: CaptureCheckResponse, gtin?: string): RapidAddVerdict {
  if (check.outcome === "matched" && check.match) {
    return verdictForCandidate(check.match);
  }
  if (check.outcome === "needs_question") {
    // Only candidates with a catalog shade can be added exactly: finalizing a SKU candidate
    // re-runs the resolver, which may not pick the one the shopper chose.
    const pickable = check.candidates.filter((c) => c.shadeId !== null).slice(0, 5);
    if (pickable.length > 0) return { kind: "pick", candidates: pickable };
  }
  return { kind: "not-found", gtin };
}

/**
 * Verdict for the bottle sequence: a match answers as usual; the pickable candidates of a
 * `candidate_select` question are offered (with any brand conflict); otherwise the suggested shade becomes the create card, and with
 * nothing to prefill it is not-found. `afterNoneOfThese` lets the card replace the candidates.
 */
export function deriveBottleVerdict(check: CaptureCheckResponse, opts: { afterNoneOfThese: boolean; gtin?: string }): RapidAddVerdict {
  if (check.outcome === "matched" && check.match) return verdictForCandidate(check.match);
  // Only the candidate question is a pick list: a brand + shade question can carry weak
  // global candidates that are not worth choosing from.
  if (check.outcome === "needs_question" && check.questionKey === "candidate_select" && !opts.afterNoneOfThese) {
    const pickable = check.candidates.filter((c) => c.shadeId !== null).slice(0, 5);
    if (pickable.length > 0) return { kind: "pick", candidates: pickable, brandConflict: check.brandConflict ?? null };
  }
  const card = deriveCreateCard(check, { afterNoneOfThese: opts.afterNoneOfThese });
  if (card) return { kind: "create", card, brandConflict: check.brandConflict ?? null };
  return { kind: "not-found", gtin: opts.gtin };
}

/**
 * Which brand a pick row came from when the typed brand and the brand read off the bottle
 * disagree: `typed` / `bottle` with that brand's name, or `null` for any other candidate.
 */
export function candidateBrandBadge(
  candidate: Pick<CaptureCheckCandidate, "brandId">,
  conflict: CaptureBrandConflict | null | undefined,
): { source: "typed" | "bottle"; name: string } | null {
  if (!conflict || !candidate.brandId) return null;
  if (candidate.brandId === conflict.read.brandId) return { source: "bottle", name: conflict.read.name };
  if (candidate.brandId === conflict.hinted.brandId) return { source: "typed", name: conflict.hinted.name };
  return null;
}

/** The `added` verdict's candidate for a polish the create card just made. */
export function createdCandidate(
  created: { id: string; brand: string; name: string },
  status: "owned" | "wishlist",
  hex: string | null,
): CaptureCheckCandidate {
  const candidate: CaptureCheckCandidate = {
    entityType: "shade",
    entityId: created.id,
    shadeId: created.id,
    display: `${created.brand} — ${created.name}`,
    confidence: 1,
    ownership: status === "owned" ? { relationship: "owned", quantity: 1 } : { relationship: "wishlisted" },
  };
  if (hex) candidate.hex = hex;
  return candidate;
}

/** Upgrade an `add` verdict to `near-dupe` when the shopper owns a dupe. */
export function withDupes(verdict: RapidAddVerdict, dupes: PolishDupesResponse | null): RapidAddVerdict {
  if (verdict.kind !== "add" || !dupes || dupes.dupeCount === 0) return verdict;
  return { kind: "near-dupe", candidate: verdict.candidate, dupes };
}

/** Confidence as a short label (resolver confidence is 0–1). */
export function confidenceLabel(confidence: number): string {
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}% match`;
}
