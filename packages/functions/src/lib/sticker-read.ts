import type { BottleSurface } from "swatchwatch-shared";
import {
  loadDetectionFinishCatalog,
  parseConfidence,
  requestAzureOpenAIChatCompletion,
  resolveVisionImageDetail,
  type HexDetectionOptions,
  type VisionImageDetail,
} from "./ai-color-detection";
import { resolveAzureOpenAiConfig } from "./azure-openai-config";
import { normalizeGtin } from "./barcodes";
import { BRAND_SHADE_NAMES_CAP } from "./brand-resolve";
import { canonicalizeFinish, finishNamesForPrompt, type FinishCatalog } from "./finishes";
import type { OcrResult } from "./ocr";

/**
 * Vision read of the bottom sticker (Bottle Flow slice A): one low-detail chat call that reads
 * the printed brand, shade name, finish and barcode digits straight from the photo. When the
 * brand is known the question is closed (the brand's shade names are listed and the model picks
 * the closest one, or none), which beats OCR on stylized sticker fonts; it also runs when OCR is
 * unusable. Best effort: a missing config, an empty answer or a throw is `null`, and the frame
 * keeps its OCR evidence.
 */

/** Bump whenever the prompt text in `buildStickerReadPayload` changes. */
export const STICKER_READ_PROMPT_VERSION = "sticker-read/2026-10-v1";
/** OCR below this confidence (or without text) is unusable, so the vision read runs anyway. */
export const STICKER_READ_OCR_MIN_CONFIDENCE = 0.4;
export const STICKER_READ_DEPLOYMENT_ENV_KEYS = [
  "AZURE_OPENAI_DEPLOYMENT_LABEL",
  "AZURE_OPENAI_DEPLOYMENT_HEX",
  "AZURE_OPENAI_DEPLOYMENT",
];

/** Confidence used when the model answers fields but gives none. */
const STICKER_READ_DEFAULT_CONFIDENCE = 0.5;
const STICKER_READ_MAX_TOKENS = 250;
const MAX_FIELD_CHARS = 120;
const GTIN_PATTERN = /^\d{8,14}$/;

/** Spec §5.2: brand known (closed question), or OCR unusable (null, empty text, or confidence < 0.4). */
export function shouldVisionRead(input: {
  brandKnown: boolean;
  ocr: Pick<OcrResult, "rawText" | "confidence"> | null;
}): boolean {
  if (input.brandKnown) return true;
  if (!input.ocr) return true;
  return input.ocr.rawText.trim().length === 0 || input.ocr.confidence < STICKER_READ_OCR_MIN_CONFIDENCE;
}

export interface StickerReadInput {
  imageDataUri: string;
  surface: BottleSurface | null;
  brandName: string | null;
  /** The brand's shade names; a closed set when 1 to `BRAND_SHADE_NAMES_CAP` of them, else the read is open. */
  shadeNames: readonly string[];
  finishCatalog?: FinishCatalog;
  imageDetail?: VisionImageDetail;
}

export interface StickerReadResult {
  brand: string | null;
  /** Confidence of `brand`: the read's overall confidence when a brand was read, else null. */
  brandConfidence: number | null;
  /** The shade name as printed. */
  printedName: string | null;
  /** Exactly one of the listed names (listed spelling), or null; null on an open read or without a printed name. */
  closestListed: string | null;
  finish: string | null;
  gtin: string | null;
  confidence: number;
  promptVersion: string;
  closedSet: boolean;
  rawContent: string;
}

function isClosedSet(shadeNames: readonly string[]): boolean {
  return shadeNames.length >= 1 && shadeNames.length <= BRAND_SHADE_NAMES_CAP;
}

