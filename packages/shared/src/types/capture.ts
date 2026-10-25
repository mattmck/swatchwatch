export type CaptureStatus =
  | "processing"
  | "matched"
  | "needs_question"
  | "unmatched"
  | "cancelled";

export type CaptureFrameType = "barcode" | "label" | "color" | "other";

/** Photographed surfaces of one bottle. */
export const BOTTLE_SURFACES = ["front", "bottom", "glass", "box"] as const;
export type BottleSurface = (typeof BOTTLE_SURFACES)[number];

/** Frame type the capture API gets for each surface (front/bottom/box → label, glass → color). */
export const BOTTLE_SURFACE_FRAME_TYPE: Record<BottleSurface, CaptureFrameType> = {
  front: "label",
  bottom: "label",
  glass: "color",
  box: "label",
};

/** The surface named by `value` (exact, lowercase), or `null`. */
export function parseBottleSurface(value: unknown): BottleSurface | null {
  return typeof value === "string" && (BOTTLE_SURFACES as readonly string[]).includes(value)
    ? (value as BottleSurface)
    : null;
}

/** Why the capture flow asks for another photo. */
export type CaptureFrameRequestReason =
  | "need_brand"
  | "need_name"
  | "need_color"
  | "tie_break"
  | "retry_quality";

/** The next photo the server wants: which surface, how to ask for it, and whether it may be skipped. */
export interface CaptureFrameRequestSpec {
  surface: BottleSurface;
  frameType: CaptureFrameType;
  prompt: string;
  hint?: string;
  reason: CaptureFrameRequestReason;
  optional: boolean;
}

/** Where a brand on a capture session came from. */
export type CaptureBrandSource = "hint" | "barcode" | "read";

export interface CaptureBrandRef {
  /** Catalog brand id; null when the brand is not in the catalog. */
  brandId: string | null;
  name: string;
  source: CaptureBrandSource;
  confidence?: number;
}

/** Best-effort shade details for a bottle the catalog could not match, to prefill the add form. */
export interface CaptureSuggestedShade {
  brandId: string | null;
  brandName: string | null;
  brandSource: CaptureBrandSource | null;
  shadeName: string | null;
  hex: string | null;
  finish: string | null;
  gtin: string | null;
}

/** The brand the user typed disagrees with the brand read from the bottle. */
export interface CaptureBrandConflict {
  hinted: CaptureBrandRef;
  read: CaptureBrandRef;
}

/** The brand hint the user gave at session start, as the server understood it. */
export interface CaptureBrandHintEcho {
  raw: string;
  /** Catalog brand id when the hint matched a catalog brand. */
  brandId: string | null;
  /** Canonical brand name when matched, else the raw text. */
  name: string;
}

export type CaptureQuestionType = "single_select" | "multi_select" | "free_text" | "boolean";

export type CaptureQuestionStatus = "open" | "answered" | "skipped" | "expired";

export interface CaptureGuidanceConfig {
  recommendedFrameTypes: CaptureFrameType[];
  maxFrames: number;
}

export interface CaptureQuestion {
  id: string;
  key: string;
  prompt: string;
  type: CaptureQuestionType;
  options?: string[];
  status: CaptureQuestionStatus;
  createdAt: string;
}

export interface CaptureStartRequest {
  metadata?: Record<string, unknown>;
}

export interface CaptureStartResponse {
  captureId: string;
  status: CaptureStatus;
  uploadUrls: string[];
  guidanceConfig: CaptureGuidanceConfig;
  /** Present only while `BOTTLE_CAPTURE_ENABLED` is on, when the request carried a brand hint. */
  brandHint?: CaptureBrandHintEcho;
  /** First photo to take; present only while `BOTTLE_CAPTURE_ENABLED` is on. */
  nextFrame?: CaptureFrameRequestSpec | null;
}

export interface CaptureFrameRequest {
  imageId?: number;
  imageBlobUrl?: string;
  frameType: CaptureFrameType;
  quality?: Record<string, unknown>;
}

/** A field the bottle flow can read from a photo. */
export type CaptureReadField = "gtin" | "brand" | "shadeName" | "hex" | "finish";

/**
 * What the session has read from its photos so far (bottle flow, `BOTTLE_CAPTURE_ENABLED` on), so
 * the camera screen can show "barcode 4006…, brand Holo Taco, name Unicorn Skin" as photos arrive.
 */
export interface CaptureReadSummary {
  gtin: string | null;
  /** `catalogMatch` is true when the brand resolved to a catalog brand; `source` as on `suggestedShade`. */
  brand: { name: string; source: CaptureBrandSource; catalogMatch: boolean } | null;
  /** Shade name as printed (OCR or vision). */
  shadeName: string | null;
  /** Closest catalog shade name the vision read picked from the brand's list. */
  shadeNameListed: string | null;
  /** Lacquer color measured from the glass photo. */
  hex: string | null;
  finish: string | null;
  /** Fields the latest photo added (empty for a skip or a check). */
  newFields: CaptureReadField[];
}

