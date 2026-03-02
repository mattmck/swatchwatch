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

const DEFAULT_BATCH_POLL_SCHEDULE = "0 */2 * * * *";
const DEFAULT_MAX_JOBS_PER_POLL = 10;

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

const BATCH_POLLER_ENABLED = envFlagTrue(process.env.HEX_DETECTION_BATCH_ENABLED);
const BATCH_POLL_SCHEDULE =
  process.env.INGESTION_AI_BATCH_POLL_SCHEDULE?.trim() || DEFAULT_BATCH_POLL_SCHEDULE;
const MAX_JOBS_PER_POLL = parseIntEnv(
  process.env.INGESTION_AI_BATCH_MAX_POLL_JOBS,
  DEFAULT_MAX_JOBS_PER_POLL,
  1,
  100
);

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
    const failedMetrics = withPipelineMetrics(metrics, "failed", "awaiting_ai", {
      failedAt: new Date().toISOString(),
      failedStage: "awaiting_ai",
    });
    await markIngestionJobFailed(job.jobId, message, failedMetrics);
    context.error(`[ingestion-ai-batch-poller] Job ${job.jobId} failed: ${message}`);
    return;
  }

  const batchStatus = await getVisionHexBatchStatus(aiBatchMetrics.batchId);
  const polledAt = new Date().toISOString();

  if (isBatchStillRunning(batchStatus.status)) {
    const runningMetrics = withPipelineMetrics(metrics, "running", "awaiting_ai", {
      aiBatch: {
        ...toRecord(metrics.aiBatch),
        status: batchStatus.status,
        lastPolledAt: polledAt,
        outputFileId: batchStatus.outputFileId,
        errorFileId: batchStatus.errorFileId,
        requestCounts: batchStatus.requestCounts,
      },
    });
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

    const applyMetrics = await applyAiBatchShadeDetections(
      job.dataSourceId,
      parsedDetections.map((row) => ({
        externalId: row.customId,
        detectedHex: row.detection?.hex || null,
        detectedFinishes: row.detection?.finishes || null,
      })),
      aiBatchMetrics.overwriteDetectedHex
    );

    const completionMetrics = withPipelineMetrics(
      {
        ...metrics,
        aiBatch: {
          ...toRecord(metrics.aiBatch),
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
        },
      },
      "succeeded",
      "completed",
      {
        workerCompletedAt: polledAt,
      }
    );

    await markIngestionJobSucceeded(job.jobId, completionMetrics);
    context.log(
      `[ingestion-ai-batch-poller] Job ${job.jobId} completed from batch ${batchStatus.id}`,
      {
        outputRows: outputRows.length,
        parsedRows: parsedDetections.length,
        applied: applyMetrics.applied,
        noShadeMatch: applyMetrics.noShadeMatch,
      }
    );
    return;
  }

  const failedMessage = `Azure OpenAI batch ${batchStatus.id} ended with status ${batchStatus.status}`;
  const failedMetrics = withPipelineMetrics(metrics, "failed", "awaiting_ai", {
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
  });
  await markIngestionJobFailed(job.jobId, failedMessage, failedMetrics);
  context.error(
    `[ingestion-ai-batch-poller] Job ${job.jobId} failed: ${failedMessage}`
  );
}

async function ingestionAiBatchPoller(
  _timer: Timer,
  context: InvocationContext
): Promise<void> {
  if (!BATCH_POLLER_ENABLED) {
    context.log(
      "[ingestion-ai-batch-poller] Skipping run because HEX_DETECTION_BATCH_ENABLED is false"
    );
    return;
  }

  const awaitingJobs = await listIngestionJobsAwaitingAiBatch(MAX_JOBS_PER_POLL);
  if (awaitingJobs.length === 0) {
    context.log("[ingestion-ai-batch-poller] No awaiting_ai jobs found");
    return;
  }

  context.log(
    `[ingestion-ai-batch-poller] Processing ${awaitingJobs.length} awaiting_ai job(s)`
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
      await markIngestionJobFailed(job.jobId, message, failedMetrics);
    }
  }
}

app.timer("ingestion-ai-batch-poller", {
  schedule: BATCH_POLL_SCHEDULE,
  runOnStartup: false,
  handler: ingestionAiBatchPoller,
});
