import sharp from "sharp";
import {
  parseConfidence,
  parseDetectedFinishes,
  requestAzureOpenAIChatCompletion,
  loadDetectionFinishCatalog,
  type HexDetectionOptions,
  type HexDetectionTokenUsage,
  type VisionImageDetail,
} from "./ai-color-detection";
import { resolveAzureOpenAiConfig } from "./azure-openai-config";
import { finishNamesForPrompt, type FinishCatalog } from "./finishes";
import { mergeSimilarColors } from "./color-match";
import { extractDominantColors, type DominantColor } from "./dominant-color";

/**
 * Palette-pick hex detection.
 *
 * LLM vision models are good at semantics (which blob is the polish, which is
 * the cap) and bad at reading absolute color values (they answer in CSS named
 * colors). This splits the job: pixels measure, the model chooses.
 *
 *  1. `extractDominantColors` + `mergeSimilarColors` turn the product photo into
 *     8–12 perceptually distinct candidate colors.
 *  2. `renderPaletteComposite` draws the photo next to a strip of labeled solid
 *     chips (A, B, C, ...) of those candidates.
 *  3. Azure OpenAI is asked which chip best represents the base lacquer, and the
 *     letter is mapped back to the chip's *measured* hex.
 *
 * Everything except the network call is pure/deterministic and unit-tested.
 * Nothing here is wired into the ingestion write path yet.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface PaletteCandidate {
  /** Single-letter chip label (A, B, C, ...). */
  label: string;
  /** Measured `#RRGGBB`. */
  hex: string;
  /** Share of sampled pixels the merged bucket represents. */
  fraction: number;
}

export interface BuildPaletteCandidatesOptions {
  /** Prefer at least this many candidates when the image has that much variety. Default 8. */
  minCandidates?: number;
  /** Never return more than this many. Default 12 (one letter each). */
  maxCandidates?: number;
  /**
   * OKLAB merge distances tried in order (largest first) until at least
   * `minCandidates` survive. Default `[0.04, 0.025, 0.015]`.
   */
  mergeDistances?: readonly number[];
  /** Merged entries covering less than this share of the image are dropped. Default 0.002. */
  minFraction?: number;
}

