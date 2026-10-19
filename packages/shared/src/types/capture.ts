export type CaptureStatus =
  | "processing"
  | "matched"
  | "needs_question"
  | "unmatched"
  | "cancelled";

export type CaptureFrameType = "barcode" | "label" | "color" | "other";

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
}

export interface CaptureFrameRequest {
  imageId?: number;
  imageBlobUrl?: string;
  frameType: CaptureFrameType;
  quality?: Record<string, unknown>;
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
}

export interface CaptureAnswerRequest {
  questionId?: string;
  answer: unknown;
}

export interface CaptureAnswerResponse {
  captureId: string;
  status: CaptureStatus;
  question?: CaptureQuestion;
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
}
