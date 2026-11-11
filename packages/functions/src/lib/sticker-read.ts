import type { BottleSurface } from "swatchwatch-shared";
import {
  loadDetectionFinishCatalog,
  parseConfidence,
  requestAzureOpenAIChatCompletion,
  type HexDetectionOptions,
  type VisionImageDetail,
} from "./ai-color-detection";
import { resolveAzureOpenAiConfig } from "./azure-openai-config";
import { normalizeGtin } from "./barcodes";
import { BRAND_SHADE_NAMES_CAP, CATALOG_BRAND_NAMES_CAP } from "./brand-resolve";
import { canonicalizeFinish, finishNamesForPrompt, type FinishCatalog } from "./finishes";
import type { OcrResult } from "./ocr";
import { nameLocation, parseNormalizedBox, type NameLocation, type NormalizedBox, type NormalizedRegion } from "./frame-region";

/**
 * Vision read of the bottom sticker (Bottle Flow slice A): a high-detail chat call that reads
 * the printed brand, shade name, finish and barcode digits straight from the photo. When the
 * brand is known the brand's shade names are a closed list the model can pick from, but the pick
 * is only evidence when an independent read agrees: the sticker is first read WITHOUT the list
 * (the printed name), and only when that name spells no listed name is a second, closed call
 * made for the pick, which counts (`closestListed`) when the printed name agrees with it and is
 * complete, else stays an unverified candidate (`unverifiedPick`). With the list in the prompt
 * the model reports its pick as the printed text (bottle eval 2026-11-10: 5 confident wrong
 * matches), so a pick alone never matches. Without a known brand the catalog's brand names are
 * listed so a script logo comes back as the catalog brand (`brandListed`), never picked without
 * a printed brand. It also runs when OCR is unusable. Best effort: a missing config, an empty
 * answer or a throw is `null`, and the frame keeps its OCR evidence.
 */

/**
 * Bump whenever the prompt text in `buildStickerReadPayload` changes.
 * v2 (2026-11): separate `brandConfidence`, the closed brand list (`brandListed`), and a note
 * that the sticker text may be rotated or sideways.
 * v3 (2026-11): the name transcribed letter by letter without the list, `nameComplete`, the
 * middle bottle only (never a background one), a shade may be missing from the list; high detail.
 * v4 (2026-11): the open name read also reports `bottleBox` (the held bottle) and `nameBox` (the
 * name it read), and a name off the held bottle is dropped (`nameLocation`); the front (brand
 * only) is read with the v2 wording again, which v3 had made misread script logos ("Starry").
 */
export const STICKER_READ_PROMPT_VERSION = "sticker-read/2026-11-v4";
/**
 * Image detail of every sticker read. Low detail (512 px) could not read most stickers (bottle
 * eval 2026-11-10: 19 bottles with no name read) and let the model fill the name from the list.
 */
export const STICKER_READ_IMAGE_DETAIL: VisionImageDetail = "high";
/**
 * The front is read for its brand only, at low detail: high detail made gpt-4o-mini misread the
 * logo or read other text as the brand (bottle eval 2026-11-10: 7 bottles lost their brand).
 */
export const STICKER_READ_FRONT_IMAGE_DETAIL: VisionImageDetail = "low";
/** Lowest `nameAgreement` of the printed name with the closed-set pick for the pick to count. */
export const STICKER_READ_PICK_MIN_AGREEMENT = 0.75;
/** A printed name that agrees this well with exactly one listed name is the pick, with no closed call. */
export const STICKER_READ_OWN_MATCH_MIN = 0.92;
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
/** The open name read also answers two boxes. */
const STICKER_READ_BOXES_MAX_TOKENS = 320;
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
  /** The outline the client showed (`quality.guideRegion`); a name read outside it is dropped. */
  guideRegion?: NormalizedRegion | null;
}