export interface ChipRect {
  label: string;
  hex: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompositeLayout {
  width: number;
  height: number;
  photo: { x: number; y: number; width: number; height: number };
  chips: ChipRect[];
  chipSize: number;
  columns: number;
  rows: number;
}

export interface CompositeLayoutOptions {
  /** Already-scaled photo size. */
  photoWidth: number;
  photoHeight: number;
  candidates: readonly PaletteCandidate[];
  /** Gap between chips and between the photo and the strip. Default 12. */
  gap?: number;
  /** Outer padding. Default 16. */
  padding?: number;
  /** Chip size bounds; chips shrink to fit the photo height. Defaults 56–128. */
  minChipSize?: number;
  maxChipSize?: number;
  /** Chips per row in the strip; default 1 for up to 6 candidates, else 2. */
  columns?: number;
}

export interface RenderedComposite {
  bytes: Buffer;
  contentType: "image/png";
  dataUri: string;
  layout: CompositeLayout;
}

export interface ParsedPaletteChoice {
  /** Normalized letter the model answered with, or null when none could be read. */
  choice: string | null;
  /** The chosen chip's measured hex, or null when `choice` is missing or not a chip label. */
  hex: string | null;
  confidence: number | null;
  /** Raw `finishes` value from the response (canonicalized later, async). */
  finishesRaw: unknown;
  /** Why `hex` is null. */
  reason?: "unparseable" | "missing_choice" | "unknown_label";
}

export type PalettePickReason =
  | "missing_config"
  | "no_candidates"
  | "content_filtered"
  | "empty_response"
  | ParsedPaletteChoice["reason"];

export interface PalettePickResult {
  provider: "azure-openai" | "none";
  hex: string | null;
  confidence: number | null;
  finishes: string[] | null;
  /** Letter the model chose (may be set even when `hex` is null if it was not a valid label). */
  choice: string | null;
  candidates: PaletteCandidate[];
  /** Composite geometry, or null when no composite was built. */
  composite: Pick<CompositeLayout, "width" | "height" | "chipSize" | "columns" | "rows"> | null;
  /** PNG bytes of the composite when `includeCompositeBytes` was requested. */
  compositeBytes?: Buffer;
  usage: HexDetectionTokenUsage | null;
  rawContent: string | null;
  reason?: PalettePickReason;
}

export interface PalettePickOptions extends Pick<HexDetectionOptions, "onLog" | "finishCatalog"> {
  candidates?: BuildPaletteCandidatesOptions;
  /** Longest edge the photo is scaled to inside the composite. Default 512. */
  photoMaxSize?: number;
  /** Vision detail for the composite; defaults to `AZURE_OPENAI_VISION_DETAIL` or `low`. */
  imageDetail?: VisionImageDetail;
  /** Env keys consulted for the deployment name (defaults to the hex-detection keys). */
  deploymentEnvKeys?: string[];
  /** Return the composite PNG in the result (debugging / fixtures). */
  includeCompositeBytes?: boolean;
  /** `extractDominantColors` sample size. Default 96. */
  sampleSize?: number;
  /** `extractDominantColors` quantization bits. Default 4. */
  quantizeBits?: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const PALETTE_PICK_DEFAULTS = {
  minCandidates: 8,
  maxCandidates: 12,
  mergeDistances: [0.04, 0.025, 0.015] as readonly number[],
  minFraction: 0.002,
  /** Raw buckets pulled from the extractor before merging. */
  rawColors: 48,
  sampleSize: 96,
  quantizeBits: 4,
  photoMaxSize: 512,
  gap: 12,
  padding: 16,
  minChipSize: 56,
  maxChipSize: 128,
  background: "#F2F2F2",
  chipBorder: "#3A3A3A",
} as const;

export const CHIP_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const DEPLOYMENT_ENV_KEYS = ["AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT"];
const VISION_IMAGE_DETAILS: readonly VisionImageDetail[] = ["low", "high", "auto"];

// ── Candidates ───────────────────────────────────────────────────────────────

/**
 * Collapse raw dominant colors into a labeled, perceptually distinct palette.
 * Merge distance is loosened→tightened until at least `minCandidates` survive,
 * so a flat two-tone image yields two chips and a busy one yields twelve.
 */
export function buildPaletteCandidates(
  colors: readonly DominantColor[],
  options?: BuildPaletteCandidatesOptions
): PaletteCandidate[] {
  const maxCandidates = Math.max(
    1,
    Math.min(CHIP_LABELS.length, options?.maxCandidates ?? PALETTE_PICK_DEFAULTS.maxCandidates)
  );
  const minCandidates = Math.max(1, Math.min(maxCandidates, options?.minCandidates ?? PALETTE_PICK_DEFAULTS.minCandidates));
  const mergeDistances = options?.mergeDistances?.length ? options.mergeDistances : PALETTE_PICK_DEFAULTS.mergeDistances;
  const minFraction = options?.minFraction ?? PALETTE_PICK_DEFAULTS.minFraction;

  let merged: Array<{ hex: string; fraction: number }> = [];
  for (const mergeDistance of mergeDistances) {
    merged = mergeSimilarColors([...colors], { maxColors: maxCandidates, mergeDistance, minFraction });
    if (merged.length >= minCandidates) break;
  }

  return merged.map((color, index) => ({
    label: CHIP_LABELS[index],
    hex: color.hex,
    fraction: color.fraction,
  }));
}

/** Extract + merge in one step with the palette-pick sampling defaults. */
export async function extractPaletteCandidates(
  image: Buffer,
  options?: Pick<PalettePickOptions, "candidates" | "sampleSize" | "quantizeBits">
): Promise<PaletteCandidate[]> {
  const raw = await extractDominantColors(image, {
    maxColors: PALETTE_PICK_DEFAULTS.rawColors,
    sampleSize: options?.sampleSize ?? PALETTE_PICK_DEFAULTS.sampleSize,
    quantizeBits: options?.quantizeBits ?? PALETTE_PICK_DEFAULTS.quantizeBits,
  });
  return buildPaletteCandidates(raw, options?.candidates);
}

// ── Layout ───────────────────────────────────────────────────────────────────

/** Scale (never enlarge) a photo so its longest edge is at most `maxSize`. */
export function fitPhoto(width: number, height: number, maxSize: number): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const scale = Math.min(1, maxSize / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

/**
 * Place the photo at the left and a grid of chips at the right. Chips are laid
 * out row-major (A B / C D / ...), sized to fit the photo height when possible.
 * Pure: all geometry is derived from the inputs, so it can be asserted on.
 */
export function computeCompositeLayout(options: CompositeLayoutOptions): CompositeLayout {
  const gap = options.gap ?? PALETTE_PICK_DEFAULTS.gap;
  const padding = options.padding ?? PALETTE_PICK_DEFAULTS.padding;
  const minChip = options.minChipSize ?? PALETTE_PICK_DEFAULTS.minChipSize;
  const maxChip = Math.max(minChip, options.maxChipSize ?? PALETTE_PICK_DEFAULTS.maxChipSize);
  const photoWidth = Math.max(1, Math.round(options.photoWidth));
  const photoHeight = Math.max(1, Math.round(options.photoHeight));
  const count = options.candidates.length;

  const columns = Math.max(1, options.columns ?? (count <= 6 ? 1 : 2));
  const rows = Math.max(1, Math.ceil(count / columns));
  const fitted = Math.floor((photoHeight - (rows - 1) * gap) / rows);
  const chipSize = Math.max(minChip, Math.min(maxChip, fitted));

  const stripWidth = columns * chipSize + (columns - 1) * gap;
  const stripHeight = rows * chipSize + (rows - 1) * gap;
  const stripX = padding + photoWidth + gap * 2;
  const stripY = padding;

  const chips: ChipRect[] = options.candidates.map((candidate, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return {
      label: candidate.label,
      hex: candidate.hex,
      x: stripX + column * (chipSize + gap),
      y: stripY + row * (chipSize + gap),
      width: chipSize,
      height: chipSize,
    };
  });

  return {
    width: stripX + stripWidth + padding,
    height: Math.max(photoHeight, count > 0 ? stripHeight : 0) + padding * 2,
    photo: { x: padding, y: padding, width: photoWidth, height: photoHeight },
    chips,
    chipSize,
    columns,
    rows,
  };
}

/** Black on light chips, white on dark ones (WCAG relative luminance, sRGB). */
export function labelColorFor(hex: string): "#000000" | "#FFFFFF" {
  const value = Number.parseInt(hex.replace(/^#/, ""), 16);
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance =
    0.2126 * channel((value >> 16) & 0xff) + 0.7152 * channel((value >> 8) & 0xff) + 0.0722 * channel(value & 0xff);
  return luminance > 0.35 ? "#000000" : "#FFFFFF";
}

/** SVG for the background + chip strip (the photo is composited on top separately). */
export function buildCompositeSvg(layout: CompositeLayout): string {
  const fontSize = Math.round(layout.chipSize * 0.6);
  const stroke = Math.max(1, Math.round(layout.chipSize * 0.03));
  const chips = layout.chips
    .map((chip) => {
      const fill = labelColorFor(chip.hex);
      const outline = fill === "#000000" ? "#FFFFFF" : "#000000";
      const cx = chip.x + chip.width / 2;
      const cy = chip.y + chip.height / 2 + fontSize * 0.35;
      return (
        `<rect x="${chip.x}" y="${chip.y}" width="${chip.width}" height="${chip.height}" fill="${chip.hex}" ` +
        `stroke="${PALETTE_PICK_DEFAULTS.chipBorder}" stroke-width="2"/>` +
        `<text x="${cx}" y="${cy}" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="bold" ` +
        `text-anchor="middle" fill="${fill}" stroke="${outline}" stroke-width="${stroke}" paint-order="stroke" ` +
        `stroke-opacity="0.6">${chip.label}</text>`
      );
    })
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}">` +
    `<rect width="${layout.width}" height="${layout.height}" fill="${PALETTE_PICK_DEFAULTS.background}"/>` +
    chips +
    `</svg>`
  );
}

/** Scale the photo, draw the chip strip, and return the PNG composite plus its layout. */
export async function renderPaletteComposite(
  image: Buffer,
  candidates: readonly PaletteCandidate[],
  options?: Pick<PalettePickOptions, "photoMaxSize"> & Omit<CompositeLayoutOptions, "photoWidth" | "photoHeight" | "candidates">
): Promise<RenderedComposite> {
  const photoMaxSize = options?.photoMaxSize ?? PALETTE_PICK_DEFAULTS.photoMaxSize;
  const { data: photo, info } = await sharp(image)
    .rotate()
    .resize(photoMaxSize, photoMaxSize, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });

  const layout = computeCompositeLayout({
    photoWidth: info.width,
    photoHeight: info.height,
    candidates,
    ...(options?.gap !== undefined ? { gap: options.gap } : {}),
    ...(options?.padding !== undefined ? { padding: options.padding } : {}),
    ...(options?.minChipSize !== undefined ? { minChipSize: options.minChipSize } : {}),
    ...(options?.maxChipSize !== undefined ? { maxChipSize: options.maxChipSize } : {}),
    ...(options?.columns !== undefined ? { columns: options.columns } : {}),
  });

  const bytes = await sharp(Buffer.from(buildCompositeSvg(layout)))
    .composite([{ input: photo, left: layout.photo.x, top: layout.photo.y }])
    .png()
    .toBuffer();

  return {
    bytes,
    contentType: "image/png",
    dataUri: `data:image/png;base64,${bytes.toString("base64")}`,
    layout,
  };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function resolveImageDetail(override?: VisionImageDetail): VisionImageDetail {
  if (override) return override;
  const raw = process.env.AZURE_OPENAI_VISION_DETAIL?.trim().toLowerCase();
  return VISION_IMAGE_DETAILS.find((detail) => detail === raw) ?? "low";
}

export function buildPalettePickPayload(
  compositeDataUri: string,
  candidates: readonly PaletteCandidate[],
  safePrompt = false,
  imageDetail?: VisionImageDetail,
  finishCatalog?: FinishCatalog
): Record<string, unknown> {
  // Same source as the main vision prompt; the built-in finishes when no catalog is given.
  const finishList = finishNamesForPrompt(finishCatalog).join(", ");
  const letters = candidates.map((candidate) => candidate.label).join(", ");
  const image = { type: "image_url", image_url: { url: compositeDataUri, detail: resolveImageDetail(imageDetail) } };

  const systemPrompt = safePrompt
    ? `The image shows a nail polish product photo on the left and labeled solid color chips (${letters}) on the right. Pick the one chip that best matches the polish color. Respond with valid JSON only: {"choice":"<letter>","confidence":0..1,"finishes":["creme",...]}. Always include choice and confidence.`
    : `You identify the base lacquer color of a nail polish. The image shows the product photo on the left and a strip of labeled solid color chips (${letters}) on the right; each chip is a color measured from the photo. Choose the ONE chip whose color best represents the polish's base lacquer as it appears in the bottle or on the nail. Ignore the cap, brush, label text, packaging/box, background, props, shadows and glare. For glitter, shimmer, flake, holographic, duochrome or multichrome finishes, choose the chip matching the underlying base lacquer rather than sparkle particles or highlights. ALWAYS respond with valid JSON: {"choice":"<letter>","confidence":0..1,"finishes":["creme",...]}. "choice" must be exactly one of the chip letters.`;

  const userPrompt = safePrompt
    ? `Which chip (${letters}) best matches the polish color? Return JSON with choice, confidence and finishes.`
    : `Which labeled chip (${letters}) best represents this polish's base color? Also list the finishes visible or implied (${finishList}). If no chip is a good match, still pick the closest one and lower the confidence. Return JSON only.`;

  return {
    temperature: 0,
    max_tokens: 100,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: [{ type: "text", text: userPrompt }, image] },
    ],
  };
}

// ── Response parsing ─────────────────────────────────────────────────────────

/** First standalone letter in a value such as `"B"`, `"b."`, `"chip B"` or `"Option C"`. */
export function normalizeChoiceLabel(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= CHIP_LABELS.length) {
    // Tolerate 1-based numeric answers.
    return CHIP_LABELS[value - 1];
  }
  if (typeof value !== "string") return null;
  const tokens = value.toUpperCase().match(/[A-Z]+/g) ?? [];
  const single = tokens.find((token) => token.length === 1);
  return single ?? null;
}

