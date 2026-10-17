import { app, InvocationContext, Timer } from "@azure/functions";
import {
  applyAiBatchShadeDetections,
  getIngestionJobById,
  listIngestionJobsAwaitingAiBatch,
  markIngestionJobFailed,
  markIngestionJobSucceeded,
  updateIngestionJobMetrics,
} from "../lib/ingestion-repo";
import {
  downloadBatchFileContent,
  getVisionHexBatchStatus,
  parseVisionHexBatchDetections,
  parseVisionHexBatchOutput,
} from "../lib/azure-openai-batch";
import { trackMetric } from "../lib/telemetry";
import {
  AI_BATCHES_METRICS_KEY,
  CHECKPOINT_METRICS_KEY,
  CONTINUATION_QUEUED_STAGE,
  enqueueIngestionContinuation,
  IngestionAiBatchEntry,
  isAiBatchPending,
  readAiBatchesFromMetrics,
  readResumeMessageFromMetrics,
  RESUME_MESSAGE_METRICS_KEY,
} from "../lib/ingestion-continuation";

const DEFAULT_BATCH_POLL_SCHEDULE = "0 * * * * *";
const DEFAULT_MAX_JOBS_PER_POLL = 10;
const MAX_JOB_LOG_ENTRIES = 500;

interface BatchPollerRuntimeConfig {
  enabled: boolean;
  maxJobsPerPoll: number;
}

function envFlagTrue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseIntEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

const BATCH_POLL_SCHEDULE =
  process.env.INGESTION_AI_BATCH_POLL_SCHEDULE?.trim() || DEFAULT_BATCH_POLL_SCHEDULE;

function getBatchPollerRuntimeConfig(): BatchPollerRuntimeConfig {
  return {
    enabled: envFlagTrue(process.env.HEX_DETECTION_BATCH_ENABLED),
    maxJobsPerPoll: parseIntEnv(
      process.env.INGESTION_AI_BATCH_MAX_POLL_JOBS,
      DEFAULT_MAX_JOBS_PER_POLL,
      1,
      100
    ),
  };
}

