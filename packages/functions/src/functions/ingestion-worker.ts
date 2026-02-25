import { app, InvocationContext } from "@azure/functions";
import { getIngestionJobById, markIngestionJobFailed } from "../lib/ingestion-repo";
import {
  INGESTION_JOB_QUEUE_NAME,
  IngestionJobQueueMessage,
  processIngestionJobQueueMessage,
} from "./ingestion";

const INVALID_QUEUE_PAYLOAD_STAGE = "queue_payload_validation";

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
  const overwriteDetectedHex =
    value.overwriteDetectedHex === undefined
      ? false
      : parseBoolean(value.overwriteDetectedHex);
  const collectTrainingData =
    value.collectTrainingData === undefined
      ? false
      : parseBoolean(value.collectTrainingData);

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
    overwriteDetectedHex === null ||
    collectTrainingData === null
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
    detectHexOnSuspiciousOnly: false,
    overwriteDetectedHex,
    collectTrainingData,
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
  };

  await processIngestionJobQueueMessage(payload, context);
}

app.storageQueue("ingestion-job-worker", {
  queueName: INGESTION_JOB_QUEUE_NAME,
  connection: "Storage",
  handler: ingestionJobWorker,
});
