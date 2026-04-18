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

async function shouldApplyTerminalUpdate(
  jobId: number,
  context: InvocationContext,
  updateType: "success" | "failure"
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
    if (!(await shouldApplyTerminalUpdate(job.jobId, context, "failure"))) {
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

    const completionLogs = appendJobLog(
      appendJobLog(metrics, "info", `Batch ${batchStatus.id} completed`, {
        outputRows: outputRows.length,
        parsedRows: parsedDetections.length,
        parseErrors: parsedDetections.filter((row) => row.error).length,
      }),
      "info",
      `Applied ${applyMetrics.applied} batch detections`,
      {
        processed: applyMetrics.processed,
        skippedNoDetection: applyMetrics.skippedNoDetection,
        noShadeMatch: applyMetrics.noShadeMatch,
      }
    );

    const completionMetrics = withPipelineMetrics(
      {
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
        aiBatchApply: {
          ...applyMetrics,
          outputRows: outputRows.length,
          parsedRows: parsedDetections.length,
          parseErrors: parsedDetections.filter((row) => row.error).length,
          rowsWithTokenUsage: tokenUsage.rowsWithUsage,
          promptTokens: tokenUsage.promptTokens,
          completionTokens: tokenUsage.completionTokens,
          totalTokens: tokenUsage.totalTokens,
        },
      },
      "succeeded",
      "completed",
      {
        workerCompletedAt: polledAt,
      }
    );

    if (!(await shouldApplyTerminalUpdate(job.jobId, context, "success"))) {
      return;
    }
    await markIngestionJobSucceeded(job.jobId, completionMetrics);
    context.log(
      `[ingestion-ai-batch-poller] Job ${job.jobId} completed from batch ${batchStatus.id}`,
      {
        outputRows: outputRows.length,
        parsedRows: parsedDetections.length,
        applied: applyMetrics.applied,
        noShadeMatch: applyMetrics.noShadeMatch,
        rowsWithTokenUsage: tokenUsage.rowsWithUsage,
        promptTokens: tokenUsage.promptTokens,
        completionTokens: tokenUsage.completionTokens,
        totalTokens: tokenUsage.totalTokens,
      }
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
  if (!(await shouldApplyTerminalUpdate(job.jobId, context, "failure"))) {
    return;
  }
  await markIngestionJobFailed(job.jobId, failedMessage, failedMetrics);
  context.error(
    `[ingestion-ai-batch-poller] Job ${job.jobId} failed: ${failedMessage}`
  );
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
