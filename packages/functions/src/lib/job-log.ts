import type {
  IngestionLogEntry,
  IngestionLogLevel,
  IngestionLogOmission,
} from "swatchwatch-shared";

/**
 * Bounded storage for an ingestion job's log (`ingestion_job.metrics_json.logs`).
 *
 * One job can span many worker invocations (continuations), Azure OpenAI batch phases and
 * AI batch poller runs, and they all append to the same list. To keep the row small the list
 * is capped, but never by silently dropping lines: it keeps the first lines of the run (the
 * request, config and early progress), the most recent lines, and one marker entry between
 * them that counts every omitted line by level ("N earlier lines omitted").
 *
 * Shared by the worker's {@link JobLogger} and the AI batch poller so both trim the same way.
 */

export const DEFAULT_JOB_LOG_MAX_ENTRIES = 500;
const MIN_JOB_LOG_MAX_ENTRIES = 100;
const MAX_JOB_LOG_MAX_ENTRIES = 2000;
/** Share of the cap reserved for the start of the run. */
const HEAD_SHARE = 0.2;

const LOG_LEVELS: readonly IngestionLogLevel[] = ["debug", "info", "warn", "error"];

export interface JobLogLimits {
  /** Total entries kept, including the omission marker. */
  maxEntries: number;
  /** Entries kept from the start of the run. */
  headEntries: number;
}

/** Cap from `INGESTION_JOB_LOG_MAX_ENTRIES` (default 500, clamped 100–2000). */
export function getJobLogMaxEntries(): number {
  const parsed = Number.parseInt(process.env.INGESTION_JOB_LOG_MAX_ENTRIES || "", 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_JOB_LOG_MAX_ENTRIES;
  }
  return Math.min(MAX_JOB_LOG_MAX_ENTRIES, Math.max(MIN_JOB_LOG_MAX_ENTRIES, parsed));
}

export function resolveJobLogLimits(maxEntries?: number): JobLogLimits {
  // Room for at least one head line, the marker and one recent line.
  const max = Math.max(3, Math.floor(maxEntries ?? getJobLogMaxEntries()));
  const headEntries = Math.min(max - 2, Math.max(1, Math.floor(max * HEAD_SHARE)));
  return { maxEntries: max, headEntries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLogLevel(value: unknown): value is IngestionLogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate an omission roll-up read back from the database; null when malformed. */
function parseOmission(value: unknown): IngestionLogOmission | null {
  if (!isRecord(value) || !isNonNegativeInt(value.count)) {
    return null;
  }
  const byLevel: Partial<Record<IngestionLogLevel, number>> = {};
  if (isRecord(value.byLevel)) {
    for (const level of LOG_LEVELS) {
      const count = value.byLevel[level];
      if (isNonNegativeInt(count) && count > 0) {
        byLevel[level] = count;
      }
    }
  }
  return {
    count: value.count,
    byLevel,
    ...(typeof value.firstTs === "string" ? { firstTs: value.firstTs } : {}),
    ...(typeof value.lastTs === "string" ? { lastTs: value.lastTs } : {}),
  };
}

/** Keep only well-formed entries from an untrusted `metrics.logs` value. */
export function sanitizeJobLog(value: unknown): IngestionLogEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate): IngestionLogEntry[] => {
    if (
      !isRecord(candidate) ||
      typeof candidate.ts !== "string" ||
      typeof candidate.msg !== "string" ||
      !isLogLevel(candidate.level)
    ) {
      return [];
    }
    const entry: IngestionLogEntry = { ts: candidate.ts, level: candidate.level, msg: candidate.msg };
    if (isRecord(candidate.data)) {
      entry.data = candidate.data;
    }
    if (candidate.omitted !== undefined) {
      const omitted = parseOmission(candidate.omitted);
      if (!omitted) {
        return [];
      }
      entry.omitted = omitted;
    }
    return [entry];
  });
}

