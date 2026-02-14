import { InvocationContext } from "@azure/functions";
import { updateIngestionJobMetrics } from "./ingestion-repo";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  data?: Record<string, unknown>;
}

export interface JobLoggerOptions {
  jobId: number;
  context: InvocationContext;
  baseMetrics?: Record<string, unknown>;
  flushIntervalMs?: number;
  maxEntries?: number;
}

/**
 * JobLogger accumulates structured log entries during job execution
 * and periodically flushes them to the job's metrics_json field.
 *
 * Also forwards all logs to the Azure Functions context logger.
 */
export class JobLogger {
  private readonly jobId: number;
  private readonly context: InvocationContext;
  private readonly entries: LogEntry[] = [];
  private readonly maxEntries: number;
  private baseMetrics: Record<string, unknown>;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastFlushIndex = 0;

  constructor(options: JobLoggerOptions) {
    this.jobId = options.jobId;
    this.context = options.context;
    this.baseMetrics = options.baseMetrics || {};
    this.maxEntries = options.maxEntries || 500;

    const flushInterval = options.flushIntervalMs ?? 3000;
    if (flushInterval > 0) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, flushInterval);
    }
  }

  private addEntry(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
    };

    if (data && Object.keys(data).length > 0) {
      entry.data = data;
    }

    // Trim old entries if we hit max
    if (this.entries.length >= this.maxEntries) {
      const removeCount = Math.floor(this.maxEntries * 0.2);
      this.entries.splice(0, removeCount);
      this.lastFlushIndex = Math.max(0, this.lastFlushIndex - removeCount);
    }

    this.entries.push(entry);
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
    if (this.entries.length === this.lastFlushIndex) {
      return;
    }

    try {
      await updateIngestionJobMetrics(this.jobId, this.getMetricsWithLogs());
      this.lastFlushIndex = this.entries.length;
    } catch (err) {
      // Don't let flush errors break the job - just log to context
      this.context.warn("Failed to flush job logs:", err);
    }
  }

  /**
   * Stop the flush timer and do a final flush.
   */
  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
