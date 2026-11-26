import { sourceBlockedReason } from "./ingestion-run-guard";

/**
 * Nightly catalog refresh (#532): which data sources the `catalog-refresh` timer queues a run
 * for, in what order and with what start delay. Pure: the timer (`functions/catalog-refresh.ts`)
 * loads the rows with {@link SELECT_CATALOG_REFRESH_SOURCES_SQL} and does the queueing.
 *
 * A source is refreshed only when it would also be accepted by the admin run endpoints
 * (`lib/ingestion-run-guard.ts`: not `metadata.blocked`, `enabled`), the worker has a connector
 * for it (`lib/connectors/factories.ts`), its records become catalog shades, and no job of its
 * own is still queued or running. The timer re-checks that last rule atomically when it queues
 * (`admitIngestionJob`, shared with the bulk endpoint).
 */

export const DEFAULT_CATALOG_REFRESH_SCHEDULE = "0 30 7 * * *";
export const DEFAULT_CATALOG_REFRESH_STAGGER_SECONDS = 120;
const MAX_CATALOG_REFRESH_STAGGER_SECONDS = 3600;
const MAX_CATALOG_REFRESH_SOURCES_PER_RUN = 1000;
/** Azure Storage queues accept a visibility timeout of at most 7 days; stay a minute under. */
export const MAX_QUEUE_VISIBILITY_DELAY_SECONDS = 7 * 24 * 3600 - 60;

/** `ingestion_job.status` values of a job that has not finished (`awaiting_ai` is a `running` stage). */
export const ACTIVE_INGESTION_JOB_STATUSES = ["queued", "running"] as const;

/** Marker stored as `metrics.triggeredBy` on jobs the timer queues (`triggeredByUserId` is null). */
export const CATALOG_REFRESH_TRIGGER = "catalog_refresh";

export type CatalogRefreshSkipReason =
  | "disabled"
  | "blocked"
  | "no_runnable_connector"
  | "not_catalog_source"
  | "already_running"
  | "capped";

export const CATALOG_REFRESH_SKIP_REASONS: readonly CatalogRefreshSkipReason[] = [
  "disabled",
  "blocked",
  "no_runnable_connector",
  "not_catalog_source",
  "already_running",
  "capped",
];

/** One `data_source` row with its job state (see {@link SELECT_CATALOG_REFRESH_SOURCES_SQL}). */
export interface CatalogRefreshSourceRow {
  dataSourceId: number | string;
  name: string;
  enabled: boolean;
  metadata: Record<string, unknown> | null;
  /** Newest queued/running job of the source, or null. */
  activeJobId: number | string | null;
  /**
   * `started_at` of the source's newest job of any status (the last attempt), or null when it was
   * never run. Ordering by attempt, not success, keeps a source that keeps failing from holding
   * the front of a capped run every night.
   */
  lastAttemptAt: string | Date | null;
}

export interface CatalogRefreshPlanDeps {
  /** The worker has a connector for this source name (`isRunnableConnectorSource`). */
  isRunnable: (name: string) => boolean;
  /** The source's records are materialized into catalog shades (`materializesShadeProductsByName`). */
  isCatalogSource: (name: string) => boolean;
}

export interface CatalogRefreshConfig {
  staggerSeconds: number;
  /** 0 = no cap. */
  maxSourcesPerRun: number;
}

export interface PlannedCatalogRefresh {
  dataSourceId: number;
  name: string;
  /** Queue visibility delay: the job's message becomes visible this many seconds after the run (a start delay, not a no-overlap guarantee). */
  delaySeconds: number;
  lastAttemptAt: string | null;
}

export interface SkippedCatalogRefresh {
  name: string;
  reason: CatalogRefreshSkipReason;
  /** For `blocked`: the `metadata.blocked` reason. */
  detail?: string;
  /** For `already_running`: the job still queued or running. */
  activeJobId?: number;
}

