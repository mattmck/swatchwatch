import {
  DEFAULT_VIBE,
  LOOK_FINISHES,
  LOOK_MOODS,
  LOOK_OCCASIONS,
  type LookFinish,
  type LookMood,
  type LookOccasion,
  type Vibe,
} from "./looks";
import { parsePositiveInt, type ReadableParams } from "./polish-list-url";

/**
 * URL state for `/polishes/looks`: `occasion`, `mood`, `finish` (omitted = any), `owned=1` and
 * `seed` (Shuffle). Defaults are omitted so the bare route is the default vibe; back/forward and
 * shared links reproduce the same looks because the recommender is seeded.
 */
export interface LooksState {
  vibe: Vibe;
  seed: number;
}

export const DEFAULT_LOOKS_SEED = 1;

export const DEFAULT_LOOKS_STATE: LooksState = { vibe: DEFAULT_VIBE, seed: DEFAULT_LOOKS_SEED };

function pick<T extends string>(values: readonly T[], raw: string | null): T | null {
  const value = raw?.trim().toLowerCase();
  return value && (values as readonly string[]).includes(value) ? (value as T) : null;
}

export function parseLooksState(params: ReadableParams): LooksState {
  const owned = params.get("owned")?.trim().toLowerCase();
  return {
    vibe: {
      occasion: pick<LookOccasion>(LOOK_OCCASIONS, params.get("occasion")) ?? DEFAULT_VIBE.occasion,
      mood: pick<LookMood>(LOOK_MOODS, params.get("mood")) ?? DEFAULT_VIBE.mood,
      finish: pick<LookFinish>(LOOK_FINISHES, params.get("finish")),
      ownedOnly: owned === "1" || owned === "true",
    },
    seed: parsePositiveInt(params.get("seed"), DEFAULT_LOOKS_SEED),
  };
}

/** Canonical query string (defaults omitted). */
export function buildLooksQueryString(state: LooksState): string {
  const params = new URLSearchParams();
  if (state.vibe.occasion !== DEFAULT_VIBE.occasion) params.set("occasion", state.vibe.occasion);
  if (state.vibe.mood !== DEFAULT_VIBE.mood) params.set("mood", state.vibe.mood);
  if (state.vibe.finish) params.set("finish", state.vibe.finish);
  if (state.vibe.ownedOnly) params.set("owned", "1");
  if (state.seed !== DEFAULT_LOOKS_SEED) params.set("seed", String(state.seed));
  return params.toString();
}

/**
 * The shareable link for a vibe: the page URL with the vibe and seed (nothing personal). The
 * recipient sees the same vibe built from their own collection, not this person's polishes.
 */
export function lookShareUrl(origin: string, pathname: string, state: LooksState): string {
  const qs = buildLooksQueryString(state);
  return `${origin}${pathname}${qs ? `?${qs}` : ""}`;
}
