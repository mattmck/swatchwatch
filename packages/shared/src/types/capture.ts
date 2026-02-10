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
