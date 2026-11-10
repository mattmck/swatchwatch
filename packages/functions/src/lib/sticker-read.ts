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
import { BRAND_SHADE_NAMES_CAP, CATALOG_BRAND_NAMES_CAP } from "./brand-resolve";
import { canonicalizeFinish, finishNamesForPrompt, type FinishCatalog } from "./finishes";
import type { OcrResult } from "./ocr";

/**
 * Vision read of the bottom sticker (Bottle Flow slice A): one low-detail chat call that reads
 * the printed brand, shade name, finish and barcode digits straight from the photo. When the
 * brand is known the question is closed (the brand's shade names are listed and the model picks
 * the closest one, or none), which beats OCR on stylized sticker fonts; when it is not, the
 * catalog's brand names are listed instead so a script logo comes back as the catalog brand
 * (`brandListed`), never picked without a printed brand. It also runs when OCR is unusable.
 * Best effort: a missing config, an empty answer or a throw is `null`, and the frame keeps its
 * OCR evidence.
 */

/**
 * Bump whenever the prompt text in `buildStickerReadPayload` changes.
 * v2 (2026-11): separate `brandConfidence`, the closed brand list (`brandListed`), and a note
 * that the sticker text may be rotated or sideways.
 */
export const STICKER_READ_PROMPT_VERSION = "sticker-read/2026-11-v2";
/** Most catalog brand names listed on a brand read; more than that and the read is open. */
export { CATALOG_BRAND_NAMES_CAP as BRAND_NAMES_PROMPT_CAP };
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
  /** Catalog brand names; listed (a closed brand question) only without `brandName` and when 1 to `BRAND_NAMES_PROMPT_CAP` of them. */
  brandNames?: readonly string[];
  finishCatalog?: FinishCatalog;
  imageDetail?: VisionImageDetail;
}

