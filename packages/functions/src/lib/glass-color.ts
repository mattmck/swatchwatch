import sharp from "sharp";
import { hexToOklab, oklabDistance } from "swatchwatch-shared";
import {
  loadDetectionFinishCatalog,
  requestAzureOpenAIChatCompletion,
  resolveVisionImageDetail,
  type HexDetectionOptions,
  type VisionImageDetail,
} from "./ai-color-detection";
import { resolveAzureOpenAiConfig } from "./azure-openai-config";
import { finishNamesForPrompt, type FinishCatalog } from "./finishes";
import {
  extractPaletteCandidates,
  parsePaletteChoice,
  renderPaletteComposite,
  type PaletteCandidate,
} from "./palette-pick-detection";

/**
 * Glass color evidence (Bottle Flow slice A): the lacquer hex measured from a hand-held bottle
 * frame. Pixels measure, the model chooses (the palette-pick split): chips are measured from the
 * frame, one low-detail vision call picks the chip that is the lacquer seen through the glass,
 * and a deterministic skin/grey-avoiding rule picks when the model is unconfigured, declines,
 * answers a letter that is not a chip, or throws. The result is always a measured hex, never
 * one the model wrote.
 */

export const GLASS_HEX_METHOD_PALETTE_PICK = "palette-pick-bottle";
export const GLASS_HEX_METHOD_FALLBACK = "palette-top";
export const GLASS_HEX_FALLBACK_CONFIDENCE = 0.3;
/** Bump whenever the prompt text in `buildGlassPalettePayload` changes. */
export const GLASS_PROMPT_VERSION = "glass-palette-pick/2026-10-v1";
/** The fallback only considers the largest chips: the lacquer fills a lot of the frame. */
export const GLASS_FALLBACK_TOP_BY_AREA = 3;
/** Skin-tone references (light to dark); a chip near one is probably the hand, not the lacquer. */
export const SKIN_TONE_REFERENCE_HEXES: readonly string[] = [
  "#FFDFC4",
  "#F0C8A0",
  "#D9A077",
  "#B07B52",
  "#8D5524",
  "#5C3A1E",
];

/** Frames with a shorter edge than this cannot show a bottle; nothing is measured. */
const GLASS_MIN_IMAGE_EDGE_PX = 8;
/** Confidence used when the model picks a valid chip but gives none. */
const GLASS_DEFAULT_MODEL_CONFIDENCE = 0.5;
const DEPLOYMENT_ENV_KEYS = ["AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT"];
const HEX_PATTERN = /^#[0-9A-F]{6}$/;

export interface GlassHexAudit {
  candidates: PaletteCandidate[];
  /** The letter the model answered (may not be a chip), or null when it did not answer. */
  choice: string | null;
  modelCalls: 0 | 1;
  /** Why the deterministic fallback was used, or why nothing was measured. */
  reason?: string;
}

export interface GlassHexResult {
  hex: string;
  confidence: number;
  method: typeof GLASS_HEX_METHOD_PALETTE_PICK | typeof GLASS_HEX_METHOD_FALLBACK;
  promptVersion: string;
  audit: GlassHexAudit;
}

// ── Deterministic fallback ───────────────────────────────────────────────────

function fallbackScore(hex: string): number {
  const lab = hexToOklab(hex);
  const skinDistance = Math.min(...SKIN_TONE_REFERENCE_HEXES.map((skin) => oklabDistance(lab, hexToOklab(skin))));
  return Math.min(skinDistance, Math.sqrt(lab.a ** 2 + lab.b ** 2));
}

/**
 * Among the top `GLASS_FALLBACK_TOP_BY_AREA` chips by fraction, the one farthest from both skin
 * tones and grey (the smaller of its distance to the nearest skin reference and its OKLAB
 * chroma). Ties go to the larger fraction, then the earlier label. Null without candidates.
 */