export interface StickerReadResult {
  /** The brand as printed; null when none, or when it only echoes the brand the prompt named. */
  brand: string | null;
  /** Exactly one of the listed catalog brand names (listed spelling), or null; never without a printed `brand`. */
  brandListed: string | null;
  /** Confidence of `brand`: the model's `brandConfidence`, else the read's overall confidence; null without a brand. */
  brandConfidence: number | null;
  /** The shade name as printed, from the read without the list (on a closed set). */
  printedName: string | null;
  /** The model's `nameComplete`: false when part of the name was cut off or hidden; null when not said. */
  nameComplete: boolean | null;
  /**
   * The verified pick: a listed name (listed spelling) the independently printed, complete name
   * agrees with (`nameAgreement` >= `STICKER_READ_PICK_MIN_AGREEMENT`); null otherwise.
   */
  closestListed: string | null;
  /** A listed name the closed call picked that the printed name did not verify: a candidate only. */
  unverifiedPick: string | null;
  /** True when `closestListed` is set, false when the pick stayed unverified, null on an open read. */
  pickVerified: boolean | null;
  /** `nameAgreement` of the printed name with the closed call's pick; null without both. */
  pickAgreement: number | null;
  /** Chat calls this read made (1, or 2 when the closed call ran). */
  modelCalls: number;
  /**
   * Where the open read says its printed name is (`nameLocation`); `off_bottle` / `off_guide`
   * mean the name was read off another object and dropped (`printedName` null). `unknown` when
   * the read reported no usable boxes (the name is kept).
   */
  nameLocation: NameLocation;
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

/** Whether a read of `surface` is the open name read that reports boxes (not the front, not a closed call). */
function asksForBoxes(surface: BottleSurface | null, closedSet: boolean): boolean {
  return surface !== "front" && !closedSet;
}

/**
 * The front is read for its brand only, with the v2 (2026-11) wording: v3's letter-by-letter
 * transcription made gpt-4o-mini read the Starrily script logo as "Starry" (bottle eval
 * 2026-11-10, samples 177 and 186).
 */
function buildFrontReadPrompts(
  input: StickerReadInput,
  safePrompt: boolean,
  brandNames: readonly string[],
  finishList: string
): { system: string; user: string } {
  const surfaceText = " The photo shows the front of the bottle.";
  const brandText = input.brandName ? ` The brand is ${input.brandName}.` : "";
  const shape = `{"printedName":"<shade name as printed or null>","closestListed":"<one listed name or null>","brand":"<brand as printed or null>","brandListed":"<one listed brand or null>","brandConfidence":0..1,"finish":"<finish or null>","gtin":"<barcode digits or null>","confidence":0..1}`;
  const rotation = "The text may be rotated or sideways; read it in any orientation.";
  const brandConfidenceText = "brandConfidence is how sure you are of the brand alone; confidence is for the whole read.";
  const system = safePrompt
    ? `You read the printed text on a nail polish bottle sticker in a photo.${surfaceText}${brandText} The list of shade names is unavailable. ${rotation} ${brandConfidenceText} Respond with valid JSON only: ${shape}.`
    : `You read the sticker printed on a nail polish bottle.${surfaceText}${brandText} The list of shade names is unavailable, so closestListed is always null. ${rotation} The shade name is never the brand, its website, the size or the maker's address. Report only what is printed; never guess. Use null for anything you cannot read. ${brandConfidenceText} ALWAYS respond with valid JSON: ${shape}.`;
  const brandListText = brandNames.length > 0
    ? `Listed brand names (one per line):\n${brandNames.join("\n")}\n\nbrand is the brand name or logo as printed (it may be a stylized or script logo). brandListed must be exactly one of the listed brand names, the one printed on the bottle, or null when the printed brand is none of them or no brand is printed; never pick a brand from the bottle's color or shape.`
    : "brandListed: null.";
  const user = `Read the sticker. closestListed: null.\n${brandListText}\nprintedName is the shade name as printed. finish is one of: ${finishList}. gtin is the barcode digits when visible. Return JSON only.`;
  return { system, user };
}

export function buildStickerReadPayload(input: StickerReadInput, safePrompt: boolean): Record<string, unknown> {
  const closedSet = isClosedSet(input.shadeNames);
  const brandNames = listedBrandNames(input);
  const finishList = finishNamesForPrompt(input.finishCatalog).join(", ");
  const imageDetail = input.imageDetail ?? (input.surface === "front" ? STICKER_READ_FRONT_IMAGE_DETAIL : STICKER_READ_IMAGE_DETAIL);
  const image = { type: "image_url", image_url: { url: input.imageDataUri, detail: imageDetail } };
  const payload = (system: string, user: string, maxTokens: number) => ({
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: [{ type: "text", text: user }, image] },
    ],
  });

  if (input.surface === "front" && !closedSet) {
    const front = buildFrontReadPrompts(input, safePrompt, brandNames, finishList);
    return payload(front.system, front.user, STICKER_READ_MAX_TOKENS);
  }

  const boxes = asksForBoxes(input.surface, closedSet);
  const surfaceText = input.surface ? ` The photo shows the ${input.surface} of the bottle.` : "";
  const brandText = input.brandName ? ` The brand is ${input.brandName}.` : "";
  const boxShape = boxes ? `,"bottleBox":[left,top,right,bottom],"nameBox":[left,top,right,bottom] or null` : "";
  const shape = `{"printedName":"<shade name letters as printed, or null>","nameComplete":true|false,"closestListed":"<one listed name or null>","brand":"<brand as printed or null>","brandListed":"<one listed brand or null>","brandConfidence":0..1,"finish":"<finish or null>","gtin":"<barcode digits or null>","confidence":0..1${boxShape}}`;
  const rotation = "The text may be rotated, sideways or upside down; read it in any orientation.";
  const brandConfidenceText = "brandConfidence is how sure you are of the brand alone; confidence is for the whole read.";
  const completeText = "nameComplete is false when part of the shade name is cut off, covered or outside the photo.";
  const missingText = "The bottle's shade may be missing from the list: when the printed letters spell no listed name, closestListed is null.";
  const boxText = boxes
    ? " Also report where things are, as [left,top,right,bottom] fractions (0 to 1) of the photo's width and height: bottleBox is the tight box around the bottle (or box) held up in the middle, closest to the camera; nameBox is the tight box around the printedName text you read (null without one)."
    : "";

  const systemPrompt = safePrompt
    ? `You read the printed text on a nail polish bottle sticker in a photo.${surfaceText}${brandText} ${
        closedSet ? `A list of shade names is provided. ${missingText}` : "The list of shade names is unavailable."
      } ${rotation} ${completeText} ${brandConfidenceText}${boxText} Respond with valid JSON only: ${shape}.`
    : `You transcribe the sticker printed on a nail polish bottle.${surfaceText}${brandText} ${rotation} Read only the bottle (or box) held up in the middle of the photo: other bottles, boxes, cards or screens in the background are different products, so never read a name from them. The shade name is never the brand, its website, the size, a lot or batch code, or the maker's address. printedName is the shade name transcribed from the photo alone, letter by letter, as printed${
        closedSet ? ", never copied from the list" : ""
      }; when part of it is cut off, covered or outside the photo, write only the letters you can see and set nameComplete to false. ${
        closedSet
          ? `closestListed is the listed name that printedName spells (ignoring case, spacing and punctuation). ${missingText} Never pick a listed name that only shares a word or looks similar.`
          : "The list of shade names is unavailable, so closestListed is always null."
      } Report only what is printed; never guess. Use null for anything you cannot read. ${brandConfidenceText}${boxText} ALWAYS respond with valid JSON: ${shape}.`;

  const listText = closedSet
    ? `Listed shade names (one per line):\n${input.shadeNames.join("\n")}\n\nclosestListed must be exactly one of the listed names, the one the printed shade name spells, or null when it spells none.`
    : "closestListed: null.";
  const brandListText = brandNames.length > 0
    ? `Listed brand names (one per line):\n${brandNames.join("\n")}\n\nbrand is the brand name or logo as printed (it may be a stylized or script logo). brandListed must be exactly one of the listed brand names, the one printed on the bottle, or null when the printed brand is none of them or no brand is printed; never pick a brand from the bottle's color or shape.`
    : "brandListed: null.";
  const userPrompt = `Read the sticker. ${listText}\n${brandListText}\nprintedName is the shade name as printed. finish is one of: ${finishList}. gtin is the barcode digits when visible.${
    boxes ? " bottleBox and nameBox are where the held bottle and the printed name are." : ""
  } Return JSON only.`;

  return payload(systemPrompt, userPrompt, boxes ? STICKER_READ_BOXES_MAX_TOKENS : STICKER_READ_MAX_TOKENS);
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

