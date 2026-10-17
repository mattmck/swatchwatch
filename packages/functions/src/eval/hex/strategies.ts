import { detectHexWithAzureOpenAI, type HexDetectionOptions } from "../../lib/ai-color-detection";
import { resolveAzureOpenAiConfig } from "../../lib/azure-openai-config";
import { extractDominantColors } from "../../lib/dominant-color";
import { regionCropStrategy } from "./strategies/region-crop";
import { palettePickStrategy } from "./strategies/palette-pick";
import type { HexDetectionStrategy, StrategyInput, StrategyOutput } from "./types";

/**
 * Detection strategies under evaluation. Adding one is a single entry here: a
 * name, whether it needs Azure OpenAI, and a `run` that maps a case + image to
 * a predicted hex. The runner handles loading, scoring and reporting.
 */

const AZURE_DEPLOYMENT_ENV_KEYS = ["AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT"];

/** True when `detectHexWithAzureOpenAI` has endpoint + credentials + deployment. */
export function hasAzureOpenAiConfig(): boolean {
  return resolveAzureOpenAiConfig({ deploymentEnvKeys: AZURE_DEPLOYMENT_ENV_KEYS }).isValid;
}

/** Suppress the library's per-call console chatter; errors still surface through the result. */
const quietLog: HexDetectionOptions["onLog"] = () => undefined;

async function runAzure(input: StrategyInput, vendorContext: HexDetectionOptions["vendorContext"]): Promise<StrategyOutput> {
  const result = await detectHexWithAzureOpenAI(input.image.dataUri, {
    onLog: quietLog,
    ...(vendorContext ? { vendorContext } : {}),
  });
  if (result.provider === "none") {
    throw new Error("Azure OpenAI config missing");
  }
  return {
    hex: result.hex,
    confidence: result.confidence,
    finishes: result.finishes,
    meta: { usage: result.usage ?? null },
  };
}

/**
 * (a) The production call as ingestion makes it: image + vendor context
 * (shade name, vendor hex when the vendor published one, description, tags).
 * The vendor hex is only forwarded when the ground truth *is* a vendor option,
 * since that is the only case where production would have had it.
 */
export const azureCurrentStrategy: HexDetectionStrategy = {
  name: "azure-current",
  description: "detectHexWithAzureOpenAI as ingestion calls it (image + vendor context)",
  requiresAzureOpenAI: true,
  run: (input) =>
    runAzure(input, {
      shadeName: input.evalCase.shadeName,
      vendorHex: input.evalCase.groundTruthSource === "vendor_option" ? input.evalCase.groundTruthHex : null,
      description: input.evalCase.description ?? null,
      tags: input.evalCase.tags?.length ? input.evalCase.tags : null,
    }),
};

/** (b) The same call with no vendor context at all — what the model sees in the image alone. */
export const azureBlindStrategy: HexDetectionStrategy = {
  name: "azure-blind",
  description: "detectHexWithAzureOpenAI with vendorContext removed (image only)",
  requiresAzureOpenAI: true,
  run: (input) => runAzure(input, undefined),
};

/** (c) Pure pixel baseline: the most prominent quantized color in the whole image. */
export const pixelStrategy: HexDetectionStrategy = {
  name: "pixel",
  description: "top dominant color from extractDominantColors (no AI)",
  requiresAzureOpenAI: false,
  run: async (input) => {
    const palette = await extractDominantColors(input.image.bytes, { maxColors: 5 });
    return {
      hex: palette[0]?.hex ?? null,
      meta: { palette },
    };
  },
};

export const STRATEGIES: readonly HexDetectionStrategy[] = [
  azureCurrentStrategy,
  azureBlindStrategy,
  pixelStrategy,
  regionCropStrategy,
  palettePickStrategy,
];

export function getStrategy(name: string): HexDetectionStrategy | null {
  const needle = name.trim().toLowerCase();
  return STRATEGIES.find((strategy) => strategy.name === needle) ?? null;
}

/** Why a strategy cannot run in this environment, or null when it can. */
export function strategySkipReason(strategy: HexDetectionStrategy, azureConfigured = hasAzureOpenAiConfig()): string | null {
  if (strategy.requiresAzureOpenAI && !azureConfigured) {
    return "Azure OpenAI is not configured (set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY and AZURE_OPENAI_DEPLOYMENT_HEX, or copy local.settings.json)";
  }
  return null;
}
