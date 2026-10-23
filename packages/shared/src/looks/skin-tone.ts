/**
 * Skin tone for Looks (product rule, `docs/looks-experience-plan.md`). An optional undertone
 * (cool / neutral / warm) and depth (fair / light / medium / tan / deep) that nudge which bases
 * and accents the recommender prefers. It is a soft score term, never a filter:
 *
 * - It is added to the base/accent score only AFTER the distance cut-offs (`BASE_MAX_DISTANCE`,
 *   `ACCENT_MAX_DISTANCE`), so it can reorder candidates that already fit the template but never
 *   admit or drop one; an owned polish still beats a catalog gap, and templates keep their
 *   identity (French Modern stays a sheer pink base with a white tip).
 * - No skin tone (or `neutral` + `medium`) adds exactly 0: output is identical to before.
 * - Toppers are not scored.
 *
 * **Undertone.** Cool prefers OKLCH hues in the blue–purple–pink–berry range and cool reds
 * (`COOL_ARC`: 250°–30°); warm prefers coral–orange–warm red–gold–olive (`WARM_ARC`: 30°–120°).
 * The bonus is full across the middle half of the arc and falls linearly to its edges and scales with chroma (a nude or grey
 * has none). Neutral has no preference.
 *
 * **Depth.** Each depth has a reference skin lightness (`SKIN_LIGHTNESS`, OKLab L).
 * - A low-chroma polish within `VANISH_BAND` of the skin lightness reads as no contrast and is
 *   penalised (fair/light: pale nudes; tan/deep: very dark muted shades), except at `medium`.
 * - Fair/light also get a small bonus for mid-tone lightness (L 0.45–0.75) over very pale picks.
 * - Tan/deep get a bonus for higher chroma and for lightness above the skin's.
 *
 * All weights are OKLAB-distance units on the same scale as the score they join.
 */
import { hexToOklab } from "../color/oklab";
import type { SkinDepth, SkinTone, SkinUndertone } from "../types/looks";

/** Full undertone bonus (inside an arc's core, high chroma). Above `BASE_TIE_BAND` so it decides near-ties. */
export const SKIN_UNDERTONE_WEIGHT = 0.04;
/** Penalty for a low-chroma polish that vanishes into the skin. */
export const SKIN_VANISH_PENALTY = 0.04;
/** Mid-tone bonus (fair/light) and chroma / lighter-than-skin bonuses (tan/deep). */
export const SKIN_DEPTH_BONUS = 0.02;
/** Chroma that earns the full undertone / depth-chroma weight; lower chroma scales it down. */
export const SKIN_FULL_CHROMA = 0.1;
/** Chroma below which a polish counts as muted for the vanishing rule. */
export const SKIN_MUTED_CHROMA = 0.06;
/** Lightness distance within which a muted polish vanishes into the skin. */
export const SKIN_VANISH_BAND = 0.1;

/** With a skin tone, bases within this of the best adjusted score are the near-ties the seed picks among (instead of `BASE_TIE_BAND`). */
export const SKIN_TIE_BAND = 0.01;

/** OKLCH hue arcs in degrees [start, end] going up, wrapping at 360. */
export const COOL_ARC: readonly [number, number] = [250, 390]; // 250° … 30° (wraps)
export const WARM_ARC: readonly [number, number] = [30, 120];

/** Reference skin lightness (OKLab L) per depth. */
export const SKIN_LIGHTNESS: Record<SkinDepth, number> = { fair: 0.85, light: 0.78, medium: 0.68, tan: 0.58, deep: 0.38 };

export function skinToneFrom(undertone: SkinUndertone | null, depth: SkinDepth | null): SkinTone | null {
  return undertone || depth ? { undertone: undertone ?? "neutral", depth: depth ?? "medium" } : null;
}

/** 1 across the middle half of the arc, falling linearly to 0 at its edges (and outside); hue in degrees. */
function arcCloseness(hue: number, [start, end]: readonly [number, number]): number {
  const half = (end - start) / 2;
  const centre = start + half;
  let delta = Math.abs((((hue - centre) % 360) + 540) % 360 - 180);
  delta = Math.min(delta, 360 - delta);
  return Math.min(1, Math.max(0, 2 * (1 - delta / half)));
}

/**
 * Score adjustment for a candidate hex (negative = preferred, added to a score where lower is
 * better). 0 when there is no skin tone or it expresses no preference.
 */
export function skinToneAdjustment(hex: string, skinTone: SkinTone | null | undefined): number {
  if (!skinTone) return 0;
  const lab = hexToOklab(hex);
  const chroma = Math.hypot(lab.a, lab.b);
  const chromaShare = Math.min(1, chroma / SKIN_FULL_CHROMA);
  const hue = ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
  let adjustment = 0;

  if (skinTone.undertone === "cool") adjustment -= SKIN_UNDERTONE_WEIGHT * chromaShare * arcCloseness(hue, COOL_ARC);
  else if (skinTone.undertone === "warm") adjustment -= SKIN_UNDERTONE_WEIGHT * chromaShare * arcCloseness(hue, WARM_ARC);

  if (skinTone.depth !== "medium") {
    const skinL = SKIN_LIGHTNESS[skinTone.depth];
    if (chroma < SKIN_MUTED_CHROMA && Math.abs(lab.L - skinL) <= SKIN_VANISH_BAND) adjustment += SKIN_VANISH_PENALTY;
    if (skinTone.depth === "fair" || skinTone.depth === "light") {
      if (lab.L >= 0.45 && lab.L <= 0.75) adjustment -= SKIN_DEPTH_BONUS;
    } else {
      adjustment -= SKIN_DEPTH_BONUS * chromaShare;
      if (lab.L > skinL) adjustment -= SKIN_DEPTH_BONUS / 2;
    }
  }
  return adjustment;
}