export interface StickerReadResult {
  /** The brand as printed; null when none, or when it only echoes the brand the prompt named. */
  brand: string | null;
  /** Exactly one of the listed catalog brand names (listed spelling), or null; never without a printed `brand`. */
  brandListed: string | null;
  /** Confidence of `brand`: the model's `brandConfidence`, else the read's overall confidence; null without a brand. */
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

/** The brand names to list: only when the brand is unknown and the list fits. */
function listedBrandNames(input: Pick<StickerReadInput, "brandName" | "brandNames">): readonly string[] {
  const names = input.brandNames ?? [];
  if (input.brandName || names.length < 1 || names.length > CATALOG_BRAND_NAMES_CAP) return [];
  return names;
}

export function buildStickerReadPayload(input: StickerReadInput, safePrompt: boolean): Record<string, unknown> {
  const closedSet = isClosedSet(input.shadeNames);
  const brandNames = listedBrandNames(input);
  const finishList = finishNamesForPrompt(input.finishCatalog).join(", ");
  const imageDetail = input.imageDetail ?? resolveVisionImageDetail();
  const image = { type: "image_url", image_url: { url: input.imageDataUri, detail: imageDetail } };
  const surfaceText = input.surface ? ` The photo shows the ${input.surface} of the bottle.` : "";
  const brandText = input.brandName ? ` The brand is ${input.brandName}.` : "";
  const shape = `{"printedName":"<shade name as printed or null>","closestListed":"<one listed name or null>","brand":"<brand as printed or null>","brandListed":"<one listed brand or null>","brandConfidence":0..1,"finish":"<finish or null>","gtin":"<barcode digits or null>","confidence":0..1}`;
  const rotation = "The text may be rotated or sideways; read it in any orientation.";
  const brandConfidenceText = "brandConfidence is how sure you are of the brand alone; confidence is for the whole read.";

  const systemPrompt = safePrompt
    ? `You read the printed text on a nail polish bottle sticker in a photo.${surfaceText}${brandText} ${
        closedSet ? "A list of shade names is provided." : "The list of shade names is unavailable."
      } ${rotation} ${brandConfidenceText} Respond with valid JSON only: ${shape}.`
    : `You read the sticker printed on a nail polish bottle.${surfaceText}${brandText} ${
        closedSet
          ? "You are given the brand's shade names; the shade on this bottle is probably one of them."
          : "The list of shade names is unavailable, so closestListed is always null."
      } ${rotation} The shade name is never the brand, its website, the size or the maker's address. Report only what is printed; never guess. Use null for anything you cannot read. ${brandConfidenceText} ALWAYS respond with valid JSON: ${shape}.`;

  const listText = closedSet
    ? `Listed shade names (one per line):\n${input.shadeNames.join("\n")}\n\nclosestListed must be exactly one of the listed names, the closest to the printed shade name, or null when none is close.`
    : "closestListed: null.";
  const brandListText = brandNames.length > 0
    ? `Listed brand names (one per line):\n${brandNames.join("\n")}\n\nbrand is the brand name or logo as printed (it may be a stylized or script logo). brandListed must be exactly one of the listed brand names, the one printed on the bottle, or null when the printed brand is none of them or no brand is printed; never pick a brand from the bottle's color or shape.`
    : "brandListed: null.";
  const userPrompt = `Read the sticker. ${listText}\n${brandListText}\nprintedName is the shade name as printed. finish is one of: ${finishList}. gtin is the barcode digits when visible. Return JSON only.`;

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

/** Answers some models write instead of a JSON null ("null" as a string, "none", "N/A"). */
const PLACEHOLDER_PATTERN = /^(null|none|n\/a|unknown)$/i;

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_CHARS);
  return trimmed.length > 0 && !PLACEHOLDER_PATTERN.test(trimmed) ? trimmed : null;
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

/** Brand spellings compared on letters and digits only ("kb shimmer" = "KBShimmer"). */
function brandKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface ParseStickerReadOptions {
  /** The listed catalog brand names `brandListed` must be one of (none = no pick). */
  brandNames?: readonly string[];
  /** The brand the prompt named: the model repeating it back is no evidence, so `brand` is null. */
  givenBrand?: string | null;
}

export function parseStickerRead(
  content: string,
  shadeNames: readonly string[],
  finishCatalog?: FinishCatalog,
  options: ParseStickerReadOptions = {}
): Omit<StickerReadResult, "promptVersion" | "closedSet" | "rawContent"> {
  const row = parseJsonObject(content);
  if (!row) {
    return {
      brand: null,
      brandListed: null,
      brandConfidence: null,
      printedName: null,
      closestListed: null,
      finish: null,
      gtin: null,
      confidence: 0,
    };
  }

  const printedName = cleanText(row.printedName);
  const listed = cleanText(row.closestListed);
  // A pick with no printed name was made from the bottle's look, not its sticker: a guess.
  const closestListed = listed && printedName
    ? (shadeNames.find((name) => listKey(name) === listKey(listed)) ?? null)
    : null;
  const printedBrand = cleanText(row.brand);
  const echoed = Boolean(printedBrand && options.givenBrand && brandKey(printedBrand) === brandKey(options.givenBrand));
  const brand = echoed ? null : printedBrand;
  const listedBrand = cleanText(row.brandListed);
  // Like the shade pick: a brand picked with none printed was guessed from the bottle's look.
  const brandListed = brand && listedBrand
    ? ((options.brandNames ?? []).find((name) => listKey(name) === listKey(listedBrand)) ?? null)
    : null;
  const confidence = parseConfidence(row.confidence) ?? STICKER_READ_DEFAULT_CONFIDENCE;
  const brandConfidence = brand ? (parseConfidence(row.brandConfidence) ?? confidence) : null;
  const digits = typeof row.gtin === "string" || typeof row.gtin === "number" ? String(row.gtin).replace(/\D/g, "") : "";

  return {
    brand,
    brandListed,
    brandConfidence,
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
    const brandNames = listedBrandNames(input);
    const withCatalog = { ...input, finishCatalog };
    options?.onModelCall?.();
    const response = await requestAzureOpenAIChatCompletion(
      {
        buildPayload: (safePrompt) => buildStickerReadPayload(withCatalog, safePrompt),
        deploymentEnvKeys: STICKER_READ_DEPLOYMENT_ENV_KEYS,
        usageMetricPrefix: "sticker_read",
        logLabel: `sticker read (${input.surface ?? "unknown surface"}, ${closedSet ? `${input.shadeNames.length} listed` : "open"}${
          brandNames.length > 0 ? `, ${brandNames.length} brands` : ""
        })`,
      },
      { onLog: options?.onLog }
    );
    if (response.provider === "none" || response.content === null) return null;

    return {
      ...parseStickerRead(response.content, closedSet ? input.shadeNames : [], finishCatalog, {
        brandNames,
        givenBrand: input.brandName,
      }),
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
      // A listed brand is the catalog spelling of the printed one.
      const visionValue = key === "brand" ? (vision.brandListed ?? vision.brand) : vision[visionKey];
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
