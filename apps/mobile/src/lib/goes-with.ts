/**
 * Polish detail "Goes with" (#384): harmony targets for a polish's display hex (shared
 * `generateHarmonyColors`), each paired with the closest owned color polish within
 * `PAIR_MAX_DISTANCE` (the Pair it radius), or left as a bare target to look up in the catalog.
 */
import {
  colorDistance,
  generateHarmonyColors,
  hexToOklch,
  PAIR_MAX_DISTANCE,
  PAIR_NEUTRAL_MAX_CHROMA,
  resolveProductCategory,
  type HarmonyType,
  type Polish,
} from "swatchwatch-shared";
import { polishHex } from "./color-search";

/** Harmonies shown on the detail card, in display order. */
export const GOES_WITH_HARMONIES: readonly { harmony: HarmonyType; label: string }[] = [
  { harmony: "complementary", label: "Complementary" },
  { harmony: "analogous", label: "Analogous" },
  { harmony: "triadic", label: "Triadic" },
];

export interface GoesWithTarget {
  key: string;
  harmony: HarmonyType;
  label: string;
  /** The generated target color, `#RRGGBB`. */
  targetHex: string;
  /** The closest owned color polish within `PAIR_MAX_DISTANCE`, or null (→ "Find in catalog"). */
  match: { polish: Polish; hex: string; distance: number } | null;
}

/**
 * Harmony targets for `sourceHex` with the closest owned match per target. Each owned polish is
 * used at most once (targets are filled in order), the source polish never matches itself, and
 * only owned `color` polishes count (D23). Returns `[]` for a near-neutral source, whose hue has
 * no meaningful harmonies (same chroma cut-off as Pair it).
 */
export function goesWithTargets(sourceHex: string | null | undefined, polishes: readonly Polish[], sourceId?: string): GoesWithTarget[] {
  if (!sourceHex) return [];
  const { C } = hexToOklch(sourceHex);
  if (!(C >= PAIR_NEUTRAL_MAX_CHROMA)) return [];

  const pool = polishes
    .filter((p) => p.status === "owned" && p.id !== sourceId && resolveProductCategory(p.productCategory) === "color")
    .map((polish) => ({ polish, hex: polishHex(polish) }))
    .filter((entry): entry is { polish: Polish; hex: string } => entry.hex !== null);

  const used = new Set<string>();
  const out: GoesWithTarget[] = [];
  for (const { harmony, label } of GOES_WITH_HARMONIES) {
    generateHarmonyColors(sourceHex, harmony).forEach((raw, index) => {
      const targetHex = raw.toUpperCase();
      let best: GoesWithTarget["match"] = null;
      for (const entry of pool) {
        if (used.has(entry.polish.id)) continue;
        const distance = colorDistance(entry.hex, targetHex);
        if (distance > PAIR_MAX_DISTANCE) continue;
        if (!best || distance < best.distance || (distance === best.distance && entry.polish.name.localeCompare(best.polish.name) < 0)) {
          best = { ...entry, distance };
        }
      }
      if (best) used.add(best.polish.id);
      out.push({ key: `${harmony}-${index}`, harmony, label, targetHex, match: best });
    });
  }
  return out;
}

/** The `hex` route param for a By color deep link (`#C0392B` → `C0392B`). */
export function hexRouteParam(hex: string): string {
  return hex.replace(/^#/, "").toUpperCase();
}
