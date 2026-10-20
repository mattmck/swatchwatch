/**
 * "Pick for me" (issue #272): a weighted random pick from the user's owned polishes, plus an
 * optional "pair it" suggestion built from the harmony definitions in `color-harmonies.ts`.
 *
 * Everything here is pure: the clock (`now`) and the random source (`random`) are inputs, so a
 * fixed seed (`createSeededRandom`) reproduces the same picks. It runs client-side on the owned
 * list the dashboard already fetches; there is no server use, so it lives in the web app.
 *
 * ## Weighting
 *
 * Only `status === "owned"` color polishes are candidates (wishlist, destash and archived are never
 * picked; toppers, coats, treatments and accessories are never the main pick, #349 D-C).
 * "Pair it" may add an owned topper. Each candidate's weight is the product of three factors (see `PICK_WEIGHTS`):
 *
 * | Factor   | Value |
 * |----------|-------|
 * | tried    | `untriedMultiplier` (3) when `triedAt` is null, else 1 |
 * | recency  | 0 when worn within `recentWearCooldownDays` (worn today/yesterday); `staleMaxMultiplier` (2) when never worn; otherwise ramps linearly from 1 to 2 over `staleFullDays` (90) since `lastWornAt` |
 * | gap      | `gapThinMultiplier` (2) when the polish sits in a thin hue × lightness cell of the gap heatmap (`analyzeCollectionGaps().underrepresented`), else 1 |
 *
 * So an untried, never-worn polish in a thin cell weighs 3 × 2 × 2 = 12, and a tried polish
 * worn last week in a well-covered cell weighs about 1.08: roughly 11× as likely per draw.
 *
 * A weight of 0 (the cooldown) makes a polish unpickable while any positive-weight candidate
 * remains. If every remaining candidate is in cooldown, the cooldown is ignored for that draw so
 * a non-empty collection always yields a pick.
 *
 * ## No repeats
 *
 * `pickForMe` takes the ids of recent picks (`exclude`, the last `PICK_HISTORY_SIZE` = 3) and
 * never returns one of them while another owned polish exists. With fewer than 4 owned polishes
 * it relaxes to "not the immediately previous pick", and a single-polish collection always
 * returns that polish.
 */
import type { HueFamily, LightnessBand, ManicurePolishRole, Polish } from "swatchwatch-shared";
import { resolveDisplayHex, resolvePolishFinishes, resolveProductCategory } from "swatchwatch-shared";
import { analyzeCollectionGaps, classifyHexToGapCell, colorDistance, hexToOklch } from "./color-utils";
import { generateHarmonyPalette } from "./color-harmonies";
import { isOwnedPolish } from "./inventory-status";

/** Weighting constants. Change these (and the table above) together. */
export const PICK_WEIGHTS = {
  /** Multiplier for polishes never tried (`triedAt` null). */
  untriedMultiplier: 3,
  /** Recency multiplier for polishes never worn, and the cap for long-unworn ones. */
  staleMaxMultiplier: 2,
  /** Days since `lastWornAt` at which the recency multiplier reaches `staleMaxMultiplier`. */
  staleFullDays: 90,
  /** Polishes worn fewer than this many days ago get weight 0 (0 = today, 1 = yesterday). */
  recentWearCooldownDays: 2,
  /** Multiplier for polishes in an under-represented (thin) gap-heatmap cell. */
  gapThinMultiplier: 2,
} as const;

/** How many recent picks "Pick again" avoids repeating. */
export const PICK_HISTORY_SIZE = 3;

/** "Not worn in …" is only a reason once the polish has rested at least this long. */
export const NOT_WORN_REASON_MIN_DAYS = 30;

const DAY_MS = 86_400_000;

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/** The polish's display hex (vendor > detected > name) when it is a valid `#RRGGBB`. */
function displayHex(polish: Polish): string | undefined {
  const hex = resolveDisplayHex(polish);
  return hex && HEX_RE.test(hex) ? hex : undefined;
}

export type PickReasonKind = "untried" | "never-worn" | "not-worn" | "gap" | "random";

export interface PickReason {
  kind: PickReasonKind;
  /** Short human text, e.g. "Untried", "Not worn in 3 months", "Fills a gap: deep teal". */
  label: string;
}

export interface PickFactors {
  tried: number;
  recency: number;
  gap: number;
}

export interface PickCandidate {
  polish: Polish;
  /** `tried × recency × gap`; 0 means "not pickable while anything else is". */
  weight: number;
  factors: PickFactors;
  /** Why this polish is favored (empty when nothing stands out). */
  reasons: PickReason[];
  /** Days since `lastWornAt` (null when never worn or unparseable). */
  daysSinceWorn: number | null;
  /** Gap-heatmap cell of the display hex (null without a valid hex). */
  cell: { hueFamily: HueFamily; lightnessBand: LightnessBand } | null;
}

export interface PickResult {
  polish: Polish;
  candidate: PickCandidate;
  /** Reasons to show; falls back to a single "random" reason. */
  reasons: PickReason[];
  /** Candidates in the pool the pick was drawn from. */
  poolSize: number;
}

export type RandomSource = () => number;

