import { InvocationContext } from "@azure/functions";
import type { IngestionLogEntry, IngestionLogLevel } from "swatchwatch-shared";
import { updateIngestionJobMetrics } from "./ingestion-repo";
import {
  compactJobLog,
  createJobLogEntry,
  JobLogLimits,
  resolveJobLogLimits,
  sanitizeJobLog,
} from "./job-log";

export type LogLevel = IngestionLogLevel;
export type LogEntry = IngestionLogEntry;

export interface JobLoggerOptions {
  jobId: number;
  context: InvocationContext;
  baseMetrics?: Record<string, unknown>;
  flushIntervalMs?: number;
  /** Entries kept in `metrics.logs`; defaults to `INGESTION_JOB_LOG_MAX_ENTRIES` (see job-log.ts). */
  maxEntries?: number;
}

function parseIntEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/**
 * JobLogger accumulates structured log entries during job execution
 * and periodically flushes them to the job's metrics_json field.
 *
 * The stored log is bounded (see job-log.ts): it keeps the start of the run, the most recent
 * lines and one marker counting the lines omitted in between, so a long run never silently
 * loses its beginning.
 *
 * Also forwards all logs to the Azure Functions context logger.
 */
export class JobLogger {
  private readonly jobId: number;
  private readonly context: InvocationContext;
  private entries: LogEntry[] = [];
  private readonly limits: JobLogLimits;
  private baseMetrics: Record<string, unknown>;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumped on every change to `entries`; compared with the version last flushed. */
  private version = 0;
  private flushedVersion = 0;

  constructor(options: JobLoggerOptions) {
    this.jobId = options.jobId;
    this.context = options.context;
    this.baseMetrics = options.baseMetrics || {};
    this.limits = resolveJobLogLimits(options.maxEntries);

    const flushInterval =
      options.flushIntervalMs ??
      parseIntEnv(process.env.INGESTION_LOG_FLUSH_INTERVAL_MS, 10000, 1000, 120000);
    if (flushInterval > 0) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, flushInterval);
    }
  }

  private addEntry(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    this.entries.push(createJobLogEntry(level, msg, data));
    if (this.entries.length > this.limits.maxEntries) {
      this.entries = compactJobLog(this.entries, this.limits);
    }
    this.version += 1;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.addEntry("debug", msg, data);
    if (data) {
      this.context.log(`[DEBUG] ${msg}`, data);
    } else {
      this.context.log(`[DEBUG] ${msg}`);
    }
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.addEntry("info", msg, data);
    if (data) {
      this.context.log(`[INFO] ${msg}`, data);
    } else {
      this.context.log(`[INFO] ${msg}`);
    }
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.addEntry("warn", msg, data);
    if (data) {
      this.context.warn(`[WARN] ${msg}`, data);
    } else {
      this.context.warn(`[WARN] ${msg}`);
    }
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.addEntry("error", msg, data);
    if (data) {
      this.context.error(`[ERROR] ${msg}`, data);
    } else {
      this.context.error(`[ERROR] ${msg}`);
    }
  }

  /**
   * Restore log entries persisted by earlier invocations of the same job (ingestion
   * continuations, the AI batch poller), so the job's log spans the whole run. Malformed
   * entries are dropped; the merged log is bounded like any other (head + marker + tail).
   */
  restoreEntries(entries: unknown): void {
    const restored = sanitizeJobLog(entries);
    if (restored.length === 0) {
      return;
    }
    this.entries = compactJobLog([...restored, ...this.entries], this.limits);
    // Force the next flush to write the merged history.
    this.version += 1;
  }

  /**
   * Update base metrics that get merged with logs on flush.
   */
  updateBaseMetrics(metrics: Record<string, unknown>): void {
    this.baseMetrics = { ...this.baseMetrics, ...metrics };
  }

  /**
   * Get current log entries (for final metrics).
   */
  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  /**
   * Get metrics object with logs included.
   */
  getMetricsWithLogs(): Record<string, unknown> {
    return {
      ...this.baseMetrics,
      logs: this.entries,
    };
  }

  /**
   * Flush logs to the database if there are new entries.
   */
  async flush(): Promise<void> {
    if (this.version === this.flushedVersion) {
      return;
    }

    const flushingVersion = this.version;
    try {
      await updateIngestionJobMetrics(this.jobId, this.getMetricsWithLogs());
      this.flushedVersion = flushingVersion;
    } catch (err) {
      // Don't let flush errors break the job - just log to context
      this.context.warn("Failed to flush job logs:", err);
    }
  }

  /**
   * Stop the flush timer and do a final flush. Pass `{ flush: false }` when this invocation
   * must not write to the job row any more (e.g. another invocation now owns the job).
   */
  async dispose(options?: { flush?: boolean }): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (options?.flush === false) {
      return;
    }
    await this.flush();
  }
}
