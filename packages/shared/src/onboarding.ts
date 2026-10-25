/**
 * First-run "Getting started" checklist rules (M2 metric: signup → 20 polishes in under 5 minutes,
 * `docs/roadmap-2026-10-to-12.md` §4), shared by the web dashboard and the Expo Home panel. Pure
 * and platform-free; each app keeps its own storage and maps step ids to routes.
 *
 * Visibility: a user who owns fewer than `ONBOARDING_SHOW_BELOW` polishes sees the checklist and
 * is marked as "started". A started user keeps seeing their progress until they own
 * `ONBOARDING_GOAL`, then gets a completed card they dismiss. Closing it hides it for good.
 * Users who already owned 5+ before this shipped never see it.
 */

export const ONBOARDING_GOAL = 20;
export const ONBOARDING_SHOW_BELOW = 5;

export type GettingStartedStepId = "import" | "scan" | "search";

export interface GettingStartedStep {
  id: GettingStartedStepId;
  /** Short action label; each app maps the id to its own route. */
  label: string;
}

/** The three ways in, fastest first. */
export const GETTING_STARTED_STEPS: readonly GettingStartedStep[] = [
  { id: "import", label: "Import a spreadsheet" },
  { id: "scan", label: "Scan a bottle" },
  { id: "search", label: "Search the catalog" },
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
