/**
 * M2 success-metric events (decision D19, #323; roadmap `docs/roadmap-2026-10-to-12.md` §4).
 *
 * The dupe-warning funnel only exists in the browser, so it is measured with App Insights
 * custom events (as are the Looks page events `looks.generated` / `looks.wear_clicked`); status adoption, manis per week and time to 20 polishes come from the weekly
 * Postgres query in `docs/queries/m2-metrics.sql`. `mani.logged` and `import.completed` are
 * browser-side cross-checks for those numbers. `onboarding.step_clicked` shows which way in
 * (import, scan, catalog search) new users pick on the way to 20 polishes.
 *
 * Every helper goes through `trackEvent` (a no-op without a connection string) and sends counts
 * and enum values only: never an email, a name or free text. The signed-in user is attached by
 * `setUser` (internal user id) in `TelemetryProvider`.
 */
import type {
  MatchConfidence,
  MatchScope,
  PolishDupesResponse,
  PolishImportCommitResult,
  PolishStatus,
} from "swatchwatch-shared";
import type { Look, Vibe } from "./looks";
import type { GettingStartedStepId } from "./onboarding";
import { trackEvent } from "./telemetry";

export const METRIC_EVENTS = {
  dupeWarningShown: "dupe.warning_shown",
  dupeWarningOutcome: "dupe.warning_outcome",
  maniLogged: "mani.logged",
  importCompleted: "import.completed",
  looksGenerated: "looks.generated",
  looksWearClicked: "looks.wear_clicked",
  looksColorLabOpened: "looks.color_lab_opened",
  onboardingStepClicked: "onboarding.step_clicked",
  matchImageProcessed: "match.image_processed",
  matchResultAction: "match.result_action",
} as const;

export type MetricEventName = (typeof METRIC_EVENTS)[keyof typeof METRIC_EVENTS];

/**
 * Where a dupe warning appeared: the add guard adding to the collection (`add_form`: list rows,
 * color search, `/polishes/new`) or to the wishlist (`wishlist`), or Rapid Add's verdict card.
 */
export type DupeWarningSurface = "add_form" | "wishlist" | "rapid_add";

/** What the user did after the warning. `cancel` and `wishlist_instead` count as "avoided". */
export type DupeWarningOutcome = "cancel" | "wishlist_instead" | "add_anyway";

export type DupeWarningGrade = "HIGH" | "MEDIUM";

export type MetricProperties = Record<string, string | number | boolean>;

export interface MetricEvent {
  name: MetricEventName;
  properties: MetricProperties;
}

/** Injected in tests; defaults to the lazy-loaded App Insights client. */
export type MetricTracker = (name: string, properties: MetricProperties) => void;

const defaultTracker: MetricTracker = (name, properties) => trackEvent(name, properties);

function emit(event: MetricEvent, tracker: MetricTracker): void {
  tracker(event.name, event.properties);
}

/** Add-guard intent → funnel surface. */
export function dupeSurfaceForIntent(intent: "own" | "wishlist"): DupeWarningSurface {
  return intent === "wishlist" ? "wishlist" : "add_form";
}

/** Grade of the best owned dupe (the response lists best first), or null when there is none. */
export function bestDupeGrade(
  response: Pick<PolishDupesResponse, "dupes"> | null | undefined
): DupeWarningGrade | null {
  const grade = response?.dupes[0]?.grade;
  if (grade === "high") return "HIGH";
  if (grade === "medium") return "MEDIUM";
  return null;
}

export interface DupeWarningInput {
  surface: DupeWarningSurface;
  response: Pick<PolishDupesResponse, "dupes" | "dupeCount">;
  /** Surface-specific, non-PII extras (page, intent, catalog shade id, …). Never override the funnel keys. */
  details?: MetricProperties;
}

function dupeWarningProperties(input: DupeWarningInput): MetricProperties {
  const properties: MetricProperties = {
    ...input.details,
    surface: input.surface,
    dupeCount: input.response.dupeCount,
  };
  const grade = bestDupeGrade(input.response);
  if (grade) properties.bestGrade = grade;
  else delete properties.bestGrade;
  return properties;
}

export function dupeWarningShownEvent(input: DupeWarningInput): MetricEvent {
  return { name: METRIC_EVENTS.dupeWarningShown, properties: dupeWarningProperties(input) };
}

export function dupeWarningOutcomeEvent(
  input: DupeWarningInput & { outcome: DupeWarningOutcome }
): MetricEvent {
  return {
    name: METRIC_EVENTS.dupeWarningOutcome,
    properties: { ...dupeWarningProperties(input), outcome: input.outcome },
  };
}