export interface CatalogRefreshPlan {
  planned: PlannedCatalogRefresh[];
  skipped: SkippedCatalogRefresh[];
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function catalogRefreshSchedule(env: NodeJS.ProcessEnv = process.env): string {
  return env.CATALOG_REFRESH_SCHEDULE?.trim() || DEFAULT_CATALOG_REFRESH_SCHEDULE;
}

/** `CATALOG_REFRESH_STAGGER_SECONDS` (default 120, 0–3600) and `CATALOG_REFRESH_MAX_SOURCES_PER_RUN` (default 0 = no cap, 0–1000). */
export function getCatalogRefreshConfig(env: NodeJS.ProcessEnv = process.env): CatalogRefreshConfig {
  return {
    staggerSeconds: clampInt(
      env.CATALOG_REFRESH_STAGGER_SECONDS,
      DEFAULT_CATALOG_REFRESH_STAGGER_SECONDS,
      0,
      MAX_CATALOG_REFRESH_STAGGER_SECONDS
    ),
    maxSourcesPerRun: clampInt(env.CATALOG_REFRESH_MAX_SOURCES_PER_RUN, 0, 0, MAX_CATALOG_REFRESH_SOURCES_PER_RUN),
  };
}

/**
 * Every `data_source` row (disabled ones too, so the run reports why they were skipped) with its
 * newest queued/running job and the start time of its newest job (any status).
 */
export const SELECT_CATALOG_REFRESH_SOURCES_SQL = `
  SELECT
    ds.data_source_id AS "dataSourceId",
    ds.name,
    ds.enabled,
    ds.metadata,
    active.ingestion_job_id AS "activeJobId",
    last_run.started_at AS "lastAttemptAt"
  FROM data_source ds
  LEFT JOIN LATERAL (
    SELECT j.ingestion_job_id
    FROM ingestion_job j
    WHERE j.data_source_id = ds.data_source_id
      AND j.status IN ('queued', 'running')
    ORDER BY j.started_at DESC
    LIMIT 1
  ) active ON true
  LEFT JOIN LATERAL (
    SELECT max(j.started_at) AS started_at
    FROM ingestion_job j
    WHERE j.data_source_id = ds.data_source_id
  ) last_run ON true
  ORDER BY ds.name`;

function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toPositiveIntOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Why a source is not refreshed, or null when it is eligible. Checked in this order: blocked,
 * disabled (the run guard's order), no runnable connector, not a catalog source, already running.
 */
export function catalogRefreshSkipReason(
  row: CatalogRefreshSourceRow,
  deps: CatalogRefreshPlanDeps
): SkippedCatalogRefresh | null {
  const blocked = sourceBlockedReason(row);
  if (blocked) return { name: row.name, reason: "blocked", detail: blocked };
  if (row.enabled !== true) return { name: row.name, reason: "disabled" };
  if (!deps.isRunnable(row.name)) return { name: row.name, reason: "no_runnable_connector" };
  if (!deps.isCatalogSource(row.name)) return { name: row.name, reason: "not_catalog_source" };
  const activeJobId = toPositiveIntOrNull(row.activeJobId);
  if (activeJobId !== null) return { name: row.name, reason: "already_running", activeJobId };
  return null;
}

/**
 * The run's plan: eligible sources ordered by their last attempt (newest job of any status),
 * oldest first (never run first, then by name). Under a cap the least recently attempted sources
 * go first; the others wait for a later run, possibly several nights when the cap is small, and a
 * source that keeps failing moves to the back once attempted instead of holding the front. The
 * i-th planned source's queue message becomes visible `i × staggerSeconds` after the run (bounded
 * by the queue's 7-day visibility limit); that is a start delay only, not a guarantee that the
 * previous job has finished.
 */
export function planCatalogRefresh(
  rows: readonly CatalogRefreshSourceRow[],
  deps: CatalogRefreshPlanDeps,
  config: CatalogRefreshConfig
): CatalogRefreshPlan {
  const skipped: SkippedCatalogRefresh[] = [];
  const eligible: Array<{ dataSourceId: number; name: string; lastAttemptAt: string | null }> = [];

  for (const row of rows) {
    const skip = catalogRefreshSkipReason(row, deps);
    if (skip) {
      skipped.push(skip);
      continue;
    }
    const dataSourceId = toPositiveIntOrNull(row.dataSourceId);
    if (dataSourceId === null) {
      skipped.push({ name: row.name, reason: "no_runnable_connector", detail: "invalid data_source_id" });
      continue;
    }
    eligible.push({ dataSourceId, name: row.name, lastAttemptAt: toIsoOrNull(row.lastAttemptAt) });
  }

  eligible.sort((a, b) => {
    if (a.lastAttemptAt !== b.lastAttemptAt) {
      if (a.lastAttemptAt === null) return -1;
      if (b.lastAttemptAt === null) return 1;
      return a.lastAttemptAt < b.lastAttemptAt ? -1 : 1;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const cap = config.maxSourcesPerRun > 0 ? config.maxSourcesPerRun : eligible.length;
  const planned = eligible.slice(0, cap).map((source, index) => ({
    ...source,
    delaySeconds: Math.min(index * config.staggerSeconds, MAX_QUEUE_VISIBILITY_DELAY_SECONDS),
  }));
  for (const source of eligible.slice(cap)) {
    skipped.push({ name: source.name, reason: "capped" });
  }

  return { planned, skipped };
}

/** Skip counts keyed by reason (every reason present, 0 when none), for telemetry. */
export function countSkipsByReason(
  skipped: readonly SkippedCatalogRefresh[]
): Record<CatalogRefreshSkipReason, number> {
  const counts = Object.fromEntries(CATALOG_REFRESH_SKIP_REASONS.map((reason) => [reason, 0])) as Record<
    CatalogRefreshSkipReason,
    number
  >;
  for (const skip of skipped) counts[skip.reason] += 1;
  return counts;
}