export function buildStickerReadPayload(input: StickerReadInput, safePrompt: boolean): Record<string, unknown> {
  const closedSet = isClosedSet(input.shadeNames);
  const finishList = finishNamesForPrompt(input.finishCatalog).join(", ");
  const imageDetail = input.imageDetail ?? resolveVisionImageDetail();
  const image = { type: "image_url", image_url: { url: input.imageDataUri, detail: imageDetail } };
  const surfaceText = input.surface ? ` The photo shows the ${input.surface} of the bottle.` : "";
  const brandText = input.brandName ? ` The brand is ${input.brandName}.` : "";
  const shape = `{"printedName":"<shade name as printed or null>","closestListed":"<one listed name or null>","brand":"<brand or null>","finish":"<finish or null>","gtin":"<barcode digits or null>","confidence":0..1}`;

  const systemPrompt = safePrompt
    ? `You read the printed text on a nail polish bottle sticker in a photo.${surfaceText}${brandText} ${
        closedSet ? "A list of shade names is provided." : "The list of shade names is unavailable."
      } Respond with valid JSON only: ${shape}.`
    : `You read the sticker printed on a nail polish bottle.${surfaceText}${brandText} ${
        closedSet
          ? "You are given the brand's shade names; the shade on this bottle is probably one of them."
          : "The list of shade names is unavailable, so closestListed is always null."
      } Report only what is printed; never guess. Use null for anything you cannot read. ALWAYS respond with valid JSON: ${shape}.`;

  const listText = closedSet
    ? `Listed shade names (one per line):\n${input.shadeNames.join("\n")}\n\nclosestListed must be exactly one of the listed names, the closest to the printed shade name, or null when none is close.`
    : "closestListed: null.";
  const userPrompt = `Read the sticker. ${listText}\nprintedName is the shade name as printed. finish is one of: ${finishList}. gtin is the barcode digits when visible. Return JSON only.`;

  return {
    temperature: 0,
    max_tokens: STICKER_READ_MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: [{ type: "text", text: userPrompt }, image] },
    ],
  };
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_CHARS);
  return trimmed.length > 0 ? trimmed : null;
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const unfenced = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed: unknown = JSON.parse(unfenced);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function listKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function parseStickerRead(
  content: string,
  shadeNames: readonly string[],
  finishCatalog?: FinishCatalog
): Omit<StickerReadResult, "promptVersion" | "closedSet" | "rawContent"> {
  const row = parseJsonObject(content);
  if (!row) {
    return { brand: null, brandConfidence: null, printedName: null, closestListed: null, finish: null, gtin: null, confidence: 0 };
  }

  const printedName = cleanText(row.printedName);
  const listed = cleanText(row.closestListed);
  // A pick with no printed name was made from the bottle's look, not its sticker: a guess.
  const closestListed = listed && printedName
    ? (shadeNames.find((name) => listKey(name) === listKey(listed)) ?? null)
    : null;
  const brand = cleanText(row.brand);
  const confidence = parseConfidence(row.confidence) ?? STICKER_READ_DEFAULT_CONFIDENCE;
  const digits = typeof row.gtin === "string" || typeof row.gtin === "number" ? String(row.gtin).replace(/\D/g, "") : "";

  return {
    brand,
    brandConfidence: brand ? confidence : null,
    printedName,
    closestListed,
    finish: canonicalizeFinish(row.finish, finishCatalog),
    gtin: GTIN_PATTERN.test(digits) ? digits : null,
    confidence,
  };
}

// ── The call ─────────────────────────────────────────────────────────────────

export interface ReadStickerOptions {
  onLog?: HexDetectionOptions["onLog"];
  /** Called right before the chat request is sent, so the caller can audit the model call. */
  onModelCall?: () => void;
}

