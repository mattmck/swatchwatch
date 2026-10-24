import { createHash, randomUUID } from "node:crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { PoolClient } from "pg";
import {
  BOTTLE_SURFACE_FRAME_TYPE,
  CaptureAnswerRequest,
  CaptureAnswerResponse,
  CaptureBrandHintEcho,
  CaptureBrandRef,
  CaptureCheckCandidate,
  CaptureCheckResponse,
  CaptureFinalizeResponse,
  CaptureFrameRequest,
  CaptureFrameRequestSpec,
  CaptureFrameResponse,
  CaptureQuestion,
  CaptureStartRequest,
  CaptureStartResponse,
  CaptureFrameType,
  CaptureStatus,
  CaptureStatusResponse,
  BOTTLE_SURFACES,
  frameQualityWarningsFromQuality,
  parseBottleSurface,
  resolveDisplayHex,
  type BottleSurface,
} from "swatchwatch-shared";
import { query, transaction } from "../lib/db";
import { withAuth } from "../lib/auth";
import {
  checkStorageImageUrl,
  deleteBlobFromStorageUrl,
  stripImageMetadata,
  userMediaContainer,
  validateImageUpload,
} from "../lib/blob-storage";
import { isValidUuid } from "../lib/capture-session";
import { inlineCaptureFrameUrl, releaseCaptureFrames, storeCaptureFrameBytes } from "../lib/capture-frame-store";
import { isFeatureEnabled } from "../lib/feature-flags";
import { listBrandShadeNames, resolveBrandFromText, toBrandHintEcho, toBrandRef } from "../lib/brand-resolve";
import { decodeDataUri } from "../lib/detection-image";
import { measureGlassHex, type GlassHexAudit } from "../lib/glass-color";
import {
  STICKER_READ_PROMPT_VERSION,
  mergeLabelExtraction,
  readStickerWithVision,
  shouldVisionRead,
  type StickerReadResult,
} from "../lib/sticker-read";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { trackEvent, trackException } from "../lib/telemetry";
import { invalidatePolishCachesForUser } from "../lib/polish-cache";
import { extractTextFromImage, OcrResult } from "../lib/ocr";
import { parseLabelText, ParsedLabelFields } from "../lib/ocr-parser";
import { loadInventoryOwnership } from "../lib/inventory-relationship";
import { gtinLookupKeys, gtinSpellings, normalizeGtin, rememberUserShadeBarcode } from "../lib/barcodes";
import {
  BarcodeMatchVia,
  CaptureEvidence,
  CaptureFrameEvidenceRow,
  CaptureMatchCandidate,
  FrameExtractionSource,
  ResolverDecision,
  ResolverOutcome,
  collectCaptureEvidence,
  extractFrameEvidence,
  getStringField,
  toRecord,
} from "../lib/capture-evidence";
import {
  buildBrandShadeQuestion,
  buildCandidateQuestion,
  buildNeedsFrameQuestion,
  serializeQuestionOptions,
} from "../lib/capture-questions";
import {
  hintBrandFromMetadata,
  loadColorDistances,
  resolveBottle,
  sumFrameModelCalls,
  visionConfidenceFromFrames,
} from "../lib/bottle-resolver";
import {
  bottleFlowMetadataPatch,
  decisionForPlan,
  planNextFrame,
  readBottleFlowState,
  readLastNextFrame,
  recordPrompt,
  recordRejected,
  recordSkip,
  type BottleFlowState,
} from "../lib/bottle-flow";

const GUIDANCE_CONFIG = {
  recommendedFrameTypes: ["barcode", "label", "color"],
  maxFrames: 6,
} as const;

// Maximum chars stored in quality_json.ai.ocrRawText to keep jsonb rows bounded
const MAX_CAPTURE_AI_RAW_TEXT_CHARS = 2000;

interface CaptureSessionRow {
  id: number;
  captureId: string;
  status: CaptureStatus;
  topConfidence: string | number | null;
  acceptedEntityType: "shade" | "sku" | null;
  acceptedEntityId: string | null;
  metadata: Record<string, unknown> | null;
}

interface CaptureQuestionRow {
  id: string;
  key: string;
  prompt: string;
  type: CaptureQuestion["type"];
  options: unknown;
  status: CaptureQuestion["status"];
  createdAt: string;
}

const REMOTE_IMAGE_URL_ERROR =
  "imageBlobUrl must be a base64 data URL or an https URL on the configured storage account";

class CaptureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureInputError";
  }
}

interface PreparedImageInput {
  storageUrl: string;
  checksumSha256: string | null;
  qualityPatch: Record<string, unknown> | null;
  /**
   * Image input safe to forward to AI/OCR services. For base64 data URLs this is
   * the EXIF-stripped payload; for remote URLs it is the trimmed original URL.
   */
  sanitizedImageInput: string;
  /**
   * EXIF-stripped bytes of a data-URL frame, kept so the frame endpoint can store them as a
   * private blob while `BOTTLE_CAPTURE_ENABLED` is on. Null for remote URLs.
   */
  bytes: Buffer | null;
  contentType: string | null;
  extension: string | null;
}

function isValidBase64Payload(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function getImageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    case "image/gif":
      return "gif";
    default:
      return "img";
  }
}

function buildImageIngestionPatch(details: {
  source: "remote_url" | "data_url";
  mimeType?: string;
  byteSize?: number;
  checksumSha256?: string;
  host?: string;
  exifStripped?: boolean;
}): Record<string, unknown> {
  return {
    ingestion: {
      source: details.source,
      mimeType: details.mimeType,
      byteSize: details.byteSize,
      checksumSha256: details.checksumSha256,
      host: details.host,
      exifStripped: details.exifStripped,
    },
  };
}

interface FrameAiExtractionResult {
  extracted: Record<string, unknown>;
  ocrRawText?: string;
  ocrConfidence?: number;
  ocrBarcodeCount?: number;
  llmConfidence?: number;
  /** Color frames only: how the lacquer hex was measured (stored as `quality_json.ai.glass`). */
  glass?: GlassHexAudit;
  /** Bottle-capture label frames only: the sticker vision read audit (stored as `quality_json.ai.sticker`). */
  sticker?: StickerReadAudit;
}

/** What the sticker vision read did on one label frame (`quality_json.ai.sticker`). */
interface StickerReadAudit {
  promptVersion: string;
  closedSet: boolean;
  listedCount: number;
  /** The read's confidence; null when no read ran or it produced nothing. */
  confidence: number | null;
  /** Calls that were sent to the model (0 when the read was not needed, unconfigured or skipped). */
  modelCalls: 0 | 1;
  /** Barcode digits the read reported; evidence only when the check digit is valid (`mergeLabelExtraction`). */
  gtin?: string | null;
}

/** What a label frame's vision read needs to know; present only when the bottle-capture flag is on and the frame is a data URL. */
interface StickerReadContext {
  userId: number;
  surface: BottleSurface | null;
  /** The catalog brand the session is known to be about, or null when none is. */
  brand: { brandId: number; name: string } | null;
}

/**
 * The catalog brand a session is known to be about: the resolved hint (`metadata.bottle.brand`,
 * set at start), else the brand read from an earlier frame resolved against the catalog. Null
 * when neither resolves; a failed lookup is treated as unknown.
 */
