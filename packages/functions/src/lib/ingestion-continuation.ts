import { QueueServiceClient } from "@azure/storage-queue";
import type { SupportedConnectorSource } from "./connectors/types";

/**
 * Shared contract for splitting one ingestion job across multiple queue invocations.
 *
 * The Consumption plan kills a worker invocation after 5 minutes, so a whole-store run
 * cannot finish in one invocation. Instead, the worker processes records until its time
 * budget is spent, persists an {@link IngestionCheckpoint}, and enqueues a continuation
 * message that carries the checkpoint. The AI batch poller does the same after it applies
 * the job's pending batches: it re-enqueues the {@link RESUME_MESSAGE_METRICS_KEY} message the
 * worker stored when it paused for `awaiting_ai`.
 */

const AZURE_STORAGE_CONNECTION_SETTING = "AzureWebJobsStorage";
const DEFAULT_WORKER_TIME_BUDGET_MS = 240_000;
const MIN_WORKER_TIME_BUDGET_MS = 30_000;
// Leave headroom under the 5-minute Consumption plan limit for checkpoint + enqueue.
const MAX_WORKER_TIME_BUDGET_MS = 270_000;

export const INGESTION_JOB_QUEUE_NAME =
  (process.env.INGESTION_JOB_QUEUE_NAME || "ingestion-jobs").trim().toLowerCase();

/** Key in `ingestion_job.metrics_json` holding the latest {@link IngestionCheckpoint}. */
export const CHECKPOINT_METRICS_KEY = "checkpoint";

/**
 * Key in `ingestion_job.metrics_json` holding the {@link IngestionJobQueueMessage} to
 * enqueue once the job's pending Azure OpenAI batches have been applied. Absent when no work
 * remains, in which case the poller completes the job.
 */
export const RESUME_MESSAGE_METRICS_KEY = "resumeMessage";

/** Pipeline stage set immediately before a continuation message is enqueued. */
export const CONTINUATION_QUEUED_STAGE = "continuation_queued";

/**
 * Key in `ingestion_job.metrics_json` listing every Azure OpenAI hex batch submitted for the
 * job ({@link IngestionAiBatchEntry}). Records are committed before their batch is submitted
 * (the batch only fills in detected hex), so the worker keeps ingesting while batches run and
 * the poller applies each one as it completes. The job finishes once none are pending.
 */
export const AI_BATCHES_METRICS_KEY = "aiBatches";

const DEFAULT_MAX_IN_FLIGHT_AI_BATCHES = 20;

/** One submitted hex detection batch; `status` mirrors the Azure OpenAI batch status. */
export interface IngestionAiBatchEntry extends Record<string, unknown> {
  batchId: string;
  status: string;
  overwriteDetectedHex: boolean;
  requestCount?: number;
  /** Deployment the batch was submitted to; stamped on applied detections as `detected_hex_model`. */
  deployment?: string | null;
  /** `PROMPT_VERSION` the batch requests were built with (`detected_hex_prompt_version`). */
  promptVersion?: string | null;
}

/** Statuses after which a batch needs no more polling. */
const TERMINAL_AI_BATCH_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);

export function isAiBatchPending(entry: IngestionAiBatchEntry): boolean {
  return !TERMINAL_AI_BATCH_STATUSES.has(entry.status);
}

