/**
 * "Pick for me" (#272), mirrored from `apps/web/src/lib/pick-for-me.ts` (weighting, no-repeat
 * history and reasons). "Pair it" uses the shared rule (`suggestPairings` from swatchwatch-shared
 * `color/pair-it.ts`, the same one the web uses). Pure: the clock and random source are inputs,
 * so a seeded source reproduces a pick.
 *
 * Only owned (`status === "owned"`) color polishes are candidates: toppers, coats, treatments and
 * accessories are never the main pick (#349 D-C); Pair it may add an owned topper. Weight = tried × recency × gap:
 * untried ×3; recency 0 when worn in the last 2 days, ×2 when never worn, otherwise ramping
 * 1 → 2 over 90 days; ×2 when the polish sits in a thin hue × lightness cell of the
 * collection's gap heatmap (`analyzeCollectionGaps` on the web, mirrored below). A weight of 0
 * (cooldown) is only ignored when every remaining candidate is in cooldown.
 */
import {
  hexToOklab,
  resolveDisplayHex,
  resolvePolishFinishes,
  resolveProductCategory,
  type ManicureCreateRequest,
  type PairSuggestion,
  type Polish,
} from "swatchwatch-shared";
import { isOwnedPolish, quickLogRole } from "./status";

export { MAX_PAIRINGS, PAIR_MAX_DISTANCE, suggestPairings, type PairSuggestion } from "swatchwatch-shared";

/** Same constants as the web's `PICK_WEIGHTS`; change them together. */
export const PICK_WEIGHTS = {
  untriedMultiplier: 3,
  staleMaxMultiplier: 2,
  staleFullDays: 90,
  recentWearCooldownDays: 2,
  gapThinMultiplier: 2,
} as const;

export const PICK_HISTORY_SIZE = 3;
export const NOT_WORN_REASON_MIN_DAYS = 30;

const DAY_MS = 86_400_000;
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export type RandomSource = () => number;

/** Deterministic PRNG (mulberry32) returning floats in `[0, 1)`. */
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

// ── Gap heatmap (mirrors the web's color-utils: classifyHueFamily / LightnessBand) ─────────

const HUE_FAMILIES = ["reds", "oranges-corals", "yellows-golds", "greens", "blues-teals", "purples-violets", "pinks-magentas", "neutrals"] as const;
const LIGHTNESS_BANDS = ["dark", "dark-medium", "medium", "medium-light", "light"] as const;

function gapCellKey(hex: string): string | null {
  if (!HEX_RE.test(hex)) return null;
  const { L, a, b } = hexToOklab(hex);
  const C = Math.sqrt(a * a + b * b);
  const h = C < 1e-8 ? NaN : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  let hue: (typeof HUE_FAMILIES)[number];
  if (C < 0.04 || Number.isNaN(h)) hue = "neutrals";
  else if (h >= 350 || h < 10) hue = "reds";
  else if (h < 40) hue = "oranges-corals";
  else if (h < 80) hue = "yellows-golds";
  else if (h < 170) hue = "greens";
  else if (h < 260) hue = "blues-teals";
  else if (h < 310) hue = "purples-violets";
  else hue = "pinks-magentas";
  const band = L < 0.3 ? "dark" : L < 0.44 ? "dark-medium" : L < 0.6 ? "medium" : L < 0.76 ? "medium-light" : "light";
  return `${hue}:${band}`;
}

/** Keys of cells with a few polishes (`count > 0 && count <= max(1, floor(avg × 0.5))`). */
export function thinGapCells(hexes: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const hex of hexes) {
    const key = gapCellKey(hex);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const cellCount = HUE_FAMILIES.length * LIGHTNESS_BANDS.length;
  const low = Math.max(1, Math.floor((hexes.length / cellCount) * 0.5));
  return new Set([...counts].filter(([, count]) => count > 0 && count <= low).map(([key]) => key));
}

// ── Scoring and picking ─────────────────────────────────────────────────────────────────

export interface PickReason {
  kind: "untried" | "never-worn" | "not-worn" | "gap" | "random";
  label: string;
}

export interface PickCandidate {
  polish: Polish;
  weight: number;
  tried: number;
  gap: number;
  reasons: PickReason[];
  daysSinceWorn: number | null;
}

export interface PickResult {
  polish: Polish;
  reasons: PickReason[];
  poolSize: number;
}

function daysBetween(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.floor((nowMs - ms) / DAY_MS)) : null;
}

function recencyFactor(days: number | null, ignoreCooldown = false): number {
  const { staleMaxMultiplier, staleFullDays, recentWearCooldownDays } = PICK_WEIGHTS;
  if (days === null) return staleMaxMultiplier;
  if (days < recentWearCooldownDays) return ignoreCooldown ? 1 : 0;
  return 1 + ((staleMaxMultiplier - 1) * Math.min(days, staleFullDays)) / staleFullDays;
}

