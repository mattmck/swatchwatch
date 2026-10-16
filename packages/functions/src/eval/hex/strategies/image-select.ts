import { detectHexWithAzureOpenAI, type HexDetectionOptions } from "../../../lib/ai-color-detection";
import { resolveAzureOpenAiConfig } from "../../../lib/azure-openai-config";
import { rankImagesForColorDetection, type RankedImage } from "../../../lib/image-selection";
import type { CaseImage, HexDetectionStrategy, StrategyInput, StrategyOutput } from "../types";

/**
 * Image-selection strategies: pick which product photo to analyze, then run
 * the production detection call (`detectHexWithAzureOpenAI`, no vendor context)
 * on it, so the score difference against `azure-blind` is the effect of the
 * image choice alone.
 *
 * - `image-select`: alt-text / filename ranking only (no extra AI call).
 * - `image-select-ai`: the same ranking, plus one cheap vision call asking which
 *   image shows painted nails when no image has alt text.
 *
 * Cases without an `images` list fall back to the case image, i.e. behave like `azure-blind`.
 */

const AZURE_DEPLOYMENT_ENV_KEYS = ["AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT"];
const OPENAI_API_VERSION = "2024-05-01-preview";
/** Upper bound on images sent to the swatch-pick call (Shopify PDPs rarely exceed this). */
const MAX_SWATCH_PICK_IMAGES = 8;

const quietLog: HexDetectionOptions["onLog"] = () => undefined;

export type CaseImageChoiceSource = "case-image" | "ranked" | "primary" | "ai-pick";

export interface CaseImageChoice {
  source: CaseImageChoiceSource;
  /** Index into `evalCase.images`, or null when the case image was used. */
  index: number | null;
  url: string | null;
  /** True when alt text (not just a filename) pointed at an on-nail photo. */
  confident: boolean;
  reason: string;
  /** Ranking summary for the results JSON. */
  ranking: Array<Pick<RankedImage, "index" | "url" | "alt" | "position" | "score" | "confident" | "reason">>;
  load(): Promise<CaseImage>;
}

/**
 * Choose the image to analyze from the ranking alone. Pure apart from the lazy
 * `load`. Unlike production (which only trusts alt text), the eval follows any
 * positive score, filename hints included, and records `confident` so the
 * report can separate alt-text picks from filename picks.
 */
export function chooseCaseImage(input: StrategyInput): CaseImageChoice {
  const candidates = input.images ?? [];
  const caseImageChoice = (source: CaseImageChoiceSource, reason: string, ranking: CaseImageChoice["ranking"] = []): CaseImageChoice => ({
    source,
    index: null,
    url: input.image.sourceUrl ?? input.evalCase.imageUrl ?? null,
    confident: false,
    reason,
    ranking,
    load: async () => input.image,
  });

  if (!candidates.length) {
    return caseImageChoice("case-image", "case has no images list; using the case image");
  }

  const ranked = rankImagesForColorDetection(candidates.map((c) => ({ url: c.url, alt: c.alt, position: c.position })));
  const ranking = ranked.map(({ index, url, alt, position, score, confident, reason }) => ({ index, url, alt, position, score, confident, reason }));
  const top = ranked[0];
  if (!top || top.score <= 0) {
    return caseImageChoice(
      "primary",
      top ? `no positive ranking signal (best: ${top.reason}); using the case image` : "no usable images; using the case image",
      ranking
    );
  }

  const candidate = candidates[top.index];
  return {
    source: "ranked",
    index: top.index,
    url: top.url,
    confident: top.confident,
    reason: `image #${top.position ?? top.index + 1} ranked best (${top.reason})`,
    ranking,
    load: () => candidate.load(),
  };
}

/** Parse the swatch-pick model reply (`{"index": n, "confidence": c}`). Pure. */
export function parseSwatchPickResponse(content: string, imageCount: number): { index: number | null; confidence: number | null } {
  const none = { index: null, confidence: null };
  const text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return none;
  }
  if (!parsed || typeof parsed !== "object") return none;
  const row = parsed as Record<string, unknown>;
  const index = row.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= imageCount) return none;
  const confidence = typeof row.confidence === "number" && Number.isFinite(row.confidence)
    ? Math.min(1, Math.max(0, row.confidence))
    : null;
  return { index, confidence };
}

