/**
 * First-run "Getting started" checklist. The rules (progress, state, visibility) live in
 * `swatchwatch-shared` (`packages/shared/src/onboarding.ts`) so the mobile app uses the same
 * ones; this file re-exports them and adds the web routes and `/polishes` helpers. The
 * component is `components/getting-started.tsx`.
 */
import {
  GETTING_STARTED_STEPS as SHARED_STEPS,
  type GettingStartedStepId,
} from "swatchwatch-shared";
import { hasActiveFilters, statusPresetFor, type PolishesListState } from "./polish-list-url";

export {
  ONBOARDING_GOAL,
  ONBOARDING_SHOW_BELOW,
  dismissGettingStarted,
  gettingStartedStorageKey,
  gettingStartedView,
  markGettingStartedStarted,
  markStepVisited,
  onboardingProgress,
  parseGettingStartedState,
  serializeGettingStartedState,
  type GettingStartedState,
  type GettingStartedStepId,
  type GettingStartedView,
  type OnboardingProgress,
} from "swatchwatch-shared";

/** `/polishes` lists every polish by default; `focus=search` focuses the search box on load. */
export const CATALOG_SEARCH_HREF = "/polishes?focus=search";

export interface GettingStartedStep {
  id: GettingStartedStepId;
  href: string;
}

const WEB_STEP_HREFS: Record<GettingStartedStepId, string> = {
  import: "/polishes/import",
  scan: "/rapid-add",
  search: CATALOG_SEARCH_HREF,
};

/** The three ways in, fastest first. */
export const GETTING_STARTED_STEPS: readonly GettingStartedStep[] = SHARED_STEPS.map((step) => ({
  id: step.id,
  href: WEB_STEP_HREFS[step.id],
}));

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