/** Parse the model's JSON (tolerating junk) and map the chosen letter back to a measured hex. */
export function parsePaletteChoice(content: string, candidates: readonly PaletteCandidate[]): ParsedPaletteChoice {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(content) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }

  let choice: string | null;
  let confidence: number | null = null;
  let finishesRaw: unknown = null;
  if (parsed) {
    choice = normalizeChoiceLabel(parsed.choice ?? parsed.chip ?? parsed.label);
    confidence = parseConfidence(parsed.confidence);
    finishesRaw = parsed.finishes ?? null;
  } else {
    // Not JSON: look for `"choice": "X"` or a bare letter token.
    const match = content.match(/choice\s*"?\s*[:=]\s*"?\s*([A-Za-z])\b/i);
    choice = match ? match[1].toUpperCase() : null;
    if (!choice) {
      return { choice: null, hex: null, confidence: null, finishesRaw: null, reason: "unparseable" };
    }
  }

  if (!choice) {
    return { choice: null, hex: null, confidence, finishesRaw, reason: "missing_choice" };
  }

  const candidate = candidates.find((entry) => entry.label === choice);
  if (!candidate) {
    return { choice, hex: null, confidence, finishesRaw, reason: "unknown_label" };
  }
  return { choice, hex: candidate.hex, confidence, finishesRaw };
}

