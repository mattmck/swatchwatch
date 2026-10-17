import type { IngestionJobRecord, IngestionLogEntry, IngestionLogLevel } from "swatchwatch-shared";

/**
 * Helpers for the ingestion job log (`metrics.logs`). The Functions worker bounds the stored
 * log to the start of the run plus the most recent lines, with one marker entry
 * (`entry.omitted`) counting what was dropped in between, so counts here add those back.
 */

const LEVELS: readonly IngestionLogLevel[] = ["debug", "info", "warn", "error"];

function isLogEntry(entry: unknown): entry is IngestionLogEntry {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Record<string, unknown>;
  return (
    typeof candidate.ts === "string" &&
    typeof candidate.msg === "string" &&
    typeof candidate.level === "string" &&
    (LEVELS as readonly string[]).includes(candidate.level)
  );
}

export function getJobLogs(job: Pick<IngestionJobRecord, "metrics">): IngestionLogEntry[] {
  if (!job.metrics || typeof job.metrics !== "object") return [];
  const logs = job.metrics.logs;
  if (!Array.isArray(logs)) return [];
  return logs.filter(isLogEntry);
}

export function isOmissionMarker(entry: IngestionLogEntry): boolean {
  return (
    !!entry.omitted &&
    typeof entry.omitted === "object" &&
    typeof entry.omitted.count === "number" &&
    entry.omitted.count >= 0
  );
}

export interface JobLogSummary {
  /** Lines stored and shown (markers excluded). */
  shown: number;
  /** Lines the run logged, including omitted ones. */
  total: number;
  omitted: number;
  /** Errors and warnings across the whole run, including omitted ones. */
  errors: number;
  warnings: number;
}

export function summarizeJobLog(entries: readonly IngestionLogEntry[]): JobLogSummary {
  const summary: JobLogSummary = { shown: 0, total: 0, omitted: 0, errors: 0, warnings: 0 };
  for (const entry of entries) {
    if (isOmissionMarker(entry)) {
      const omitted = entry.omitted!;
      summary.omitted += omitted.count;
      summary.errors += omitted.byLevel?.error ?? 0;
      summary.warnings += omitted.byLevel?.warn ?? 0;
      continue;
    }
    summary.shown += 1;
    if (entry.level === "error") summary.errors += 1;
    if (entry.level === "warn") summary.warnings += 1;
  }
  summary.total = summary.shown + summary.omitted;
  return summary;
}

/** Badge text for the log header, e.g. "500 entries" or "499 of 1,734 lines". */
export function formatJobLogCount(summary: JobLogSummary): string {
  if (summary.omitted === 0) {
    return `${summary.shown} ${summary.shown === 1 ? "entry" : "entries"}`;
  }
  return `${summary.shown.toLocaleString("en-US")} of ${summary.total.toLocaleString("en-US")} lines`;
}

export type JobLogFilter = "all" | "problems";

/** "problems" keeps warnings, errors and omission markers (which may hide some). */
export function filterJobLog(
  entries: readonly IngestionLogEntry[],
  filter: JobLogFilter
): IngestionLogEntry[] {
  if (filter === "all") return [...entries];
  return entries.filter(
    (entry) => isOmissionMarker(entry) || entry.level === "warn" || entry.level === "error"
  );
}
