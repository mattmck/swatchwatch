/**
 * "Pair it" (issue #272, mobile #384): up to two owned polishes to wear with a picked polish,
 * chosen from the harmony rules in `harmonies.ts`. Shared by the web dashboard's Pick for me
 * card and the mobile Home pick card / polish detail "Goes with".
 *
 * Pure and deterministic: no clock, no randomness, no DOM.
 */
import { resolveProductCategory } from "../constants/product-categories";
import type { ManicurePolishRole } from "../types/manicure";
import { resolveDisplayHex, resolvePolishFinishes, type Polish } from "../types/polish";
import { hexToOklch } from "./color-family";
import { generateHarmonyPalette } from "./harmonies";
import { colorDistance } from "./oklab";

/** Largest OKLAB distance between a harmony target and an owned polish to count as a pairing. */
export const PAIR_MAX_DISTANCE = 0.12;

/** Below this OKLCH chroma the pick reads as neutral and has no meaningful hue harmony. */
export const PAIR_NEUTRAL_MAX_CHROMA = 0.04;

/** Finishes that make a polish an accent topper candidate (`topper` preferred). */
export const TOPPER_FINISHES = ["topper", "flake", "glitter"] as const;

/** Most pairings suggested for one pick. */
export const MAX_PAIRINGS = 2;

export type PairHarmony = "complementary" | "analogous" | "topper";

/** The polish fields the pairing rule reads. */
export type PairablePolish = Pick<
  Polish,
  | "id"
  | "brand"
  | "name"
  | "status"
  | "productCategory"
  | "vendorHex"
  | "detectedHex"
  | "nameHex"
  | "finish"
  | "finishes"
  | "wearCount"
>;

export interface PairSuggestion<T extends PairablePolish = Polish> {
  polish: T;
  harmony: PairHarmony;
  /** Role to log it with in a manicure. */
  role: ManicurePolishRole;
  label: string;
  /** OKLAB distance to the harmony target (null for toppers, which are chosen by finish). */
  distance: number | null;
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/** The polish's display hex (vendor > detected > name) when it is a valid `#RRGGBB`. */
export function pairableDisplayHex(polish: Pick<Polish, "vendorHex" | "detectedHex" | "nameHex">): string | undefined {
  const hex = resolveDisplayHex(polish);
  return hex && HEX_RE.test(hex) ? hex : undefined;
}

function isOwned(polish: Pick<Polish, "status">): boolean {
  return polish.status === "owned";
}

function finishSet(polish: PairablePolish): Set<string> {
  return new Set(resolvePolishFinishes(polish).map((f) => f.toLowerCase()));
}

function topperRank(polish: PairablePolish): number {
  // A topper by category ranks with the `topper` finish (#349).
  if (resolveProductCategory(polish.productCategory) === "topper") return 0;
  const finishes = finishSet(polish);
  const index = TOPPER_FINISHES.findIndex((f) => finishes.has(f));
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

function byName(a: PairablePolish, b: PairablePolish): number {
  return a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * Owned polish nearest to any harmony target, within `PAIR_MAX_DISTANCE`. A candidate must be
 * closer to the target than to the pick itself, so near-duplicates of the pick never count as a
 * (small-rotation) analogous pairing.
 */
function nearest<T extends PairablePolish>(
  pool: T[],
  targets: string[],
  pickHex: string,
  hexById: Map<string, string | undefined>
): { polish: T; distance: number } | null {
  let best: { polish: T; distance: number } | null = null;
  for (const polish of pool) {
    const hex = hexById.get(polish.id);
    if (!hex) continue;
    const toPick = colorDistance(hex, pickHex);
    for (const target of targets) {
      const distance = colorDistance(hex, target);
      if (distance >= toPick) continue;
      if (!best || distance < best.distance || (distance === best.distance && byName(polish, best.polish) < 0)) {
        best = { polish, distance };
      }
    }
  }
  return best && best.distance <= PAIR_MAX_DISTANCE ? best : null;
}

/**
 * Suggest up to `MAX_PAIRINGS` owned polishes to wear with `pick`, deterministically:
 *
 * - **complementary** — nearest owned polish to the 180° OKLCH hue rotation of the pick;
 * - **analogous** — nearest owned polish to the ±30° rotations;
 * - **topper** — an owned topper (category `topper`, or a topper/flake/glitter finish; `topper`
 *   first, then the least worn), skipped when the pick is itself a topper.
 *
 * Only owned (`status === "owned"`) color polishes and toppers are paired; coats, treatments and
 * accessories never are (#349).
 *
 * Hue harmonies need a non-neutral pick (chroma ≥ `PAIR_NEUTRAL_MAX_CHROMA`) and a match within
 * `PAIR_MAX_DISTANCE` that is closer to the harmony target than to the pick. Order: the closer
 * hue match, then the topper, then the other hue match.
 */
export function suggestPairings<T extends PairablePolish>(
  pick: PairablePolish,
  polishes: T[],
  max: number = MAX_PAIRINGS
): PairSuggestion<T>[] {
  if (max <= 0) return [];
  const pool = polishes.filter((p) => {
    if (!isOwned(p) || p.id === pick.id) return false;
    const category = resolveProductCategory(p.productCategory);
    return category === "color" || category === "topper";
  });
  const toppers = pool.filter((p) => Number.isFinite(topperRank(p)));
  const colorPool = pool.filter((p) => !Number.isFinite(topperRank(p)));
  const hexById = new Map(pool.map((p) => [p.id, pairableDisplayHex(p)]));

  const hueMatches: PairSuggestion<T>[] = [];
  const pickHex = pairableDisplayHex(pick);
  if (pickHex) {
    const oklch = hexToOklch(pickHex);
    if (oklch.C >= PAIR_NEUTRAL_MAX_CHROMA && Number.isFinite(oklch.h)) {
      const complement = nearest(colorPool, generateHarmonyPalette(pickHex, "complementary").slice(1), pickHex, hexById);
      if (complement) {
        hueMatches.push({
          polish: complement.polish,
          harmony: "complementary",
          role: "accent",
          label: "Complementary accent",
          distance: complement.distance,
        });
      }
      const analogous = nearest(
        colorPool.filter((p) => p.id !== complement?.polish.id),
        generateHarmonyPalette(pickHex, "analogous").slice(1),
        pickHex,
        hexById
      );
      if (analogous) {
        hueMatches.push({
          polish: analogous.polish,
          harmony: "analogous",
          role: "accent",
          label: "Analogous accent",
          distance: analogous.distance,
        });
      }
      hueMatches.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    }
  }

  let topper: PairSuggestion<T> | null = null;
  if (!Number.isFinite(topperRank(pick)) && toppers.length > 0) {
    const best = [...toppers].sort(
      (a, b) => topperRank(a) - topperRank(b) || (a.wearCount ?? 0) - (b.wearCount ?? 0) || byName(a, b)
    )[0];
    const isTopperFinish =
      resolveProductCategory(best.productCategory) === "topper" || finishSet(best).has("topper");
    topper = {
      polish: best,
      harmony: "topper",
      role: isTopperFinish ? "topper" : "accent",
      label: isTopperFinish ? "Topper" : "Sparkle accent",
      distance: null,
    };
  }

  const ordered = [hueMatches[0], topper, hueMatches[1]].filter((s): s is PairSuggestion<T> => Boolean(s));
  return ordered.slice(0, max);
}