function withPipelineMetrics(
  baseMetrics: Record<string, unknown>,
  status: "running" | "succeeded" | "failed",
  stage: string,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...baseMetrics,
    ...(extra || {}),
    pipeline: {
      status,
      stage,
      updatedAt: new Date().toISOString(),
    },
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function appendJobLog(
  metrics: Record<string, unknown>,
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  data?: Record<string, unknown>
): Record<string, unknown> {
  const existingLogs = Array.isArray(metrics.logs) ? metrics.logs : [];
  const trimmedLogs =
    existingLogs.length >= MAX_JOB_LOG_ENTRIES
      ? existingLogs.slice(existingLogs.length - (MAX_JOB_LOG_ENTRIES - 1))
      : existingLogs;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (data && Object.keys(data).length > 0) {
    entry.data = data;
  }

  return {
    ...metrics,
    logs: [...trimmedLogs, entry],
  };
}

/**
 * Batches the job is waiting on. Jobs list them in `aiBatches`; jobs paused by an older
 * worker carry a single `aiBatch`, which is handled as a list of one.
 */
function readJobAiBatches(metrics: Record<string, unknown>): {
  entries: IngestionAiBatchEntry[];
  tracked: boolean;
} {
  const tracked = readAiBatchesFromMetrics(metrics);
  if (tracked.length > 0) {
    return { entries: tracked, tracked: true };
  }

  const aiBatch = toRecord(metrics.aiBatch);
  const batchId = typeof aiBatch.batchId === "string" ? aiBatch.batchId.trim() : "";
  if (!batchId) {
    return { entries: [], tracked: false };
  }
  return {
    entries: [
      {
        ...aiBatch,
        batchId,
        // A legacy job only reaches the poller while its single batch is outstanding.
        status: aiBatch.status === "completed" ? "submitted" : String(aiBatch.status ?? "submitted"),
        overwriteDetectedHex: aiBatch.overwriteDetectedHex === true,
      },
    ],
    tracked: false,
  };
}

function isBatchStillRunning(status: string): boolean {
  return ["validating", "in_progress", "finalizing", "cancelling"].includes(status);
}

/**
 * Re-read the job immediately before a write so a job cancelled (or otherwise finished)
 * while the poller was downloading/applying batch output is never resurrected.
 */
async function shouldApplyJobUpdate(
  jobId: number,
  context: InvocationContext,
  updateType: "success" | "failure" | "continuation" | "progress"
): Promise<boolean> {
  const latest = await getIngestionJobById(jobId);
  if (!latest || latest.status !== "running") {
    context.log(
      `[ingestion-ai-batch-poller] Skipping ${updateType} update for job ${jobId}: no longer running`
    );
    return false;
  }
  return true;
}

function sumBatchTokenUsage(
  rows: Array<{
    usage: {
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
    } | null;
  }>
): {
  rowsWithUsage: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  let rowsWithUsage = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;

  for (const row of rows) {
    const usage = row.usage;
    if (!usage) {
      continue;
    }

    rowsWithUsage += 1;
    if (typeof usage.promptTokens === "number") {
      promptTokens += usage.promptTokens;
    }
    if (typeof usage.completionTokens === "number") {
      completionTokens += usage.completionTokens;
    }
    if (typeof usage.totalTokens === "number") {
      totalTokens += usage.totalTokens;
    }
  }

  return {
    rowsWithUsage,
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

const AI_BATCH_APPLY_TOTAL_KEYS = [
  "processed",
  "applied",
  "skippedNoDetection",
  "noShadeMatch",
  "outputRows",
  "parsedRows",
  "parseErrors",
  "rowsWithTokenUsage",
  "promptTokens",
  "completionTokens",
  "totalTokens",
] as const;

type AiBatchApplyTotals = Record<(typeof AI_BATCH_APPLY_TOTAL_KEYS)[number], number>;

/**
 * A job may submit several Azure OpenAI batches. `aiBatchApply` holds the latest applied
 * batch only; `aiBatchApplyTotals` sums every batch applied for the job.
 */
function accumulateAiBatchApplyTotals(
  previous: unknown,
  batchApply: AiBatchApplyTotals
): AiBatchApplyTotals {
  const prior = toRecord(previous);
  const totals = {} as AiBatchApplyTotals;
  for (const key of AI_BATCH_APPLY_TOTAL_KEYS) {
    const priorValue = prior[key];
    totals[key] =
      (typeof priorValue === "number" && Number.isFinite(priorValue) ? priorValue : 0) +
      batchApply[key];
  }
  return totals;
}

function readAiBatchesCompleted(metrics: Record<string, unknown>): number {
  const value = metrics.aiBatchesCompleted;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

type BatchStatus = Awaited<ReturnType<typeof getVisionHexBatchStatus>>;
type AwaitingJob = Awaited<ReturnType<typeof listIngestionJobsAwaitingAiBatch>>[number];

function withBatchStatus(
  entry: IngestionAiBatchEntry,
  batchStatus: BatchStatus,
  polledAt: string
): IngestionAiBatchEntry {
  return {
    ...entry,
    status: batchStatus.status,
    lastPolledAt: polledAt,
    outputFileId: batchStatus.outputFileId,
    errorFileId: batchStatus.errorFileId,
    requestCounts: batchStatus.requestCounts,
    ...(batchStatus.status === "completed" ? { completedAt: polledAt } : {}),
  };
}

/** Download a completed batch, apply its detections, and fold the results into metrics. */
async function applyCompletedBatch(
  job: AwaitingJob,
  entry: IngestionAiBatchEntry,
  batchStatus: BatchStatus,
  metrics: Record<string, unknown>
): Promise<{ metrics: Record<string, unknown>; logContext: Record<string, unknown> }> {
  if (!batchStatus.outputFileId) {
    throw new Error(`Batch ${batchStatus.id} completed without an output file id`);
  }

  const outputJsonl = await downloadBatchFileContent(batchStatus.outputFileId);
  const outputRows = parseVisionHexBatchOutput(outputJsonl);
  const parsedDetections = await parseVisionHexBatchDetections(outputRows);
  const tokenUsage = sumBatchTokenUsage(parsedDetections);
  const tokenMetricProperties = {
    source: job.source,
    jobId: String(job.jobId),
    batchId: batchStatus.id,
  };
  trackMetric(
    "hex_detection.batch.rows_with_token_usage",
    tokenUsage.rowsWithUsage,
    tokenMetricProperties
  );
  trackMetric(
    "hex_detection.batch.prompt_tokens",
    tokenUsage.promptTokens,
    tokenMetricProperties
  );
  trackMetric(
    "hex_detection.batch.completion_tokens",
    tokenUsage.completionTokens,
    tokenMetricProperties
  );
  trackMetric(
    "hex_detection.batch.total_tokens",
    tokenUsage.totalTokens,
    tokenMetricProperties
  );

  const applyMetrics = await applyAiBatchShadeDetections(
    job.dataSourceId,
    parsedDetections.map((row) => ({
      externalId: row.customId,
      detectedHex: row.detection?.hex || null,
      detectedFinishes: row.detection?.finishes || null,
    })),
    entry.overwriteDetectedHex
  );

  const parseErrors = parsedDetections.filter((row) => row.error).length;
  const completionLogs = appendJobLog(
    appendJobLog(metrics, "info", `Batch ${batchStatus.id} completed`, {
      outputRows: outputRows.length,
      parsedRows: parsedDetections.length,
      parseErrors,
    }),
    "info",
    `Applied ${applyMetrics.applied} batch detections`,
    {
      processed: applyMetrics.processed,
      skippedNoDetection: applyMetrics.skippedNoDetection,
      noShadeMatch: applyMetrics.noShadeMatch,
    }
  );

  const batchApply: AiBatchApplyTotals = {
    ...applyMetrics,
    outputRows: outputRows.length,
    parsedRows: parsedDetections.length,
    parseErrors,
    rowsWithTokenUsage: tokenUsage.rowsWithUsage,
    promptTokens: tokenUsage.promptTokens,
    completionTokens: tokenUsage.completionTokens,
    totalTokens: tokenUsage.totalTokens,
  };

  return {
    metrics: {
      ...completionLogs,
      aiBatchApply: batchApply,
      aiBatchApplyTotals: accumulateAiBatchApplyTotals(metrics.aiBatchApplyTotals, batchApply),
      aiBatchesCompleted: readAiBatchesCompleted(metrics) + 1,
    },
    logContext: {
      batchId: batchStatus.id,
      outputRows: outputRows.length,
      parsedRows: parsedDetections.length,
      applied: applyMetrics.applied,
      noShadeMatch: applyMetrics.noShadeMatch,
      rowsWithTokenUsage: tokenUsage.rowsWithUsage,
      promptTokens: tokenUsage.promptTokens,
      completionTokens: tokenUsage.completionTokens,
      totalTokens: tokenUsage.totalTokens,
    },
  };
}

async function processAwaitingAiBatchJob(
  job: AwaitingJob,
  context: InvocationContext
): Promise<void> {
  const currentJob = await getIngestionJobById(job.jobId);
  if (!currentJob || currentJob.status !== "running") {
    context.log(
      `[ingestion-ai-batch-poller] Skipping job ${job.jobId}: no longer running`
    );
    return;
  }

  let metrics = toRecord(currentJob.metrics);
  const { entries, tracked } = readJobAiBatches(metrics);

  if (entries.length === 0) {
    const message = "Missing aiBatch metadata for awaiting_ai ingestion job";
    const failedMetrics = withPipelineMetrics(
      appendJobLog(metrics, "error", message),
      "failed",
      "awaiting_ai",
      {
        failedAt: new Date().toISOString(),
        failedStage: "awaiting_ai",
      }
    );
    if (!(await shouldApplyJobUpdate(job.jobId, context, "failure"))) {
      return;
    }
    await markIngestionJobFailed(job.jobId, message, failedMetrics);
    context.error(`[ingestion-ai-batch-poller] Job ${job.jobId} failed: ${message}`);
    return;
  }

  // `aiBatch` mirrors the most recently polled batch so existing readers keep working.
  let latestEntry = entries[entries.length - 1];
  const withEntries = (base: Record<string, unknown>): Record<string, unknown> => ({
    ...base,
    aiBatch: latestEntry,
    ...(tracked ? { [AI_BATCHES_METRICS_KEY]: entries } : {}),
  });

  const pendingIndexes = entries.flatMap((entry, index) => (isAiBatchPending(entry) ? [index] : []));
  const polledAt = new Date().toISOString();
  let stillRunning = 0;
  let lastLogContext: Record<string, unknown> = {};
  // The first batch that ended without completing. The job fails after the loop, so later
  // batches that did complete are still applied: their records are already committed.
  let terminalFailure: string | null = null;

  for (const [position, index] of pendingIndexes.entries()) {
    const entry = entries[index];
    let batchStatus: BatchStatus;
    try {
      batchStatus = await getVisionHexBatchStatus(entry.batchId);
    } catch (error) {
      // A transient lookup error (timeout, 5xx) must not fail a long job and orphan its
      // other batches: keep the entry as-is and retry it on the next poll.
      const reason = error instanceof Error ? error.message : String(error);
      stillRunning += 1;
      metrics = appendJobLog(metrics, "warn", `Batch ${entry.batchId} status lookup failed; retrying next poll`, {
        error: reason,
      });
      context.warn(
        `[ingestion-ai-batch-poller] Job ${job.jobId} batch ${entry.batchId} status lookup failed: ${reason}`
      );
      continue;
    }
    entries[index] = withBatchStatus(entry, batchStatus, polledAt);
    latestEntry = entries[index];

    if (isBatchStillRunning(batchStatus.status)) {
      stillRunning += 1;
      metrics = appendJobLog(metrics, "info", `Batch ${batchStatus.id} polled: ${batchStatus.status}`, {
        outputFileId: batchStatus.outputFileId,
        errorFileId: batchStatus.errorFileId,
        requestCounts: batchStatus.requestCounts || undefined,
      });
      context.log(
        `[ingestion-ai-batch-poller] Job ${job.jobId} batch ${batchStatus.id} still ${batchStatus.status}`
      );
      continue;
    }

    if (batchStatus.status !== "completed") {
      const failedMessage = `Azure OpenAI batch ${batchStatus.id} ended with status ${batchStatus.status}`;
      terminalFailure ??= failedMessage;
      metrics = appendJobLog(metrics, "error", failedMessage, {
        outputFileId: batchStatus.outputFileId,
        errorFileId: batchStatus.errorFileId,
      });
      continue;
    }

    const applied = await applyCompletedBatch(job, entry, batchStatus, metrics);
    metrics = applied.metrics;
    lastLogContext = applied.logContext;
    context.log(
      `[ingestion-ai-batch-poller] Job ${job.jobId} applied batch ${batchStatus.id}`,
      applied.logContext
    );

    // Persist each applied batch unless the final write follows immediately, so a crash
    // mid-poll does not re-apply batches that already landed.
    if (position < pendingIndexes.length - 1) {
      if (!(await shouldApplyJobUpdate(job.jobId, context, "progress"))) {
        return;
      }
      await updateIngestionJobMetrics(
        job.jobId,
        withPipelineMetrics(withEntries(metrics), "running", "awaiting_ai")
      );
    }
  }

  if (terminalFailure) {
    const failedMetrics = withPipelineMetrics(withEntries(metrics), "failed", "awaiting_ai", {
      failedAt: polledAt,
      failedStage: "awaiting_ai",
    });
    if (!(await shouldApplyJobUpdate(job.jobId, context, "failure"))) {
      return;
    }
    await markIngestionJobFailed(job.jobId, terminalFailure, failedMetrics);
    context.error(`[ingestion-ai-batch-poller] Job ${job.jobId} failed: ${terminalFailure}`);
    return;
  }

  if (stillRunning > 0) {
    await updateIngestionJobMetrics(
      job.jobId,
      withPipelineMetrics(withEntries(metrics), "running", "awaiting_ai")
    );
    return;
  }

  const appliedBatchMetrics = withEntries(metrics);
  const lastBatchId = latestEntry.batchId;

  // The worker stores the next queue message when the paused page was not the last unit
  // of work. A key that is present but unreadable must fail loudly: completing the job
  // would silently truncate an exhaustive run (the bug this hand-off exists to fix).
  const hasResumeMessageKey = metrics[RESUME_MESSAGE_METRICS_KEY] !== undefined;
  const resumeMessage = readResumeMessageFromMetrics(metrics);
  if (hasResumeMessageKey) {
    const invalidReason = !resumeMessage
      ? "is malformed"
      : resumeMessage.jobId !== job.jobId
        ? `targets job ${resumeMessage.jobId}`
        : !resumeMessage.checkpoint
          ? "has no checkpoint"
          : null;
    if (invalidReason) {
      const message = `Cannot continue job ${job.jobId} after batch ${lastBatchId}: stored resume message ${invalidReason}`;
      await failContinuation(job.jobId, appliedBatchMetrics, message, polledAt, context);
      return;
    }
  }

  if (resumeMessage?.checkpoint) {
    const { checkpoint } = resumeMessage;
    const { [RESUME_MESSAGE_METRICS_KEY]: _consumedResumeMessage, ...withoutResumeMessage } =
      appliedBatchMetrics;
    const continuationMetrics = withPipelineMetrics(
      appendJobLog(
        withoutResumeMessage,
        "info",
        `Batch ${lastBatchId} applied; continuation queued at page ${checkpoint.nextPage}`,
        {
          nextPage: checkpoint.nextPage,
          recordOffset: checkpoint.recordOffset,
          pagesCompleted: checkpoint.pagesCompleted,
          recordsProcessed: checkpoint.recordsProcessed,
          continuationCount: checkpoint.continuationCount,
        }
      ),
      "running",
      CONTINUATION_QUEUED_STAGE,
      {
        [CHECKPOINT_METRICS_KEY]: checkpoint,
      }
    );

    if (!(await shouldApplyJobUpdate(job.jobId, context, "continuation"))) {
      return;
    }
    // Persist the checkpoint + stage BEFORE enqueueing so a fast-starting worker never
    // sees a stale awaiting_ai stage or an older continuationCount and drops the message.
    await updateIngestionJobMetrics(job.jobId, continuationMetrics);

    try {
      await enqueueIngestionContinuation(resumeMessage);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const message = `Failed to enqueue continuation for job ${job.jobId} after batch ${lastBatchId}: ${reason}`;
      await failContinuation(job.jobId, continuationMetrics, message, polledAt, context);
      return;
    }

    context.log(
      `[ingestion-ai-batch-poller] Job ${job.jobId} applied batch ${lastBatchId}; continuation ${checkpoint.continuationCount} queued at page ${checkpoint.nextPage}`,
      lastLogContext
    );
    return;
  }

  const completionMetrics = withPipelineMetrics(appliedBatchMetrics, "succeeded", "completed", {
    workerCompletedAt: polledAt,
  });

  if (!(await shouldApplyJobUpdate(job.jobId, context, "success"))) {
    return;
  }
  await markIngestionJobSucceeded(job.jobId, completionMetrics);
  context.log(
    `[ingestion-ai-batch-poller] Job ${job.jobId} completed from batch ${lastBatchId}`,
    lastLogContext
  );
}

async function failContinuation(
  jobId: number,
  baseMetrics: Record<string, unknown>,
  message: string,
  failedAt: string,
  context: InvocationContext
): Promise<void> {
  const failedMetrics = withPipelineMetrics(
    appendJobLog(baseMetrics, "error", message),
    "failed",
    "continuation_enqueue",
    {
      failedAt,
      failedStage: "continuation_enqueue",
    }
  );
  if (!(await shouldApplyJobUpdate(jobId, context, "failure"))) {
    return;
  }
  await markIngestionJobFailed(jobId, message, failedMetrics);
  context.error(`[ingestion-ai-batch-poller] Job ${jobId} failed: ${message}`);
}

async function ingestionAiBatchPoller(
  _timer: Timer,
  context: InvocationContext
): Promise<void> {
  const runtimeConfig = getBatchPollerRuntimeConfig();

  if (!runtimeConfig.enabled) {
    context.log(
      "[ingestion-ai-batch-poller] Skipping run because HEX_DETECTION_BATCH_ENABLED is false"
    );
    return;
  }

  const awaitingJobs = await listIngestionJobsAwaitingAiBatch(runtimeConfig.maxJobsPerPoll);
  if (awaitingJobs.length === 0) {
    context.log("[ingestion-ai-batch-poller] No awaiting_ai jobs found");
    return;
  }

  context.log(
    `[ingestion-ai-batch-poller] Processing ${awaitingJobs.length} awaiting_ai job(s), maxJobsPerPoll=${runtimeConfig.maxJobsPerPoll}`
  );

  for (const job of awaitingJobs) {
    try {
      await processAwaitingAiBatchJob(job, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.error(
        `[ingestion-ai-batch-poller] Error processing job ${job.jobId}: ${message}`,
        error
      );

      const current = await getIngestionJobById(job.jobId);
      if (!current || current.status !== "running") {
        continue;
      }

      const failedMetrics = withPipelineMetrics(toRecord(current.metrics), "failed", "awaiting_ai", {
        failedAt: new Date().toISOString(),
        failedStage: "awaiting_ai",
      });
      await markIngestionJobFailed(
        job.jobId,
        message,
        appendJobLog(failedMetrics, "error", `[poller] ${message}`)
      );
    }
  }
}

app.timer("ingestion-ai-batch-poller", {
  schedule: BATCH_POLL_SCHEDULE,
  runOnStartup: false,
  handler: ingestionAiBatchPoller,
});
