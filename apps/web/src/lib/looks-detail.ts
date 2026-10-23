import type { SkinDepth, SkinTone, SkinUndertone } from "./looks";

/**
 * The Looks cards' extras live in `swatchwatch-shared` (`packages/shared/src/looks/detail.ts`:
 * the "Add missing items" shopping list, the detail drawer's application order and finish notes,
 * the share text) so web and the Expo app print the same text. This file re-exports them and keeps
 * the web-only skin-tone swatch backdrop.
 */
export {
  applicationOrder,
  finishNotes,
  formatShoppingSubtotals,
  lookShareText,
  shoppingItemPriceFields,
  shoppingItemsForLook,
  shoppingListText,
  shoppingSubtotals,
} from "swatchwatch-shared";
export type {
  ApplicationKind,
  ApplicationStep,
  DetailStep,
  FinishNote,
  ShoppingItem,
  ShoppingSubtotals,
} from "swatchwatch-shared";

// ── Skin-tone backdrop ───────────────────────────────────────
// Driven by the same skin-tone choice that shapes the recommendations (undertone + depth).

/** Cool (pink-undertone) and warm (golden-undertone) ends of the swatch backdrop. */
export const SKIN_TONE_COOL = "#E3C0B8";
export const SKIN_TONE_WARM = "#DDB98E";

function channel(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

/**
 * Backdrop color for the swatch strip at `value` (0 = cool, 100 = warm, clamped). Cosmetic only;
 * `skinToneBackdropFor` maps the skin-tone choice (which also shapes the recommendations) onto it.
 */
export function skinToneBackdrop(value: number): string {
  const t = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 50)) / 100;
  const mixed = [0, 1, 2].map((i) => Math.round(channel(SKIN_TONE_COOL, i) + (channel(SKIN_TONE_WARM, i) - channel(SKIN_TONE_COOL, i)) * t));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const BACKDROP_UNDERTONE: Record<SkinUndertone, number> = { cool: 0, neutral: 50, warm: 100 };
/** Share mixed toward white (positive) or deep brown (negative) per depth; medium leaves the base. */
const BACKDROP_DEPTH: Record<SkinDepth, number> = { fair: 0.45, light: 0.25, medium: 0, tan: -0.2, deep: -0.5 };
const BACKDROP_DEEP = "#6B4A38";

/** Backdrop for a skin-tone choice: undertone picks cool ↔ warm, depth lightens or deepens it. */
export function skinToneBackdropFor(skinTone: SkinTone): string {
  const base = skinToneBackdrop(BACKDROP_UNDERTONE[skinTone.undertone]);
  const shift = BACKDROP_DEPTH[skinTone.depth];
  if (shift === 0) return base;
  const target = shift > 0 ? "#FFFFFF" : BACKDROP_DEEP;
  const t = Math.abs(shift);
  const mixed = [0, 1, 2].map((i) => Math.round(channel(base, i) + (channel(target, i) - channel(base, i)) * t));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