/** Shortest brand key (letters and digits) a misspelled logo read may be mapped from. */
export const BRAND_NEAR_SPELLING_MIN_LENGTH = 6;
/** Most letter edits between a printed brand and the one listed brand it is mapped to. */
export const BRAND_NEAR_SPELLING_MAX_EDITS = 2;

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * The one listed brand a printed brand misspells: a script logo read a letter or two off
 * ("Starry", "Starrity", "Starrrly" for Starrily; bottle eval 2026-11-10) when the model left
 * `brandListed` empty. Both keys (letters and digits) at least `BRAND_NEAR_SPELLING_MIN_LENGTH`
 * long, at most `BRAND_NEAR_SPELLING_MAX_EDITS` edits apart, and no other listed brand within
 * one edit more; else null.
 */
export function nearestListedBrand(printed: string, brandNames: readonly string[]): string | null {
  const key = brandKey(printed);
  if (key.length < BRAND_NEAR_SPELLING_MIN_LENGTH) return null;
  let best: string | null = null;
  let bestDistance = Infinity;
  let runnerUp = Infinity;
  for (const name of brandNames) {
    const other = brandKey(name);
    if (other.length < BRAND_NEAR_SPELLING_MIN_LENGTH) continue;
    const distance = editDistance(key, other);
    if (distance < bestDistance) {
      runnerUp = bestDistance;
      best = name;
      bestDistance = distance;
    } else if (distance < runnerUp) {
      runnerUp = distance;
    }
  }
  if (best === null || bestDistance > BRAND_NEAR_SPELLING_MAX_EDITS || runnerUp <= bestDistance + 1) return null;
  return best;
}