/** One low-detail call; null when config is missing, content is null, or the call throws (logged). */
export async function readStickerWithVision(
  input: StickerReadInput,
  options?: ReadStickerOptions
): Promise<StickerReadResult | null> {
  if (!resolveAzureOpenAiConfig({ deploymentEnvKeys: STICKER_READ_DEPLOYMENT_ENV_KEYS }).isValid) return null;

  try {
    const finishCatalog = input.finishCatalog ?? (await loadDetectionFinishCatalog(options));
    const closedSet = isClosedSet(input.shadeNames);
    const withCatalog = { ...input, finishCatalog };
    options?.onModelCall?.();
    const response = await requestAzureOpenAIChatCompletion(
      {
        buildPayload: (safePrompt) => buildStickerReadPayload(withCatalog, safePrompt),
        deploymentEnvKeys: STICKER_READ_DEPLOYMENT_ENV_KEYS,
        usageMetricPrefix: "sticker_read",
        logLabel: `sticker read (${input.surface ?? "unknown surface"}, ${closedSet ? `${input.shadeNames.length} listed` : "open"})`,
      },
      { onLog: options?.onLog }
    );
    if (response.provider === "none" || response.content === null) return null;

    return {
      ...parseStickerRead(response.content, closedSet ? input.shadeNames : [], finishCatalog),
      promptVersion: STICKER_READ_PROMPT_VERSION,
      closedSet,
      rawContent: response.content,
    };
  } catch (error) {
    options?.onLog?.("warn", `[sticker-read] Vision read failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ── Merge with OCR ───────────────────────────────────────────────────────────

export interface MergedLabelExtraction {
  extracted: Record<string, unknown>;
  sources: Record<string, "ocr" | "vision">;
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim().length === 0);
}

/**
 * Fields both reads can fill (OCR key → vision key). An OCR value keeps its place only when its
 * confidence is higher than the vision read's; a value only one side has is used as is.
 */
const CONTESTED_FIELDS: ReadonlyArray<readonly [string, "brand" | "printedName" | "finish" | "gtin"]> = [
  ["brand", "brand"],
  ["shadeName", "printedName"],
  ["finish", "finish"],
  ["gtin", "gtin"],
];

/**
 * Merge the OCR-derived label fields (`parseLabelText`, confidence = its `confidence`) with the
 * vision read. A vision `gtin` is used only when its check digit is valid. `shadeNameListed`
 * exists only in the vision read and is always copied;
 * `brandConfidence` is the confidence of whichever read supplied `brand` (vision's
 * `brandConfidence`, or the OCR parse's `confidence`). `extracted.source = "vision"` when any
 * vision field made it into the result.
 */
export function mergeLabelExtraction(
  ocr: { fields: Record<string, unknown>; confidence: number } | null,
  vision: StickerReadResult | null
): MergedLabelExtraction {
  const extracted: Record<string, unknown> = {};
  const sources: Record<string, "ocr" | "vision"> = {};
  const ocrFields = ocr?.fields ?? {};

  for (const [key, value] of Object.entries(ocrFields)) {
    if (!hasValue(value)) continue;
    extracted[key] = value;
    sources[key] = "ocr";
  }

  if (vision) {
    for (const [key, visionKey] of CONTESTED_FIELDS) {
      const visionValue = vision[visionKey];
      if (!hasValue(visionValue)) continue;
      // Barcode digits the model read are evidence only with a valid check digit (else audit only).
      if (key === "gtin" && !normalizeGtin(visionValue)?.checkDigitValid) continue;
      const ocrKeeps = hasValue(ocrFields[key]) && ocr !== null && ocr.confidence > vision.confidence;
      if (ocrKeeps) continue;
      extracted[key] = visionValue;
      sources[key] = "vision";
    }
    if (vision.closestListed !== null) {
      extracted.shadeNameListed = vision.closestListed;
      sources.shadeNameListed = "vision";
    }
  }

  // `brandConfidence` describes the brand that won: the vision read's, or OCR's parse confidence.
  if (sources.brand === "vision" && vision) {
    extracted.brandConfidence = vision.brandConfidence ?? vision.confidence;
    sources.brandConfidence = "vision";
  } else if (sources.brand === "ocr" && ocr) {
    extracted.brandConfidence = ocr.confidence;
    sources.brandConfidence = "ocr";
  }

  if (Object.values(sources).includes("vision")) extracted.source = "vision";
  return { extracted, sources };
}