/** One low-detail vision call: which of these images shows the polish painted on nails? */
async function askModelForSwatchIndex(images: CaseImage[]): Promise<{ index: number | null; confidence: number | null; usage: unknown }> {
  const config = resolveAzureOpenAiConfig({ deploymentEnvKeys: AZURE_DEPLOYMENT_ENV_KEYS });
  if (!config.isValid || !config.endpoint || !config.deployment) {
    throw new Error("Azure OpenAI config missing");
  }
  const url = `${config.endpoint}/openai/deployments/${config.deployment}/chat/completions?api-version=${OPENAI_API_VERSION}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...config.headers },
    body: JSON.stringify({
      temperature: 0,
      max_tokens: 40,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You are shown numbered product photos of one nail polish. Pick the photo that best shows the polish painted on fingernails (a swatch or close-up of nails), not a bottle, box, brush or lifestyle shot. Reply with JSON only: {"index": <0-based photo number>, "confidence": 0..1}.',
        },
        {
          role: "user",
          content: images.flatMap((image, i) => [
            { type: "text", text: `Photo ${i}:` },
            { type: "image_url", image_url: { url: image.dataUri, detail: "low" } },
          ]),
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Azure OpenAI swatch pick failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }>; usage?: unknown };
  const content = body.choices?.[0]?.message?.content ?? "";
  return { ...parseSwatchPickResponse(content, images.length), usage: body.usage ?? null };
}

async function detectOn(image: CaseImage): Promise<Pick<StrategyOutput, "hex" | "confidence" | "finishes"> & { usage: unknown }> {
  const result = await detectHexWithAzureOpenAI(image.dataUri, { onLog: quietLog });
  if (result.provider === "none") {
    throw new Error("Azure OpenAI config missing");
  }
  return { hex: result.hex, confidence: result.confidence, finishes: result.finishes, usage: result.usage ?? null };
}

function choiceMeta(choice: CaseImageChoice): Record<string, unknown> {
  return {
    chosenImage: { source: choice.source, index: choice.index, url: choice.url, confident: choice.confident },
    reason: choice.reason,
    ranking: choice.ranking,
  };
}

export const imageSelectStrategy: HexDetectionStrategy = {
  name: "image-select",
  description: "rank the case's images by alt text / filename, run azure-blind detection on the best one",
  requiresAzureOpenAI: true,
  run: async (input) => {
    const choice = chooseCaseImage(input);
    const detection = await detectOn(await choice.load());
    return {
      hex: detection.hex,
      confidence: detection.confidence,
      finishes: detection.finishes,
      meta: { ...choiceMeta(choice), usage: detection.usage },
    };
  },
};

export const imageSelectAiStrategy: HexDetectionStrategy = {
  name: "image-select-ai",
  description: "image-select, plus one vision call to pick the on-nail photo when no image has alt text",
  requiresAzureOpenAI: true,
  run: async (input) => {
    let choice = chooseCaseImage(input);
    const candidates = input.images ?? [];
    let pickMeta: Record<string, unknown> | null = null;

    if (candidates.length > 1 && candidates.every((c) => !c.alt)) {
      const pool = candidates.slice(0, MAX_SWATCH_PICK_IMAGES);
      const loaded = await Promise.all(pool.map((c) => c.load()));
      const pick = await askModelForSwatchIndex(loaded);
      pickMeta = { index: pick.index, confidence: pick.confidence, usage: pick.usage, imagesShown: pool.length };
      if (pick.index !== null) {
        const picked = pool[pick.index];
        choice = {
          ...choice,
          source: "ai-pick",
          index: picked.index,
          url: picked.url,
          confident: false,
          reason: `vision model picked image #${picked.position ?? picked.index + 1} as the on-nail photo (confidence ${pick.confidence ?? "?"}); ranking said: ${choice.reason}`,
          load: async () => loaded[pick.index as number],
        };
      }
    }

    const detection = await detectOn(await choice.load());
    return {
      hex: detection.hex,
      confidence: detection.confidence,
      finishes: detection.finishes,
      meta: { ...choiceMeta(choice), swatchPick: pickMeta, usage: detection.usage },
    };
  },
};

/** Both image-selection strategies, registered as one entry in `STRATEGIES`. */
export const IMAGE_SELECT_STRATEGIES: readonly HexDetectionStrategy[] = [imageSelectStrategy, imageSelectAiStrategy];