export interface ParseStickerReadOptions {
  /** The listed catalog brand names `brandListed` must be one of (none = no pick). */
  brandNames?: readonly string[];
  /** The brand the prompt named: the model repeating it back is no evidence, so `brand` is null. */
  givenBrand?: string | null;
}

/** One answer parsed: `closestListed` here is the model's pick (one of the listed names), unverified. */
export type ParsedStickerRead = Pick<
  StickerReadResult,
  "brand" | "brandListed" | "brandConfidence" | "printedName" | "nameComplete" | "closestListed" | "finish" | "gtin" | "confidence"
> & {
  /** The held bottle as the read located it, or null when not reported / not a valid 0–1 box. */
  bottleBox: NormalizedBox | null;
  /** The printed name as the read located it, or null. */
  nameBox: NormalizedBox | null;
};

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true") return true;
    if (text === "false") return false;
  }
  return null;
}

/** Words as pg_trgm sees them: lowercase letters and decimal digits ("²" is no digit), with "&" read as "and". */
function trigramWords(value: string): string[] {
  return value.toLowerCase().replace(/&/g, " and ").split(/[^\p{L}\p{Nd}]+/u).filter((word) => word.length > 0);
}

function trigrams(value: string): Set<string> {
  const set = new Set<string>();
  for (const word of trigramWords(value)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) set.add(padded.slice(i, i + 3));
  }
  return set;
}

/**
 * pg_trgm `similarity()` in JS (shared trigrams over all trigrams of both names; each word padded
 * with two spaces in front and one behind), with "&" read as "and" so "Sip Back And Relax" spells
 * "Sip Back & Relax". 0 when either side has no letters or digits.
 */
