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
  CHECKPOINT_METRICS_KEY,
  CONTINUATION_QUEUED_STAGE,
  enqueueIngestionContinuation,
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

function readAiBatchFromMetrics(metrics: Record<string, unknown>): {
  batchId: string;
  overwriteDetectedHex: boolean;
  requestCount: number | null;
} | null {
  const aiBatch = toRecord(metrics.aiBatch);
  const batchId = typeof aiBatch.batchId === "string" ? aiBatch.batchId.trim() : "";
  if (!batchId) {
    return null;
  }

  return {
    batchId,
    overwriteDetectedHex: aiBatch.overwriteDetectedHex === true,
    requestCount:
      typeof aiBatch.requestCount === "number" && Number.isFinite(aiBatch.requestCount)
        ? aiBatch.requestCount
        : null,
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
  updateType: "success" | "failure" | "continuation"
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
 * A job may pause for several Azure OpenAI batches (one per paused page). `aiBatchApply`
 * holds the latest batch only; `aiBatchApplyTotals` sums every batch applied for the job.
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

async function processAwaitingAiBatchJob(
  job: Awaited<ReturnType<typeof listIngestionJobsAwaitingAiBatch>>[number],
  context: InvocationContext
): Promise<void> {
  const currentJob = await getIngestionJobById(job.jobId);
  if (!currentJob || currentJob.status !== "running") {
    context.log(
      `[ingestion-ai-batch-poller] Skipping job ${job.jobId}: no longer running`
    );
    return;
  }

  const metrics = toRecord(currentJob.metrics);
  const aiBatchMetrics = readAiBatchFromMetrics(metrics);

  if (!aiBatchMetrics) {
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

  const batchStatus = await getVisionHexBatchStatus(aiBatchMetrics.batchId);
  const polledAt = new Date().toISOString();

  if (isBatchStillRunning(batchStatus.status)) {
    const runningMetrics = withPipelineMetrics(
      appendJobLog(metrics, "info", `Batch ${batchStatus.id} polled: ${batchStatus.status}`, {
        outputFileId: batchStatus.outputFileId,
        errorFileId: batchStatus.errorFileId,
        requestCounts: batchStatus.requestCounts || undefined,
      }),
      "running",
      "awaiting_ai",
      {
        aiBatch: {
          ...toRecord(metrics.aiBatch),
          status: batchStatus.status,
          lastPolledAt: polledAt,
          outputFileId: batchStatus.outputFileId,
          errorFileId: batchStatus.errorFileId,
          requestCounts: batchStatus.requestCounts,
        },
      }
    );
    await updateIngestionJobMetrics(job.jobId, runningMetrics);
    context.log(
      `[ingestion-ai-batch-poller] Job ${job.jobId} batch ${batchStatus.id} still ${batchStatus.status}`
    );
    return;
  }

  if (batchStatus.status === "completed") {
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
      aiBatchMetrics.overwriteDetectedHex
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
    const appliedBatchMetrics: Record<string, unknown> = {
      ...completionLogs,
      aiBatch: {
        ...toRecord(completionLogs.aiBatch),
        status: "completed",
        completedAt: polledAt,
        lastPolledAt: polledAt,
        outputFileId: batchStatus.outputFileId,
        errorFileId: batchStatus.errorFileId,
        requestCounts: batchStatus.requestCounts,
      },
      aiBatchApply: batchApply,
      aiBatchApplyTotals: accumulateAiBatchApplyTotals(metrics.aiBatchApplyTotals, batchApply),
      aiBatchesCompleted: readAiBatchesCompleted(metrics) + 1,
    };
    const completionLogContext = {
      outputRows: outputRows.length,
      parsedRows: parsedDetections.length,
      applied: applyMetrics.applied,
      noShadeMatch: applyMetrics.noShadeMatch,
      rowsWithTokenUsage: tokenUsage.rowsWithUsage,
      promptTokens: tokenUsage.promptTokens,
      completionTokens: tokenUsage.completionTokens,
      totalTokens: tokenUsage.totalTokens,
    };

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
        const message = `Cannot continue job ${job.jobId} after batch ${batchStatus.id}: stored resume message ${invalidReason}`;
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
          `Batch ${batchStatus.id} applied; continuation queued at page ${checkpoint.nextPage}`,
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
        const message = `Failed to enqueue continuation for job ${job.jobId} after batch ${batchStatus.id}: ${reason}`;
        await failContinuation(job.jobId, continuationMetrics, message, polledAt, context);
        return;
      }

      context.log(
        `[ingestion-ai-batch-poller] Job ${job.jobId} applied batch ${batchStatus.id}; continuation ${checkpoint.continuationCount} queued at page ${checkpoint.nextPage}`,
        completionLogContext
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
      `[ingestion-ai-batch-poller] Job ${job.jobId} completed from batch ${batchStatus.id}`,
      completionLogContext
    );
    return;
  }

  const failedMessage = `Azure OpenAI batch ${batchStatus.id} ended with status ${batchStatus.status}`;
  const failedMetrics = withPipelineMetrics(
    appendJobLog(metrics, "error", failedMessage, {
      outputFileId: batchStatus.outputFileId,
      errorFileId: batchStatus.errorFileId,
    }),
    "failed",
    "awaiting_ai",
    {
      failedAt: polledAt,
      failedStage: "awaiting_ai",
      aiBatch: {
        ...toRecord(metrics.aiBatch),
        status: batchStatus.status,
        lastPolledAt: polledAt,
        outputFileId: batchStatus.outputFileId,
        errorFileId: batchStatus.errorFileId,
        requestCounts: batchStatus.requestCounts,
      },
    }
  );
  if (!(await shouldApplyJobUpdate(job.jobId, context, "failure"))) {
    return;
  }
  await markIngestionJobFailed(job.jobId, failedMessage, failedMetrics);
  context.error(
    `[ingestion-ai-batch-poller] Job ${job.jobId} failed: ${failedMessage}`
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
