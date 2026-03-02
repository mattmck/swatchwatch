import { app, InvocationContext } from "@azure/functions";
import {
  applyBatchHexResults,
  listAwaitingAiJobs,
  markIngestionJobFailed,
  markIngestionJobSucceeded,
} from "../lib/ingestion-repo";
import { getBatchStatus, parseBatchOutput } from "../lib/openai-batch";

/**
 * Timer-triggered batch completion worker.
 *
 * Runs every 5 minutes and checks for ingestion jobs that are waiting for
 * Azure OpenAI Batch API results (pipeline.stage = "awaiting_ai").
 * When a batch completes it downloads the output, applies detected_hex to
 * shade rows, and marks the ingestion job succeeded or failed.
 */

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function processBatchCompletionWorker(
  _myTimer: unknown,
  context: InvocationContext
): Promise<void> {
  context.log("[batch-completion-worker] Timer fired, checking for awaiting_ai jobs");

  let awaitingJobs: Awaited<ReturnType<typeof listAwaitingAiJobs>>;
  try {
    awaitingJobs = await listAwaitingAiJobs();
  } catch (err) {
    context.error("[batch-completion-worker] Failed to query awaiting_ai jobs:", err);
    return;
  }

  if (awaitingJobs.length === 0) {
    context.log("[batch-completion-worker] No awaiting_ai jobs found");
    return;
  }

  context.log(`[batch-completion-worker] Found ${awaitingJobs.length} awaiting_ai job(s)`);

  for (const job of awaitingJobs) {
    context.log(`[batch-completion-worker] Checking batch ${job.batchId} for job ${job.jobId}`);

    try {
      const status = await getBatchStatus(job.batchId);
      context.log(`[batch-completion-worker] Batch ${job.batchId} status=${status.status}`, {
        completed: status.requestCounts.completed,
        failed: status.requestCounts.failed,
        total: status.requestCounts.total,
      });

      if (status.status === "in_progress" || status.status === "validating" || status.status === "finalizing") {
        context.log(`[batch-completion-worker] Batch ${job.batchId} still in progress, skipping`);
        continue;
      }

      if (status.status === "failed" || status.status === "expired" || status.status === "cancelled" || status.status === "cancelling") {
        const reason = `Batch ${job.batchId} ended with status: ${status.status}`;
        context.warn(`[batch-completion-worker] ${reason}`);
        const now = new Date().toISOString();
        await markIngestionJobFailed(job.jobId, reason, {
          ...job.metricsJson,
          pipeline: {
            ...(job.metricsJson.pipeline as Record<string, unknown> | undefined),
            status: "failed",
            stage: "batch_completion_error",
            updatedAt: now,
          },
          batchFinalStatus: status.status,
          batchId: job.batchId,
          completedAt: now,
        });
        continue;
      }

      // status === "completed"
      if (!status.outputFileId) {
        const reason = `Batch ${job.batchId} completed but has no output_file_id`;
        context.warn(`[batch-completion-worker] ${reason}`);
        const now = new Date().toISOString();
        await markIngestionJobFailed(job.jobId, reason, {
          ...job.metricsJson,
          pipeline: {
            ...(job.metricsJson.pipeline as Record<string, unknown> | undefined),
            status: "failed",
            stage: "batch_completion_error",
            updatedAt: now,
          },
          batchId: job.batchId,
          completedAt: now,
        });
        continue;
      }

      context.log(`[batch-completion-worker] Parsing output for batch ${job.batchId}`);
      const outputItems = await parseBatchOutput(status.outputFileId);

      context.log(`[batch-completion-worker] Applying ${outputItems.length} batch results for job ${job.jobId}`);
      const applyResult = await applyBatchHexResults(
        outputItems,
        job.customIdToShadeId,
        job.overwriteDetectedHex
      );

      context.log(`[batch-completion-worker] Applied results for job ${job.jobId}`, {
        applied: applyResult.applied,
        skipped: applyResult.skipped,
        failed: applyResult.failed,
      });

      await markIngestionJobSucceeded(job.jobId, {
        ...job.metricsJson,
        pipeline: {
          ...(job.metricsJson.pipeline as Record<string, unknown> | undefined),
          status: "succeeded",
          stage: "apply_results",
          updatedAt: new Date().toISOString(),
        },
        batchId: job.batchId,
        completedAt: new Date().toISOString(),
        outputProcessedCount: applyResult.applied,
        failedRequestCount: applyResult.failed,
        batchRequestCounts: status.requestCounts,
      });

      context.log(`[batch-completion-worker] Job ${job.jobId} succeeded`);
    } catch (err) {
      const message = getErrorMessage(err);
      context.error(`[batch-completion-worker] Error processing batch ${job.batchId} for job ${job.jobId}:`, err);

      try {
        const existingMetrics =
          // Prefer camelCase if present, fall back to snake_case, otherwise empty.
          (job as any).metricsJson ??
          (job as any).metrics_json ??
          {};
        const now = new Date().toISOString();
        const mergedMetrics = {
          ...existingMetrics,
          pipeline: {
            ...(existingMetrics as any).pipeline,
            status: "failed",
            stage: "batch_completion_error",
            updatedAt: now,
          },
          batchId: job.batchId,
          failedAt: now,
          error: message,
        };

        await markIngestionJobFailed(job.jobId, message, mergedMetrics);
      } catch (markErr) {
        context.error(`[batch-completion-worker] Failed to mark job ${job.jobId} failed:`, markErr);
      }
    }
  }

  context.log("[batch-completion-worker] Done");
}

// Run every 5 minutes
app.timer("batch-completion-worker", {
  schedule: "0 */5 * * * *",
  handler: processBatchCompletionWorker,
});
