import { app, InvocationContext } from "@azure/functions";
import { getIngestionJobById, markIngestionJobFailed } from "../lib/ingestion-repo";
import type { IngestionJobRecord } from "../lib/ingestion-repo";
import {
  IngestionCheckpoint,
  parseIngestionCheckpoint,
  readCheckpointFromMetrics,
} from "../lib/ingestion-continuation";
import {
  getPipelineStage,
  INGESTION_JOB_QUEUE_NAME,
  IngestionJobQueueMessage,
  processIngestionJobQueueMessage,
  resolveIngestionResumePoint,
} from "./ingestion";

const INVALID_QUEUE_PAYLOAD_STAGE = "queue_payload_validation";

/** The Functions runtime moves a message here after `maxDequeueCount` failed deliveries. */
export const INGESTION_JOB_POISON_QUEUE_NAME = `${INGESTION_JOB_QUEUE_NAME}-poison`;
export const QUEUE_POISONED_STAGE = "queue_poisoned";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function parseQueuePayload(queueEntry: unknown): Record<string, unknown> | null {
  if (typeof queueEntry === "string") {
    try {
      const parsed = JSON.parse(queueEntry);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  if (isRecord(queueEntry)) {
    return queueEntry;
  }

  return null;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true") {
      return true;
    }
    if (trimmed === "false") {
      return false;
    }
  }

  return null;
}

function parseNormalizedRequest(
  value: unknown
): IngestionJobQueueMessage["request"] | null {
  if (!isRecord(value)) {
    return null;
  }

  const source =
    typeof value.source === "string" && value.source.trim().length > 0
      ? value.source.trim()
      : null;
  const searchTerm =
    typeof value.searchTerm === "string" && value.searchTerm.trim().length > 0
      ? value.searchTerm.trim()
      : null;
  const page = parsePositiveInt(value.page);
  const pageSize = parsePositiveInt(value.pageSize);
  const maxRecords = parsePositiveInt(value.maxRecords);

  const materializeToInventory =
    value.materializeToInventory === undefined
      ? true
      : parseBoolean(value.materializeToInventory);
  const detectHexFromImage =
    value.detectHexFromImage === undefined
      ? true
      : parseBoolean(value.detectHexFromImage);
  const detectHexOnSuspiciousOnly =
    value.detectHexOnSuspiciousOnly === undefined
      ? false
      : parseBoolean(value.detectHexOnSuspiciousOnly);
  const overwriteDetectedHex =
    value.overwriteDetectedHex === undefined
      ? false
      : parseBoolean(value.overwriteDetectedHex);
  const collectTrainingData =
    value.collectTrainingData === undefined
      ? false
      : parseBoolean(value.collectTrainingData);
  const exhaustive =
    value.exhaustive === undefined
      ? false
      : parseBoolean(value.exhaustive);

  let recentDays: number | undefined;
  if (value.recentDays === undefined || value.recentDays === null) {
    recentDays = undefined;
  } else {
    const parsedRecentDays = parsePositiveInt(value.recentDays);
    if (parsedRecentDays === null) {
      return null;
    }
    recentDays = parsedRecentDays;
  }

  if (
    source === null ||
    searchTerm === null ||
    page === null ||
    pageSize === null ||
    maxRecords === null ||
    materializeToInventory === null ||
    detectHexFromImage === null ||
    detectHexOnSuspiciousOnly === null ||
    overwriteDetectedHex === null ||
    collectTrainingData === null ||
    exhaustive === null
  ) {
    return null;
  }

  return {
    source: source as IngestionJobQueueMessage["request"]["source"],
    searchTerm,
    page,
    pageSize,
    maxRecords,
    materializeToInventory,
    detectHexFromImage,
    detectHexOnSuspiciousOnly,
    overwriteDetectedHex,
    collectTrainingData,
    exhaustive,
    recentDays,
  };
}

async function markQueuePayloadInvalid(
  context: InvocationContext,
  rawPayload: Record<string, unknown>,
  jobId: number | null,
  reason: string
): Promise<void> {
  const message = `Invalid ingestion queue payload: ${reason}`;
  context.error(message, rawPayload);

  if (jobId === null) {
    return;
  }

  try {
    const existingJob = await getIngestionJobById(jobId);
    if (!existingJob) {
      context.warn(`Invalid queue payload references unknown job ${jobId}`);
      return;
    }

    if (existingJob.status === "succeeded" || existingJob.status === "cancelled") {
      context.warn(
        `Invalid queue payload ignored for job ${jobId}: job already ${existingJob.status}`
      );
      return;
    }

    if (existingJob.status === "failed") {
      context.log(`Invalid queue payload ignored for job ${jobId}: job already failed`);
      return;
    }

    const now = new Date().toISOString();
    const requestedMetrics = isRecord(rawPayload.requestedMetrics) ? rawPayload.requestedMetrics : {};

    await markIngestionJobFailed(jobId, message, {
      ...requestedMetrics,
      pipeline: {
        status: "failed",
        stage: INVALID_QUEUE_PAYLOAD_STAGE,
        updatedAt: now,
      },
      invalidQueuePayload: {
        reason,
        queueName: INGESTION_JOB_QUEUE_NAME,
        failedAt: now,
      },
    });
  } catch (error) {
    context.error("Failed to mark ingestion job as failed for invalid queue payload:", error);
  }
}