export function formatRestPeriod(days: number): string {
  if (days >= 60) return `${Math.floor(days / 30)} months`;
  if (days >= 14) return `${Math.floor(days / 7)} weeks`;
  return `${days} days`;
}

export function scorePickCandidates(polishes: readonly Polish[], now: Date | number): PickCandidate[] {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const owned = polishes.filter((p) => isOwnedPolish(p) && resolveProductCategory(p.productCategory) === "color");
  const hexOf = (p: Polish) => {
    const hex = resolveDisplayHex(p);
    return hex && HEX_RE.test(hex) ? hex : undefined;
  };
  const thin = thinGapCells(owned.map(hexOf).filter((h): h is string => Boolean(h)));

  return owned.map((polish) => {
    const hex = hexOf(polish);
    const cell = hex ? gapCellKey(hex) : null;
    const isThin = cell !== null && thin.has(cell);
    const untried = !polish.triedAt;
    const days = daysBetween(polish.lastWornAt, nowMs);
    const tried = untried ? PICK_WEIGHTS.untriedMultiplier : 1;
    const gap = isThin ? PICK_WEIGHTS.gapThinMultiplier : 1;

    const reasons: PickReason[] = [];
    if (untried) reasons.push({ kind: "untried", label: "Untried" });
    else if (days === null) reasons.push({ kind: "never-worn", label: "No wears logged yet" });
    if (days !== null && days >= NOT_WORN_REASON_MIN_DAYS) {
      reasons.push({ kind: "not-worn", label: `Not worn in ${formatRestPeriod(days)}` });
    }
    if (isThin) reasons.push({ kind: "gap", label: "Fills a gap in your collection" });

    return { polish, weight: tried * recencyFactor(days) * gap, tried, gap, reasons, daysSinceWorn: days };
  });
}

function weightedIndex(weights: number[], random: RandomSource): number {
  const total = weights.reduce((sum, w) => sum + (w > 0 ? w : 0), 0);
  if (!(total > 0)) return -1;
  let target = random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i] > 0 ? weights[i] : 0;
    if (w === 0) continue;
    if (target < w) return i;
    target -= w;
  }
  for (let i = weights.length - 1; i >= 0; i -= 1) if (weights[i] > 0) return i;
  return -1;
}

/** Pick one owned polish, never repeating the last `PICK_HISTORY_SIZE` picks while others exist. */
export function pickForMe(
  polishes: readonly Polish[],
  options: { now: Date | number; random: RandomSource; exclude?: readonly string[] },
): PickResult | null {
  const candidates = scorePickCandidates(polishes, options.now);
  if (candidates.length === 0) return null;
  const recent = (options.exclude ?? []).slice(-PICK_HISTORY_SIZE);
  const last = recent.length > 0 ? [recent[recent.length - 1]] : [];
  for (const excluded of [recent, last, []]) {
    const skip = new Set(excluded);
    const pool = candidates.filter((c) => !skip.has(c.polish.id));
    if (pool.length === 0) continue;
    let index = weightedIndex(pool.map((c) => c.weight), options.random);
    if (index < 0) {
      index = weightedIndex(pool.map((c) => c.tried * recencyFactor(c.daysSinceWorn, true) * c.gap), options.random);
    }
    if (index < 0) continue;
    const chosen = pool[index];
    return {
      polish: chosen.polish,
      reasons: chosen.reasons.length > 0 ? chosen.reasons : [{ kind: "random", label: "A random pick from your collection" }],
      poolSize: pool.length,
    };
  }
  return null;
}

export function pushPickHistory(history: readonly string[], id: string): string[] {
  return [...history.filter((h) => h !== id), id].slice(-PICK_HISTORY_SIZE);
}

/**
 * The `POST /api/manicures` body for "Log today's mani" on the pick card: the pick as the main
 * polish (`color`, or `topper` for a topper finish) followed by the selected pairings with their
 * suggested roles (accent / topper), like the web's `ManiLogForm` prefill.
 */
export function buildPickManicure(
  pick: Polish,
  pairings: readonly PairSuggestion<Polish>[],
  selectedIds: ReadonlySet<string>,
  wornOn: string,
): ManicureCreateRequest {
  return {
    wornOn,
    polishes: [
      { shadeId: pick.id, role: quickLogRole(resolvePolishFinishes(pick)) },
      ...pairings
        .filter((p) => selectedIds.has(p.polish.id) && p.polish.id !== pick.id)
        .map((p) => ({ shadeId: p.polish.id, role: p.role })),
    ],
  };
}