export function pickFallbackChip(candidates: readonly PaletteCandidate[]): PaletteCandidate | null {
  const byArea = [...candidates].sort((a, b) => b.fraction - a.fraction || a.label.localeCompare(b.label));
  let best: PaletteCandidate | null = null;
  let bestScore = -Infinity;
  for (const candidate of byArea.slice(0, GLASS_FALLBACK_TOP_BY_AREA)) {
    const score = fallbackScore(candidate.hex);
    // byArea is already in tie-break order, so a strictly greater score is the only way to win.
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export function buildGlassPalettePayload(
  compositeDataUri: string,
  candidates: readonly PaletteCandidate[],
  safePrompt: boolean,
  imageDetail: VisionImageDetail,
  finishCatalog?: FinishCatalog
): Record<string, unknown> {
  const finishList = finishNamesForPrompt(finishCatalog).join(", ");
  const letters = candidates.map((candidate) => candidate.label).join(", ");
  const image = { type: "image_url", image_url: { url: compositeDataUri, detail: imageDetail } };

  const systemPrompt = safePrompt
    ? `The image shows a photo of a hand holding a nail polish bottle on the left and labeled solid color chips (${letters}) on the right. Pick the one chip that matches the polish seen through the glass. Respond with valid JSON only: {"choice":"<letter>","confidence":0..1,"finishes":["creme",...]}. Always include choice and confidence.`
    : `You identify the lacquer color of a nail polish bottle. The image shows a photo of a hand holding a nail polish bottle on the left and a strip of labeled solid color chips (${letters}) on the right; each chip is a color measured from the photo. Choose the ONE chip that is the lacquer seen through the glass of the bottle. Never choose the cap, the label, the hand, skin, nails, the background or glare and reflections on the glass. For glitter, shimmer, flake, holographic, duochrome or multichrome finishes, choose the chip matching the underlying lacquer rather than sparkle particles or highlights. ALWAYS respond with valid JSON: {"choice":"<letter>","confidence":0..1,"finishes":["creme",...]}. "choice" must be exactly one of the chip letters.`;

  const userPrompt = safePrompt
    ? `Which chip (${letters}) matches the polish in the bottle? Return JSON with choice, confidence and finishes.`
    : `Which labeled chip (${letters}) is the lacquer inside the bottle? Also list the finishes visible or implied (${finishList}). If no chip is a good match, still pick the closest one and lower the confidence. Return JSON only.`;

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

// ── Measurement ──────────────────────────────────────────────────────────────

export interface MeasureGlassHexOptions {
  finishCatalog?: FinishCatalog;
  imageDetail?: VisionImageDetail;
  onLog?: HexDetectionOptions["onLog"];
  deploymentEnvKeys?: string[];
}

interface ModelPick {
  hex: string;
  confidence: number;
  choice: string;
}

/** Normalizes chip hexes to uppercase `#RRGGBB` and drops anything else. */
function validCandidates(candidates: readonly PaletteCandidate[]): PaletteCandidate[] {
  return candidates
    .map((candidate) => ({ ...candidate, hex: candidate.hex.trim().toUpperCase() }))
    .filter((candidate) => HEX_PATTERN.test(candidate.hex));
}

/**
 * Measure the lacquer hex of a glass frame: palette chips from the pixels (palette-pick
 * defaults), the model's pick when it is configured and answers a valid chip, else
 * `pickFallbackChip`. Null only when no chips could be measured. Never throws; at most one
 * model call.
 */
export async function measureGlassHex(
  image: Buffer,
  options?: MeasureGlassHexOptions
): Promise<GlassHexResult | null> {
  const deploymentEnvKeys = options?.deploymentEnvKeys ?? DEPLOYMENT_ENV_KEYS;

  let candidates: PaletteCandidate[];
  try {
    const metadata = await sharp(image).metadata();
    if (Math.min(metadata.width ?? 0, metadata.height ?? 0) < GLASS_MIN_IMAGE_EDGE_PX) {
      options?.onLog?.("warn", "[glass-color] Frame too small to measure");
      return null;
    }
    candidates = validCandidates(await extractPaletteCandidates(image));
  } catch (error) {
    options?.onLog?.("warn", `[glass-color] Could not measure frame: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (candidates.length === 0) return null;

  const audit: GlassHexAudit = { candidates, choice: null, modelCalls: 0 };
  let pick: ModelPick | null = null;

  if (!resolveAzureOpenAiConfig({ deploymentEnvKeys }).isValid) {
    audit.reason = "missing_config";
  } else {
    try {
      const composite = await renderPaletteComposite(image, candidates);
      const finishCatalog = await loadDetectionFinishCatalog(options);
      const imageDetail = options?.imageDetail ?? resolveVisionImageDetail();
      audit.modelCalls = 1;
      const response = await requestAzureOpenAIChatCompletion(
        {
          buildPayload: (safePrompt) =>
            buildGlassPalettePayload(composite.dataUri, candidates, safePrompt, imageDetail, finishCatalog),
          deploymentEnvKeys,
          usageMetricPrefix: "glass_color.palette_pick",
          logLabel: `glass-color composite ${composite.layout.width}x${composite.layout.height} (${candidates.length} chips)`,
        },
        { onLog: options?.onLog }
      );
      // `none` means the call was never made (configuration vanished between check and call).
      if (response.provider === "none") audit.modelCalls = 0;
      if (response.content === null) {
        audit.reason = response.reason ?? "empty_response";
      } else {
        const parsed = parsePaletteChoice(response.content, candidates);
        audit.choice = parsed.choice;
        if (parsed.hex && parsed.choice) {
          pick = { hex: parsed.hex.toUpperCase(), confidence: parsed.confidence ?? GLASS_DEFAULT_MODEL_CONFIDENCE, choice: parsed.choice };
        } else {
          audit.reason = parsed.reason ?? "unparseable";
        }
      }
    } catch (error) {
      audit.reason = "model_error";
      options?.onLog?.("warn", `[glass-color] Model pick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (pick) {
    return {
      hex: pick.hex,
      confidence: pick.confidence,
      method: GLASS_HEX_METHOD_PALETTE_PICK,
      promptVersion: GLASS_PROMPT_VERSION,
      audit,
    };
  }

  const fallback = pickFallbackChip(candidates);
  if (!fallback) return null;
  return {
    hex: fallback.hex,
    confidence: GLASS_HEX_FALLBACK_CONFIDENCE,
    method: GLASS_HEX_METHOD_FALLBACK,
    promptVersion: GLASS_PROMPT_VERSION,
    audit,
  };
}
