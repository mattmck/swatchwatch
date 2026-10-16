import { detectHexByPalettePick } from "../../../lib/palette-pick-detection";
import type { HexDetectionStrategy, StrategyInput, StrategyOutput } from "../types";

/**
 * (d) Palette pick: pixels measure 8–12 candidate colors from the image, the
 * model only *chooses* among labeled chips, and the answer is the chosen chip's
 * measured hex. Avoids the model's habit of answering in CSS named colors.
 * See `src/lib/palette-pick-detection.ts`.
 */
export const palettePickStrategy: HexDetectionStrategy = {
  name: "palette-pick",
  description: "model picks a labeled chip from measured candidate colors (composite image)",
  requiresAzureOpenAI: true,
  run: async (input: StrategyInput): Promise<StrategyOutput> => {
    const result = await detectHexByPalettePick(input.image.bytes, { onLog: () => undefined });
    if (result.provider === "none") {
      throw new Error("Azure OpenAI config missing");
    }
    return {
      hex: result.hex,
      confidence: result.confidence,
      finishes: result.finishes,
      meta: {
        choice: result.choice,
        candidates: result.candidates,
        composite: result.composite,
        usage: result.usage ?? null,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.hex === null ? { rawContent: result.rawContent } : {}),
      },
    };
  },
};