export function nameAgreement(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function parseStickerRead(
  content: string,
  shadeNames: readonly string[],
  finishCatalog?: FinishCatalog,
  options: ParseStickerReadOptions = {}
): ParsedStickerRead {
  const row = parseJsonObject(content);
  if (!row) {
    return {
      brand: null,
      brandListed: null,
      brandConfidence: null,
      printedName: null,
      nameComplete: null,
      closestListed: null,
      finish: null,
      gtin: null,
      confidence: 0,
      bottleBox: null,
      nameBox: null,
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
  const listedPick = brand && listedBrand
    ? ((options.brandNames ?? []).find((name) => listKey(name) === listKey(listedBrand)) ?? null)
    : null;
  // A printed brand that misspells exactly one listed brand is that brand (a script logo read off).
  const brandListed = listedPick ?? (brand ? nearestListedBrand(brand, options.brandNames ?? []) : null);
  const confidence = parseConfidence(row.confidence) ?? STICKER_READ_DEFAULT_CONFIDENCE;
  const brandConfidence = brand ? (parseConfidence(row.brandConfidence) ?? confidence) : null;
  const digits = typeof row.gtin === "string" || typeof row.gtin === "number" ? String(row.gtin).replace(/\D/g, "") : "";

  return {
    brand,
    brandListed,
    brandConfidence,
    printedName,
    nameComplete: parseBoolean(row.nameComplete),
    closestListed,
    finish: canonicalizeFinish(row.finish, finishCatalog),
    gtin: GTIN_PATTERN.test(digits) ? digits : null,
    confidence,
    bottleBox: parseNormalizedBox(row.bottleBox),
    nameBox: parseNormalizedBox(row.nameBox),
  };
}

// ── The call ─────────────────────────────────────────────────────────────────

export interface ReadStickerOptions {
  onLog?: HexDetectionOptions["onLog"];
  /** Called right before the chat request is sent, so the caller can audit the model call. */
  onModelCall?: () => void;
}

function withoutBoxes(parsed: ParsedStickerRead): Omit<ParsedStickerRead, "bottleBox" | "nameBox"> {
  const { bottleBox: _bottleBox, nameBox: _nameBox, ...rest } = parsed;
  return rest;
}

/**
 * A name's letters and digits only, compatibility-normalized and lowercase, "&" read as "and":
 * "MOON FLOWER" = "Moonflower", "E = mc²" = "E=mc^2", "Degen eration" = "Degeneration".
 */
export function compactNameKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{Nd}]+/gu, "");
}

/**
 * The listed name a printed name spells, else null: the one listed name with the same
 * `compactNameKey` (the same letters in the same order, only spacing, case or punctuation
 * differ; two listed names with that key = none), else the best `nameAgreement` >=
 * `STICKER_READ_OWN_MATCH_MIN` when unique.
 */
function listedNameSpelled(printedName: string | null, shadeNames: readonly string[]): string | null {
  if (!printedName) return null;
  const key = compactNameKey(printedName);
  if (key.length > 0) {
    const same = shadeNames.filter((name) => compactNameKey(name) === key);
    if (same.length === 1) return same[0];
    if (same.length > 1) return null;
  }
  let best: string | null = null;
  let bestScore = 0;
  let tie = false;
  for (const name of shadeNames) {
    const score = nameAgreement(printedName, name);
    if (score > bestScore) {
      best = name;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && best !== null) {
      tie = true;
    }
  }
  return best !== null && !tie && bestScore >= STICKER_READ_OWN_MATCH_MIN ? best : null;
}

/**
 * Read the sticker; null when config is missing, every call came back empty, or a call throws
 * (logged). Without a closed set: one call. With one: the open call (no list) first; a complete
 * printed name that spells a listed name is the verified pick; otherwise the closed call asks for
 * the pick, which is verified only when the open read's complete printed name agrees with it
 * (>= `STICKER_READ_PICK_MIN_AGREEMENT`). The printed name and the other fields come from the
 * open read (the closed read's printed name may be its pick echoed back), the closed read's
 * fields only fill what the open read lacks, except the brand, which comes from the closed read
 * only (none when no closed call was made). A printed name the open read located off the held
 * bottle (or outside the client's outline, `nameLocation`) is dropped before any of this, so it
 * can neither spell nor verify a pick.
 */