async function resolveSessionBrand(
  metadata: Record<string, unknown> | null,
  evidence: CaptureEvidence
): Promise<StickerReadContext["brand"]> {
  const hinted = toRecord(toRecord(metadata?.bottle).brand);
  const hintedId = Number(hinted.brandId);
  if (typeof hinted.brandId === "string" && Number.isSafeInteger(hintedId) && hintedId > 0) {
    return { brandId: hintedId, name: getStringField(hinted, "name") ?? "" };
  }
  if (evidence.brandSource !== "read" || !evidence.brand) return null;
  try {
    const resolved = await resolveBrandFromText(evidence.brand);
    return resolved ? { brandId: resolved.brandId, name: resolved.name } : null;
  } catch (error) {
    console.warn(`[capture] Brand lookup for the sticker read failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Closed-set vision read of the sticker, when needed (known brand, or unusable OCR). A brand
 * with more shades than the prompt list holds is read open: a partial list would force wrong
 * picks. Never throws.
 */
async function runStickerRead(
  imageInput: string,
  ocrResult: OcrResult | null,
  sticker: StickerReadContext
): Promise<{ vision: StickerReadResult | null; audit: StickerReadAudit }> {
  const audit: StickerReadAudit = {
    promptVersion: STICKER_READ_PROMPT_VERSION,
    closedSet: false,
    listedCount: 0,
    confidence: null,
    modelCalls: 0,
  };
  if (!shouldVisionRead({ brandKnown: sticker.brand !== null, ocr: ocrResult })) {
    return { vision: null, audit };
  }

  let shadeNames: string[] = [];
  if (sticker.brand) {
    try {
      const listed = await listBrandShadeNames(sticker.brand.brandId, sticker.userId);
      if (!listed.truncated) shadeNames = listed.names;
    } catch (error) {
      console.warn(`[capture] Brand shade list for the sticker read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const vision = await readStickerWithVision(
    {
      imageDataUri: imageInput,
      surface: sticker.surface,
      brandName: sticker.brand?.name || null,
      shadeNames,
    },
    {
      onLog: (level, message) => console.warn(`[capture] sticker read (${level}): ${message}`),
      onModelCall: () => {
        audit.modelCalls = 1;
      },
    }
  );
  audit.closedSet = vision?.closedSet ?? shadeNames.length > 0;
  audit.listedCount = audit.closedSet ? shadeNames.length : 0;
  audit.confidence = vision?.confidence ?? null;
  if (vision?.gtin) audit.gtin = vision.gtin;
  return { vision, audit };
}

/** The audit stored when a color frame yields no hex. */
function glassMissAudit(reason: "no_candidates" | "remote_url"): GlassHexAudit {
  return { candidates: [], choice: null, modelCalls: 0, reason };
}

/**
 * Bottle capture: measure the lacquer hex from a color (glass) frame. Only a data-URL frame is
 * measured; `extracted` stays empty when nothing could be, so no hex evidence is claimed.
 */
async function runGlassExtraction(imageInput: string): Promise<FrameAiExtractionResult> {
  const bytes = decodeDataUri(imageInput);
  const glass = bytes ? await measureGlassHex(bytes) : null;
  if (!glass) {
    return { extracted: {}, glass: glassMissAudit(bytes ? "no_candidates" : "remote_url") };
  }
  return {
    extracted: {
      hex: glass.hex,
      hexConfidence: glass.confidence,
      hexMethod: glass.method,
      hexPromptVersion: glass.promptVersion,
      source: "glass",
    },
    glass: glass.audit,
  };
}

/**
 * Run AI extraction pipeline on a capture frame image:
 * 1. OCR via Azure Document Intelligence (extracts text + barcodes)
 * 2. LLM structured parsing of OCR text (extracts brand, shade, finish, etc.)
 * 3. Barcode GTIN extraction from OCR barcodes
 *
 * Returns extracted fields for quality_json.extracted, or null if no AI services are configured.
 */
async function runFrameAiExtraction(
  imageInput: string,
  frameType: string,
  hints?: { brand?: string; shadeName?: string; finish?: string },
  sticker?: StickerReadContext
): Promise<FrameAiExtractionResult | null> {
  if (frameType === "color") {
    return isFeatureEnabled("bottleCapture") ? runGlassExtraction(imageInput) : null;
  }
  if (frameType !== "label" && frameType !== "barcode") {
    return null;
  }

  let ocrResult: OcrResult | null = null;
  try {
    ocrResult = await extractTextFromImage(imageInput);
  } catch (error) {
    console.warn(
      `[capture] OCR extraction failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Without OCR a bottle-capture label frame can still be read by vision.
  if (!ocrResult && !sticker) {
    return null;
  }

  const extracted: Record<string, unknown> = {};

  // Extract GTIN from barcodes, preferring EAN/UPC types over other kinds.
  const getBarcodeKindPreference = (kind: string | null | undefined): number => {
    const normalizedKind = kind?.toUpperCase();

    if (normalizedKind === "EAN_13" || normalizedKind === "EAN13") {
      return 0;
    }

    if (
      normalizedKind === "UPC_A" ||
      normalizedKind === "UPCA" ||
      normalizedKind === "UPC_E" ||
      normalizedKind === "UPCE"
    ) {
      return 1;
    }

    if (normalizedKind === "EAN_8" || normalizedKind === "EAN8") {
      return 2;
    }

    return 3;
  };

  const gtin = (ocrResult?.barcodes ?? [])
    .filter((b) => b.confidence >= 0.5)
    .sort((a, b) => {
      const kindPreferenceDifference =
        getBarcodeKindPreference(a.kind) - getBarcodeKindPreference(b.kind);

      if (kindPreferenceDifference !== 0) {
        return kindPreferenceDifference;
      }

      return b.confidence - a.confidence;
    })
    .map((b) => b.value)
    .find((v) => v.length >= 8);

  if (gtin) {
    extracted.gtin = gtin;
  }

  // Run LLM parsing on label frames
  let llmResult: ParsedLabelFields | null = null;
  if (frameType === "label" && ocrResult && ocrResult.rawText.trim().length > 0) {
    try {
      llmResult = await parseLabelText(ocrResult.rawText, hints);
    } catch (error) {
      console.warn(
        `[capture] LLM label parsing failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  let labelFields: Record<string, unknown> = {};
  if (llmResult) {
    if (llmResult.brand) labelFields.brand = llmResult.brand;
    if (llmResult.shadeName) labelFields.shadeName = llmResult.shadeName;
    if (llmResult.finish) labelFields.finish = llmResult.finish;
    if (llmResult.collection) labelFields.collection = llmResult.collection;
    if (llmResult.gtin) labelFields.gtin = llmResult.gtin;
    if (llmResult.sizeMl) labelFields.sizeMl = llmResult.sizeMl;
  }

  // Bottle capture: read the sticker with vision when the brand is known or OCR is unusable,
  // and merge it with the OCR fields (the more confident read wins each field).
  let stickerAudit: StickerReadAudit | undefined;
  if (sticker && frameType === "label") {
    const { vision, audit } = await runStickerRead(imageInput, ocrResult, sticker);
    stickerAudit = audit;
    labelFields = mergeLabelExtraction(
      llmResult ? { fields: labelFields, confidence: llmResult.confidence } : null,
      vision
    ).extracted;
  }

  // A decoded barcode GTIN outranks any GTIN read from the label text.
  Object.assign(extracted, labelFields, extracted.gtin ? { gtin: extracted.gtin } : {});

  if (Object.keys(extracted).length === 0 && !stickerAudit) {
    return null;
  }

  return {
    extracted,
    ocrRawText: ocrResult?.rawText,
    ocrConfidence: ocrResult?.confidence,
    ocrBarcodeCount: ocrResult?.barcodes.length,
    llmConfidence: llmResult?.confidence,
    ...(stickerAudit ? { sticker: stickerAudit } : {}),
  };
}

async function normalizeCaptureImageInput(
  imageBlobUrl: string,
  captureId: string
): Promise<PreparedImageInput> {
  if (typeof imageBlobUrl !== "string") {
    throw new CaptureInputError(REMOTE_IMAGE_URL_ERROR);
  }
  const trimmed = imageBlobUrl.trim();

  if (trimmed.startsWith("blob:")) {
    throw new CaptureInputError(
      "blob: image URLs are browser-local only. Send a base64 data URL instead."
    );
  }

  if (trimmed.startsWith("data:")) {
    const commaIndex = trimmed.indexOf(",");
    if (commaIndex <= 5) {
      throw new CaptureInputError("Invalid image data URL format");
    }

    const meta = trimmed.slice(5, commaIndex);
    const payload = trimmed.slice(commaIndex + 1).replace(/\s/g, "");
    const metaParts = meta.split(";").filter(Boolean);
    const mimeType = (metaParts[0] || "").toLowerCase();
    const isBase64 = metaParts.includes("base64");

    if (!mimeType.startsWith("image/")) {
      throw new CaptureInputError("Data URL must include an image MIME type");
    }
    if (!isBase64) {
      throw new CaptureInputError("Data URL images must be base64 encoded");
    }
    if (!isValidBase64Payload(payload)) {
      throw new CaptureInputError("Data URL image payload must be valid base64");
    }

    const bytes = Buffer.from(payload, "base64");
    let normalizedMimeType: string;
    try {
      normalizedMimeType = validateImageUpload(mimeType, bytes.length);
    } catch (error) {
      throw new CaptureInputError(error instanceof Error ? error.message : "Invalid capture frame image");
    }

    // Strip EXIF (and any other) metadata before the bytes are checksummed,
    // referenced, or forwarded to third-party AI/OCR services. stripImageMetadata
    // degrades gracefully to the original bytes if the payload can't be decoded.
    const cleanBytes = await stripImageMetadata(bytes);
    try {
      validateImageUpload(normalizedMimeType, cleanBytes.length);
    } catch (error) {
      throw new CaptureInputError(error instanceof Error ? error.message : "Invalid capture frame image");
    }
    const exifStripped = cleanBytes !== bytes;

    const checksumSha256 = createHash("sha256").update(cleanBytes).digest("hex");
    const extension = getImageExtension(normalizedMimeType);
    const storageUrl = inlineCaptureFrameUrl(captureId, checksumSha256, extension);
    const sanitizedImageInput = `data:${normalizedMimeType};base64,${cleanBytes.toString("base64")}`;

    return {
      storageUrl,
      checksumSha256,
      sanitizedImageInput,
      bytes: cleanBytes,
      contentType: normalizedMimeType,
      extension,
      qualityPatch: buildImageIngestionPatch({
        source: "data_url",
        mimeType: normalizedMimeType,
        byteSize: cleanBytes.length,
        checksumSha256,
        exifStripped,
      }),
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new CaptureInputError(REMOTE_IMAGE_URL_ERROR);
  }

  // Remote URLs are forwarded to Azure Document Intelligence / OpenAI vision and persisted, so
  // only plain https blob URLs on our own storage account/container are accepted.
  if (checkStorageImageUrl(trimmed) !== null) {
    throw new CaptureInputError(REMOTE_IMAGE_URL_ERROR);
  }

  return {
    storageUrl: trimmed,
    checksumSha256: null,
    sanitizedImageInput: trimmed,
    bytes: null,
    contentType: null,
    extension: null,
    qualityPatch: buildImageIngestionPatch({
      source: "remote_url",
      host: parsedUrl.host,
    }),
  };
}

/**
 * A client-sent frame `quality` without the keys only the server writes: `ai` and
 * `extracted.shadeNameListed` / `brandConfidence` / `source` (`source: "glass"` marks
 * server-measured lacquer evidence, `"request_quality"` client evidence the server stored). The
 * client's evidence fields (`extracted.brand`, `shadeName`, `gtin`, `finish`, …) stay.
 */
function stripServerOwnedQuality(
  quality: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) return quality;
  const { ai: _ai, ...rest } = quality;
  if ("extracted" in rest) {
    const {
      shadeNameListed: _listed,
      brandConfidence: _brandConfidence,
      source: _source,
      ...extracted
    } = toRecord(rest.extracted);
    rest.extracted = extracted;
  }
  return rest;
}

function mergeQualityJson(
  baseQuality: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!baseQuality && !patch) {
    return null;
  }

  return {
    ...(baseQuality ?? {}),
    ...(patch ?? {}),
  };
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function buildIngestMetadataPatch(
  metadata: Record<string, unknown> | null,
  frameType: CaptureFrameRequest["frameType"],
  hasExtractedEvidence: boolean,
  extractionSource: FrameExtractionSource
): Record<string, unknown> {
  const pipeline = toRecord(toRecord(metadata).pipeline);
  const ingest = toRecord(pipeline.ingest);
  const frameTypeCounts = toRecord(ingest.frameTypeCounts);
  const nowIso = new Date().toISOString();

  const previousFrames = toNumber(ingest.framesReceived) ?? 0;
  const previousTypeCount = toNumber(frameTypeCounts[frameType]) ?? 0;

  return {
    pipeline: {
      ...pipeline,
      status: "ready_for_finalize",
      ingest: {
        ...ingest,
        status: "frames_received",
        firstFrameAt: typeof ingest.firstFrameAt === "string" ? ingest.firstFrameAt : nowIso,
        lastFrameAt: nowIso,
        lastFrameType: frameType,
        framesReceived: previousFrames + 1,
        frameTypeCounts: {
          ...frameTypeCounts,
          [frameType]: previousTypeCount + 1,
        },
        lastFrameHasExtractedEvidence: hasExtractedEvidence,
        lastExtractionSource: extractionSource,
      },
    },
  };
}

function buildFinalizePipelinePatch(
  metadata: Record<string, unknown> | null,
  outcomeStatus: ResolverOutcome["status"],
  runId: string,
  startedAt: string
): Record<string, unknown> {
  const pipeline = toRecord(toRecord(metadata).pipeline);
  const finalize = toRecord(pipeline.finalize);
  const previousAttempt = toNumber(finalize.attempt) ?? 0;

  return {
    pipeline: {
      ...pipeline,
      status: outcomeStatus,
      finalize: {
        attempt: previousAttempt + 1,
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        outcome: outcomeStatus,
      },
    },
  };
}

function withFinalizeAuditPatch(
  metadata: Record<string, unknown> | null,
  basePatch: Record<string, unknown>,
  outcomeStatus: ResolverOutcome["status"],
  runId: string,
  startedAt: string
): Record<string, unknown> {
  const resolver = toRecord(basePatch.resolver);
  const pipelinePatch = buildFinalizePipelinePatch(metadata, outcomeStatus, runId, startedAt);

  return {
    ...basePatch,
    resolver: {
      ...resolver,
      status: outcomeStatus,
      runId,
      finalizedAt: new Date().toISOString(),
    },
    pipeline: pipelinePatch.pipeline,
  };
}

function buildStartCaptureMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  const baseMetadata = toRecord(metadata);
  const pipeline = toRecord(baseMetadata.pipeline);
  const ingest = toRecord(pipeline.ingest);
  const nowIso = new Date().toISOString();

  return {
    ...baseMetadata,
    pipeline: {
      ...pipeline,
      status: typeof pipeline.status === "string" ? pipeline.status : "awaiting_frames",
      ingest: {
        ...ingest,
        status: typeof ingest.status === "string" ? ingest.status : "awaiting_frames",
        createdAt: typeof ingest.createdAt === "string" ? ingest.createdAt : nowIso,
        framesReceived: toNumber(ingest.framesReceived) ?? 0,
        frameTypeCounts: toRecord(ingest.frameTypeCounts),
      },
    },
  };
}

function parseNumeric(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toCaptureQuestion(row: CaptureQuestionRow | undefined): CaptureQuestion | undefined {
  if (!row) return undefined;

  return {
    id: row.id,
    key: row.key,
    prompt: row.prompt,
    type: row.type,
    options: Array.isArray(row.options) ? row.options.filter((v): v is string => typeof v === "string") : undefined,
    status: row.status,
    createdAt: row.createdAt,
  };
}

async function getCaptureFrameEvidence(sessionId: number): Promise<CaptureFrameEvidenceRow[]> {
  const result = await query<CaptureFrameEvidenceRow>(
    `SELECT
       frame_type   AS "frameType",
       quality_json AS quality
     FROM capture_frame
     WHERE capture_session_id = $1
     ORDER BY created_at DESC`,
    [sessionId]
  );

  return result.rows;
}

function extractSelectedEntityId(answer: unknown): number | null {
  if (typeof answer === "number" && Number.isInteger(answer) && answer > 0) {
    return answer;
  }

  if (typeof answer === "string") {
    const trimmed = answer.trim();
    const parsedPrefixed = parseInt(trimmed.split(":")[0], 10);
    if (Number.isInteger(parsedPrefixed) && parsedPrefixed > 0) {
      return parsedPrefixed;
    }
    const parsed = parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (typeof answer === "object" && answer !== null) {
    const shadeId = (answer as Record<string, unknown>).shadeId;
    if (typeof shadeId === "number" && Number.isInteger(shadeId) && shadeId > 0) {
      return shadeId;
    }
    if (typeof shadeId === "string") {
      const parsed = parseInt(shadeId, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return null;
}

function normalizeBrandShadeAnswer(answer: unknown): Record<string, unknown> {
  if (typeof answer === "object" && answer !== null) {
    const record = answer as Record<string, unknown>;
    return {
      brand: getStringField(record, "brand"),
      shadeName: getStringField(record, "shadeName", "name"),
      finish: getStringField(record, "finish"),
      raw: record.raw ?? answer,
    };
  }

  if (typeof answer === "string") {
    const raw = answer.trim();
    const split = raw
      .split(/\s+(?:-|—)\s+|\s*\|\s*|\s*,\s*/)
      .filter(Boolean);

    if (split.length >= 2) {
      return {
        brand: split[0],
        shadeName: split.slice(1).join(" "),
        raw,
      };
    }

    return {
      shadeName: raw || undefined,
      raw,
    };
  }

  return { raw: answer };
}

function normalizeAnswerForQuestion(questionKey: string, answer: unknown): unknown {
  if (questionKey === "brand_shade") {
    return normalizeBrandShadeAnswer(answer);
  }
  return answer;
}

/**
 * Barcode lookup for the capture resolver (#21, #325), first hit wins:
 * 1. catalog `barcode` rows (written by ingestion and the admin backfill) by canonical key, so a
 *    UPC-A scan finds the EAN-13 form a vendor published; the raw string is also tried for rows
 *    stored before normalization. Shades the caller cannot see are skipped.
 * 2. the caller's own learned barcodes (`user_shade_barcode`, scoped by user_id), following an
 *    admin merge to the surviving shade.
 * 3. fallback until the backfill has run everywhere: connector products whose raw GTIN equals
 *    any spelling of the code, through `shade_source_product`, active shades only. Only a GTIN
 *    that leads to exactly one shade matches; several shades fall through to label matching.
 * Every hit is exact, so confidence is 1 (as before).
 */
async function resolveByBarcode(
  gtin: string,
  format: string | undefined,
  userId: number
): Promise<{ candidate: CaptureMatchCandidate; via: BarcodeMatchVia } | null> {
  const keys = gtinLookupKeys(gtin, format);
  const scanned = normalizeGtin(gtin, format);
  if (scanned && !scanned.checkDigitValid) {
    // Looked up anyway: the bottle may still be known under its (mis)printed code.
    trackEvent("capture.barcode_bad_check_digit", { gtin: scanned.gtin, source: "resolver" });
  }
  const raw = gtin.trim();
  const catalogKeys = Array.from(new Set([...keys, raw])).filter(Boolean);

  const catalog = await query<{
    skuId: string;
    shadeId: string | null;
    brand: string | null;
    productName: string | null;
    shadeName: string | null;
  }>(
    `SELECT
       s.sku_id::text              AS "skuId",
       s.shade_id::text            AS "shadeId",
       b.name_canonical            AS brand,
       s.product_name              AS "productName",
       sh.shade_name_canonical     AS "shadeName"
     FROM barcode bc
     JOIN sku s ON bc.sku_id = s.sku_id
     LEFT JOIN brand b ON s.brand_id = b.brand_id
     LEFT JOIN shade sh ON s.shade_id = sh.shade_id
     WHERE bc.gtin = ANY($1::text[])
       AND (
         sh.shade_id IS NULL
         OR (sh.merged_into_shade_id IS NULL AND (sh.status <> 'user_submitted' OR sh.created_by_user_id = $2))
       )
     ORDER BY array_position($1::text[], bc.gtin)
     LIMIT 1`,
    [catalogKeys, userId]
  );
  const row = catalog.rows[0];
  if (row) {
    const display = [row.brand, row.productName || row.shadeName || `SKU ${row.skuId}`]
      .filter(Boolean)
      .join(" — ");
    return {
      via: "catalog",
      candidate: {
        entityType: "sku",
        entityId: parseInt(row.skuId, 10),
        shadeId: row.shadeId ? parseInt(row.shadeId, 10) : null,
        display,
        confidence: 1,
      },
    };
  }

  if (keys.length === 0) return null;

  const learned = await query<{ shadeId: string; brand: string; shadeName: string }>(
    `SELECT sh.shade_id::text AS "shadeId", b.name_canonical AS brand, sh.shade_name_canonical AS "shadeName"
     FROM user_shade_barcode ub
     JOIN shade src ON src.shade_id = ub.shade_id
     JOIN shade sh ON sh.shade_id = COALESCE(src.merged_into_shade_id, src.shade_id)
     JOIN brand b ON b.brand_id = sh.brand_id
     WHERE ub.gtin = ANY($1::text[])
       AND ub.user_id = $2
       AND (
         sh.status <> 'user_submitted'
         OR sh.created_by_user_id = $2
         OR EXISTS (SELECT 1 FROM user_inventory_item ui WHERE ui.shade_id = sh.shade_id AND ui.user_id = $2)
       )
     ORDER BY ub.updated_at DESC
     LIMIT 1`,
    [keys, userId]
  );
  const learnedRow = learned.rows[0];
  if (learnedRow) {
    const shadeId = parseInt(learnedRow.shadeId, 10);
    return {
      via: "user",
      candidate: {
        entityType: "shade",
        entityId: shadeId,
        shadeId,
        display: `${learnedRow.brand} — ${learnedRow.shadeName}`,
        confidence: 1,
      },
    };
  }

  const spellings = Array.from(new Set(keys.flatMap((key) => gtinSpellings(key))));
  const products = await query<{ shadeId: string; brand: string; shadeName: string }>(
    `SELECT DISTINCT sh.shade_id::text AS "shadeId", b.name_canonical AS brand, sh.shade_name_canonical AS "shadeName"
     FROM external_product ep
     JOIN shade_source_product ssp ON ssp.external_product_id = ep.external_product_id
     JOIN shade sh ON sh.shade_id = ssp.shade_id
     JOIN brand b ON b.brand_id = sh.brand_id
     WHERE ep.gtin IS NOT NULL
       AND regexp_replace(ep.gtin, '[[:space:]-]', '', 'g') = ANY($1::text[])
       AND sh.status = 'active'
       AND sh.merged_into_shade_id IS NULL
     LIMIT 2`,
    [spellings]
  );
  if (products.rows.length !== 1) return null;
  const product = products.rows[0];
  const shadeId = parseInt(product.shadeId, 10);
  return {
    via: "external_product",
    candidate: {
      entityType: "shade",
      entityId: shadeId,
      shadeId,
      display: `${product.brand} — ${product.shadeName}`,
      confidence: 1,
    },
  };
}

/**
 * Teach the caller's next scan (#21): when a session that scanned a valid GTIN ends up matched
 * by something other than that barcode (label photo, picked candidate, typed name), remember the
 * GTIN on the matched shade in `user_shade_barcode`, private to the caller. Never touches the
 * shared catalog. Runs inside the caller's transaction.
 */
async function rememberScannedBarcode(
  client: PoolClient,
  userId: number,
  sessionId: number,
  evidence: CaptureEvidence,
  entityType: "shade" | "sku",
  entityId: number,
  barcodeVia: BarcodeMatchVia | undefined
): Promise<void> {
  if (barcodeVia || !evidence.gtin) return;
  const normalized = normalizeGtin(evidence.gtin, evidence.gtinFormat);
  if (!normalized) return;
  let shadeId: number | null = entityType === "shade" ? entityId : null;
  if (entityType === "sku") {
    const sku = await client.query<{ shadeId: number | string | null }>(
      `SELECT shade_id AS "shadeId" FROM sku WHERE sku_id = $1`,
      [entityId]
    );
    const found = sku.rows[0]?.shadeId;
    shadeId = found === undefined || found === null ? null : Number(found);
  }
  if (shadeId === null || !Number.isSafeInteger(shadeId)) return;
  await rememberUserShadeBarcode(client, { userId, shadeId, gtin: normalized, captureSessionId: sessionId });
}

async function resolveShadeCandidates(evidence: CaptureEvidence): Promise<CaptureMatchCandidate[]> {
  if (!evidence.shadeName) {
    return [];
  }

  if (evidence.brand) {
    const result = await query<{
      shadeId: string;
      brand: string;
      shadeName: string;
      score: number;
    }>(
      `SELECT
         s.shade_id::text AS "shadeId",
         b.name_canonical AS brand,
         s.shade_name_canonical AS "shadeName",
         similarity(s.shade_name_canonical, $2) AS score
       FROM shade s
       JOIN brand b ON s.brand_id = b.brand_id
       WHERE s.status = 'active'
         AND b.name_canonical ILIKE $1
         AND (
           s.shade_name_canonical % $2
           OR similarity(s.shade_name_canonical, $2) >= 0.20
         )
       ORDER BY score DESC
       LIMIT 5`,
      [evidence.brand, evidence.shadeName]
    );

    return result.rows.map((row) => ({
      entityType: "shade",
      entityId: parseInt(row.shadeId, 10),
      shadeId: parseInt(row.shadeId, 10),
      display: `${row.brand} — ${row.shadeName}`,
      confidence: Math.max(0, Math.min(1, row.score)),
    }));
  }

  const result = await query<{
    shadeId: string;
    brand: string;
    shadeName: string;
    score: number;
  }>(
    `SELECT
       s.shade_id::text AS "shadeId",
       b.name_canonical AS brand,
       s.shade_name_canonical AS "shadeName",
       GREATEST(
         similarity(s.shade_name_canonical, $1),
         similarity(b.name_canonical, $1)
       ) AS score
     FROM shade s
     JOIN brand b ON s.brand_id = b.brand_id
     WHERE s.status = 'active'
       AND (
         s.shade_name_canonical % $1
         OR b.name_canonical % $1
         OR similarity(s.shade_name_canonical, $1) >= 0.20
       )
     ORDER BY score DESC
     LIMIT 5`,
    [evidence.shadeName]
  );

  return result.rows.map((row) => ({
    entityType: "shade",
    entityId: parseInt(row.shadeId, 10),
    shadeId: parseInt(row.shadeId, 10),
    display: `${row.brand} — ${row.shadeName}`,
    confidence: Math.max(0, Math.min(1, row.score)),
  }));
}

/** A resolver outcome plus what `capture.resolved` reports about the session it ran on. */
type SessionResolution = ResolverOutcome & { frameCount: number; brandLocked: boolean; modelCalls: number };

/** What the brand-first resolver needs from the session (present only while `BOTTLE_CAPTURE_ENABLED` is on). */
interface BottleResolverInput {
  hintBrand: CaptureBrandRef | null;
  frames: CaptureFrameEvidenceRow[];
  modelCalls: number;
}

async function resolveCaptureSession(session: CaptureSessionRow, userId: number): Promise<SessionResolution> {
  const frames = await getCaptureFrameEvidence(session.id);
  const evidence = collectCaptureEvidence(session.metadata, frames);
  const modelCalls = sumFrameModelCalls(frames);
  const hintBrand = isFeatureEnabled("bottleCapture") ? hintBrandFromMetadata(session.metadata) : null;
  const bottle: BottleResolverInput | null = isFeatureEnabled("bottleCapture") ? { hintBrand, frames, modelCalls } : null;
  const outcome = await resolveFromEvidence(evidence, frames.length, userId, bottle);
  return { ...outcome, evidence, frameCount: frames.length, brandLocked: hintBrand !== null, modelCalls };
}

/** `capture.resolved` method: how the session was (or was not) resolved. */
function resolvedMethod(outcome: ResolverDecision): string {
  if (outcome.barcodeVia) return "barcode";
  const resolver = toRecord(outcome.metadataPatch.resolver);
  if (typeof resolver.method === "string") return resolver.method;
  return resolver.step === "matched_by_shade_similarity" || resolver.step === "needs_user_candidate_selection"
    ? "name"
    : "unmatched";
}

function trackCaptureResolved(captureId: string, resolution: SessionResolution): void {
  const resolver = toRecord(resolution.metadataPatch.resolver);
  trackEvent("capture.resolved", {
    captureId,
    method: resolvedMethod(resolution),
    brandLocked: resolution.brandLocked,
    candidateCount: typeof resolver.candidateCount === "number" ? resolver.candidateCount : resolution.candidates.length,
    modelCalls: resolution.modelCalls,
    frames: resolution.frameCount,
  });
}

/** The next photo to ask for, from a resolution and the flow state stored with the session. */
function planFromResolution(state: BottleFlowState, resolution: SessionResolution): CaptureFrameRequestSpec | null {
  const { evidence } = resolution;
  return planNextFrame({
    state,
    frameCount: resolution.frameCount,
    maxFrames: GUIDANCE_CONFIG.maxFrames,
    surfaces: evidence.surfaces,
    // What the resolver counts as the session brand (a hint, a barcode brand, or a read that
    // resolved); without a resolver verdict (barcode match, no frames yet), any brand text.
    brandKnown: resolution.bottle ? resolution.bottle.brand !== null : Boolean(evidence.brand),
    nameRead: Boolean(evidence.shadeName || evidence.shadeNameListed),
    glassHex: Boolean(evidence.glassHex),
    gtinRead: Boolean(evidence.gtin),
    decision: decisionForPlan(resolution),
  });
}

/** True when `after` holds a name, brand, GTIN or glass color that `before` did not. */
function evidenceAdded(before: CaptureEvidence, after: CaptureEvidence): boolean {
  return (
    (!before.gtin && Boolean(after.gtin)) ||
    (!before.shadeName && Boolean(after.shadeName)) ||
    (!before.shadeNameListed && Boolean(after.shadeNameListed)) ||
    (!before.brand && Boolean(after.brand)) ||
    (!before.glassHex && Boolean(after.glassHex))
  );
}

/**
 * Bottle flow step after a frame or a skip: resolve (unless the caller already did), plan the
 * next photo, store the flow counters and the resolver verdict with one metadata update, and
 * report the surface. Throws on failure; the frame path degrades, the skip path surfaces it.
 */
async function advanceBottleFlow(
  session: CaptureSessionRow,
  userId: number,
  step:
    | { kind: "frame"; frameType: CaptureFrameType; quality: Record<string, unknown> | null; priorEvidence: CaptureEvidence }
    | { kind: "skip"; surface: BottleSurface },
  resolution?: SessionResolution | null
): Promise<CaptureFrameRequestSpec | null> {
  const resolved = resolution ?? (await resolveCaptureSession(session, userId));
  let state = readBottleFlowState(session.metadata);

  let surface: BottleSurface | null;
  let frameType: CaptureFrameType;
  let extracted = false;
  if (step.kind === "skip") {
    surface = step.surface;
    frameType = BOTTLE_SURFACE_FRAME_TYPE[surface];
    state = recordSkip(state, surface);
  } else {
    surface = parseBottleSurface(step.quality?.surface);
    frameType = step.frameType;
    extracted = evidenceAdded(step.priorEvidence, resolved.evidence);
    const warnings = frameQualityWarningsFromQuality(step.quality);
    // A poor photo that added nothing is retried; one that read something is not.
    state = recordRejected(state, surface && warnings.length > 0 && !extracted ? { surface, warning: warnings[0] } : null);
  }

  const nextFrame = planFromResolution(state, resolved);
  if (nextFrame) state = recordPrompt(state, nextFrame);

  await query(
    `UPDATE capture_session
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = now()
     WHERE capture_session_id = $1`,
    [
      session.id,
      {
        ...bottleFlowMetadataPatch(state, nextFrame, toRecord(session.metadata?.bottle)),
        resolver: resolved.metadataPatch.resolver,
      },
    ]
  );

  if (surface) {
    trackEvent("capture.surface_captured", {
      captureId: session.captureId,
      surface,
      frameType,
      skipped: step.kind === "skip",
      extracted,
    });
  }
  return nextFrame;
}

async function resolveFromEvidence(
  evidence: CaptureEvidence,
  frameCount: number,
  userId: number,
  bottle: BottleResolverInput | null = null
): Promise<ResolverDecision> {
  const hasTextEvidence = Boolean(evidence.gtin || evidence.shadeName || evidence.brand);
  const resolverAudit = {
    version: "deterministic-v1",
    frameCount,
    hasTextEvidence,
    evidence: {
      gtin: evidence.gtin ?? null,
      brand: evidence.brand ?? null,
      shadeName: evidence.shadeName ?? null,
      finish: evidence.finish ?? null,
    },
  };

  if (frameCount === 0 && !hasTextEvidence) {
    return {
      status: "needs_question",
      confidence: 0,
      question: buildNeedsFrameQuestion(),
      candidates: [],
      metadataPatch: { resolver: { step: "awaiting_frames", audit: resolverAudit } },
    };
  }

  if (evidence.gtin) {
    const barcodeHit = await resolveByBarcode(evidence.gtin, evidence.gtinFormat, userId);
    if (barcodeHit) {
      const barcodeMatch = barcodeHit.candidate;
      return {
        status: "matched",
        barcodeVia: barcodeHit.via,
        confidence: barcodeMatch.confidence,
        entityType: barcodeMatch.entityType,
        entityId: barcodeMatch.entityId,
        candidates: [barcodeMatch],
        metadataPatch: {
          resolver: {
            step: "matched_by_barcode",
            via: barcodeHit.via,
            gtin: evidence.gtin,
            display: barcodeMatch.display,
            audit: resolverAudit,
          },
        },
      };
    }
  }

  if (bottle) {
    return resolveBottle(
      evidence,
      {
        userId,
        frameCount,
        hintBrand: bottle.hintBrand,
        barcodeBrand: null, // a barcode hit has already matched above
        modelCalls: bottle.modelCalls,
        visionConfidence: visionConfidenceFromFrames(bottle.frames),
      },
      {
        query,
        resolveBrand: resolveBrandFromText,
        globalCandidates: (frameEvidence) => resolveShadeCandidates(frameEvidence),
        colorDistances: (shadeIds, glassHex) => loadColorDistances(shadeIds, glassHex, userId, { query }),
      }
    );
  }

  const shadeCandidates = await resolveShadeCandidates(evidence);
  const topCandidate = shadeCandidates[0];

  if (topCandidate && topCandidate.confidence >= 0.92) {
    return {
      status: "matched",
      confidence: topCandidate.confidence,
      entityType: topCandidate.entityType,
      entityId: topCandidate.entityId,
      candidates: shadeCandidates,
        metadataPatch: {
          resolver: {
            step: "matched_by_shade_similarity",
            topCandidate: topCandidate.display,
            candidateCount: shadeCandidates.length,
            audit: resolverAudit,
          },
        },
      };
  }

  if (topCandidate && topCandidate.confidence >= 0.75) {
    return {
      status: "needs_question",
      confidence: topCandidate.confidence,
      question: buildCandidateQuestion(shadeCandidates),
      candidates: shadeCandidates,
        metadataPatch: {
          resolver: {
            step: "needs_user_candidate_selection",
            candidateCount: shadeCandidates.length,
            topCandidate: topCandidate.display,
            audit: resolverAudit,
          },
        },
      };
  }

  if (!evidence.brand || !evidence.shadeName) {
    return {
      status: "needs_question",
      confidence: topCandidate?.confidence ?? 0,
      question: buildBrandShadeQuestion(),
      candidates: shadeCandidates,
        metadataPatch: {
          resolver: {
            step: "needs_brand_and_shade",
            brand: evidence.brand || null,
            shadeName: evidence.shadeName || null,
            audit: resolverAudit,
          },
        },
      };
  }

  return {
    status: "unmatched",
    confidence: topCandidate?.confidence ?? 0,
    candidates: shadeCandidates,
    metadataPatch: {
      resolver: {
        step: "unmatched_after_resolver",
        brand: evidence.brand,
        shadeName: evidence.shadeName,
        audit: resolverAudit,
      },
    },
  };
}

async function getCaptureSession(captureId: string, userId: number): Promise<CaptureSessionRow | null> {
  const result = await query<CaptureSessionRow>(
    `SELECT
       capture_session_id          AS id,
       capture_uuid::text          AS "captureId",
       status,
       top_confidence              AS "topConfidence",
       accepted_entity_type        AS "acceptedEntityType",
       accepted_entity_id::text    AS "acceptedEntityId",
       metadata
     FROM capture_session
     WHERE capture_uuid = $1::uuid
       AND user_id = $2`,
    [captureId, userId]
  );

  return result.rows[0] ?? null;
}

class CaptureShadeNotFoundError extends Error {
  constructor() {
    super("Shade not found");
    this.name = "CaptureShadeNotFoundError";
  }
}

async function addToInventoryFromMatch(
  client: PoolClient,
  userId: number,
  entityType: "shade" | "sku",
  entityId: number
): Promise<number> {
  if (entityType === "sku") {
    const skuResult = await client.query<{ shadeId: number | null }>(
      `SELECT shade_id AS "shadeId"
       FROM sku
       WHERE sku_id = $1`,
      [entityId]
    );
    const shadeId = skuResult.rows[0]?.shadeId ?? null;

    // A user has at most one row per shade, so the caller's row for the SKU's shade is the one
    // to bump, with or without a sku_id. A row already carrying this SKU wins over a shade row.
    const existing = await client.query<{ id: number }>(
      `SELECT inventory_item_id AS id
       FROM user_inventory_item
       WHERE user_id = $1 AND (sku_id = $2 OR shade_id = $3)
       ORDER BY (sku_id = $2) DESC NULLS LAST, created_at ASC
       LIMIT 1`,
      [userId, entityId, shadeId]
    );

    if (existing.rows.length > 0) {
      await client.query(
        `UPDATE user_inventory_item
         SET quantity = quantity + 1,
             sku_id = COALESCE(sku_id, $3),
             -- Capturing a bottle means the caller has it: a wishlist/archived row becomes owned.
             status = CASE WHEN status IN ('wishlist', 'archived') THEN 'owned' ELSE status END,
             updated_at = now()
         WHERE inventory_item_id = $1 AND user_id = $2`,
        [existing.rows[0].id, userId, entityId]
      );
      return existing.rows[0].id;
    }

    // ON CONFLICT covers a concurrent finalize that inserted the same shade first. The predicate
    // makes the partial idx_user_inventory_unique_shade an arbiter too; without it the race
    // fails on that index instead of bumping.
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO user_inventory_item (user_id, sku_id, shade_id, quantity, status, notes)
       VALUES ($1, $2, $3, 1, 'owned', $4)
       ON CONFLICT (user_id, shade_id) WHERE shade_id IS NOT NULL DO UPDATE
         SET quantity = user_inventory_item.quantity + 1,
             sku_id = COALESCE(user_inventory_item.sku_id, EXCLUDED.sku_id),
             status = CASE WHEN user_inventory_item.status IN ('wishlist', 'archived') THEN 'owned'
                           ELSE user_inventory_item.status END,
             updated_at = now()
       RETURNING inventory_item_id AS id`,
      [userId, entityId, shadeId, "Added via Rapid Add capture"]
    );

    return inserted.rows[0].id;
  }

  // The entity id can come from the client (candidate_select), so refuse shades the caller
  // cannot see: another user's private `user_submitted` shade (or one retired by an admin merge)
  // must not be claimable by id.
  const visible = await client.query(
    `SELECT 1
     FROM shade s
     WHERE s.shade_id = $2
       AND s.merged_into_shade_id IS NULL
       AND (
         s.status <> 'user_submitted'
         OR s.created_by_user_id = $1
         OR EXISTS (SELECT 1 FROM user_inventory_item ui WHERE ui.shade_id = s.shade_id AND ui.user_id = $1)
       )
     LIMIT 1`,
    [userId, entityId]
  );
  if (visible.rows.length === 0) {
    throw new CaptureShadeNotFoundError();
  }

  const existing = await client.query<{ id: number }>(
    `SELECT inventory_item_id AS id
     FROM user_inventory_item
     WHERE user_id = $1 AND shade_id = $2
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId, entityId]
  );

  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE user_inventory_item
       SET quantity = quantity + 1,
           status = CASE WHEN status IN ('wishlist', 'archived') THEN 'owned' ELSE status END,
           updated_at = now()
       WHERE inventory_item_id = $1 AND user_id = $2`,
      [existing.rows[0].id, userId]
    );
    return existing.rows[0].id;
  }

  const inserted = await client.query<{ id: number }>(
    `INSERT INTO user_inventory_item (user_id, shade_id, quantity, status, notes)
     VALUES ($1, $2, 1, 'owned', $3)
     ON CONFLICT (user_id, shade_id) WHERE shade_id IS NOT NULL DO UPDATE
       SET quantity = user_inventory_item.quantity + 1,
           status = CASE WHEN user_inventory_item.status IN ('wishlist', 'archived') THEN 'owned'
                         ELSE user_inventory_item.status END,
           updated_at = now()
     RETURNING inventory_item_id AS id`,
    [userId, entityId, "Added via Rapid Add capture"]
  );
  return inserted.rows[0].id;
}

async function getOpenQuestion(sessionId: number): Promise<CaptureQuestionRow | undefined> {
  const result = await query<CaptureQuestionRow>(
    `SELECT
       capture_question_id::text AS id,
       question_key              AS key,
       prompt,
       question_type             AS type,
       options_json              AS options,
       status,
       created_at::text          AS "createdAt"
     FROM capture_question
     WHERE capture_session_id = $1
       AND status = 'open'
     ORDER BY created_at ASC
     LIMIT 1`,
    [sessionId]
  );

  return result.rows[0];
}

async function startCapture(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/capture/start");

  try {
    let body: CaptureStartRequest = {};
    try {
      body = ((await request.json()) ?? {}) as CaptureStartRequest;
    } catch {
      body = {};
    }

    const captureId = randomUUID();

    const metadata = buildStartCaptureMetadata(body.metadata);

    // Bottle flow: resolve the typed brand hint against the catalog and keep it as the session
    // brand. The raw `metadata.brand` stays for the legacy resolver. Flag off: untouched.
    let brandHint: CaptureBrandHintEcho | undefined;
    const bottleCapture = isFeatureEnabled("bottleCapture");
    // `metadata.bottle` is server-owned; a client-sent one is never kept (flag on or off, so it
    // is not waiting to be read when the flag is turned on).
    delete metadata.bottle;
    const rawBrand = typeof metadata.brand === "string" ? metadata.brand.trim() : "";
    if (bottleCapture && rawBrand) {
      let resolved = null;
      try {
        resolved = await resolveBrandFromText(rawBrand, undefined, { mode: "hint" });
      } catch (error) {
        // A failed lookup must not block the capture: the hint is kept as typed.
        context.warn(`capture brand hint lookup failed: ${error instanceof Error ? error.message : String(error)}`);
        trackException(error, { area: "capture", stage: "brand-hint" });
      }
      metadata.bottle = {
        brand: { ...toBrandRef(resolved, rawBrand, "hint"), raw: rawBrand },
        prompts: {},
        skipped: [],
      };
      brandHint = toBrandHintEcho(resolved, rawBrand);
    }

    // The first ask: the bottom when the brand is already known, else the front.
    let nextFrame: CaptureFrameRequestSpec | null = null;
    if (bottleCapture) {
      let flow = readBottleFlowState(null);
      nextFrame = planNextFrame({
        state: flow,
        frameCount: 0,
        maxFrames: GUIDANCE_CONFIG.maxFrames,
        surfaces: {},
        brandKnown: Boolean(toRecord(metadata.bottle).brand),
        nameRead: false,
        glassHex: false,
        decision: "none",
      });
      if (nextFrame) flow = recordPrompt(flow, nextFrame);
      metadata.bottle = bottleFlowMetadataPatch(flow, nextFrame, toRecord(metadata.bottle)).bottle;
    }

    const result = await query<{ captureId: string; status: CaptureStatus }>(
      `INSERT INTO capture_session (capture_uuid, user_id, status, metadata)
       VALUES ($1::uuid, $2, 'processing', $3::jsonb)
       RETURNING capture_uuid::text AS "captureId", status`,
      [captureId, userId, metadata]
    );

    const response: CaptureStartResponse = {
      captureId: result.rows[0].captureId,
      status: result.rows[0].status,
      uploadUrls: [],
      guidanceConfig: {
        recommendedFrameTypes: [...GUIDANCE_CONFIG.recommendedFrameTypes],
        maxFrames: GUIDANCE_CONFIG.maxFrames,
      },
    };
    if (bottleCapture) {
      if (brandHint) response.brandHint = brandHint;
      response.nextFrame = nextFrame;
    }

    return { status: 201, jsonBody: response };
  } catch (error: any) {
    return internalServerError(context, error, "Failed to start capture", "capture.start");
  }
}

/**
 * Release a session's frame blobs after it reaches a terminal state (matched / unmatched). Runs
 * flag on or off (no blobs means nothing to do). Best effort: a failure is logged and the hourly
 * sweep releases whatever is left, so the response is never affected.
 */
async function releaseSessionFrames(
  context: InvocationContext,
  session: { id: number; captureId: string },
  userId: number
): Promise<void> {
  try {
    const mediaContainer = userMediaContainer();
    const warn = (message: string, error?: unknown) => {
      context.warn(`${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`);
      if (error) trackException(error, { area: "capture", stage: "release-frames" });
    };
    await releaseCaptureFrames(
      { sessionId: session.id, userId, captureId: session.captureId },
      {
        query,
        deleteBlob: (storageUrl) => deleteBlobFromStorageUrl(storageUrl, { allowedContainers: [mediaContainer] }),
        warn,
      }
    );
  } catch (error) {
    context.warn(`capture frame release failed: ${error instanceof Error ? error.message : String(error)}`);
    trackException(error, { area: "capture", stage: "release-frames" });
  }
}

async function addCaptureFrame(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/capture/{captureId}/frame");

  const captureId = request.params.captureId;
  if (!captureId) {
    return { status: 400, jsonBody: { error: "Capture id is required" } };
  }
  if (!isValidUuid(captureId)) {
    return { status: 400, jsonBody: { error: "Capture id must be a valid UUID" } };
  }

  const bottleOn = isFeatureEnabled("bottleCapture");
  // Blob stored for this frame but not yet referenced by a committed row; removed on failure.
  let uploadedFrameUrl: string | null = null;
  try {
    let body: CaptureFrameRequest;
    try {
      body = (await request.json()) as CaptureFrameRequest;
    } catch {
      return { status: 400, jsonBody: { error: "Invalid JSON body" } };
    }

    if (!body?.frameType) {
      return { status: 400, jsonBody: { error: "frameType is required" } };
    }

    const validFrameTypes = new Set(["barcode", "label", "color", "other"]);
    if (!validFrameTypes.has(body.frameType)) {
      return { status: 400, jsonBody: { error: "frameType must be one of: barcode, label, color, other" } };
    }

    if (!body.imageId && !body.imageBlobUrl) {
      return { status: 400, jsonBody: { error: "Either imageId or imageBlobUrl is required" } };
    }

    const session = await getCaptureSession(captureId, userId);
    if (!session) {
      return { status: 404, jsonBody: { error: "Capture session not found" } };
    }

    if (session.status === "cancelled") {
      return { status: 409, jsonBody: { error: "Cannot add frames to a cancelled session" } };
    }

    // A caller may only attach image assets they own; never link another user's media.
    if (body.imageId !== undefined && body.imageId !== null) {
      const requestedImageId = Number(body.imageId);
      if (!Number.isSafeInteger(requestedImageId) || requestedImageId <= 0) {
        return { status: 400, jsonBody: { error: "imageId must be a positive integer" } };
      }
      const owned = await query<{ imageId: string }>(
        `SELECT image_id::text AS "imageId"
         FROM image_asset
         WHERE image_id = $1
           AND owner_type = 'user'
           AND owner_id = $2`,
        [requestedImageId, userId]
      );
      if (owned.rows.length === 0) {
        return { status: 404, jsonBody: { error: "Image not found" } };
      }
      body.imageId = requestedImageId;
    }

    // A barcode the client already decoded on-device (BarcodeDetector / zxing) is trusted
    // evidence when it is a valid GTIN: no OCR, and the verdict goes back in this response.
    // The server owns `quality.ai` (model audits, read back as model calls and the sticker
    // read's confidence) and the vision-derived `extracted` fields; a client never sets them.
    body.quality = stripServerOwnedQuality(body.quality);
    const frameQuality = toRecord(body.quality);
    const scannedBarcode =
      body.frameType === "barcode" ? normalizeGtin(frameQuality.gtin, frameQuality.barcodeFormat) : null;
    // A wrong check digit is evidence worth looking up but not worth skipping OCR for.
    const decodedBarcode = scannedBarcode?.checkDigitValid ? scannedBarcode : null;

    // What the session knew before this frame (bottle flow: to tell whether the frame added any).
    const priorEvidence = bottleOn
      ? collectCaptureEvidence(session.metadata, await getCaptureFrameEvidence(session.id))
      : null;

    // Pre-transaction: normalize image and run AI extraction pipeline
    let normalizedImage: PreparedImageInput | null = null;
    let preQualityJson: Record<string, unknown> | null = body.quality ?? null;

    // Always validate imageBlobUrl when present (even alongside imageId) so an unvalidated
    // remote URL can never reach the AI services.
    if (body.imageBlobUrl) {
      normalizedImage = await normalizeCaptureImageInput(body.imageBlobUrl, session.captureId);
      if (!body.imageId) {
        preQualityJson = mergeQualityJson(body.quality, normalizedImage.qualityPatch);
      }
    }

    // Run AI extraction on label/barcode frames (outside transaction to avoid long locks).
    // Only normalized input is forwarded: EXIF-stripped, whitespace-free data URLs or
    // allowlisted storage-account URLs.
    const imageInputForAi = normalizedImage ? normalizedImage.sanitizedImageInput : null;
    let aiExtraction: FrameAiExtractionResult | null = null;
    if (imageInputForAi && !decodedBarcode) {
      const existingEvidence =
        priorEvidence ?? collectCaptureEvidence(session.metadata, await getCaptureFrameEvidence(session.id));
      // Bottle capture reads a data-URL label frame with vision too; a remote URL is OCR-only.
      const stickerContext: StickerReadContext | undefined =
        body.frameType === "label" && bottleOn && imageInputForAi.startsWith("data:")
          ? {
              userId,
              surface: parseBottleSurface(frameQuality.surface),
              brand: await resolveSessionBrand(session.metadata, existingEvidence),
            }
          : undefined;
      aiExtraction = await runFrameAiExtraction(
        imageInputForAi,
        body.frameType,
        {
          brand: existingEvidence.brand,
          shadeName: existingEvidence.shadeName,
          finish: existingEvidence.finish,
        },
        stickerContext
      );
    }

    // Bottle capture keeps the EXIF-stripped bytes as a private blob until the session is
    // resolved (or the sweep expires it). Flag off, no data-URL bytes, an attached imageId, or a
    // session that is already over (matched / unmatched, whose frames are released at that
    // terminal state): nothing is stored and the row keeps the inline placeholder as before.
    const sessionOver = session.status === "matched" || session.status === "unmatched";
    let frameStorageUrl = normalizedImage?.storageUrl ?? null;
    if (
      !sessionOver &&
      normalizedImage?.bytes &&
      normalizedImage.contentType &&
      normalizedImage.extension &&
      normalizedImage.checksumSha256 &&
      !body.imageId &&
      bottleOn
    ) {
      const stored = await storeCaptureFrameBytes(
        {
          userId,
          captureId: session.captureId,
          bytes: normalizedImage.bytes,
          contentType: normalizedImage.contentType,
          checksum: normalizedImage.checksumSha256,
          extension: normalizedImage.extension,
        },
        {
          warn: (message, error) => {
            context.warn(`${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`);
            if (error) trackException(error, { area: "capture", stage: "store-frame" });
          },
        }
      );
      frameStorageUrl = stored.storageUrl;
      if (stored.stored) uploadedFrameUrl = stored.storageUrl;
    }

    const result = await transaction(async (client) => {
      let imageId = body.imageId ?? null;
      let qualityJson = preQualityJson;
      const hasAiExtracted = Boolean(aiExtraction && Object.keys(aiExtraction.extracted).length > 0);

      // Merge AI extraction results into quality_json.extracted. A color frame that measured
      // nothing has an empty `extracted` and leaves the request's evidence alone.
      if (aiExtraction) {
        const ocrRawTextRaw = aiExtraction.ocrRawText;
        const ocrRawText = ocrRawTextRaw
          ? ocrRawTextRaw.length > MAX_CAPTURE_AI_RAW_TEXT_CHARS
            ? `${ocrRawTextRaw.slice(0, MAX_CAPTURE_AI_RAW_TEXT_CHARS)}…`
            : ocrRawTextRaw
          : undefined;
        qualityJson = mergeQualityJson(qualityJson ?? undefined, {
          ...(hasAiExtracted ? { extracted: aiExtraction.extracted } : {}),
          ai: {
            ocrRawText,
            ocrConfidence: aiExtraction.ocrConfidence,
            ocrBarcodeCount: aiExtraction.ocrBarcodeCount,
            llmConfidence: aiExtraction.llmConfidence,
            glass: aiExtraction.glass,
            sticker: aiExtraction.sticker,
            processedAt: new Date().toISOString(),
          },
        });
      }

      const normalizedExtraction = extractFrameEvidence(qualityJson);
      if (normalizedExtraction && !hasAiExtracted) {
        // AI produced nothing, so whatever `extracted` holds came from the client. Its own
        // `source` was stripped on ingest, so mark it here: client evidence is typed text
        // (`request_quality`), never a pipeline read.
        qualityJson = mergeQualityJson(qualityJson ?? undefined, {
          extracted: { ...normalizedExtraction, source: "request_quality" },
        });
      }
      const ingestMetadataPatch = buildIngestMetadataPatch(
        session.metadata,
        body.frameType,
        Boolean(normalizedExtraction || hasAiExtracted),
        hasAiExtracted ? "pipeline" : normalizedExtraction ? "request_quality" : "none"
      );

      if (!imageId && body.imageBlobUrl) {
        if (!normalizedImage) {
          throw new CaptureInputError("Failed to normalize image input");
        }
        const imageResult = await client.query<{ imageId: string }>(
          `INSERT INTO image_asset (owner_type, owner_id, storage_url, checksum_sha256, captured_at)
           VALUES ('user', $1, $2, $3, now())
           RETURNING image_id::text AS "imageId"`,
          [userId, frameStorageUrl ?? normalizedImage.storageUrl, normalizedImage.checksumSha256]
        );
        imageId = parseInt(imageResult.rows[0].imageId, 10);
      }

      const frameResult = await client.query<{ frameId: string }>(
        `INSERT INTO capture_frame (capture_session_id, image_id, frame_type, quality_json)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING capture_frame_id::text AS "frameId"`,
        [session.id, imageId, body.frameType, qualityJson]
      );

      await client.query(
        `UPDATE capture_session
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
             updated_at = now()
         WHERE capture_session_id = $1`,
        [session.id, ingestMetadataPatch]
      );

      return frameResult.rows[0];
    });
    uploadedFrameUrl = null; // committed: the blob is now referenced

    let check: CaptureCheckResponse | undefined;
    let checkResolution: SessionResolution | null = null;
    if (decodedBarcode) {
      try {
        const refreshed = await getCaptureSession(captureId, userId);
        if (refreshed && refreshed.status !== "cancelled") {
          const computed = await computeCaptureCheckWithResolution(refreshed, userId);
          check = computed.response;
          checkResolution = computed.resolution;
          trackCaptureChecked(check, "barcode_frame");
        }
      } catch (error) {
        // The frame is saved; the client can still call /check or /finalize.
        context.warn(`capture frame check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Bottle flow: plan the next photo. The frame is saved either way, so a planning failure
    // degrades to "nothing more to ask" (the client then calls /check).
    // A finished session (matched / unmatched) takes no more asks: planning would overwrite the
    // finalize or create audit in `metadata.resolver`.
    let nextFrame: CaptureFrameRequestSpec | null = null;
    if (bottleOn && priorEvidence && !isTerminalCaptureStatus(session.status)) {
      try {
        nextFrame = await advanceBottleFlow(
          session,
          userId,
          { kind: "frame", frameType: body.frameType, quality: preQualityJson, priorEvidence },
          checkResolution
        );
      } catch (error) {
        context.warn(`capture next-frame planning failed: ${error instanceof Error ? error.message : String(error)}`);
        trackException(error, { area: "capture", stage: "next-frame" });
      }
    }

    const response: CaptureFrameResponse = {
      received: true,
      captureId: session.captureId,
      frameId: result.frameId,
      status: session.status,
      ...(check ? { check } : {}),
      ...(bottleOn ? { nextFrame } : {}),
    };

    return { status: 201, jsonBody: response };
  } catch (error: any) {
    if (uploadedFrameUrl) {
      // Not linked to any row: remove it so a failed frame leaves no private media behind.
      try {
        await deleteBlobFromStorageUrl(uploadedFrameUrl, { allowedContainers: [userMediaContainer()] });
      } catch (deleteError) {
        context.warn(
          `capture frame blob cleanup failed: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
        );
      }
    }
    if (error instanceof CaptureInputError) {
      return { status: 400, jsonBody: { error: error.message } };
    }
    return internalServerError(context, error, "Failed to save capture frame", "capture.frame");
  }
}

async function finalizeCapture(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/capture/{captureId}/finalize");

  const captureId = request.params.captureId;
  if (!captureId) {
    return { status: 400, jsonBody: { error: "Capture id is required" } };
  }
  if (!isValidUuid(captureId)) {
    return { status: 400, jsonBody: { error: "Capture id must be a valid UUID" } };
  }

  try {
    const session = await getCaptureSession(captureId, userId);
    if (!session) {
      return { status: 404, jsonBody: { error: "Capture session not found" } };
    }

    if (session.status === "matched" || session.status === "unmatched" || session.status === "cancelled") {
      const existingQuestion = await getOpenQuestion(session.id);
      const response: CaptureFinalizeResponse = {
        captureId: session.captureId,
        status: session.status,
        question: toCaptureQuestion(existingQuestion),
      };
      return { status: 200, jsonBody: response };
    }
    const finalizeStartedAt = new Date().toISOString();
    const finalizeRunId = randomUUID();
    const outcome = await resolveCaptureSession(session, userId);
    const metadataPatch = withFinalizeAuditPatch(
      session.metadata,
      outcome.metadataPatch,
      outcome.status,
      finalizeRunId,
      finalizeStartedAt
    );
    trackEvent("capture.finalized", {
      captureId: session.captureId,
      outcome: outcome.status,
      confidence: outcome.confidence,
      runId: finalizeRunId,
    });
    trackCaptureResolved(session.captureId, outcome);

    if (outcome.status === "matched") {
      await transaction(async (client) => {
        const inventoryItemId = await addToInventoryFromMatch(
          client,
          userId,
          outcome.entityType,
          outcome.entityId
        );
        await rememberScannedBarcode(
          client,
          userId,
          session.id,
          outcome.evidence,
          outcome.entityType,
          outcome.entityId,
          outcome.barcodeVia
        );

        await client.query(
          `UPDATE capture_question
           SET status = 'expired'
           WHERE capture_session_id = $1
             AND status = 'open'`,
          [session.id]
        );

        await client.query(
          `UPDATE capture_session
           SET status = 'matched',
               top_confidence = $2,
               accepted_entity_type = $3,
               accepted_entity_id = $4,
               metadata = COALESCE(metadata, '{}'::jsonb)
                 || $5::jsonb
                 || jsonb_build_object('inventoryItemId', $6::bigint),
               updated_at = now()
           WHERE capture_session_id = $1`,
          [
            session.id,
            outcome.confidence,
            outcome.entityType,
            outcome.entityId,
            metadataPatch,
            inventoryItemId,
          ]
        );
      });
      // Rapid Add added a bottle: drop the caller's polish list + collection stats caches.
      await invalidatePolishCachesForUser(userId);
      await releaseSessionFrames(context, session, userId);

      const response: CaptureFinalizeResponse = {
        captureId: session.captureId,
        status: "matched",
      };
      return { status: 200, jsonBody: response };
    }

    if (outcome.status === "needs_question") {
      const question = await transaction(async (client) => {
        await client.query(
          `UPDATE capture_question
           SET status = 'expired'
           WHERE capture_session_id = $1
             AND status = 'open'`,
          [session.id]
        );

        await client.query(
          `UPDATE capture_session
           SET status = 'needs_question',
               top_confidence = $2,
               accepted_entity_type = NULL,
               accepted_entity_id = NULL,
               metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
               updated_at = now()
           WHERE capture_session_id = $1`,
          [session.id, outcome.confidence, metadataPatch]
        );

        const inserted = await client.query<CaptureQuestionRow>(
          `INSERT INTO capture_question
             (capture_session_id, question_key, prompt, question_type, options_json, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'open')
           RETURNING
             capture_question_id::text AS id,
             question_key              AS key,
             prompt,
             question_type             AS type,
             options_json              AS options,
             status,
             created_at::text          AS "createdAt"`,
          [
            session.id,
            outcome.question.key,
            outcome.question.prompt,
            outcome.question.type,
            serializeQuestionOptions(outcome.question.options),
          ]
        );

        return inserted.rows[0];
      });

      const response: CaptureFinalizeResponse = {
        captureId: session.captureId,
        status: "needs_question",
        question: toCaptureQuestion(question),
      };
      return { status: 200, jsonBody: response };
    }

    await transaction(async (client) => {
      await client.query(
        `UPDATE capture_question
         SET status = 'expired'
         WHERE capture_session_id = $1
           AND status = 'open'`,
        [session.id]
      );

      await client.query(
        `UPDATE capture_session
         SET status = 'unmatched',
             top_confidence = $2,
             accepted_entity_type = NULL,
             accepted_entity_id = NULL,
             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
             updated_at = now()
         WHERE capture_session_id = $1`,
        [session.id, outcome.confidence, metadataPatch]
      );
    });

    await releaseSessionFrames(context, session, userId);

    const response: CaptureFinalizeResponse = {
      captureId: session.captureId,
      status: "unmatched",
    };
    return { status: 200, jsonBody: response };
  } catch (error: any) {
    return internalServerError(context, error, "Failed to finalize capture", "capture.finalize");
  }
}

/**
 * Display data for a session's already-accepted entity (a finalized/answered match), so a
 * check on a matched session reports what was accepted instead of re-running the resolver.
 */
async function describeCaptureEntity(
  entityType: "shade" | "sku",
  entityId: number
): Promise<CaptureMatchCandidate> {
  if (entityType === "sku") {
    const result = await query<{
      shadeId: string | null;
      brand: string | null;
      productName: string | null;
      shadeName: string | null;
    }>(
      `SELECT
         s.shade_id::text        AS "shadeId",
         b.name_canonical        AS brand,
         s.product_name          AS "productName",
         sh.shade_name_canonical AS "shadeName"
       FROM sku s
       LEFT JOIN brand b ON s.brand_id = b.brand_id
       LEFT JOIN shade sh ON s.shade_id = sh.shade_id
       WHERE s.sku_id = $1`,
      [entityId]
    );
    const row = result.rows[0];
    return {
      entityType,
      entityId,
      shadeId: row?.shadeId ? parseInt(row.shadeId, 10) : null,
      display: [row?.brand, row?.productName || row?.shadeName || `SKU ${entityId}`]
        .filter(Boolean)
        .join(" — "),
      confidence: 1,
    };
  }

  const result = await query<{ brand: string | null; shadeName: string | null }>(
    `SELECT
       b.name_canonical       AS brand,
       s.shade_name_canonical AS "shadeName"
     FROM shade s
     LEFT JOIN brand b ON s.brand_id = b.brand_id
     WHERE s.shade_id = $1`,
    [entityId]
  );
  const row = result.rows[0];
  return {
    entityType,
    entityId,
    shadeId: entityId,
    display: [row?.brand, row?.shadeName || `Shade ${entityId}`].filter(Boolean).join(" — "),
    confidence: 1,
  };
}

function sameEntity(a: CaptureMatchCandidate, b: CaptureMatchCandidate): boolean {
  return a.entityType === b.entityType && a.entityId === b.entityId;
}

/** Display hex (vendor > detected > name) per shade id, for the verdict swatch. */
async function loadDisplayHexes(shadeIds: Array<number | null>): Promise<Map<string, string>> {
  const ids = Array.from(new Set(shadeIds.filter((id): id is number => id !== null)));
  const hexes = new Map<string, string>();
  if (ids.length === 0) return hexes;
  const result = await query<{
    shadeId: string;
    vendorHex: string | null;
    detectedHex: string | null;
    nameHex: string | null;
  }>(
    `SELECT shade_id::text AS "shadeId", vendor_hex AS "vendorHex", detected_hex AS "detectedHex", name_hex AS "nameHex"
     FROM shade
     WHERE shade_id = ANY($1::bigint[])`,
    [ids]
  );
  for (const row of result.rows) {
    const hex = resolveDisplayHex({
      vendorHex: row.vendorHex ?? undefined,
      detectedHex: row.detectedHex ?? undefined,
      nameHex: row.nameHex ?? undefined,
    });
    if (hex) hexes.set(row.shadeId, hex);
  }
  return hexes;
}

/**
 * The read-only check verdict for a session (shared by POST /check and the decoded-barcode
 * frame response) plus the resolution it ran (null when the session was already accepted).
 */
async function computeCaptureCheckWithResolution(
  session: CaptureSessionRow,
  userId: number
): Promise<{ response: CaptureCheckResponse; resolution: SessionResolution | null }> {
  let resolution: SessionResolution | null = null;
  let outcome: CaptureCheckResponse["outcome"];
  let confidence: number;
  let match: CaptureMatchCandidate | null = null;
  let candidates: CaptureMatchCandidate[];
  let questionKey: string | undefined;

  const acceptedEntityId = session.acceptedEntityId ? parseInt(session.acceptedEntityId, 10) : NaN;
  if (session.status === "matched" && session.acceptedEntityType && Number.isInteger(acceptedEntityId)) {
    // Already finalized/answered: report the accepted entity, don't second-guess it.
    const accepted = await describeCaptureEntity(session.acceptedEntityType, acceptedEntityId);
    match = { ...accepted, confidence: parseNumeric(session.topConfidence) ?? accepted.confidence };
    outcome = "matched";
    confidence = match.confidence;
    candidates = [match];
  } else {
    const resolved = await resolveCaptureSession(session, userId);
    resolution = resolved;
    outcome = resolved.status;
    confidence = resolved.confidence;
    candidates = resolved.candidates;
    if (resolved.status === "matched") {
      const { entityType, entityId } = resolved;
      const found = candidates.find((c) => c.entityType === entityType && c.entityId === entityId);
      match = found ?? (await describeCaptureEntity(entityType, entityId));
      if (!found) {
        candidates = [match, ...candidates];
      }
    } else if (resolved.status === "needs_question") {
      questionKey = resolved.question.key;
    }
  }

  const ownerships = await loadInventoryOwnership(
    userId,
    candidates.map((c) => ({
      shadeId: c.shadeId === null ? null : String(c.shadeId),
      skuId: c.entityType === "sku" ? String(c.entityId) : null,
    }))
  );
  const hexes = await loadDisplayHexes(candidates.map((c) => c.shadeId));
  const checkCandidates: CaptureCheckCandidate[] = candidates.map((c, i) => ({
    entityType: c.entityType,
    entityId: String(c.entityId),
    shadeId: c.shadeId === null ? null : String(c.shadeId),
    display: c.display,
    confidence: c.confidence,
    ownership: ownerships[i],
    ...(c.shadeId !== null && hexes.has(String(c.shadeId)) ? { hex: hexes.get(String(c.shadeId)) } : {}),
    ...(c.brandId !== undefined ? { brandId: String(c.brandId) } : {}),
    ...(typeof c.colorDistance === "number" ? { colorDistance: c.colorDistance } : {}),
  }));
  const matched = match;
  const matchIndex = matched ? candidates.findIndex((c) => sameEntity(c, matched)) : -1;

  const response: CaptureCheckResponse = {
    captureId: session.captureId,
    status: session.status,
    outcome,
    confidence,
    match: matchIndex >= 0 ? checkCandidates[matchIndex] : undefined,
    candidates: checkCandidates,
    questionKey,
    ...(isFeatureEnabled("bottleCapture")
      ? { nextFrame: resolution ? planFromResolution(readBottleFlowState(session.metadata), resolution) : null }
      : {}),
    ...(resolution?.bottle?.suggestedShade ? { suggestedShade: resolution.bottle.suggestedShade } : {}),
    ...(resolution?.bottle?.brandConflict ? { brandConflict: resolution.bottle.brandConflict } : {}),
  };
  return { response, resolution };
}

function trackCaptureChecked(response: CaptureCheckResponse, trigger: "check" | "barcode_frame"): void {
  trackEvent("capture.checked", {
    captureId: response.captureId,
    outcome: response.outcome,
    confidence: response.confidence,
    relationship: response.match?.ownership.relationship ?? "none",
    candidateCount: response.candidates.length,
    trigger,
  });
}

/**
 * POST /api/capture/{captureId}/check — "do I own this?" without buying it.
 *
 * Runs the same resolver as finalize, then reports the caller's relationship
 * (owned/wishlisted/notOwned) to the match and to each candidate. Strictly read-only:
 * only SELECTs, no transaction, and nothing is written to inventory, inventory_event,
 * capture_session (status/metadata), capture_question or capture_answer. The session
 * stays exactly as it was, so a later finalize still resolves and adds as before.
 */
async function checkCapture(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/capture/{captureId}/check");

  const captureId = request.params.captureId;
  if (!captureId) {
    return { status: 400, jsonBody: { error: "Capture id is required" } };
  }
  if (!isValidUuid(captureId)) {
    return { status: 400, jsonBody: { error: "Capture id must be a valid UUID" } };
  }

  try {
    const session = await getCaptureSession(captureId, userId);
    if (!session) {
      return { status: 404, jsonBody: { error: "Capture session not found" } };
    }
    if (session.status === "cancelled") {
      return { status: 409, jsonBody: { error: "Cannot check a cancelled session" } };
    }

    const { response, resolution } = await computeCaptureCheckWithResolution(session, userId);

    trackCaptureChecked(response, "check");
    if (resolution) trackCaptureResolved(session.captureId, resolution);

    return { status: 200, jsonBody: response };
  } catch (error: any) {
    return internalServerError(context, error, "Failed to check capture", "capture.check");
  }
}

async function getCaptureStatus(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("GET /api/capture/{captureId}/status");

  const captureId = request.params.captureId;
  if (!captureId) {
    return { status: 400, jsonBody: { error: "Capture id is required" } };
  }
  if (!isValidUuid(captureId)) {
    return { status: 400, jsonBody: { error: "Capture id must be a valid UUID" } };
  }

  try {
    const session = await getCaptureSession(captureId, userId);
    if (!session) {
      return { status: 404, jsonBody: { error: "Capture session not found" } };
    }

    const question = await getOpenQuestion(session.id);

    const response: CaptureStatusResponse = {
      captureId: session.captureId,
      status: session.status,
      topConfidence: parseNumeric(session.topConfidence),
      acceptedEntityType: session.acceptedEntityType || undefined,
      acceptedEntityId: session.acceptedEntityId || undefined,
      metadata: session.metadata || undefined,
      question: toCaptureQuestion(question),
      // A session that is over asks for no more photos, whatever was planned last.
      ...(isFeatureEnabled("bottleCapture")
        ? { nextFrame: isTerminalCaptureStatus(session.status) ? null : readLastNextFrame(session.metadata) }
        : {}),
    };

    return { status: 200, jsonBody: response };
  } catch (error: any) {
    return internalServerError(context, error, "Failed to fetch capture status", "capture.status");
  }
}

/** Matched, unmatched or cancelled: the session takes no more photo asks. */
function isTerminalCaptureStatus(status: CaptureStatus): boolean {
  return status === "matched" || status === "unmatched" || status === "cancelled";
}

/** Bottle flow: the user skipped a photo. Records it, re-plans and answers with the next ask. */
async function skipBottleSurface(captureId: string, surface: BottleSurface, userId: number): Promise<HttpResponseInit> {
  const session = await getCaptureSession(captureId, userId);
  if (!session) {
    return { status: 404, jsonBody: { error: "Capture session not found" } };
  }
  if (isTerminalCaptureStatus(session.status)) {
    // Over: no re-resolve and no metadata write.
    return { status: 409, jsonBody: { error: `Cannot skip a photo on a ${session.status} session` } };
  }
  const nextFrame = await advanceBottleFlow(session, userId, { kind: "skip", surface });
  const response: CaptureAnswerResponse = {
    captureId: session.captureId,
    status: session.status,
    question: toCaptureQuestion(await getOpenQuestion(session.id)),
    nextFrame,
  };
  return { status: 200, jsonBody: response };
}

async function answerCaptureQuestion(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/capture/{captureId}/answer");

  const captureId = request.params.captureId;
  if (!captureId) {
    return { status: 400, jsonBody: { error: "Capture id is required" } };
  }
  if (!isValidUuid(captureId)) {
    return { status: 400, jsonBody: { error: "Capture id must be a valid UUID" } };
  }

  try {
    let body: CaptureAnswerRequest;
    try {
      body = (await request.json()) as CaptureAnswerRequest;
    } catch {
      return { status: 400, jsonBody: { error: "Invalid JSON body" } };
    }
    if (body?.skipSurface !== undefined) {
      if (!isFeatureEnabled("bottleCapture")) {
        // Flag off: skipSurface does not exist, so a bare one is the old "answer is required".
        return {
          status: 400,
          jsonBody: { error: body.answer === undefined ? "answer is required" : "skipSurface is not enabled" },
        };
      }
      if (body.answer !== undefined) {
        return { status: 400, jsonBody: { error: "Send either answer or skipSurface, not both" } };
      }
      const skipped = parseBottleSurface(body.skipSurface);
      if (!skipped) {
        return { status: 400, jsonBody: { error: `skipSurface must be one of: ${BOTTLE_SURFACES.join(", ")}` } };
      }
      return skipBottleSurface(captureId, skipped, userId);
    }
    if (body?.answer === undefined) {
      return { status: 400, jsonBody: { error: "answer is required" } };
    }
    let requestedQuestionId: number | null = null;
    if (body.questionId !== undefined) {
      requestedQuestionId = parseInt(body.questionId, 10);
      if (!Number.isInteger(requestedQuestionId) || requestedQuestionId <= 0) {
        return { status: 400, jsonBody: { error: "questionId must be a positive integer when provided" } };
      }
    }

    const session = await getCaptureSession(captureId, userId);
    if (!session) {
      return { status: 404, jsonBody: { error: "Capture session not found" } };
    }

    const openQuestion = await (async () => {
      if (body.questionId) {
        const result = await query<CaptureQuestionRow>(
          `SELECT
             capture_question_id::text AS id,
             question_key              AS key,
             prompt,
             question_type             AS type,
             options_json              AS options,
             status,
             created_at::text          AS "createdAt"
           FROM capture_question
           WHERE capture_question_id = $1
             AND capture_session_id = $2
             AND status = 'open'`,
          [requestedQuestionId, session.id]
        );
        return result.rows[0];
      }
      return getOpenQuestion(session.id);
    })();

    if (!openQuestion) {
      return { status: 404, jsonBody: { error: "No open question found for this capture session" } };
    }

    const normalizedAnswer = normalizeAnswerForQuestion(openQuestion.key, body.answer);
    const answerJson = JSON.stringify(normalizedAnswer);

    let updatedStatus: CaptureStatus = "processing";
    // A picked candidate can teach the scanned GTIN (#21); read the evidence before writing.
    const answerEvidence =
      openQuestion.key === "candidate_select"
        ? collectCaptureEvidence(session.metadata, await getCaptureFrameEvidence(session.id))
        : null;

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO capture_answer (capture_question_id, user_id, answer_json)
         VALUES ($1, $2, $3::jsonb)`,
        [parseInt(openQuestion.id, 10), userId, answerJson]
      );

      await client.query(
        `UPDATE capture_question
         SET status = CASE WHEN $2::jsonb = '"skip"'::jsonb THEN 'skipped' ELSE 'answered' END
         WHERE capture_question_id = $1`,
        [parseInt(openQuestion.id, 10), answerJson]
      );

      const selectedShadeId =
        openQuestion.key === "candidate_select"
          ? extractSelectedEntityId(normalizedAnswer)
          : null;

      if (selectedShadeId && body.answer !== "skip") {
        updatedStatus = "matched";
        const inventoryItemId = await addToInventoryFromMatch(
          client,
          userId,
          "shade",
          selectedShadeId
        );
        if (answerEvidence) {
          await rememberScannedBarcode(client, userId, session.id, answerEvidence, "shade", selectedShadeId, undefined);
        }

        await client.query(
          `UPDATE capture_session
           SET status = 'matched',
               top_confidence = 1,
               accepted_entity_type = 'shade',
               accepted_entity_id = $2,
               metadata = COALESCE(metadata, '{}'::jsonb)
                 || jsonb_build_object(
                      'answers',
                      COALESCE(metadata->'answers', '{}'::jsonb)
                        || jsonb_build_object($3::text, $4::jsonb)
                    )
                 || jsonb_build_object('inventoryItemId', $5::bigint),
               updated_at = now()
           WHERE capture_session_id = $1`,
          [session.id, selectedShadeId, openQuestion.key, answerJson, inventoryItemId]
        );

        await client.query(
          `UPDATE capture_question
           SET status = 'expired'
           WHERE capture_session_id = $1
             AND status = 'open'`,
          [session.id]
        );
        return;
      }

      await client.query(
        `UPDATE capture_session
         SET status = 'processing',
             metadata = COALESCE(metadata, '{}'::jsonb)
               || jsonb_build_object(
                    'answers',
                    COALESCE(metadata->'answers', '{}'::jsonb)
                      || jsonb_build_object($2::text, $3::jsonb)
                  ),
             updated_at = now()
         WHERE capture_session_id = $1`,
        [session.id, openQuestion.key, answerJson]
      );
    });
    if ((updatedStatus as CaptureStatus) === "matched") {
      // Rapid Add added a bottle: drop the caller's polish list + collection stats caches.
      await invalidatePolishCachesForUser(userId);
      await releaseSessionFrames(context, session, userId);
    }

    // Re-resolve after non-selection answers (e.g., brand_shade free-text)
    if (body.answer !== "skip" && openQuestion.key !== "candidate_select") {
      const refreshedSession = await getCaptureSession(captureId, userId);
      if (refreshedSession && refreshedSession.status === "processing") {
        const reResolveRunId = randomUUID();
        const reResolveStartedAt = new Date().toISOString();
        const outcome = await resolveCaptureSession(refreshedSession, userId);
        const metadataPatch = withFinalizeAuditPatch(
          refreshedSession.metadata,
          outcome.metadataPatch,
          outcome.status,
          reResolveRunId,
          reResolveStartedAt
        );

        trackEvent("capture.re_resolved", {
          captureId: refreshedSession.captureId,
          outcome: outcome.status,
          confidence: outcome.confidence,
          trigger: openQuestion.key,
          runId: reResolveRunId,
        });

        if (outcome.status === "matched") {
          updatedStatus = "matched";
          await transaction(async (client) => {
            const inventoryItemId = await addToInventoryFromMatch(
              client,
              userId,
              outcome.entityType,
              outcome.entityId
            );
            await rememberScannedBarcode(
              client,
              userId,
              refreshedSession.id,
              outcome.evidence,
              outcome.entityType,
              outcome.entityId,
              outcome.barcodeVia
            );
            await client.query(
              `UPDATE capture_question SET status = 'expired' WHERE capture_session_id = $1 AND status = 'open'`,
              [refreshedSession.id]
            );
            await client.query(
              `UPDATE capture_session
               SET status = 'matched',
                   top_confidence = $2,
                   accepted_entity_type = $3,
                   accepted_entity_id = $4,
                   metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb || jsonb_build_object('inventoryItemId', $6::bigint),
                   updated_at = now()
               WHERE capture_session_id = $1`,
              [refreshedSession.id, outcome.confidence, outcome.entityType, outcome.entityId, metadataPatch, inventoryItemId]
            );
          });
          // Rapid Add added a bottle: drop the caller's polish list + collection stats caches.
          await invalidatePolishCachesForUser(userId);
          await releaseSessionFrames(context, refreshedSession, userId);
        } else if (outcome.status === "needs_question") {
          updatedStatus = "needs_question";
          await transaction(async (client) => {
            await client.query(
              `UPDATE capture_question SET status = 'expired' WHERE capture_session_id = $1 AND status = 'open'`,
              [refreshedSession.id]
            );
            await client.query(
              `UPDATE capture_session
               SET status = 'needs_question', top_confidence = $2, metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at = now()
               WHERE capture_session_id = $1`,
              [refreshedSession.id, outcome.confidence, metadataPatch]
            );
            await client.query(
              `INSERT INTO capture_question (capture_session_id, question_key, prompt, question_type, options_json, status)
               VALUES ($1, $2, $3, $4, $5::jsonb, 'open')`,
              [refreshedSession.id, outcome.question.key, outcome.question.prompt, outcome.question.type, serializeQuestionOptions(outcome.question.options)]
            );
          });
        } else {
          updatedStatus = "unmatched";
          await transaction(async (client) => {
            await client.query(
              `UPDATE capture_question SET status = 'expired' WHERE capture_session_id = $1 AND status = 'open'`,
              [refreshedSession.id]
            );
            await client.query(
              `UPDATE capture_session
               SET status = 'unmatched', top_confidence = $2, metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at = now()
               WHERE capture_session_id = $1`,
              [refreshedSession.id, outcome.confidence, metadataPatch]
            );
          });
          await releaseSessionFrames(context, refreshedSession, userId);
        }
      }
    }

    const nextQuestion = await getOpenQuestion(session.id);
    const response: CaptureAnswerResponse = {
      captureId: session.captureId,
      status: updatedStatus,
      question: toCaptureQuestion(nextQuestion),
    };

    return { status: 200, jsonBody: response };
  } catch (error: any) {
    if (error instanceof CaptureShadeNotFoundError) {
      return { status: 404, jsonBody: { error: "Shade not found" } };
    }
    return internalServerError(context, error, "Failed to answer capture question", "capture.answer");
  }
}

app.http("capture-start", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "capture/start",
  handler: withCors(withAuth(startCapture)),
});

app.http("capture-frame", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "capture/{captureId}/frame",
  handler: withCors(withAuth(addCaptureFrame)),
});

app.http("capture-finalize", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "capture/{captureId}/finalize",
  handler: withCors(withAuth(finalizeCapture)),
});

// Check-only matching: a separate read-only route rather than a finalize flag, so the
// mutating state machine in finalize stays untouched (see checkCapture).
app.http("capture-check", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "capture/{captureId}/check",
  handler: withCors(withAuth(checkCapture)),
});

app.http("capture-status", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "capture/{captureId}/status",
  handler: withCors(withAuth(getCaptureStatus)),
});

app.http("capture-answer", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "capture/{captureId}/answer",
  handler: withCors(withAuth(answerCaptureQuestion)),
});