/**
 * Deterministic PRNG (mulberry32) returning floats in `[0, 1)`. Same seed, same sequence.
 */
export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIGHTNESS_WORD: Record<LightnessBand, string> = {
  dark: "deep",
  "dark-medium": "dark",
  medium: "mid",
  "medium-light": "soft",
  light: "pale",
};

const HUE_WORD: Record<Exclude<HueFamily, "blues-teals">, string> = {
  reds: "red",
  "oranges-corals": "coral",
  "yellows-golds": "gold",
  greens: "green",
  "purples-violets": "purple",
  "pinks-magentas": "pink",
  neutrals: "neutral",
};

/**
 * Friendly name for a gap cell, e.g. "deep teal", "pale pink". The blues/teals family is split
 * by the polish's own OKLCH hue (teal below 230°, blue above) when a hex is given.
 */
export function describeGapCell(cell: { hueFamily: HueFamily; lightnessBand: LightnessBand }, hex?: string): string {
  let hueWord: string;
  if (cell.hueFamily === "blues-teals") {
    const h = hex ? hexToOklch(hex).h : NaN;
    hueWord = Number.isFinite(h) ? (h < 230 ? "teal" : "blue") : "blue-teal";
  } else {
    hueWord = HUE_WORD[cell.hueFamily];
  }
  return `${LIGHTNESS_WORD[cell.lightnessBand]} ${hueWord}`;
}

/** "3 months", "5 weeks", "12 days". */
export function formatRestPeriod(days: number): string {
  if (days >= 60) return `${Math.floor(days / 30)} months`;
  if (days >= 14) return `${Math.floor(days / 7)} weeks`;
  return `${days} days`;
}

function daysBetween(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((nowMs - ms) / DAY_MS));
}

function recencyFactor(daysSinceWorn: number | null, ignoreCooldown = false): number {
  const { staleMaxMultiplier, staleFullDays, recentWearCooldownDays } = PICK_WEIGHTS;
  if (daysSinceWorn === null) return staleMaxMultiplier;
  if (daysSinceWorn < recentWearCooldownDays) return ignoreCooldown ? 1 : 0;
  return 1 + ((staleMaxMultiplier - 1) * Math.min(daysSinceWorn, staleFullDays)) / staleFullDays;
}

/** Owned color polishes: the only main-pick candidates (#349, D-C). */
function isPickable(polish: Polish): boolean {
  return isOwnedPolish(polish) && resolveProductCategory(polish.productCategory) === "color";
}

/**
 * Score every owned color polish. Non-owned rows and other categories are dropped. Pure: `now`
 * is the reference time.
 */
export function scorePickCandidates(polishes: Polish[], now: Date | number): PickCandidate[] {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const owned = polishes.filter(isPickable);
  const hexById = new Map(owned.map((p) => [p.id, displayHex(p)]));

  const analysis = analyzeCollectionGaps(
    owned.map((p) => hexById.get(p.id)).filter((hex): hex is string => typeof hex === "string")
  );
  const thinKeys = new Set(analysis.underrepresented.map((c) => `${c.hueFamily}:${c.lightnessBand}`));

  return owned.map((polish) => {
    const hex = hexById.get(polish.id);
    const cell = hex ? classifyHexToGapCell(hex) : null;
    const isThin = cell !== null && thinKeys.has(`${cell.hueFamily}:${cell.lightnessBand}`);
    const untried = !polish.triedAt;
    const daysSinceWorn = daysBetween(polish.lastWornAt, nowMs);

    const factors: PickFactors = {
      tried: untried ? PICK_WEIGHTS.untriedMultiplier : 1,
      recency: recencyFactor(daysSinceWorn),
      gap: isThin ? PICK_WEIGHTS.gapThinMultiplier : 1,
    };

    const reasons: PickReason[] = [];
    if (untried) {
      reasons.push({ kind: "untried", label: "Untried" });
    } else if (daysSinceWorn === null) {
      reasons.push({ kind: "never-worn", label: "No wears logged yet" });
    }
    if (daysSinceWorn !== null && daysSinceWorn >= NOT_WORN_REASON_MIN_DAYS) {
      reasons.push({ kind: "not-worn", label: `Not worn in ${formatRestPeriod(daysSinceWorn)}` });
    }
    if (isThin && cell && hex) {
      reasons.push({ kind: "gap", label: `Fills a gap: ${describeGapCell(cell, hex)}` });
    }

    return {
      polish,
      weight: factors.tried * factors.recency * factors.gap,
      factors,
      reasons,
      daysSinceWorn,
      cell,
    };
  });
}

/** Weighted draw; returns -1 when the total weight is not positive. */
function weightedIndex(weights: number[], random: RandomSource): number {
  const total = weights.reduce((sum, w) => sum + (w > 0 ? w : 0), 0);
  if (!(total > 0)) return -1;
  let target = random() * total;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] > 0 ? weights[i] : 0;
    if (w === 0) continue;
    if (target < w) return i;
    target -= w;
  }
  // Floating-point slack: fall back to the last positive weight.
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}