export async function readStickerWithVision(
  input: StickerReadInput,
  options?: ReadStickerOptions
): Promise<StickerReadResult | null> {
  if (!resolveAzureOpenAiConfig({ deploymentEnvKeys: STICKER_READ_DEPLOYMENT_ENV_KEYS }).isValid) return null;

  try {
    const finishCatalog = input.finishCatalog ?? (await loadDetectionFinishCatalog(options));
    const closedSet = isClosedSet(input.shadeNames);
    const brandNames = listedBrandNames(input);
    let modelCalls = 0;
    const call = async (shadeNames: readonly string[]): Promise<{ parsed: ParsedStickerRead; content: string } | null> => {
      const listed = isClosedSet(shadeNames);
      const withCatalog = { ...input, shadeNames, finishCatalog };
      modelCalls += 1;
      options?.onModelCall?.();
      const response = await requestAzureOpenAIChatCompletion(
        {
          buildPayload: (safePrompt) => buildStickerReadPayload(withCatalog, safePrompt),
          deploymentEnvKeys: STICKER_READ_DEPLOYMENT_ENV_KEYS,
          usageMetricPrefix: "sticker_read",
          logLabel: `sticker read (${input.surface ?? "unknown surface"}, ${listed ? `${shadeNames.length} listed` : "open"}${
            brandNames.length > 0 ? `, ${brandNames.length} brands` : ""
          })`,
        },
        { onLog: options?.onLog }
      );
      if (response.provider === "none" || response.content === null) return null;
      return {
        parsed: parseStickerRead(response.content, listed ? shadeNames : [], finishCatalog, { brandNames, givenBrand: input.brandName }),
        content: response.content,
      };
    };
    const base = { promptVersion: STICKER_READ_PROMPT_VERSION, closedSet };

    const rawOpen = await call([]);
    const location: NameLocation = rawOpen
      ? nameLocation({ bottleBox: rawOpen.parsed.bottleBox, nameBox: rawOpen.parsed.nameBox, guideRegion: input.guideRegion })
      : "unknown";
    // A name read off another object (a bottle behind the held one) is no evidence about this bottle.
    const offBottle = location === "off_bottle" || location === "off_guide";
    if (rawOpen && offBottle) {
      options?.onLog?.("info", `[sticker-read] Printed name dropped: ${location}`);
    }
    const open = rawOpen && offBottle
      ? { ...rawOpen, parsed: { ...rawOpen.parsed, printedName: null, nameComplete: null } }
      : rawOpen;
    if (!closedSet) {
      if (!open) return null;
      return {
        ...withoutBoxes(open.parsed),
        nameLocation: location,
        closestListed: null,
        unverifiedPick: null,
        pickVerified: null,
        pickAgreement: null,
        modelCalls,
        ...base,
        rawContent: open.content,
      };
    }

    const printedName = open?.parsed.printedName ?? null;
    const complete = open?.parsed.nameComplete !== false;
    const spelled = complete ? listedNameSpelled(printedName, input.shadeNames) : null;
    // A read told the brand takes its brand from the closed read only: without the list the model
    // reported other sticker text as the brand ("Holographic"), replacing the front's brand.
    const noBrand = { brand: null, brandListed: null, brandConfidence: null };
    if (open && spelled) {
      return {
        ...withoutBoxes(open.parsed),
        nameLocation: location,
        ...noBrand,
        closestListed: spelled,
        unverifiedPick: null,
        pickVerified: true,
        pickAgreement: nameAgreement(printedName ?? "", spelled),
        modelCalls,
        ...base,
        rawContent: open.content,
      };
    }

    const closed = await call(input.shadeNames);
    if (!open && !closed) return null;
    const pick = closed?.parsed.closestListed ?? null;
    const pickAgreement = pick && printedName ? nameAgreement(printedName, pick) : null;
    const verified = Boolean(open && pick && complete && pickAgreement !== null && pickAgreement >= STICKER_READ_PICK_MIN_AGREEMENT);
    const first = open?.parsed;
    const second = closed?.parsed;
    return {
      brand: second?.brand ?? null,
      brandListed: second?.brandListed ?? null,
      brandConfidence: second?.brandConfidence ?? null,
      printedName,
      nameComplete: open ? open.parsed.nameComplete : null,
      closestListed: verified ? pick : null,
      unverifiedPick: verified ? null : pick,
      pickVerified: pick ? verified : false,
      pickAgreement,
      finish: first?.finish ?? second?.finish ?? null,
      gtin: first?.gtin ?? second?.gtin ?? null,
      confidence: first?.confidence ?? second?.confidence ?? 0,
      nameLocation: location,
      modelCalls,
      ...base,
      rawContent: JSON.stringify({ open: open?.content ?? null, closed: closed?.content ?? null }),
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
 * (the verified pick) and `shadeNamePick` (an unverified one, a candidate only) exist only in the
 * vision read and are always copied; `shadeNameComplete: false` marks a vision-won name the model
 * saw only in part;
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
    if (vision.unverifiedPick) {
      extracted.shadeNamePick = vision.unverifiedPick;
      sources.shadeNamePick = "vision";
    }
    if (sources.shadeName === "vision" && vision.nameComplete === false) {
      extracted.shadeNameComplete = false;
      sources.shadeNameComplete = "vision";
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