/** Parse the job's batch list, dropping malformed entries. */
export function readAiBatchesFromMetrics(
  metrics: Record<string, unknown> | undefined | null
): IngestionAiBatchEntry[] {
  const raw = metrics?.[AI_BATCHES_METRICS_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((value): IngestionAiBatchEntry[] => {
    if (!isRecord(value) || typeof value.batchId !== "string" || !value.batchId.trim()) {
      return [];
    }
    return [
      {
        ...value,
        batchId: value.batchId.trim(),
        status: typeof value.status === "string" ? value.status : "submitted",
        overwriteDetectedHex: value.overwriteDetectedHex === true,
      },
    ];
  });
}

/**
 * Cap on batches a job may have pending at once. Each batch enqueues its prompt tokens
 * against the batch deployment's enqueued-token quota; at ~3K tokens per image and 50
 * images per batch, 20 batches stay well under a 5M-token quota. Once a job reaches the cap
 * the worker pauses for `awaiting_ai` and the poller resumes it when they have completed.
 */
export function getMaxInFlightAiBatches(): number {
  const parsed = Number.parseInt(process.env.HEX_DETECTION_BATCH_MAX_IN_FLIGHT || "", 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_IN_FLIGHT_AI_BATCHES;
  }
  return Math.min(100, Math.max(1, parsed));
}

export interface IngestionJobRequest {
  source: SupportedConnectorSource;
  searchTerm: string;
  page: number;
  pageSize: number;
  maxRecords: number;
  recentDays?: number;
  materializeToInventory: boolean;
  detectHexFromImage: boolean;
  detectHexOnSuspiciousOnly: boolean;
  overwriteDetectedHex: boolean;
  collectTrainingData: boolean;
  /** When true, loop through all pages until source returns empty (ignores maxRecords cap) */
  exhaustive: boolean;
}

/** Where the next invocation should pick up. Pages are 1-based; offsets are 0-based. */
export interface IngestionCheckpoint {
  /** Connector page to pull next. */
  nextPage: number;
  /** Number of records in `nextPage` already processed; 0 means start of page. */
  recordOffset: number;
  /** Pages fully processed so far across all invocations. */
  pagesCompleted: number;
  /** Records processed so far across all invocations. */
  recordsProcessed: number;
  /** How many continuation messages have been enqueued for this job. */
  continuationCount: number;
  updatedAt: string;
}

export interface IngestionJobQueueMessage {
  jobId: number;
  userId: number;
  queuedAt: string;
  request: IngestionJobRequest;
  requestedMetrics: Record<string, unknown>;
  /** Present on continuation messages; absent on the first message for a job. */
  checkpoint?: IngestionCheckpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate an untrusted checkpoint (queue payload or metrics_json); null when malformed. */
export function parseIngestionCheckpoint(value: unknown): IngestionCheckpoint | null {
  if (!isRecord(value)) {
    return null;
  }

  const { nextPage, recordOffset, pagesCompleted, recordsProcessed, continuationCount, updatedAt } =
    value;
  if (
    !isNonNegativeInt(nextPage) ||
    nextPage < 1 ||
    !isNonNegativeInt(recordOffset) ||
    !isNonNegativeInt(pagesCompleted) ||
    !isNonNegativeInt(recordsProcessed) ||
    !isNonNegativeInt(continuationCount) ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }

  return { nextPage, recordOffset, pagesCompleted, recordsProcessed, continuationCount, updatedAt };
}

/** Read the checkpoint persisted on a job row, if any. */
export function readCheckpointFromMetrics(
  metrics: Record<string, unknown> | undefined | null
): IngestionCheckpoint | null {
  return parseIngestionCheckpoint(metrics?.[CHECKPOINT_METRICS_KEY]);
}

/** Read the continuation message the worker stored before pausing for an AI batch. */
export function readResumeMessageFromMetrics(
  metrics: Record<string, unknown> | undefined | null
): IngestionJobQueueMessage | null {
  const candidate = metrics?.[RESUME_MESSAGE_METRICS_KEY];
  if (!isRecord(candidate)) {
    return null;
  }

  if (
    // Positive, matching the worker's parsePositiveInt so the poller never enqueues a
    // message the worker would reject.
    !isNonNegativeInt(candidate.jobId) ||
    candidate.jobId < 1 ||
    !isNonNegativeInt(candidate.userId) ||
    candidate.userId < 1 ||
    typeof candidate.queuedAt !== "string" ||
    !isRecord(candidate.request) ||
    !isRecord(candidate.requestedMetrics)
  ) {
    return null;
  }

  const checkpoint =
    candidate.checkpoint === undefined ? undefined : parseIngestionCheckpoint(candidate.checkpoint);
  if (checkpoint === null) {
    return null;
  }

  return {
    jobId: candidate.jobId,
    userId: candidate.userId,
    queuedAt: candidate.queuedAt,
    request: candidate.request as unknown as IngestionJobRequest,
    requestedMetrics: candidate.requestedMetrics,
    ...(checkpoint ? { checkpoint } : {}),
  };
}

/** Wall-clock budget for one worker invocation before it must checkpoint and hand off. */
export function getWorkerTimeBudgetMs(): number {
  const parsed = Number.parseInt(process.env.INGESTION_WORKER_TIME_BUDGET_MS || "", 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WORKER_TIME_BUDGET_MS;
  }
  return Math.min(MAX_WORKER_TIME_BUDGET_MS, Math.max(MIN_WORKER_TIME_BUDGET_MS, parsed));
}

/**
 * Enqueue a continuation message from code that has no queue output binding (the timer
 * poller, or a worker mid-invocation). The Functions queue trigger decodes base64 by
 * default, so the payload must be base64-encoded to match output-binding messages.
 *
 * Callers must persist the checkpoint and set the pipeline stage to
 * {@link CONTINUATION_QUEUED_STAGE} BEFORE calling this, so a fast-starting worker never
 * reads a stale `awaiting_ai` stage and drops the message.
 */
export async function enqueueIngestionContinuation(
  message: IngestionJobQueueMessage
): Promise<void> {
  const connectionString = process.env[AZURE_STORAGE_CONNECTION_SETTING];
  if (!connectionString) {
    throw new Error(`${AZURE_STORAGE_CONNECTION_SETTING} environment variable not configured`);
  }

  const queueClient = QueueServiceClient.fromConnectionString(connectionString).getQueueClient(
    INGESTION_JOB_QUEUE_NAME
  );
  await queueClient.createIfNotExists();
  await queueClient.sendMessage(Buffer.from(JSON.stringify(message), "utf8").toString("base64"));
}
