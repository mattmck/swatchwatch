import type { CaptureFrameType } from "./capture";

/**
 * Bottle eval samples (admin console, `/api/bottle-eval-admin/*`): the owner labels a bottle
 * (a catalog shade, or brand + shade text when it is not in the catalog) and photographs its
 * surfaces as ground truth for bottle recognition.
 */

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

/** Most frames one sample may hold. */
export const BOTTLE_EVAL_MAX_FRAMES = 12;
/** Longest `brandText` / `shadeText`, after trimming. */
export const BOTTLE_EVAL_MAX_TEXT_LENGTH = 200;
/** Longest `notes`, after trimming. */
export const BOTTLE_EVAL_MAX_NOTES_LENGTH = 1000;

/** `POST /api/bottle-eval-admin/samples` body: `shadeId`, or both `brandText` and `shadeText`. */
export interface BottleEvalSampleRequest {
  /** Catalog shade. */
  shadeId?: string;
  /** Bottle not in the catalog (both required then). */
  brandText?: string;
  shadeText?: string;
  notes?: string;
}

/** `POST /api/bottle-eval-admin/samples/{id}/frames` body. */
export interface BottleEvalFrameRequest {
  surface: BottleSurface;
  /** `data:<type>;base64,…` */
  image: string;
}

export interface BottleEvalFrame {
  frameId: string;
  surface: BottleSurface;
  frameType: CaptureFrameType;
  /** Owner-scoped `v3` image URL; `null` for non-owners or when it cannot be signed. */
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  createdAt: string;
}

export interface BottleEvalSample {
  sampleId: string;
  shadeId: string | null;
  brand: string;
  shadeName: string;
  inCatalog: boolean;
  notes: string | null;
  frames: BottleEvalFrame[];
  createdByUserId: string;
  createdAt: string;
}

export interface BottleEvalSampleResponse {
  sample: BottleEvalSample;
}

/** `POST /api/bottle-eval-admin/samples/{id}/frames` response: the sample plus the new frame's id. */
export interface BottleEvalFrameAddResponse extends BottleEvalSampleResponse {
  frameId: string;
}

export interface BottleEvalSampleListResponse {
  samples: BottleEvalSample[];
  total: number;
  nextCursor: string | null;
}

/** A validated sample request. */
export type BottleEvalSampleInput =
  | { kind: "catalog"; shadeId: string; notes: string | null }
  | { kind: "external"; brandText: string; shadeText: string; notes: string | null };

/** Thrown by `validateBottleEvalSampleInput`; its message is safe to return as a 400. */
export class BottleEvalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BottleEvalValidationError";
  }
}

function optionalTrimmedString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new BottleEvalValidationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new BottleEvalValidationError(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed.length > 0 ? trimmed : null;
}

function parseShadeId(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) return String(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed) && /[1-9]/.test(trimmed)) return trimmed;
  }
  throw new BottleEvalValidationError("shadeId must be a positive integer id");
}

/**
 * Pure: trims, enforces lengths and the shadeId-xor-text rule (a catalog `shadeId`, or both
 * `brandText` and `shadeText`, never both kinds). Blank `notes` become `null`.
 * Throws `BottleEvalValidationError(message)`.
 */
export function validateBottleEvalSampleInput(body: unknown): BottleEvalSampleInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BottleEvalValidationError("Request body must be a JSON object");
  }
  const input = body as Record<string, unknown>;

  const notes = optionalTrimmedString(input.notes, "notes", BOTTLE_EVAL_MAX_NOTES_LENGTH);
  const brandText = optionalTrimmedString(input.brandText, "brandText", BOTTLE_EVAL_MAX_TEXT_LENGTH);
  const shadeText = optionalTrimmedString(input.shadeText, "shadeText", BOTTLE_EVAL_MAX_TEXT_LENGTH);
  const hasShadeId = input.shadeId !== undefined && input.shadeId !== null;

  if (hasShadeId) {
    if (brandText !== null || shadeText !== null) {
      throw new BottleEvalValidationError("Send either shadeId or brandText and shadeText, not both");
    }
    return { kind: "catalog", shadeId: parseShadeId(input.shadeId), notes };
  }

  if (brandText === null || shadeText === null) {
    throw new BottleEvalValidationError("Send shadeId, or both brandText and shadeText");
  }
  return { kind: "external", brandText, shadeText, notes };
}

/** The surface named by `value` (exact, lowercase), or `null`. */
export function parseBottleSurface(value: unknown): BottleSurface | null {
  return typeof value === "string" && (BOTTLE_SURFACES as readonly string[]).includes(value)
    ? (value as BottleSurface)
    : null;
}
