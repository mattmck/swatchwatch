import {
  DEFAULT_VIBE,
  LOOK_FINISHES,
  LOOK_MOODS,
  LOOK_OCCASIONS,
  SKIN_DEPTHS,
  SKIN_UNDERTONES,
  skinToneFrom,
  type LookFinish,
  type LookMood,
  type LookOccasion,
  type SkinDepth,
  type SkinUndertone,
  type Vibe,
} from "./looks";
import { parsePositiveInt, type ReadableParams } from "./polish-list-url";
import { DEFAULT_COLOR_SEARCH_STATE, MAX_PALETTE_ANCHORS, colorSearchHref, parseHexParam } from "./color-search-url";
import type { LookStep } from "./looks";

/**
 * URL state for `/polishes/looks`: `occasion`, `mood`, `finish` (omitted = any), `owned=1`,
 * `toppers=0` (Include toppers off, #386), `undertone` / `depth` (skin tone; either one sets the
 * other to its no-preference value, so `?undertone=warm` is warm + medium) and `seed` (Shuffle). Defaults are omitted so the bare
 * route is the default vibe and links made before a field existed keep their meaning; back/forward
 * and shared links reproduce the same looks because the recommender is seeded.
 */
export interface LooksState {
  vibe: Vibe;
  seed: number;
  /** Include toppers (default on). Kept out of `Vibe` because saved looks store the vibe. */
  toppers: boolean;
}

export const DEFAULT_LOOKS_SEED = 1;

export const DEFAULT_LOOKS_STATE: LooksState = { vibe: DEFAULT_VIBE, seed: DEFAULT_LOOKS_SEED, toppers: true };

function pick<T extends string>(values: readonly T[], raw: string | null): T | null {
  const value = raw?.trim().toLowerCase();
  return value && (values as readonly string[]).includes(value) ? (value as T) : null;
}

export function parseLooksState(params: ReadableParams): LooksState {
  const owned = params.get("owned")?.trim().toLowerCase();
  const toppers = params.get("toppers")?.trim().toLowerCase();
  const skinTone = skinToneFrom(
    pick<SkinUndertone>(SKIN_UNDERTONES, params.get("undertone")),
    pick<SkinDepth>(SKIN_DEPTHS, params.get("depth"))
  );
  return {
    vibe: {
      occasion: pick<LookOccasion>(LOOK_OCCASIONS, params.get("occasion")) ?? DEFAULT_VIBE.occasion,
      mood: pick<LookMood>(LOOK_MOODS, params.get("mood")) ?? DEFAULT_VIBE.mood,
      finish: pick<LookFinish>(LOOK_FINISHES, params.get("finish")),
      ownedOnly: owned === "1" || owned === "true",
      ...(skinTone ? { skinTone } : {}),
    },
    seed: parsePositiveInt(params.get("seed"), DEFAULT_LOOKS_SEED),
    toppers: !(toppers === "0" || toppers === "false"),
  };
}

/** Canonical query string (defaults omitted). */
export function buildLooksQueryString(state: LooksState): string {
  const params = new URLSearchParams();
  if (state.vibe.occasion !== DEFAULT_VIBE.occasion) params.set("occasion", state.vibe.occasion);
  if (state.vibe.mood !== DEFAULT_VIBE.mood) params.set("mood", state.vibe.mood);
  if (state.vibe.finish) params.set("finish", state.vibe.finish);
  if (state.vibe.ownedOnly) params.set("owned", "1");
  if (!state.toppers) params.set("toppers", "0");
  if (state.vibe.skinTone) {
    params.set("undertone", state.vibe.skinTone.undertone);
    params.set("depth", state.vibe.skinTone.depth);
  }
  if (state.seed !== DEFAULT_LOOKS_SEED) params.set("seed", String(state.seed));
  return params.toString();
}

/**
 * The shareable link for a vibe: the page URL with the vibe and seed (nothing personal). The
 * recipient sees the same vibe built from their own collection, not this person's polishes.
 */
export function lookShareUrl(origin: string, pathname: string, state: LooksState): string {
  // Skin tone is personal: it stays out of the copied link.
  const qs = buildLooksQueryString({ ...state, vibe: { ...state.vibe, skinTone: null } });
  return `${origin}${pathname}${qs ? `?${qs}` : ""}`;
}

/**
 * "Open in Color Lab" (#386): `/polishes/search` seeded with a look's palette. The wheel starts on
 * the base color, every step's hex (base, accent, topper; deduplicated, in step order) becomes a
 * focused color, and `returnTo` (this page with its vibe + seed + toppers) gives the search page a
 * "Back to Looks" link.
 */
export function lookColorLabHref(steps: readonly Pick<LookStep, "role" | "hex">[], returnTo: string | null): string {
  const palette: string[] = [];
  for (const step of steps) {
    const hex = parseHexParam(step.hex);
    if (hex && !palette.includes(hex)) palette.push(hex);
  }
  const base = steps.find((s) => s.role === "base");
  return colorSearchHref({
    ...DEFAULT_COLOR_SEARCH_STATE,
    color: parseHexParam(base?.hex) ?? palette[0] ?? null,
    paletteAnchors: palette.slice(0, MAX_PALETTE_ANCHORS),
    returnTo,
  });
}