export interface PickOptions {
  /** Reference time for recency. */
  now: Date | number;
  /** Random source in `[0, 1)`; use `createSeededRandom(seed)` for reproducible picks. */
  random: RandomSource;
  /** Recent pick ids, most recent last (only the last `PICK_HISTORY_SIZE` are honored). */
  exclude?: readonly string[];
}

/**
 * Pick one owned polish. Returns null only when the user owns nothing.
 */
export function pickForMe(polishes: Polish[], options: PickOptions): PickResult | null {
  const candidates = scorePickCandidates(polishes, options.now);
  if (candidates.length === 0) return null;

  const recent = (options.exclude ?? []).slice(-PICK_HISTORY_SIZE);
  const last = recent.length > 0 ? [recent[recent.length - 1]] : [];
  // Strict "no repeat of the last 3"; relax to "not the last one", then to anything.
  for (const excluded of [recent, last, []]) {
    const skip = new Set(excluded);
    const pool = candidates.filter((c) => !skip.has(c.polish.id));
    if (pool.length === 0) continue;

    let index = weightedIndex(pool.map((c) => c.weight), options.random);
    if (index < 0) {
      // Everything left is in the wear cooldown: ignore it rather than return nothing.
      index = weightedIndex(
        pool.map((c) => c.factors.tried * recencyFactor(c.daysSinceWorn, true) * c.factors.gap),
        options.random
      );
    }
    if (index < 0) continue;

    const candidate = pool[index];
    return {
      polish: candidate.polish,
      candidate,
      reasons:
        candidate.reasons.length > 0 ? candidate.reasons : [{ kind: "random", label: "A random pick from your collection" }],
      poolSize: pool.length,
    };
  }
  return null;
}

/** Append a pick to the session history, keeping the last `PICK_HISTORY_SIZE` ids. */
export function pushPickHistory(history: readonly string[], id: string): string[] {
  return [...history.filter((h) => h !== id), id].slice(-PICK_HISTORY_SIZE);
}

// ── Pair it ──────────────────────────────────────────────────

/** Largest OKLAB distance between a harmony target and an owned polish to count as a pairing. */
export const PAIR_MAX_DISTANCE = 0.12;

/** Below this OKLCH chroma the pick reads as neutral and has no meaningful hue harmony. */
export const PAIR_NEUTRAL_MAX_CHROMA = 0.04;

/** Finishes that make a polish an accent topper candidate (`topper` preferred). */
export const TOPPER_FINISHES = ["topper", "flake", "glitter"] as const;

/** Most pairings suggested for one pick. */
export const MAX_PAIRINGS = 2;

export type PairHarmony = "complementary" | "analogous" | "topper";

export interface PairSuggestion {
  polish: Polish;
  harmony: PairHarmony;
  /** Role to log it with in a manicure. */
  role: ManicurePolishRole;
  label: string;
  /** OKLAB distance to the harmony target (null for toppers, which are chosen by finish). */
  distance: number | null;
}

function finishSet(polish: Polish): Set<string> {
  return new Set(resolvePolishFinishes(polish).map((f) => f.toLowerCase()));
}

function topperRank(polish: Polish): number {
  // A topper by category ranks with the `topper` finish (#349).
  if (resolveProductCategory(polish.productCategory) === "topper") return 0;
  const finishes = finishSet(polish);
  const index = TOPPER_FINISHES.findIndex((f) => finishes.has(f));
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

function byName(a: Polish, b: Polish): number {
  return a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * Owned polish nearest to any harmony target, within `PAIR_MAX_DISTANCE`. A candidate must be
 * closer to the target than to the pick itself, so near-duplicates of the pick never count as a
 * (small-rotation) analogous pairing.
 */
function nearest(
  pool: Polish[],
  targets: string[],
  pickHex: string,
  hexById: Map<string, string | undefined>
): { polish: Polish; distance: number } | null {
  let best: { polish: Polish; distance: number } | null = null;
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
 * Only color polishes and toppers are paired; coats, treatments and accessories never are (#349).
 *
 * Hue harmonies need a non-neutral pick (chroma ≥ `PAIR_NEUTRAL_MAX_CHROMA`) and a match within
 * `PAIR_MAX_DISTANCE` that is closer to the harmony target than to the pick. Order: the closer hue match, then the topper, then the other hue match.
 */
export function suggestPairings(pick: Polish, polishes: Polish[], max: number = MAX_PAIRINGS): PairSuggestion[] {
  if (max <= 0) return [];
  const pool = polishes.filter((p) => {
    if (!isOwnedPolish(p) || p.id === pick.id) return false;
    const category = resolveProductCategory(p.productCategory);
    return category === "color" || category === "topper";
  });
  const toppers = pool.filter((p) => Number.isFinite(topperRank(p)));
  const colorPool = pool.filter((p) => !Number.isFinite(topperRank(p)));
  const hexById = new Map(pool.map((p) => [p.id, displayHex(p)]));

  const hueMatches: PairSuggestion[] = [];
  const pickHex = displayHex(pick);
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

  let topper: PairSuggestion | null = null;
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

  const ordered = [hueMatches[0], topper, hueMatches[1]].filter((s): s is PairSuggestion => Boolean(s));
  return ordered.slice(0, max);
}