/** How a mani was logged: the one-tap button or the full form. */
export type ManiLogVia = "quick" | "form";

export function maniLoggedEvent(input: { polishCount: number; via: ManiLogVia }): MetricEvent {
  return {
    name: METRIC_EVENTS.maniLogged,
    properties: { polishCount: input.polishCount, via: input.via },
  };
}

export function importCompletedEvent(result: PolishImportCommitResult): MetricEvent {
  return {
    name: METRIC_EVENTS.importCompleted,
    properties: {
      rowsCommitted: result.created + result.updated,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      shadesCreated: result.shadesCreated,
    },
  };
}

/**
 * Where an onboarding step was tapped: the dashboard checklist (`GettingStarted`) or the empty
 * state of a page that needs a collection first.
 */
export type OnboardingSurface =
  | "dashboard_checklist"
  | "dashboard_stats_empty"
  | "polishes_empty"
  | "manis_empty"
  | "gaps_empty"
  | "match_empty";

export interface OnboardingStepInput {
  step: GettingStartedStepId;
  surface: OnboardingSurface;
  /** Owned polishes when the step was tapped (where the user was on the way to 20). */
  ownedCount: number;
}

export function onboardingStepClickedEvent(input: OnboardingStepInput): MetricEvent {
  const ownedCount = Number.isFinite(input.ownedCount) ? Math.max(0, Math.floor(input.ownedCount)) : 0;
  return {
    name: METRIC_EVENTS.onboardingStepClicked,
    properties: { step: input.step, surface: input.surface, ownedCount },
  };
}

// ── Photo match (#105) ───────────────────────────────────────────────────────

/** What started a match: a new photo (`upload` covers drag-and-drop), a focused area, or a filter change. */
export type MatchImageTrigger = "upload" | "camera" | "region" | "filters";

export interface MatchImageProcessedInput {
  trigger: MatchImageTrigger;
  scope: MatchScope;
  finishFiltered: boolean;
  familyFilterCount: number;
  /** Palette size returned by the API. */
  extractedColorCount: number;
  /** Background / skin colors hidden by default. */
  hiddenColorCount: number;
  candidateCount: number;
  /** Flat matches over the active colors, and how many of them are close / similar. */
  matchCount: number;
  highCount: number;
  mediumCount: number;
  /** Request round trip in ms (rounded); omitted for a cached response. */
  durationMs?: number;
  cached: boolean;
}

export function matchImageProcessedEvent(input: MatchImageProcessedInput): MetricEvent {
  const properties: MetricProperties = {
    trigger: input.trigger,
    scope: input.scope,
    finishFiltered: input.finishFiltered,
    familyFilterCount: input.familyFilterCount,
    extractedColorCount: input.extractedColorCount,
    hiddenColorCount: input.hiddenColorCount,
    candidateCount: input.candidateCount,
    matchCount: input.matchCount,
    highCount: input.highCount,
    mediumCount: input.mediumCount,
    cached: input.cached,
  };
  if (input.durationMs !== undefined) properties.durationMs = Math.round(input.durationMs);
  return { name: METRIC_EVENTS.matchImageProcessed, properties };
}

/** What the user did with a match row. */
export type MatchResultAction = "open" | "wishlist" | "remove_wishlist" | "own" | "status" | "tried" | "quantity";

export interface MatchResultActionInput {
  action: MatchResultAction;
  scope: MatchScope;
  view: "colors" | "list";
  confidence: MatchConfidence;
  /** 1-based position of the row in its list. */
  rank: number;
  /** Inventory status before the action (`none` for a catalog-only shade). */
  fromStatus: PolishStatus | null | undefined;
}

export function matchResultActionEvent(input: MatchResultActionInput): MetricEvent {
  return {
    name: METRIC_EVENTS.matchResultAction,
    properties: {
      action: input.action,
      scope: input.scope,
      view: input.view,
      confidence: input.confidence,
      rank: input.rank,
      fromStatus: input.fromStatus ?? "none",
    },
  };
}

export function trackMatchImageProcessed(
  input: MatchImageProcessedInput,
  tracker: MetricTracker = defaultTracker
): void {
  emit(matchImageProcessedEvent(input), tracker);
}

export function trackMatchResultAction(input: MatchResultActionInput, tracker: MetricTracker = defaultTracker): void {
  emit(matchResultActionEvent(input), tracker);
}

export function trackDupeWarningShown(input: DupeWarningInput, tracker: MetricTracker = defaultTracker): void {
  emit(dupeWarningShownEvent(input), tracker);
}

export function trackDupeWarningOutcome(
  input: DupeWarningInput & { outcome: DupeWarningOutcome },
  tracker: MetricTracker = defaultTracker
): void {
  emit(dupeWarningOutcomeEvent(input), tracker);
}