export interface CaptureFrameResponse {
  received: boolean;
  captureId: string;
  frameId: string;
  status: CaptureStatus;
  /**
   * Present when the frame is a `barcode` frame whose `quality.gtin` is a valid on-device
   * decoded barcode: the same read-only verdict as `POST /api/capture/{captureId}/check`, so a
   * scan resolves in one round trip without OCR. Absent otherwise (and if the check failed).
   */
  check?: CaptureCheckResponse;
  /** Next photo to take (`null` = nothing more to ask); present only while `BOTTLE_CAPTURE_ENABLED` is on. */
  nextFrame?: CaptureFrameRequestSpec | null;
  /** Bottle flow only: what the session has read so far. */
  readSoFar?: CaptureReadSummary;
}

export interface CaptureFinalizeResponse {
  captureId: string;
  status: CaptureStatus;
  question?: CaptureQuestion;
}

export interface CaptureStatusResponse {
  captureId: string;
  status: CaptureStatus;
  topConfidence?: number;
  acceptedEntityType?: "shade" | "sku";
  acceptedEntityId?: string;
  metadata?: Record<string, unknown>;
  question?: CaptureQuestion;
  /** Next photo to take (`null` = nothing more to ask); present only while `BOTTLE_CAPTURE_ENABLED` is on. */
  nextFrame?: CaptureFrameRequestSpec | null;
}

export interface CaptureAnswerRequest {
  questionId?: string;
  /** Required unless `skipSurface` is sent. */
  answer?: unknown;
  /** Skip an optional photo instead of answering a question. */
  skipSurface?: BottleSurface;
}

export interface CaptureAnswerResponse {
  captureId: string;
  status: CaptureStatus;
  question?: CaptureQuestion;
  /** Next photo to take (`null` = nothing more to ask); present only while `BOTTLE_CAPTURE_ENABLED` is on. */
  nextFrame?: CaptureFrameRequestSpec | null;
  /** Bottle flow only: what the session has read so far. */
  readSoFar?: CaptureReadSummary;
}

/**
 * How the caller relates to a matched shade, from their own inventory rows' `status`.
 * - `owned`: at least one row has `status = 'owned'` (`quantity` is those rows' total)
 * - `wishlisted`: no owned row, but at least one `status = 'wishlist'` row
 * - `notOwned`: no row for the shade, or only `destash` / `archived` rows
 */
export type CaptureOwnershipRelationship = "owned" | "wishlisted" | "notOwned";

export interface CaptureOwnership {
  relationship: CaptureOwnershipRelationship;
  /** Total quantity of the `owned` rows; present only when `relationship === "owned"`. */
  quantity?: number;
}

/** Resolver outcome as finalize would compute it (check never persists it). */
export type CaptureCheckOutcome = "matched" | "needs_question" | "unmatched";

export interface CaptureCheckCandidate {
  entityType: "shade" | "sku";
  entityId: string;
  /** Shade the entity resolves to (a SKU's shade_id); null for a SKU without a shade. */
  shadeId: string | null;
  display: string;
  /** 0–1 resolver confidence. */
  confidence: number;
  ownership: CaptureOwnership;
  /** Display hex of the shade (vendor > detected > name) for a swatch; absent when unknown. */
  hex?: string;
  /** Catalog brand of the shade. */
  brandId?: string;
  /** OKLAB distance between the glass photo's hex and this candidate's display hex, when a glass hex exists. */
  colorDistance?: number;
}

/**
 * Response of `POST /api/capture/{captureId}/check`: the resolver's answer plus the
 * caller's relationship to each match, computed read-only. The session status is
 * returned unchanged; nothing about inventory or the session is written.
 */
export interface CaptureCheckResponse {
  captureId: string;
  /** The session's stored status, unchanged by the check. */
  status: CaptureStatus;
  outcome: CaptureCheckOutcome;
  /** Confidence of the top result (0 when nothing matched). */
  confidence: number;
  /** The matched entity when `outcome === "matched"`. */
  match?: CaptureCheckCandidate;
  /** Ranked candidates the resolver considered (includes the match when there is one). */
  candidates: CaptureCheckCandidate[];
  /** Question key finalize would open for `needs_question` (not persisted by check). */
  questionKey?: string;
  /** Next photo to take (`null` = nothing more to ask); present only while `BOTTLE_CAPTURE_ENABLED` is on. */
  nextFrame?: CaptureFrameRequestSpec | null;
  /** Prefill for an unmatched bottle; present only while `BOTTLE_CAPTURE_ENABLED` is on. */
  suggestedShade?: CaptureSuggestedShade;
  /** Set when the typed brand and the brand read from the bottle disagree. */
  brandConflict?: CaptureBrandConflict;
  /** Bottle flow only: what the session has read so far. */
  readSoFar?: CaptureReadSummary;
}
