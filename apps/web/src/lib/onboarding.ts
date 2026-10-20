/**
 * First-run "Getting started" checklist (M2 metric: signup → 20 polishes in under 5 minutes,
 * `docs/roadmap-2026-10-to-12.md` §4). DOM-free so it can be unit tested; the component is
 * `components/getting-started.tsx`.
 *
 * Visibility: a user who owns fewer than `ONBOARDING_SHOW_BELOW` polishes sees the checklist and
 * is marked as "started" (localStorage). A started user keeps seeing their progress until they
 * own `ONBOARDING_GOAL`, then gets a completed card they dismiss. Closing it hides it for good.
 * Users who already owned 5+ before this shipped never see it.
 */
import { hasActiveFilters, statusPresetFor, type PolishesListState } from "./polish-list-url";

export const ONBOARDING_GOAL = 20;
export const ONBOARDING_SHOW_BELOW = 5;

export type GettingStartedStepId = "import" | "scan" | "search";

/** `/polishes` lists every polish by default; `focus=search` focuses the search box on load. */
export const CATALOG_SEARCH_HREF = "/polishes?focus=search";

export interface GettingStartedStep {
  id: GettingStartedStepId;
  href: string;
}

/** The three ways in, fastest first. */
export const GETTING_STARTED_STEPS: readonly GettingStartedStep[] = [
  { id: "import", href: "/polishes/import" },
  { id: "scan", href: "/rapid-add" },
  { id: "search", href: CATALOG_SEARCH_HREF },
];

const STEP_ORDER = GETTING_STARTED_STEPS.map((step) => step.id);

export interface OnboardingProgress {
  count: number;
  goal: number;
  percent: number;
  label: string;
}

export function onboardingProgress(ownedCount: number): OnboardingProgress {
  const safe = Number.isFinite(ownedCount) ? Math.max(0, Math.floor(ownedCount)) : 0;
  const count = Math.min(safe, ONBOARDING_GOAL);
  return {
    count,
    goal: ONBOARDING_GOAL,
    percent: Math.round((count / ONBOARDING_GOAL) * 100),
    label: `${count} of ${ONBOARDING_GOAL} polishes`,
  };
}

export interface GettingStartedState {
  /** The checklist was shown while the user owned fewer than `ONBOARDING_SHOW_BELOW`. */
  started: boolean;
  /** The user closed it (or dismissed the completed card). */
  dismissed: boolean;
  /** Steps the user has opened from the checklist, in step order. */
  visited: GettingStartedStepId[];
}

const FRESH_STATE: GettingStartedState = { started: false, dismissed: false, visited: [] };

function normalizeVisited(values: Iterable<unknown>): GettingStartedStepId[] {
  const set = new Set<unknown>(values);
  return STEP_ORDER.filter((id) => set.has(id));
}

export function parseGettingStartedState(raw: string | null): GettingStartedState {
  if (!raw) return { ...FRESH_STATE, visited: [] };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return { ...FRESH_STATE, visited: [] };
    const record = value as Record<string, unknown>;
    return {
      started: record.started === true,
      dismissed: record.dismissed === true,
      visited: Array.isArray(record.visited) ? normalizeVisited(record.visited) : [],
    };
  } catch {
    return { ...FRESH_STATE, visited: [] };
  }
}

export function serializeGettingStartedState(state: GettingStartedState): string {
  return JSON.stringify({
    started: state.started,
    dismissed: state.dismissed,
    visited: normalizeVisited(state.visited),
  });
}

export type GettingStartedView = "hidden" | "active" | "complete";

export function gettingStartedView(ownedCount: number, state: GettingStartedState): GettingStartedView {
  if (state.dismissed) return "hidden";
  if (ownedCount >= ONBOARDING_GOAL) return state.started ? "complete" : "hidden";
  if (ownedCount < ONBOARDING_SHOW_BELOW || state.started) return "active";
  return "hidden";
}

/** Returns the same object when nothing changes, so callers can skip a storage write. */
export function markGettingStartedStarted(state: GettingStartedState, ownedCount: number): GettingStartedState {
  if (state.started || ownedCount >= ONBOARDING_SHOW_BELOW) return state;
  return { ...state, started: true };
}

export function dismissGettingStarted(state: GettingStartedState): GettingStartedState {
  return { ...state, dismissed: true };
}

export function markStepVisited(state: GettingStartedState, step: GettingStartedStepId): GettingStartedState {
  return { ...state, visited: normalizeVisited([...state.visited, step]) };
}

const STORAGE_KEY_PREFIX = "swatchwatch-getting-started";

/** Per user, so two people sharing a browser each keep their own choice. */
export function gettingStartedStorageKey(userId: string | null | undefined): string {
  return userId ? `${STORAGE_KEY_PREFIX}:${userId}` : STORAGE_KEY_PREFIX;
}

/** `/polishes?focus=search` (from the checklist and empty states) focuses the search box. */
export function shouldFocusSearch(params: Pick<URLSearchParams, "get">): boolean {
  return params.get("focus") === "search";
}

/** Which `/polishes` empty state fits the current filters. */
export type PolishesEmptyStateKind = "collection" | "wishlist" | "status" | "filtered" | "catalog";

export function polishesEmptyStateKind(
  state: Pick<PolishesListState, "search" | "statuses" | "untried" | "toneFilter" | "finishFilter" | "familyFilter">
): PolishesEmptyStateKind {
  // Any filter besides the status presets (search, untried, tone, finish, color family).
  if (hasActiveFilters({ ...state, statuses: [] })) return "filtered";
  const preset = statusPresetFor(state.statuses);
  if (preset === "collection") return "collection";
  if (preset === "wishlist") return "wishlist";
  if (preset === "custom") return "status";
  return "catalog";
}