// ── End-to-end ───────────────────────────────────────────────────────────────

function compositeSummary(layout: CompositeLayout): NonNullable<PalettePickResult["composite"]> {
  return {
    width: layout.width,
    height: layout.height,
    chipSize: layout.chipSize,
    columns: layout.columns,
    rows: layout.rows,
  };
}

/**
 * Detect a polish's base hex from product image bytes by having Azure OpenAI
 * pick among measured candidate colors. Never returns a hex that was not
 * measured from the image.
 */
export async function detectHexByPalettePick(image: Buffer, options?: PalettePickOptions): Promise<PalettePickResult> {
  const deploymentEnvKeys = options?.deploymentEnvKeys ?? DEPLOYMENT_ENV_KEYS;
  const empty = (
    provider: PalettePickResult["provider"],
    reason: PalettePickReason,
    extra?: Partial<PalettePickResult>
  ): PalettePickResult => ({
    provider,
    hex: null,
    confidence: null,
    finishes: null,
    choice: null,
    candidates: [],
    composite: null,
    usage: null,
    rawContent: null,
    reason,
    ...extra,
  });

  // Fail fast before doing any image work when the model cannot be called.
  if (!resolveAzureOpenAiConfig({ deploymentEnvKeys }).isValid) {
    options?.onLog?.("error", "[palette-pick] Missing Azure OpenAI config");
    return empty("none", "missing_config");
  }

  const candidates = await extractPaletteCandidates(image, options);
  if (candidates.length === 0) {
    options?.onLog?.("warn", "[palette-pick] No candidate colors extracted from image");
    return empty("azure-openai", "no_candidates");
  }

  const composite = await renderPaletteComposite(image, candidates, {
    ...(options?.photoMaxSize !== undefined ? { photoMaxSize: options.photoMaxSize } : {}),
  });
  const base: Partial<PalettePickResult> = {
    candidates,
    composite: compositeSummary(composite.layout),
    ...(options?.includeCompositeBytes ? { compositeBytes: composite.bytes } : {}),
  };

  const finishCatalog = await loadDetectionFinishCatalog(options);
  const response = await requestAzureOpenAIChatCompletion(
    {
      buildPayload: (safePrompt) =>
        buildPalettePickPayload(composite.dataUri, candidates, safePrompt, options?.imageDetail, finishCatalog),
      deploymentEnvKeys,
      usageMetricPrefix: "hex_detection.palette_pick",
      logLabel: `palette-pick composite ${composite.layout.width}x${composite.layout.height} (${candidates.length} chips)`,
    },
    options
  );

  if (response.provider === "none") {
    return empty("none", "missing_config", base);
  }
  if (response.content === null) {
    return empty("azure-openai", response.reason ?? "empty_response", { ...base, usage: response.usage });
  }

  const parsed = parsePaletteChoice(response.content, candidates);
  const finishes = await parseDetectedFinishes(parsed.finishesRaw, options);
  if (!parsed.hex) {
    options?.onLog?.("warn", `[palette-pick] Could not map model choice to a chip (${parsed.reason}): ${response.content}`);
  }

  return {
    provider: "azure-openai",
    hex: parsed.hex,
    confidence: parsed.confidence,
    finishes,
    choice: parsed.choice,
    candidates,
    composite: compositeSummary(composite.layout),
    ...(options?.includeCompositeBytes ? { compositeBytes: composite.bytes } : {}),
    usage: response.usage,
    rawContent: response.content,
    ...(parsed.reason ? { reason: parsed.reason } : {}),
  };
}