async function ingestionJobWorker(
  queueEntry: unknown,
  context: InvocationContext
): Promise<void> {
  const rawPayload = parseQueuePayload(queueEntry);
  if (!rawPayload) {
    context.error("Invalid ingestion queue payload", queueEntry);
    return;
  }

  const jobId = parsePositiveInt(rawPayload.jobId);
  if (jobId === null) {
    await markQueuePayloadInvalid(context, rawPayload, null, "jobId is required");
    return;
  }

  const userId = parsePositiveInt(rawPayload.userId);
  if (userId === null) {
    await markQueuePayloadInvalid(context, rawPayload, jobId, "userId is required");
    return;
  }

  const request = parseNormalizedRequest(rawPayload.request);
  if (!request) {
    await markQueuePayloadInvalid(context, rawPayload, jobId, "request is invalid");
    return;
  }

  // Continuation messages carry a checkpoint; first messages for a job do not.
  let checkpoint: IngestionJobQueueMessage["checkpoint"];
  if (rawPayload.checkpoint !== undefined && rawPayload.checkpoint !== null) {
    const parsedCheckpoint = parseIngestionCheckpoint(rawPayload.checkpoint);
    if (!parsedCheckpoint) {
      await markQueuePayloadInvalid(context, rawPayload, jobId, "checkpoint is invalid");
      return;
    }
    checkpoint = parsedCheckpoint;
  }

  const queuedAt =
    typeof rawPayload.queuedAt === "string" && rawPayload.queuedAt.trim().length > 0
      ? rawPayload.queuedAt
      : new Date().toISOString();

  const payload: IngestionJobQueueMessage = {
    jobId,
    userId,
    queuedAt,
    request,
    requestedMetrics: isRecord(rawPayload.requestedMetrics) ? rawPayload.requestedMetrics : {},
    ...(checkpoint ? { checkpoint } : {}),
  };

  await processIngestionJobQueueMessage(payload, context);
}

export type PoisonedIngestionMessageDecision =
  | { action: "fail"; reason: string }
  | { action: "ignore"; reason: string };

/**
 * Decide whether a message that landed in the poison queue should fail its job. Only the
 * job's current message may: a stale duplicate (an older continuation generation) is ignored
 * so it never fails a job a newer continuation is still running, and jobs in `awaiting_ai`
 * belong to the AI batch poller. `queued` counts too: a first message that never got as far
 * as marking the job running has no other message that would ever finish it.
 */
export function planPoisonedIngestionMessage(
  job: Pick<IngestionJobRecord, "status" | "metrics"> | null,
  messageCheckpoint: IngestionCheckpoint | null | undefined
): PoisonedIngestionMessageDecision {
  if (!job) {
    return { action: "ignore", reason: "job not found" };
  }
  if (job.status !== "running" && job.status !== "queued") {
    return { action: "ignore", reason: `job already ${job.status}` };
  }
  if (getPipelineStage(job.metrics) === "awaiting_ai") {
    return { action: "ignore", reason: "job is waiting for Azure OpenAI batches (owned by the poller)" };
  }

  const resume = resolveIngestionResumePoint(
    messageCheckpoint,
    readCheckpointFromMetrics(job.metrics)
  );
  if (resume.action === "drop") {
    return { action: "ignore", reason: resume.reason };
  }
  return { action: "fail", reason: "the job's current queue message exhausted its deliveries" };
}

async function ingestionJobPoisonHandler(
  queueEntry: unknown,
  context: InvocationContext
): Promise<void> {
  const rawPayload = parseQueuePayload(queueEntry);
  const jobId = rawPayload ? parsePositiveInt(rawPayload.jobId) : null;
  if (!rawPayload || jobId === null) {
    context.error("Poisoned ingestion queue message has no valid jobId", queueEntry);
    return;
  }

  // A malformed checkpoint is failed by the worker without throwing, so it never gets
  // here; treat one as generation 0 so a stale copy still cannot fail a newer run.
  const messageCheckpoint = parseIngestionCheckpoint(rawPayload.checkpoint);
  const job = await getIngestionJobById(jobId);
  const decision = planPoisonedIngestionMessage(job, messageCheckpoint);
  if (decision.action === "ignore" || !job) {
    context.log(`Poisoned ingestion message for job ${jobId} ignored: ${decision.reason}`);
    return;
  }

  const now = new Date().toISOString();
  const metrics = isRecord(job.metrics) ? job.metrics : {};
  const pipeline = isRecord(metrics.pipeline) ? metrics.pipeline : {};
  const continuationCount = messageCheckpoint?.continuationCount ?? 0;
  const lastStage = getPipelineStage(metrics);
  const message =
    `Ingestion queue message failed every delivery and was moved to ${INGESTION_JOB_POISON_QUEUE_NAME}` +
    ` (continuation ${continuationCount}, last stage ${lastStage ?? "unknown"})`;
  context.error(`Job ${jobId}: ${message}`);

  await markIngestionJobFailed(jobId, message, {
    ...metrics,
    pipeline: { ...pipeline, status: "failed", stage: QUEUE_POISONED_STAGE, updatedAt: now },
    poisonQueue: {
      queueName: INGESTION_JOB_POISON_QUEUE_NAME,
      messageContinuationCount: continuationCount,
      lastStage,
      failedAt: now,
    },
  });
}

app.storageQueue("ingestion-job-worker", {
  queueName: INGESTION_JOB_QUEUE_NAME,
  connection: "Storage",
  handler: ingestionJobWorker,
});

app.storageQueue("ingestion-job-poison", {
  queueName: INGESTION_JOB_POISON_QUEUE_NAME,
  connection: "Storage",
  handler: ingestionJobPoisonHandler,
});
