import { resolveHexSnapMaxDistance, snapHexToPalette } from "../../../lib/hex-snap";
import { extractPaletteCandidates } from "../../../lib/palette-pick-detection";
import type { CaseImage, HexDetectionStrategy, StrategyOutput } from "../types";
import { chooseCaseImageWithAi, choiceMeta, detectOn } from "./image-select";

/**
 * Snap strategies: the model points, the pixels measure.
 *
 * The blind prompt (`detectHexWithAzureOpenAI`, no vendor context) names a hex;
 * that hex is replaced by the nearest color measured from the same photo
 * (palette-pick's candidate chips), unless no chip is within
 * `HEX_SNAP_MAX_DISTANCE` (default: the MEDIUM threshold, 0.10).
 *
 * - `blind-snap`: the case image only, so the gain over `azure-blind` is the snap alone.
 * - `image-select-ai-snap`: picks the photo the way `image-select-ai` does, then
 *   runs blind detection and snaps on that photo.
 */

async function detectAndSnap(image: CaseImage): Promise<StrategyOutput> {
  const [detection, candidates] = await Promise.all([detectOn(image), extractPaletteCandidates(image.bytes)]);
  if (!detection.hex) {
    return { hex: null, confidence: detection.confidence, finishes: detection.finishes, meta: { usage: detection.usage, candidates } };
  }
  const snap = snapHexToPalette(detection.hex, candidates, resolveHexSnapMaxDistance());
  return {
    hex: snap.hex,
    confidence: detection.confidence,
    finishes: detection.finishes,
    meta: {
      modelHex: detection.hex,
      snapped: snap.snapped,
      nearestChip: snap.nearest,
      snapDistance: snap.snapDistance,
      maxSnapDistance: snap.maxDistance,
      candidates,
      usage: detection.usage,
    },
  };
}

export const blindSnapStrategy: HexDetectionStrategy = {
  name: "blind-snap",
  description: "azure-blind on the case image, snapped to the nearest measured palette chip",
  requiresAzureOpenAI: true,
  run: (input) => detectAndSnap(input.image),
};

export const imageSelectAiSnapStrategy: HexDetectionStrategy = {
  name: "image-select-ai-snap",
  description: "image-select-ai photo choice, then azure-blind snapped to that photo's nearest measured chip",
  requiresAzureOpenAI: true,
  run: async (input) => {
    const { choice, swatchPick } = await chooseCaseImageWithAi(input);
    const output = await detectAndSnap(await choice.load());
    return { ...output, meta: { ...choiceMeta(choice), swatchPick, ...output.meta } };
  },
};

export const SNAP_STRATEGIES: readonly HexDetectionStrategy[] = [blindSnapStrategy, imageSelectAiSnapStrategy];
