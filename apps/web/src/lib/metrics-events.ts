/**
 * M2 success-metric events (decision D19, #323; roadmap `docs/roadmap-2026-10-to-12.md` §4).
 *
 * The dupe-warning funnel only exists in the browser, so it is measured with App Insights
 * custom events (as are the Looks page events `looks.generated` / `looks.wear_clicked`); status adoption, manis per week and time to 20 polishes come from the weekly
 * Postgres query in `docs/queries/m2-metrics.sql`. `mani.logged` and `import.completed` are
 * browser-side cross-checks for those numbers.
 *
 * Every helper goes through `trackEvent` (a no-op without a connection string) and sends counts
 * and enum values only: never an email, a name or free text. The signed-in user is attached by
 * `setUser` (internal user id) in `TelemetryProvider`.
 */
import type { PolishDupesResponse, PolishImportCommitResult } from "swatchwatch-shared";
import type { Look, Vibe } from "./looks";
import { trackEvent } from "./telemetry";

export const METRIC_EVENTS = {
  dupeWarningShown: "dupe.warning_shown",
  dupeWarningOutcome: "dupe.warning_outcome",
  maniLogged: "mani.logged",
  importCompleted: "import.completed",
  looksGenerated: "looks.generated",
  looksWearClicked: "looks.wear_clicked",
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

export interface LooksWearClickedInput {
  look: LookCounts;
  /** Whether the user swapped any step before wearing. */
  swapped: boolean;
  /** 0-based card position. */
  position: number;
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
    },
  };
}

export function trackLooksGenerated(input: LooksGeneratedInput, tracker: MetricTracker = defaultTracker): void {
  emit(looksGeneratedEvent(input), tracker);
}

export function trackLooksWearClicked(input: LooksWearClickedInput, tracker: MetricTracker = defaultTracker): void {
  emit(looksWearClickedEvent(input), tracker);
}