export function trackManiLogged(
  input: { polishCount: number; via: ManiLogVia },
  tracker: MetricTracker = defaultTracker
): void {
  emit(maniLoggedEvent(input), tracker);
}

/** Skip `alreadyCommitted` responses (a retried commit returns the stored result) so a re-commit isn't counted twice. */
export function trackImportCompleted(
  response: { result: PolishImportCommitResult; alreadyCommitted: boolean },
  tracker: MetricTracker = defaultTracker
): void {
  if (response.alreadyCommitted) return;
  emit(importCompletedEvent(response.result), tracker);
}

// ── Looks (`/polishes/looks`) ────────────────────────────────

/** What produced a set of looks: first render or a vibe change (`vibe`), or Shuffle. */
export type LooksTrigger = "vibe" | "shuffle";

type LookCounts = Pick<Look, "templateId" | "ownedSteps" | "missingSteps">;

export interface LooksGeneratedInput {
  vibe: Vibe;
  looks: readonly LookCounts[];
  shortfall: boolean;
  /** Owned polishes the recommender considered. */
  ownedCount: number;
  trigger: LooksTrigger;
  /** The "Include toppers" toggle (#386; default on). */
  includeToppers?: boolean;
}

export function looksGeneratedEvent(input: LooksGeneratedInput): MetricEvent {
  const sum = (key: "ownedSteps" | "missingSteps") => input.looks.reduce((total, look) => total + look[key], 0);
  return {
    name: METRIC_EVENTS.looksGenerated,
    properties: {
      occasion: input.vibe.occasion,
      mood: input.vibe.mood,
      finish: input.vibe.finish ?? "any",
      ownedOnly: input.vibe.ownedOnly,
      includeToppers: input.includeToppers ?? true,
      undertone: input.vibe.skinTone?.undertone ?? "none",
      depth: input.vibe.skinTone?.depth ?? "none",
      trigger: input.trigger,
      lookCount: input.looks.length,
      ownedSteps: sum("ownedSteps"),
      missingSteps: sum("missingSteps"),
      fullyOwnedLooks: input.looks.filter((look) => look.missingSteps === 0).length,
      ownedCount: input.ownedCount,
      shortfall: input.shortfall,
      templates: input.looks.map((look) => look.templateId).join(","),
    },
  };
}

/** Where a Looks action was taken: a live look card, its details drawer, or the Saved tab. */
export type LooksSurface = "card" | "drawer" | "saved";

export interface LooksWearClickedInput {
  look: LookCounts;
  /** Whether the user swapped any step before wearing. */
  swapped: boolean;
  /** 0-based card position (in the Saved list for `surface: "saved"`). */
  position: number;
  /** Default `card`. */
  surface?: Exclude<LooksSurface, "drawer">;
}

export function looksWearClickedEvent(input: LooksWearClickedInput): MetricEvent {
  return {
    name: METRIC_EVENTS.looksWearClicked,
    properties: {
      template: input.look.templateId,
      position: input.position,
      ownedSteps: input.look.ownedSteps,
      missingSteps: input.look.missingSteps,
      swapped: input.swapped,
      surface: input.surface ?? "card",
    },
  };
}

export interface LooksColorLabOpenedInput {
  look: LookCounts;
  surface: LooksSurface;
  /** 0-based card position (in the Saved list for `surface: "saved"`). */
  position: number;
}

/** "Open in Color Lab" (#386): the look's palette handed to `/polishes/search`. */
export function looksColorLabOpenedEvent(input: LooksColorLabOpenedInput): MetricEvent {
  return {
    name: METRIC_EVENTS.looksColorLabOpened,
    properties: {
      template: input.look.templateId,
      surface: input.surface,
      position: input.position,
      ownedSteps: input.look.ownedSteps,
      missingSteps: input.look.missingSteps,
    },
  };
}

export function trackLooksGenerated(input: LooksGeneratedInput, tracker: MetricTracker = defaultTracker): void {
  emit(looksGeneratedEvent(input), tracker);
}

export function trackLooksWearClicked(input: LooksWearClickedInput, tracker: MetricTracker = defaultTracker): void {
  emit(looksWearClickedEvent(input), tracker);
}

export function trackLooksColorLabOpened(input: LooksColorLabOpenedInput, tracker: MetricTracker = defaultTracker): void {
  emit(looksColorLabOpenedEvent(input), tracker);
}

export function trackOnboardingStepClicked(
  input: OnboardingStepInput,
  tracker: MetricTracker = defaultTracker
): void {
  emit(onboardingStepClickedEvent(input), tracker);
}