export function createJobLogEntry(
  level: IngestionLogLevel,
  msg: string,
  data?: Record<string, unknown>,
  ts: string = new Date().toISOString()
): IngestionLogEntry {
  const entry: IngestionLogEntry = { ts, level, msg };
  if (data && Object.keys(data).length > 0) {
    entry.data = data;
  }
  return entry;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatOmissionMessage(omitted: IngestionLogOmission): string {
  const notable: string[] = [];
  if (omitted.byLevel.error) notable.push(plural(omitted.byLevel.error, "error"));
  if (omitted.byLevel.warn) notable.push(plural(omitted.byLevel.warn, "warning"));
  const suffix = notable.length > 0 ? ` (including ${notable.join(" and ")})` : "";
  return `… ${plural(omitted.count, "earlier log line")} omitted to keep the job log bounded${suffix} …`;
}

function addToOmission(
  omission: IngestionLogOmission | null,
  entries: readonly IngestionLogEntry[]
): IngestionLogOmission {
  const result: IngestionLogOmission = omission
    ? { ...omission, byLevel: { ...omission.byLevel } }
    : { count: 0, byLevel: {} };
  for (const entry of entries) {
    if (entry.omitted) {
      // A marker folded into another (e.g. two logs concatenated): carry its counts over.
      result.count += entry.omitted.count;
      for (const level of LOG_LEVELS) {
        const count = entry.omitted.byLevel[level];
        if (count) {
          result.byLevel[level] = (result.byLevel[level] ?? 0) + count;
        }
      }
      result.firstTs ??= entry.omitted.firstTs;
      result.lastTs = entry.omitted.lastTs ?? result.lastTs;
      continue;
    }
    result.count += 1;
    result.byLevel[entry.level] = (result.byLevel[entry.level] ?? 0) + 1;
    result.firstTs ??= entry.ts;
    result.lastTs = entry.ts;
  }
  return result;
}

function buildMarker(omitted: IngestionLogOmission): IngestionLogEntry {
  return {
    // Sorts the marker where the omitted lines were.
    ts: omitted.lastTs ?? omitted.firstTs ?? new Date().toISOString(),
    level: "info",
    msg: formatOmissionMessage(omitted),
    omitted,
  };
}

/**
 * Bound a job log to `maxEntries`: keep the first `headEntries` lines of the run, the most
 * recent lines, and a single marker between them that rolls up everything omitted. Calling
 * it again on its own output (plus new lines) keeps the same head and grows the marker.
 */
export function compactJobLog(
  entries: readonly IngestionLogEntry[],
  limits: JobLogLimits = resolveJobLogLimits()
): IngestionLogEntry[] {
  const markerIndex = entries.findIndex((entry) => entry.omitted);
  const markerCount = entries.filter((entry) => entry.omitted).length;

  if (entries.length <= limits.maxEntries && markerCount <= 1) {
    return [...entries];
  }

  // Head: lines before the existing marker (capped), else the first lines of the run.
  const headEnd =
    markerIndex >= 0 ? Math.min(markerIndex, limits.headEntries) : limits.headEntries;
  const head = entries.slice(0, headEnd).filter((entry) => !entry.omitted);
  // Lines between the head and the marker (only if the head shrank) are older than the tail.
  const beforeMarker = markerIndex >= 0 ? entries.slice(headEnd, markerIndex) : [];
  const existingMarker = markerIndex >= 0 ? entries[markerIndex].omitted ?? null : null;
  const rest = markerIndex >= 0 ? entries.slice(markerIndex + 1) : entries.slice(headEnd);

  // Fold any extra markers into the omission instead of keeping them in the tail.
  const extraMarkers = rest.filter((entry) => entry.omitted);
  const tail = rest.filter((entry) => !entry.omitted);

  const tailRoom = limits.maxEntries - head.length - 1;
  const droppedTail = tail.slice(0, Math.max(0, tail.length - tailRoom));
  const keptTail = tail.slice(droppedTail.length);

  if (
    existingMarker === null &&
    beforeMarker.length === 0 &&
    extraMarkers.length === 0 &&
    droppedTail.length === 0
  ) {
    return [...head, ...keptTail];
  }

  const omitted = addToOmission(existingMarker, [...beforeMarker, ...extraMarkers, ...droppedTail]);
  return [...head, buildMarker(omitted), ...keptTail];
}

/** Append entries to an untrusted stored log and bound the result. */
export function appendJobLogEntries(
  existing: unknown,
  added: readonly IngestionLogEntry[],
  limits: JobLogLimits = resolveJobLogLimits()
): IngestionLogEntry[] {
  return compactJobLog([...sanitizeJobLog(existing), ...added], limits);
}

/** Lines the run actually logged: stored entries plus those rolled up in the marker. */
export function countJobLogLines(entries: readonly IngestionLogEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.omitted ? entry.omitted.count : 1), 0);
}
