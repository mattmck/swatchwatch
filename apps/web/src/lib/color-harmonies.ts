/**
 * Re-export shim: the harmony rules live in `swatchwatch-shared` (`packages/shared/src/color/harmonies.ts`)
 * so the mobile app uses the same palettes. Kept so existing web imports stay unchanged.
 */
export type { HarmonyType, PaletteSuggestion } from "swatchwatch-shared";
export {
  HARMONY_TYPES,
  generateHarmonyColors,
  generateHarmonyPalette,
  getHarmonyTypeOptions,
  suggestPaletteCompletion,
} from "swatchwatch-shared";
