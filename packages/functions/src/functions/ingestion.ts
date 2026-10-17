import { app, HttpRequest, HttpResponseInit, InvocationContext, output } from "@azure/functions";
import {
  BulkIngestionRequest,
  BulkIngestionResponse,
  IngestionJobListResponse,
  IngestionJobRecord,
  IngestionJobRunRequest,
  IngestionJobRunResponse,
} from "swatchwatch-shared";
import { saveConnectorRawSnapshot } from "../lib/connector-raw-storage";
import { withAdmin } from "../lib/auth";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { getQueueStats, purgeQueue } from "../lib/queue-management";
import {
  cancelIngestionJob,
  createIngestionJob,
  ensureDataSourceByName,
  ensureSupportedShopifyDataSources,
  getDataSourceByName,
  getGlobalSettings,
  getIngestionJobById,
  listDataSources,
  listDataSourcesWithSettings,
  listIngestionJobs,
  markIngestionJobFailed,
  markIngestionJobRunning,
  markIngestionJobSucceeded,
  materializeHoloTacoRecords,
  materializeMakeupApiRecords,
  updateDataSourceSettings,
  updateIngestionJobMetrics,
  updateGlobalSettings,
  upsertExternalProducts,
} from "../lib/ingestion-repo";


import {
  AI_BATCHES_METRICS_KEY,
  CHECKPOINT_METRICS_KEY,
  CONTINUATION_QUEUED_STAGE,
  enqueueIngestionContinuation,
  getMaxInFlightAiBatches,
  getWorkerTimeBudgetMs,
  INGESTION_JOB_QUEUE_NAME,
  IngestionAiBatchEntry,
  IngestionCheckpoint,
  IngestionJobQueueMessage,
  IngestionJobRequest,
  isAiBatchPending,
  readAiBatchesFromMetrics,
  readCheckpointFromMetrics,
  RESUME_MESSAGE_METRICS_KEY,
} from "../lib/ingestion-continuation";
import {
  CATALOG_SNAPSHOT_METRICS_KEY,
  createIngestionCatalogCache,
  readCatalogSnapshotFromMetrics,
} from "../lib/ingestion-catalog-cache";
import { JobLogger } from "../lib/job-logger";
import { OpenBeautyFactsConnector } from "../lib/connectors/open-beauty-facts";
import { MakeupApiConnector } from "../lib/connectors/makeup-api";
import { HoloTacoShopifyConnector } from "../lib/connectors/holo-taco-shopify";
import { ShopifyGenericConnector } from "../lib/connectors/shopify-generic";
import {
  ProductConnector,
  SOURCE_PROTOCOL_MAP,
  SupportedConnectorSource,
  SUPPORTED_SOURCES,
} from "../lib/connectors/types";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_RECORDS = 20;
const DEFAULT_RECENT_DAYS = 120;
const MAX_PAGE_SIZE = 100;
const MAX_RECORDS = 200;
const MAX_RECENT_DAYS = 3650;
const MAX_BULK_SOURCES = SUPPORTED_SOURCES.length;
const DEFAULT_SEARCH_TERM = "nail polish";
const JOB_TYPE_CONNECTOR_VERIFY = "connector_verify";
// Queue bindings resolve this to the AzureWebJobsStorage app setting.
const INGESTION_QUEUE_CONNECTION_SETTING = "Storage";

export { INGESTION_JOB_QUEUE_NAME, type IngestionJobQueueMessage };
const DEFAULT_HEX_BATCH_MIN_IMAGES = 5;
// Records persisted per unit of work when hex detection runs synchronously (one AI call +
// HEX_DETECTION_DELAY_MS per record). Small enough that a hard kill loses little work.
const INGESTION_SYNC_CHUNK_SIZE = 10;
// Bounded so that if batch submission fails and the materializer falls back to synchronous
// detection, one chunk (uploads + ~3.5s per AI call) still fits well inside functionTimeout.
const INGESTION_BATCH_CHUNK_SIZE = 50;
/** Set once batch submission has failed for a job; later chunks use synchronous detection. */
const HEX_BATCH_DEGRADED_METRICS_KEY = "hexBatchDegraded";
// Key in metrics_json holding the worker's separated persistence/materialization totals so
// a continuation can keep summing them (the flattened top-level keys overlap, e.g. `skipped`).
const WORKER_TOTALS_METRICS_KEY = "workerTotals";
const CONTINUATION_ENQUEUE_STAGE = "continuation_enqueue";
// Per-invocation keys that must not be carried into a continuation's metrics.
const NON_CARRIED_METRIC_KEYS = new Set(["logs", "pipeline", RESUME_MESSAGE_METRICS_KEY]);


function envFlagTrue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

interface HexBatchRuntimeConfig {
  enabled: boolean;
  minImages: number;
}

const ingestionJobQueueOutput = output.storageQueue({
  queueName: INGESTION_JOB_QUEUE_NAME,
  connection: INGESTION_QUEUE_CONNECTION_SETTING,
});

// Supported sources are now derived from seed_data_sources.sql
// Run "npm run generate:types" to regenerate after adding new sources

type NormalizedIngestionJobRequest = IngestionJobRequest;

function clampInt(
  value: unknown,
  fallback: number,
  minValue: number,
  maxValue: number
): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maxValue, Math.max(minValue, parsed));
}

function getHexBatchRuntimeConfig(): HexBatchRuntimeConfig {
  return {
    enabled: envFlagTrue(process.env.HEX_DETECTION_BATCH_ENABLED),
    minImages: clampInt(
      process.env.HEX_DETECTION_BATCH_MIN_IMAGES,
      DEFAULT_HEX_BATCH_MIN_IMAGES,
      1,
      1000
    ),
  };
}

function isSupportedSource(value: string): value is SupportedConnectorSource {
  return (SUPPORTED_SOURCES as readonly string[]).includes(value);
}

function hasRunnableConnector(source: SupportedConnectorSource): boolean {
  return source === "OpenBeautyFacts" || source === "MakeupAPI" || source.endsWith("Shopify");
}

function isRunnableConnectorSource(value: string): value is SupportedConnectorSource {
  return isSupportedSource(value) && hasRunnableConnector(value);
}

function createConnector(source: SupportedConnectorSource, baseUrl?: string | null): ProductConnector {
  if (source === "OpenBeautyFacts") {
    return new OpenBeautyFactsConnector(baseUrl);
  }
  if (source === "MakeupAPI") {
    return new MakeupApiConnector(baseUrl);
  }
  if (source === "HoloTacoShopify") {
    return new HoloTacoShopifyConnector(baseUrl);
  }

  // All other Shopify stores use the generic Shopify connector
  if (source.endsWith("Shopify")) {
    return new ShopifyGenericConnector(source, baseUrl);
  }

  throw new Error(`No connector available for source: ${source}`);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

const ADDITIVE_METRIC_KEYS = new Set([
  "processed",
  "inserted",
  "updated",
  "skipped",
  "variantRowsProcessed",
  "brandsCreated",
  "shadesCreated",
  "inventoryInserted",
  "inventoryUpdated",
  "legacyRowsDeleted",
  "hexOverwritten",
  "imageCandidates",
  "imageUploads",
  "imageUploadFailures",
  "additionalImagesUploaded",
  "imagesReused",
  "swatchesLinked",
  "hexDetected",
  "hexDetectionFailures",
  "hexDetectionSkipped",
  "hexDetectionSkippedUnchanged",
  "hexDetectionPromptTokens",
  "hexDetectionCompletionTokens",
  "hexDetectionTotalTokens",
  "batchRequestsQueued",
  "applied",
  "skippedNoDetection",
  "noShadeMatch",
]);

/**
 * Merge per-page metric objects while only summing known additive counters.
 * Non-additive values are overwritten by the latest incoming page metrics.
 */
function mergeMetrics(
  target: Record<string, unknown>,
  incoming: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!incoming) {
    return target;
  }

  for (const [key, value] of Object.entries(incoming)) {
    const currentValue = target[key];
    if (
      ADDITIVE_METRIC_KEYS.has(key) &&
      typeof currentValue === "number" &&
      typeof value === "number"
    ) {
      target[key] = currentValue + value;
      continue;
    }
    target[key] = value;
  }

  return target;
}

function asFinitePositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function getExhaustiveStopReason(
  pageResult: Awaited<ReturnType<ProductConnector["pullProducts"]>>,
  currentPage: number
): string | null {
  if (pageResult.records.length === 0) {
    return "empty page";
  }

  const metadata = pageResult.metadata ?? {};
  if (metadata.hasMore === false) {
    return "metadata.hasMore=false";
  }

  const sourcePageCount = asFinitePositiveNumber(metadata.sourcePageCount);
  if (sourcePageCount !== null && currentPage >= sourcePageCount) {
    return `sourcePageCount=${sourcePageCount}`;
  }

  if (
    Object.prototype.hasOwnProperty.call(metadata, "nextPage") &&
    (metadata.nextPage === null || metadata.nextPage === false || metadata.nextPage === "")
  ) {
    return "metadata.nextPage absent";
  }

  return null;
}

export type IngestionResumeDecision =
  | { action: "drop"; reason: string }
  | { action: "start"; checkpoint: IngestionCheckpoint | null; source: "fresh" | "message" | "database" };

/** True when `a` points at a later position in the source than `b`. */
function isCheckpointAhead(a: IngestionCheckpoint, b: IngestionCheckpoint): boolean {
  if (a.nextPage !== b.nextPage) {
    return a.nextPage > b.nextPage;
  }
  return a.recordOffset > b.recordOffset;
}

/**
 * Decide where a queue message should start, given the checkpoint it carries and the one
 * persisted on the job row. Queue delivery is at-least-once and a killed invocation is
 * redelivered unchanged, so a message may be a duplicate or out of date.
 *
 * `continuationCount` identifies the hand-off generation (a message with no checkpoint is
 * generation 0). The worker persists the incremented count to the DB *before* it enqueues
 * the next continuation, so:
 *
 * - DB count > message count: a newer continuation already exists; this message is stale.
 *   Drop it so two invocations never process the same job.
 * - DB count == message count: this is the current message, possibly redelivered after a
 *   kill. The worker saves progress to the DB after every chunk, so resume from whichever
 *   checkpoint is further along (the DB wins ties).
 * - DB count < message count: the DB write was lost; trust the message.
 * - Neither has a checkpoint: a fresh job; start from the request's first page.
 */
export function resolveIngestionResumePoint(
  messageCheckpoint: IngestionCheckpoint | null | undefined,
  dbCheckpoint: IngestionCheckpoint | null | undefined
): IngestionResumeDecision {
  const messageCount = messageCheckpoint?.continuationCount ?? 0;
  const dbCount = dbCheckpoint?.continuationCount ?? 0;

  if (dbCheckpoint && dbCount > messageCount) {
    return {
      action: "drop",
      reason: `stale continuation ${messageCount}; job is already at continuation ${dbCount}`,
    };
  }

  if (!dbCheckpoint || dbCount < messageCount) {
    return messageCheckpoint
      ? { action: "start", checkpoint: messageCheckpoint, source: "message" }
      : { action: "start", checkpoint: null, source: "fresh" };
  }

  if (messageCheckpoint && isCheckpointAhead(messageCheckpoint, dbCheckpoint)) {
    return { action: "start", checkpoint: messageCheckpoint, source: "message" };
  }
  return { action: "start", checkpoint: dbCheckpoint, source: "database" };
}

function toMetricsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function buildRequestedMetrics(
  request: NormalizedIngestionJobRequest,
  userId: number
): Record<string, unknown> {
  return {
    searchTerm: request.searchTerm,
    requestedPage: request.page,
    requestedPageSize: request.pageSize,
    maxRecords: request.maxRecords,
    recentDays: request.recentDays || null,
    materializeToInventory: request.materializeToInventory,
    detectHexFromImage: request.detectHexFromImage,
    detectHexOnSuspiciousOnly: request.detectHexOnSuspiciousOnly,
    overwriteDetectedHex: request.overwriteDetectedHex,
    triggeredByUserId: userId,
  };
}

function withPipelineMetrics(
  baseMetrics: Record<string, unknown>,
  status: "queued" | "running" | "succeeded" | "failed",
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

function getPipelineStage(metrics: Record<string, unknown> | undefined): string | null {
  if (!metrics || typeof metrics !== "object") {
    return null;
  }

  const pipeline = metrics.pipeline;
  if (!pipeline || typeof pipeline !== "object") {
    return null;
  }

  const stage = (pipeline as Record<string, unknown>).stage;
  return typeof stage === "string" && stage.trim().length > 0 ? stage : null;
}

async function enqueueIngestionJob(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log(`POST /api/ingestion/jobs by admin user ${userId}`);

  let body: Partial<IngestionJobRunRequest>;
  try {
    body = (await request.json()) as Partial<IngestionJobRunRequest>;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  const sourceInput = typeof body.source === "string" ? body.source.trim() : "";
  if (!sourceInput) {
    return { status: 400, jsonBody: { error: "source is required" } };
  }
  if (!isSupportedSource(sourceInput)) {
    return {
      status: 400,
      jsonBody: {
        error: `Unsupported source '${sourceInput}'. Supported: ${SUPPORTED_SOURCES.join(", ")}`,
      },
    };
  }

  const normalizedRequest: NormalizedIngestionJobRequest = {
    source: sourceInput,
    page: clampInt(body.page, DEFAULT_PAGE, 1, 50),
    pageSize: clampInt(body.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    maxRecords: clampInt(body.maxRecords, DEFAULT_MAX_RECORDS, 1, MAX_RECORDS),
    materializeToInventory: body.materializeToInventory !== false,
    detectHexFromImage: body.detectHexFromImage !== false,
    detectHexOnSuspiciousOnly: body.detectHexOnSuspiciousOnly === true,
    overwriteDetectedHex: body.overwriteDetectedHex === true,
    collectTrainingData: body.collectTrainingData === true,
    exhaustive: body.exhaustive === true,
    recentDays:
      body.recentDays === null || body.recentDays === undefined
        ? undefined
        : clampInt(body.recentDays, DEFAULT_RECENT_DAYS, 1, MAX_RECENT_DAYS),
    searchTerm:
      typeof body.searchTerm === "string" && body.searchTerm.trim().length > 0
        ? body.searchTerm.trim()
        : DEFAULT_SEARCH_TERM,
  };

  const requestedMetrics = buildRequestedMetrics(normalizedRequest, userId);
  const queuedAt = new Date().toISOString();

  let jobId: number | null = null;

  try {
    const source = await ensureDataSourceByName(normalizedRequest.source);
    if (!source) {
      return {
        status: 404,
        jsonBody: { error: `Data source '${normalizedRequest.source}' not found in data_source table` },
      };
    }

    const queuedMetrics = withPipelineMetrics(requestedMetrics, "queued", "queued", {
      queuedAt,
      queueName: INGESTION_JOB_QUEUE_NAME,
    });

    const job = await createIngestionJob(
      source.dataSourceId,
      JOB_TYPE_CONNECTOR_VERIFY,
      queuedMetrics,
      "queued"
    );
    jobId = job.jobId;

    const queueMessage: IngestionJobQueueMessage = {
      jobId: job.jobId,
      userId,
      queuedAt,
      request: normalizedRequest,
      requestedMetrics,
    };

    context.extraOutputs.set(ingestionJobQueueOutput, JSON.stringify(queueMessage));

    const queuedJob = await getIngestionJobById(job.jobId);
    if (!queuedJob) {
      return {
        status: 500,
        jsonBody: { error: `Ingestion job ${job.jobId} queued but could not be loaded` },
      };
    }

    return {
      status: 202,
      jsonBody: { job: queuedJob } satisfies IngestionJobRunResponse,
    };
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    context.error("Ingestion job enqueue failed:", error);

    if (jobId !== null) {
      try {
        const failedMetrics = withPipelineMetrics(requestedMetrics, "failed", "queue_enqueue_failed", {
          queuedAt,
          queueName: INGESTION_JOB_QUEUE_NAME,
          failedAt: new Date().toISOString(),
        });
        await markIngestionJobFailed(jobId, message, failedMetrics);
        const failedJob = await getIngestionJobById(jobId);
        if (failedJob) {
          return {
            status: 500,
            jsonBody: { error: "Failed to enqueue ingestion job", job: failedJob, requestId: context.invocationId },
          };
        }
      } catch (markFailedError) {
        context.error("Failed to update ingestion job failure status:", markFailedError);
      }
    }

    return internalServerError(context, error, "Failed to enqueue ingestion job", "ingestion.enqueue");
  }
}

export async function processIngestionJobQueueMessage(
  payload: IngestionJobQueueMessage,
  context: InvocationContext
): Promise<void> {
  // Wall-clock budget for this invocation; when spent, checkpoint and hand off to a
  // continuation message so the Consumption plan's hard timeout never kills the job.
  const invocationStartedAt = Date.now();
  const timeBudgetMs = getWorkerTimeBudgetMs();
  const requestedMetrics = payload.requestedMetrics || buildRequestedMetrics(payload.request, payload.userId);
  const hexBatchConfig = getHexBatchRuntimeConfig();
  let stage = "worker_started";

  // Initialize logger with base metrics - flushes every 3s automatically
  const logger = new JobLogger({
    jobId: payload.jobId,
    context,
    baseMetrics: withPipelineMetrics(requestedMetrics, "running", stage, {
      queuedAt: payload.queuedAt,
      queueName: INGESTION_JOB_QUEUE_NAME,
      workerStartedAt: new Date().toISOString(),
    }),
  });

  try {
    logger.info(`Job ${payload.jobId} worker started`, {
      source: payload.request.source,
      searchTerm: payload.request.searchTerm,
      maxRecords: payload.request.maxRecords,
      hexBatchEnabled: hexBatchConfig.enabled,
      hexBatchMinImages: hexBatchConfig.minImages,
      continuationCount: payload.checkpoint?.continuationCount ?? 0,
      timeBudgetMs,
    });

    // Messages that are ignored never write to the job row: it belongs to someone else
    // (a finished job, the AI batch poller, or a newer continuation).
    const existingJob = await getIngestionJobById(payload.jobId);
    if (!existingJob) {
      logger.warn(`Job ${payload.jobId} not found in database, ignoring queue message`);
      await logger.dispose({ flush: false });
      return;
    }

    if (existingJob.status === "succeeded" || existingJob.status === "cancelled") {
      logger.info(`Job ${payload.jobId} already ${existingJob.status}, ignoring queue message`);
      await logger.dispose({ flush: false });
      return;
    }

    if (existingJob.status === "failed") {
      logger.info(`Job ${payload.jobId} already failed, ignoring queue message`);
      await logger.dispose({ flush: false });
      return;
    }

    const existingStage = getPipelineStage(existingJob.metrics);
    if (existingJob.status === "running" && existingStage === "awaiting_ai") {
      logger.info(
        `Job ${payload.jobId} is waiting for Azure OpenAI batch completion, ignoring queue message`
      );
      await logger.dispose({ flush: false });
      return;
    }

    const existingMetrics = toMetricsRecord(existingJob.metrics);
    const resumeDecision = resolveIngestionResumePoint(
      payload.checkpoint,
      readCheckpointFromMetrics(existingMetrics)
    );
    if (resumeDecision.action === "drop") {
      logger.info(`Job ${payload.jobId} ignoring queue message: ${resumeDecision.reason}`);
      await logger.dispose({ flush: false });
      return;
    }

    const startCheckpoint = resumeDecision.checkpoint;
    if (startCheckpoint) {
      // Continuation: carry metrics written by earlier invocations (and the AI batch poller,
      // e.g. aiBatchApplyTotals) plus their logs, so the job row describes the whole job.
      const carriedMetrics: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(existingMetrics)) {
        if (!NON_CARRIED_METRIC_KEYS.has(key)) {
          carriedMetrics[key] = value;
        }
      }
      logger.restoreEntries(existingMetrics.logs);
      logger.updateBaseMetrics({
        ...carriedMetrics,
        ...withPipelineMetrics(requestedMetrics, "running", stage, {
          queuedAt: payload.queuedAt,
          queueName: INGESTION_JOB_QUEUE_NAME,
          workerStartedAt: new Date().toISOString(),
          [CHECKPOINT_METRICS_KEY]: startCheckpoint,
        }),
      });
      logger.info(`Job ${payload.jobId} resuming from checkpoint`, {
        ...startCheckpoint,
        checkpointSource: resumeDecision.source,
      });
    }

    await markIngestionJobRunning(payload.jobId, logger.getMetricsWithLogs());

    // Source lookup
    stage = "source_lookup";
    logger.updateBaseMetrics(withPipelineMetrics(requestedMetrics, "running", stage, {
      queuedAt: payload.queuedAt,
    }));
    logger.info(`Looking up data source: ${payload.request.source}`);

    const source = await getDataSourceByName(payload.request.source);
    if (!source) {
      throw new Error(`Data source '${payload.request.source}' not found in data_source table`);
    }
    logger.info(`Found data source`, { dataSourceId: source.dataSourceId, baseUrl: source.baseUrl });

    // Connector pull
    stage = "connector_pull";
    logger.updateBaseMetrics(withPipelineMetrics(requestedMetrics, "running", stage, {
      queuedAt: payload.queuedAt,
      sourceBaseUrl: source.baseUrl,
    }));
    logger.info(`Pulling products from ${payload.request.source}`, {
      searchTerm: payload.request.searchTerm,
      page: startCheckpoint?.nextPage ?? payload.request.page,
      recordOffset: startCheckpoint?.recordOffset ?? 0,
      pageSize: payload.request.pageSize,
      maxRecords: payload.request.maxRecords,
      recentDays: payload.request.recentDays,
    });

    const connector = createConnector(payload.request.source, source.baseUrl);
    // One catalog download per job, reused across pages and continuation invocations.
    const catalogCache = createIngestionCatalogCache({
      jobId: payload.jobId,
      source: payload.request.source,
      snapshot: startCheckpoint ? readCatalogSnapshotFromMetrics(existingMetrics) : null,
      onSnapshotSaved: (snapshot) =>
        logger.updateBaseMetrics({ [CATALOG_SNAPSHOT_METRICS_KEY]: snapshot }),
      log: (level, message, data) =>
        level === "warn" ? logger.warn(message, data) : logger.info(message, data),
    });

    const EXHAUSTIVE_PAGE_LIMIT = 500;
    // Totals from earlier invocations; the flattened top-level metrics can't be split back
    // into persistence vs materialization counters, so they are persisted separately.
    const priorTotals = startCheckpoint
      ? toMetricsRecord(existingMetrics[WORKER_TOTALS_METRICS_KEY])
      : {};
    let connectorMetadata: Record<string, unknown> = {};
    const persistenceMetricsAggregate: Record<string, unknown> = toMetricsRecord(priorTotals.persistence);
    let materializationMetricsAggregate: Record<string, unknown> | null =
      priorTotals.materialization ? toMetricsRecord(priorTotals.materialization) : null;
    let totalRecordsProcessed = startCheckpoint?.recordsProcessed ?? 0;
    let hexBatchDegraded = startCheckpoint
      ? existingMetrics[HEX_BATCH_DEGRADED_METRICS_KEY] === true
      : false;
    // Hex batches submitted so far (including by earlier invocations). Their records are
    // already committed, so the worker keeps going and the poller applies each batch.
    const aiBatches: IngestionAiBatchEntry[] = startCheckpoint
      ? readAiBatchesFromMetrics(existingMetrics)
      : [];
    const maxInFlightAiBatches = getMaxInFlightAiBatches();

    // Position of the next unprocessed record; persisted after every chunk.
    let checkpoint: IngestionCheckpoint = startCheckpoint ?? {
      nextPage: payload.request.page,
      recordOffset: 0,
      pagesCompleted: 0,
      recordsProcessed: 0,
      continuationCount: 0,
      updatedAt: new Date().toISOString(),
    };

    const buildCumulativeMetrics = (): Record<string, unknown> => ({
      ...requestedMetrics,
      ...connectorMetadata,
      ...persistenceMetricsAggregate,
      ...(materializationMetricsAggregate || {}),
      recordsProcessed: totalRecordsProcessed,
    });

    const buildWorkerTotals = (): Record<string, unknown> => {
      // aiBatch is per-batch state owned by the poller once submitted; never replay it.
      const { aiBatch: _aiBatch, ...materialization } = materializationMetricsAggregate ?? {};
      return { persistence: { ...persistenceMetricsAggregate }, materialization };
    };

    // Hand the job to the AI batch poller: it applies every pending batch, then enqueues
    // `resumeMessage` (more work remains) or completes the job (null).
    const pauseForAiBatches = async (
      resumeMessage: IngestionJobQueueMessage | null,
      latestAiBatch?: Record<string, unknown>
    ): Promise<void> => {
      stage = "awaiting_ai";
      const pending = aiBatches.filter(isAiBatchPending);
      const awaitingAiMetrics = {
        ...buildCumulativeMetrics(),
        [CHECKPOINT_METRICS_KEY]: checkpoint,
        [WORKER_TOTALS_METRICS_KEY]: buildWorkerTotals(),
        [AI_BATCHES_METRICS_KEY]: aiBatches,
        // The poller enqueues this after applying the batches; absent means the job is done.
        [RESUME_MESSAGE_METRICS_KEY]: resumeMessage ?? undefined,
      };

      logger.updateBaseMetrics(
        withPipelineMetrics(awaitingAiMetrics, "running", stage, {
          queuedAt: payload.queuedAt,
          workerPausedAt: new Date().toISOString(),
          ...(latestAiBatch ? { aiBatch: latestAiBatch } : {}),
        })
      );
      logger.info(`Job ${payload.jobId} awaiting Azure OpenAI batch completion`, {
        pendingBatches: pending.length,
        batchIds: pending.map((entry) => entry.batchId),
        resumeAt: resumeMessage?.checkpoint ?? null,
      });

      // Stop periodic flushes before the final write: once the poller owns the job, a late
      // flush from here could overwrite its continuation_queued state with awaiting_ai.
      await logger.dispose({ flush: false });
      await updateIngestionJobMetrics(payload.jobId, logger.getMetricsWithLogs());
    };

    const persistPageRecords = async (
      connectorResult: Awaited<ReturnType<typeof connector.pullProducts>>,
      unit: {
        /** Checkpoint once these records are done; persisted if the worker pauses for AI. */
        checkpointAfter: IngestionCheckpoint;
        /** Continuation for the poller to enqueue after the batch; null if no work remains. */
        resumeMessage: IngestionJobQueueMessage | null;
      }
    ): Promise<boolean> => {
      connectorMetadata = { ...connectorMetadata, ...connectorResult.metadata };
      totalRecordsProcessed += connectorResult.records.length;

      logger.info(`Connector returned ${connectorResult.records.length} records`, connectorResult.metadata);

      // Upsert external products
      stage = "upsert_external_products";
      logger.updateBaseMetrics(withPipelineMetrics(requestedMetrics, "running", stage, {
        queuedAt: payload.queuedAt,
        ...connectorMetadata,
      }));
      logger.info(`Upserting ${connectorResult.records.length} external products`);

      const persistenceMetrics = await upsertExternalProducts(source.dataSourceId, connectorResult.records);
      mergeMetrics(persistenceMetricsAggregate, persistenceMetrics as unknown as Record<string, unknown>);
      logger.info(`Upsert complete`, persistenceMetrics as unknown as Record<string, unknown>);

      let materializationMetrics: Record<string, unknown> | null = null;

      if (payload.request.source === "MakeupAPI" && payload.request.materializeToInventory) {
        stage = "materialize_inventory";
        logger.updateBaseMetrics(withPipelineMetrics(requestedMetrics, "running", stage, {
          queuedAt: payload.queuedAt,
          ...connectorMetadata,
          ...persistenceMetricsAggregate,
        }));

        const materializeStartTime = Date.now();
        logger.info(`Materializing MakeupAPI records to inventory`, {
          recordCount: connectorResult.records.length,
          userId: payload.userId,
        });

        try {
          materializationMetrics = (await materializeMakeupApiRecords(
            payload.userId,
            connectorResult.records,
            source.dataSourceId
          )) as unknown as Record<string, unknown>;

          const materializeDuration = Date.now() - materializeStartTime;
          logger.info(`MakeupAPI materialization complete`, {
            ...materializationMetrics,
            durationMs: materializeDuration,
            recordsProcessed: connectorResult.records.length,
          });
        } catch (materializeError) {
          const materializeDuration = Date.now() - materializeStartTime;
          logger.error(`MakeupAPI materialization failed`, {
            error: getErrorMessage(materializeError),
            durationMs: materializeDuration,
            recordCount: connectorResult.records.length,
          });
          throw materializeError;
        }
      }

      if (payload.request.source.endsWith("Shopify") && payload.request.materializeToInventory) {
        stage = "materialize_inventory";
        logger.updateBaseMetrics(withPipelineMetrics(requestedMetrics, "running", stage, {
          queuedAt: payload.queuedAt,
          ...connectorMetadata,
          ...persistenceMetricsAggregate,
        }));

        const materializeStartTime = Date.now();
        logger.info(`Materializing ${payload.request.source} records to inventory`, {
          recordCount: connectorResult.records.length,
          userId: payload.userId,
          dataSourceId: source.dataSourceId,
          detectHexFromImage: payload.request.detectHexFromImage,
          overwriteDetectedHex: payload.request.overwriteDetectedHex,
          hexBatchEnabled: hexBatchConfig.enabled,
          hexBatchMinImages: hexBatchConfig.minImages,
        });

        try {
          materializationMetrics = (await materializeHoloTacoRecords(
            payload.userId,
            source.dataSourceId,
            connectorResult.records,
            {
              detectHexFromImage: payload.request.detectHexFromImage,
              detectHexOnSuspiciousOnly: payload.request.detectHexOnSuspiciousOnly,
              overwriteDetectedHex: payload.request.overwriteDetectedHex,
              useBatchForHexDetection: hexBatchConfig.enabled && !hexBatchDegraded,
              batchMinImages: hexBatchConfig.minImages,
              progressLogger: {
                info: (message, data) => logger.info(message, data),
                warn: (message, data) => logger.warn(message, data),
                error: (message, data) => logger.error(message, data),
              },
            },
            `[${payload.request.source}]`
          )) as unknown as Record<string, unknown>;

          const materializeDuration = Date.now() - materializeStartTime;
          logger.info(`${payload.request.source} materialization complete`, {
            ...materializationMetrics,
            durationMs: materializeDuration,
            recordsProcessed: connectorResult.records.length,
          });

          // Batch submission failed and the materializer fell back to synchronous detection
          // (e.g. the batch deployment's enqueued-token limit). Use small synchronous chunks
          // for the rest of the job so the time budget keeps applying.
          if (!hexBatchDegraded && Number(materializationMetrics?.batchFallbacks) > 0) {
            hexBatchDegraded = true;
            logger.updateBaseMetrics({ [HEX_BATCH_DEGRADED_METRICS_KEY]: true });
            logger.warn(
              `Batch hex detection unavailable; continuing ${payload.request.source} with synchronous chunks of ${INGESTION_SYNC_CHUNK_SIZE}`
            );
          }
        } catch (materializeError) {
          const materializeDuration = Date.now() - materializeStartTime;
          logger.error(`${payload.request.source} materialization failed`, {
            error: getErrorMessage(materializeError),
            durationMs: materializeDuration,
            recordCount: connectorResult.records.length,
            detectHexFromImage: payload.request.detectHexFromImage,
            overwriteDetectedHex: payload.request.overwriteDetectedHex,
          });
          throw materializeError;
        }
      }

      materializationMetricsAggregate = mergeMetrics(
        materializationMetricsAggregate ?? {},
        materializationMetrics
      );

      const aiBatch =
        materializationMetrics &&
        typeof materializationMetrics === "object" &&
        materializationMetrics.aiBatch &&
        typeof materializationMetrics.aiBatch === "object"
          ? (materializationMetrics.aiBatch as Record<string, unknown>)
          : null;

      if (aiBatch && aiBatch.status === "submitted" && typeof aiBatch.batchId === "string") {
        aiBatches.push({
          ...aiBatch,
          batchId: aiBatch.batchId,
          status: "submitted",
          overwriteDetectedHex: aiBatch.overwriteDetectedHex === true,
        });
        logger.updateBaseMetrics({ [AI_BATCHES_METRICS_KEY]: aiBatches });
        logger.info(`Job ${payload.jobId} submitted Azure OpenAI batch; continuing ingestion`, {
          batchId: aiBatch.batchId,
          requestCount: aiBatch.requestCount,
          pendingBatches: aiBatches.filter(isAiBatchPending).length,
        });

        // Pause only when the job would exceed its enqueued-token share; the poller resumes
        // it once the pending batches are applied. The last unit pauses at the end instead.
        if (unit.resumeMessage && aiBatches.filter(isAiBatchPending).length >= maxInFlightAiBatches) {
          checkpoint = unit.checkpointAfter;
          await pauseForAiBatches(unit.resumeMessage, aiBatch);
          return true;
        }
      }

      return false;
    };

    // Batch hex detection only submits a batch per call, so chunks can be larger; sync
    // detection costs an AI call + delay per record, so it runs in small chunks.
    const usesBatchHexDetection =
      hexBatchConfig.enabled &&
      payload.request.source.endsWith("Shopify") &&
      payload.request.materializeToInventory &&
      payload.request.detectHexFromImage;
    const currentChunkSize = (): number =>
      usesBatchHexDetection && !hexBatchDegraded ? INGESTION_BATCH_CHUNK_SIZE : INGESTION_SYNC_CHUNK_SIZE;
    let chunksThisInvocation = 0;
    let longestChunkMs = 0;

    // Always process at least one chunk per invocation so every continuation makes progress.
    const hasBudgetFor = (estimatedMs: number): boolean =>
      chunksThisInvocation === 0 ||
      Date.now() - invocationStartedAt + estimatedMs < timeBudgetMs;

    // Between chunks, stop if the job was cancelled/finished elsewhere or a newer
    // continuation has taken over. Never write to the job row after this returns false.
    const stillOwnsJob = async (): Promise<boolean> => {
      const currentJob = await getIngestionJobById(payload.jobId);
      if (!currentJob || currentJob.status !== "running") {
        context.log(
          `Job ${payload.jobId} is ${currentJob?.status ?? "missing"}; stopping worker without updating it`
        );
        return false;
      }
      const dbCheckpoint = readCheckpointFromMetrics(currentJob.metrics);
      if (dbCheckpoint && dbCheckpoint.continuationCount > checkpoint.continuationCount) {
        context.warn(
          `Job ${payload.jobId} superseded by continuation ${dbCheckpoint.continuationCount}; stopping worker`
        );
        return false;
      }
      // A duplicate delivery of the same generation got further than this worker; stop rather
      // than write an older checkpoint over its progress.
      if (
        dbCheckpoint &&
        dbCheckpoint.continuationCount === checkpoint.continuationCount &&
        isCheckpointAhead(dbCheckpoint, checkpoint)
      ) {
        context.warn(
          `Job ${payload.jobId} checkpoint advanced by another worker (page ${dbCheckpoint.nextPage}, record ${dbCheckpoint.recordOffset}); stopping worker`
        );
        return false;
      }
      return true;
    };

    // Persist the checkpoint so a hard kill loses at most one chunk of work.
    const saveProgress = async (): Promise<void> => {
      logger.updateBaseMetrics(withPipelineMetrics(buildCumulativeMetrics(), "running", stage, {
        queuedAt: payload.queuedAt,
        [CHECKPOINT_METRICS_KEY]: checkpoint,
        [WORKER_TOTALS_METRICS_KEY]: buildWorkerTotals(),
      }));
      try {
        await updateIngestionJobMetrics(payload.jobId, logger.getMetricsWithLogs());
      } catch (error) {
        // Not fatal: a restart would redo work since the last saved checkpoint.
        logger.warn(`Failed to save ingestion checkpoint`, { error: getErrorMessage(error) });
      }
    };

    // Time budget spent with work remaining: persist the checkpoint, then enqueue a
    // continuation. The job stays `running` and the next invocation picks it up.
    const handOffToContinuation = async (): Promise<void> => {
      const continuationCheckpoint: IngestionCheckpoint = {
        ...checkpoint,
        continuationCount: checkpoint.continuationCount + 1,
        updatedAt: new Date().toISOString(),
      };
      stage = CONTINUATION_QUEUED_STAGE;
      logger.updateBaseMetrics(withPipelineMetrics(buildCumulativeMetrics(), "running", stage, {
        queuedAt: payload.queuedAt,
        workerPausedAt: new Date().toISOString(),
        [CHECKPOINT_METRICS_KEY]: continuationCheckpoint,
        [WORKER_TOTALS_METRICS_KEY]: buildWorkerTotals(),
      }));
      logger.info(
        `Job ${payload.jobId} used ${Date.now() - invocationStartedAt}ms of its ${timeBudgetMs}ms budget; continuing in a new invocation`,
        { ...continuationCheckpoint }
      );

      // Stop periodic flushes first: once the continuation is enqueued the next invocation
      // owns the row, and a late flush from here would overwrite its progress.
      await logger.dispose({ flush: false });
      await updateIngestionJobMetrics(payload.jobId, logger.getMetricsWithLogs());

      stage = CONTINUATION_ENQUEUE_STAGE;
      await enqueueIngestionContinuation({ ...payload, checkpoint: continuationCheckpoint });
      context.log(
        `Job ${payload.jobId} continuation ${continuationCheckpoint.continuationCount} enqueued`,
        { nextPage: continuationCheckpoint.nextPage, recordOffset: continuationCheckpoint.recordOffset }
      );
    };

    const exhaustive = payload.request.exhaustive;
    // Pages pulled across all invocations. A partially processed page is not in
    // pagesCompleted, so re-pulling it on resume counts it exactly once.
    let pagesFetched = exhaustive ? checkpoint.pagesCompleted : 0;
    let capped = false;

    if (exhaustive) {
      logger.info(`Exhaustive mode: paging through all records from ${payload.request.source}`, {
        startPage: checkpoint.nextPage,
        startOffset: checkpoint.recordOffset,
        pageSize: payload.request.pageSize,
      });
    }

    // Non-exhaustive runs are a single page (up to maxRecords) but checkpoint the same way.
    while (true) {
      if (exhaustive && pagesFetched >= EXHAUSTIVE_PAGE_LIMIT) {
        capped = true;
        connectorMetadata = {
          ...connectorMetadata,
          pagesFetched,
          exhaustive: false,
          requestedExhaustive: true,
          capped: true,
          pageLimit: EXHAUSTIVE_PAGE_LIMIT,
        };
        logger.warn(`Exhaustive mode reached page safety cap for ${payload.request.source}`, {
          source: payload.request.source,
          pagesFetched,
          currentPage: checkpoint.nextPage - 1,
          pageLimit: EXHAUSTIVE_PAGE_LIMIT,
          totalRecordsProcessed,
        });
        break;
      }

      if (!hasBudgetFor(longestChunkMs)) {
        await handOffToContinuation();
        return;
      }

      const pageNumber = checkpoint.nextPage;
      const pageResult = await connector.pullProducts({
        searchTerm: payload.request.searchTerm,
        page: pageNumber,
        pageSize: payload.request.pageSize,
        maxRecords: exhaustive ? payload.request.pageSize : payload.request.maxRecords,
        recentDays: payload.request.recentDays,
        catalogCache,
      });
      const records = pageResult.records;

      // Stop decisions always use the FULL page, never a chunk of it.
      let stopReason: string | null = null;
      if (exhaustive) {
        logger.info(`Exhaustive page ${pageNumber}: ${records.length} records`, {
          page: pageNumber,
          ...pageResult.metadata,
        });

        stopReason = getExhaustiveStopReason(pageResult, pageNumber);
        if (records.length === 0) {
          connectorMetadata = {
            ...connectorMetadata,
            ...pageResult.metadata,
            pagesFetched,
            exhaustive: true,
            requestedExhaustive: true,
            capped: false,
            pageLimit: EXHAUSTIVE_PAGE_LIMIT,
          };
          logger.info(`Exhaustive mode stopping after page ${pageNumber}: ${stopReason ?? "empty page"}`, {
            page: pageNumber,
            pagesFetched,
            source: payload.request.source,
            recordCount: records.length,
          });
          break;
        }

        pagesFetched++;
        connectorMetadata = {
          ...connectorMetadata,
          ...pageResult.metadata,
          pagesFetched,
          exhaustive: true,
          requestedExhaustive: true,
          capped: false,
          pageLimit: EXHAUSTIVE_PAGE_LIMIT,
        };
      } else {
        connectorMetadata = { ...connectorMetadata, ...pageResult.metadata };
      }

      const hasNextPage = exhaustive && !stopReason && pagesFetched < EXHAUSTIVE_PAGE_LIMIT;
      const pagesCompletedBeforePage = checkpoint.pagesCompleted;
      const positionAfter = (recordEnd: number) =>
        recordEnd < records.length
          ? { nextPage: pageNumber, recordOffset: recordEnd, pagesCompleted: pagesCompletedBeforePage }
          : { nextPage: pageNumber + 1, recordOffset: 0, pagesCompleted: pagesCompletedBeforePage + 1 };

      let offset = Math.min(checkpoint.recordOffset, records.length);
      if (offset > 0) {
        logger.info(`Resuming page ${pageNumber} at record ${offset} of ${records.length}`);
      }
      if (offset >= records.length) {
        // The page shrank since the checkpoint was written; nothing left on it.
        checkpoint = { ...checkpoint, ...positionAfter(records.length), updatedAt: new Date().toISOString() };
      }

      while (offset < records.length) {
        if (!hasBudgetFor(longestChunkMs)) {
          await handOffToContinuation();
          return;
        }

        const chunk = records.slice(offset, offset + currentChunkSize());
        const chunkEnd = offset + chunk.length;
        const checkpointAfter: IngestionCheckpoint = {
          ...checkpoint,
          ...positionAfter(chunkEnd),
          recordsProcessed: totalRecordsProcessed + chunk.length,
          updatedAt: new Date().toISOString(),
        };
        const workRemainsAfterChunk = chunkEnd < records.length || hasNextPage;
        const resumeMessage: IngestionJobQueueMessage | null = workRemainsAfterChunk
          ? {
              ...payload,
              checkpoint: { ...checkpointAfter, continuationCount: checkpointAfter.continuationCount + 1 },
            }
          : null;

        if (chunk.length < records.length) {
          logger.info(`Processing records ${offset + 1}-${chunkEnd} of ${records.length} on page ${pageNumber}`);
        }

        const chunkStartedAt = Date.now();
        const shouldPauseForAiBatch = await persistPageRecords(
          { ...pageResult, records: chunk },
          { checkpointAfter, resumeMessage }
        );
        if (shouldPauseForAiBatch) {
          return;
        }

        longestChunkMs = Math.max(longestChunkMs, Date.now() - chunkStartedAt);
        chunksThisInvocation++;
        offset = chunkEnd;
        checkpoint = checkpointAfter;

        if (!(await stillOwnsJob())) {
          await logger.dispose({ flush: false });
          return;
        }
        await saveProgress();
      }

      if (!exhaustive) {
        break;
      }

      if (stopReason) {
        logger.info(`Exhaustive mode stopping after page ${pageNumber}: ${stopReason}`, {
          page: pageNumber,
          pagesFetched,
          source: payload.request.source,
          recordCount: records.length,
        });
        break;
      }
    }

    if (exhaustive) {
      logger.info(`Exhaustive pull complete: ${totalRecordsProcessed} total records across ${pagesFetched} pages`, {
        capped,
      });
    }

    if (aiBatches.some(isAiBatchPending)) {
      // Every record is committed; only detected hex is still outstanding.
      await pauseForAiBatches(null);
      return;
    }

    // Build final metrics with logs
    logger.updateBaseMetrics(withPipelineMetrics(buildCumulativeMetrics(), "succeeded", "completed", {
      queuedAt: payload.queuedAt,
      workerCompletedAt: new Date().toISOString(),
      [CHECKPOINT_METRICS_KEY]: checkpoint,
      [WORKER_TOTALS_METRICS_KEY]: buildWorkerTotals(),
    }));
    logger.info(`Job ${payload.jobId} completed successfully`);

    await markIngestionJobSucceeded(payload.jobId, logger.getMetricsWithLogs());
    await logger.dispose();
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    const errorData = error instanceof Error ? { stack: error.stack } : undefined;
    logger.error(`Job ${payload.jobId} failed: ${message}`, errorData);

    try {
      logger.updateBaseMetrics(withPipelineMetrics(requestedMetrics, "failed", stage, {
        queuedAt: payload.queuedAt,
        failedAt: new Date().toISOString(),
        failedStage: stage,
      }));
      await markIngestionJobFailed(payload.jobId, message, logger.getMetricsWithLogs());
    } catch (markFailedError) {
      logger.error("Failed to update job failure status", {
        originalError: message,
        markError: getErrorMessage(markFailedError),
      });
    }
    await logger.dispose();
  }
}

async function handleListIngestionJobs(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/ingestion/jobs");

  try {
    const url = new URL(request.url);
    const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
    const source = url.searchParams.get("source")?.trim() || undefined;

    const result = await listIngestionJobs(limit, source);
    return {
      status: 200,
      jsonBody: result satisfies IngestionJobListResponse,
    };
  } catch (error) {
    context.error("Error listing ingestion jobs:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to list ingestion jobs" },
    };
  }
}

async function handleGetIngestionJob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/ingestion/jobs/{id}");

  const id = request.params.id;
  if (!id) {
    return { status: 400, jsonBody: { error: "job id is required" } };
  }

  const parsedId = Number.parseInt(id, 10);
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    return { status: 400, jsonBody: { error: "job id must be a positive integer" } };
  }

  try {
    const job = await getIngestionJobById(parsedId);
    if (!job) {
      return { status: 404, jsonBody: { error: "Ingestion job not found" } };
    }

    return {
      status: 200,
      jsonBody: { job } satisfies IngestionJobRunResponse,
    };
  } catch (error) {
    context.error("Error fetching ingestion job:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to fetch ingestion job" },
    };
  }
}

async function ingestionJobsHandler(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "GET") {
    return handleListIngestionJobs(request, context);
  }
  if (method === "POST") {
    return enqueueIngestionJob(request, context, userId);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function ingestionJobDetailHandler(
  request: HttpRequest,
  context: InvocationContext,
  _userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "GET") {
    return handleGetIngestionJob(request, context);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function handleCancelIngestionJob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const id = request.params.id;
  if (!id) {
    return { status: 400, jsonBody: { error: "job id is required" } };
  }

  const parsedId = Number.parseInt(id, 10);
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    return { status: 400, jsonBody: { error: "job id must be a positive integer" } };
  }

  let body: Partial<{ reason: string }>;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "Cancelled by admin";

  try {
    context.log(`DELETE /api/ingestion/jobs/${parsedId} - reason: ${reason}`);

    const job = await getIngestionJobById(parsedId);
    if (!job) {
      return { status: 404, jsonBody: { error: "Ingestion job not found" } };
    }

    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return {
        status: 400,
        jsonBody: { error: `Cannot cancel job in status: ${job.status}` },
      };
    }

    await cancelIngestionJob(parsedId, reason);

    const updatedJob = await getIngestionJobById(parsedId);
    return {
      status: 200,
      jsonBody: { job: updatedJob },
    };
  } catch (error) {
    context.error("Error cancelling ingestion job:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to cancel ingestion job" },
    };
  }
}

async function ingestionJobCancelHandler(
  request: HttpRequest,
  context: InvocationContext,
  _userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "DELETE") {
    return handleCancelIngestionJob(request, context);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function handleListDataSources(_request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/ingestion/sources");

  try {
    await ensureSupportedShopifyDataSources();
    const sources = await listDataSources(true);
    return {
      status: 200,
      jsonBody: {
        sources: sources.map((source) => ({
          ...source,
          protocol: isSupportedSource(source.name) ? SOURCE_PROTOCOL_MAP[source.name] : "Custom",
          queueable: isRunnableConnectorSource(source.name),
        })),
      },
    };
  } catch (error) {
    context.error("Error listing data sources:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to list data sources" },
    };
  }
}

async function dataSourcesHandler(
  request: HttpRequest,
  context: InvocationContext,
  _userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "GET") {
    return handleListDataSources(request, context);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function handleGetSourcesWithSettings(_request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/ingestion/sources?withSettings=true");

  try {
    const sources = await listDataSourcesWithSettings(true);
    return {
      status: 200,
      jsonBody: { sources },
    };
  } catch (error) {
    context.error("Error listing data sources with settings:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to list data sources" },
    };
  }
}

async function handleUpdateSourceSettings(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const id = request.params.id;
  if (!id) {
    return { status: 400, jsonBody: { error: "source id is required" } };
  }

  const parsedId = Number.parseInt(id, 10);
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    return { status: 400, jsonBody: { error: "source id must be a positive integer" } };
  }

  let body: Partial<{ downloadImages: boolean; detectHex: boolean; overwriteExisting: boolean }>;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  context.log(`PATCH /api/ingestion/sources/${parsedId}/settings`, body);

  try {
    await updateDataSourceSettings(parsedId, body);
    return {
      status: 200,
      jsonBody: { success: true },
    };
  } catch (error) {
    context.error("Error updating data source settings:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to update data source settings" },
    };
  }
}

async function handleGetGlobalSettings(_request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/ingestion/settings");

  try {
    const settings = await getGlobalSettings();
    return {
      status: 200,
      jsonBody: { settings },
    };
  } catch (error) {
    context.error("Error getting global settings:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to get global settings" },
    };
  }
}

async function handleUpdateGlobalSettings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  let body: Partial<{ downloadImages: boolean; detectHex: boolean }>;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  context.log(`PATCH /api/ingestion/settings`, body);

  try {
    await updateGlobalSettings(body);
    const settings = await getGlobalSettings();
    return {
      status: 200,
      jsonBody: { settings },
    };
  } catch (error) {
    context.error("Error updating global settings:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to update global settings" },
    };
  }
}

async function sourceSettingsHandler(
  request: HttpRequest,
  context: InvocationContext,
  _userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "PATCH") {
    return handleUpdateSourceSettings(request, context);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function globalSettingsHandler(
  request: HttpRequest,
  context: InvocationContext,
  _userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "GET") {
    return handleGetGlobalSettings(request, context);
  }
  if (method === "PATCH") {
    return handleUpdateGlobalSettings(request, context);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function handleGetQueueStats(
  _request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("GET /api/ingestion/queue/stats");

  try {
    const stats = await getQueueStats(INGESTION_JOB_QUEUE_NAME);
    return {
      status: 200,
      jsonBody: stats,
    };
  } catch (error) {
    context.error("Error getting queue stats:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to get queue stats" },
    };
  }
}

async function handlePurgeQueue(
  _request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("DELETE /api/ingestion/queue/messages");

  try {
    const result = await purgeQueue(INGESTION_JOB_QUEUE_NAME);
    if (!result.success) {
      context.error("Error purging queue:", result.error);
      return {
        status: 500,
        jsonBody: { error: "Failed to purge queue", requestId: context.invocationId },
      };
    }
    return {
      status: 200,
      jsonBody: result,
    };
  } catch (error) {
    context.error("Error purging queue:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to purge queue" },
    };
  }
}

async function queueStatsHandler(
  request: HttpRequest,
  context: InvocationContext,
  _userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "GET") {
    return handleGetQueueStats(request, context);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function queueMessagesHandler(
  request: HttpRequest,
  context: InvocationContext,
  _userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "DELETE") {
    return handlePurgeQueue(request, context);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function bulkIngestionHandler(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log(`POST /api/ingestion/bulk by admin user ${userId}`);

  let body: Partial<BulkIngestionRequest>;
  try {
    body = (await request.json()) as Partial<BulkIngestionRequest>;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    return { status: 400, jsonBody: { error: "sources must be a non-empty array" } };
  }

  if (body.sources.length > MAX_BULK_SOURCES) {
    return {
      status: 400,
      jsonBody: { error: `sources must not contain more than ${MAX_BULK_SOURCES} entries` },
    };
  }

  const dedupedSources = [...new Set(body.sources)];
  const invalidSources = dedupedSources.filter((s) => !isSupportedSource(s));
  if (invalidSources.length > 0) {
    return {
      status: 400,
      jsonBody: { error: `Unsupported sources: ${invalidSources.join(", ")}` },
    };
  }

  const sources = dedupedSources as SupportedConnectorSource[];
  const nonRunnableSources = sources.filter((source) => !hasRunnableConnector(source));
  if (nonRunnableSources.length > 0) {
    return {
      status: 400,
      jsonBody: { error: `No ingestion connector available for: ${nonRunnableSources.join(", ")}` },
    };
  }
  const options = body.options ?? {};
  const queuedAt = new Date().toISOString();
  const queueMessages: string[] = [];
  const jobs: IngestionJobRecord[] = [];
  const createdJobs: Array<{
    jobId: number;
    requestedMetrics: Record<string, unknown>;
    source: SupportedConnectorSource;
  }> = [];

  try {
    for (const source of sources) {
      const normalizedRequest: NormalizedIngestionJobRequest = {
        source,
        page: DEFAULT_PAGE,
        pageSize: MAX_PAGE_SIZE,
        maxRecords: DEFAULT_MAX_RECORDS,
        searchTerm: DEFAULT_SEARCH_TERM,
        materializeToInventory: options.materializeToInventory !== false,
        detectHexFromImage: options.detectHexFromImage !== false,
        detectHexOnSuspiciousOnly: false,
        overwriteDetectedHex: options.overwriteDetectedHex === true,
        collectTrainingData: false,
        exhaustive: true,
      };

      const requestedMetrics = buildRequestedMetrics(normalizedRequest, userId);

      const dataSource = await ensureDataSourceByName(source);
      if (!dataSource) {
        context.warn(`Bulk: data source '${source}' not found, skipping`);
        continue;
      }

      const queuedMetrics = withPipelineMetrics(requestedMetrics, "queued", "queued", {
        queuedAt,
        queueName: INGESTION_JOB_QUEUE_NAME,
        bulkRun: true,
      });

      const job = await createIngestionJob(
        dataSource.dataSourceId,
        JOB_TYPE_CONNECTOR_VERIFY,
        queuedMetrics,
        "queued"
      );
      createdJobs.push({ jobId: job.jobId, requestedMetrics, source });

      const queueMessage: IngestionJobQueueMessage = {
        jobId: job.jobId,
        userId,
        queuedAt,
        request: normalizedRequest,
        requestedMetrics,
      };
      queueMessages.push(JSON.stringify(queueMessage));

      const loadedJob = await getIngestionJobById(job.jobId);
      if (loadedJob) {
        jobs.push(loadedJob);
      }
    }

    if (queueMessages.length === 0) {
      return { status: 400, jsonBody: { error: "No valid sources could be queued" } };
    }

    // Enqueue all messages at once — Azure Functions queue output accepts arrays
    context.extraOutputs.set(ingestionJobQueueOutput, queueMessages);

    return {
      status: 202,
      jsonBody: { enqueued: queueMessages.length, jobs } satisfies BulkIngestionResponse,
    };
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    context.error("Bulk ingestion enqueue failed:", error);

    for (const createdJob of createdJobs) {
      try {
        await markIngestionJobFailed(
          createdJob.jobId,
          message,
          withPipelineMetrics(createdJob.requestedMetrics, "failed", "queue_enqueue", {
            queuedAt,
            queueName: INGESTION_JOB_QUEUE_NAME,
            bulkRun: true,
            source: createdJob.source,
            failedAt: new Date().toISOString(),
            failedStage: "queue_enqueue",
          })
        );
      } catch (markFailedError) {
        context.error(`Failed to mark bulk ingestion job ${createdJob.jobId} as failed:`, markFailedError);
      }
    }

    return internalServerError(context, error, "Failed to enqueue bulk ingestion", "ingestion.bulk-enqueue");
  }
}

app.http("ingestion-jobs", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "ingestion/jobs",
  extraOutputs: [ingestionJobQueueOutput],
  handler: withCors(withAdmin(ingestionJobsHandler)),
});

app.http("ingestion-job-detail", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "ingestion/jobs/{id}",
  handler: withCors(withAdmin(ingestionJobDetailHandler)),
});

app.http("ingestion-job-cancel", {
  methods: ["DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "ingestion/jobs/{id}/cancel",
  handler: withCors(withAdmin(ingestionJobCancelHandler)),
});

app.http("ingestion-bulk", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "ingestion/bulk",
  extraOutputs: [ingestionJobQueueOutput],
  handler: withCors(withAdmin(bulkIngestionHandler)),
});

app.http("ingestion-sources", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "ingestion/sources",
  handler: withCors(withAdmin(dataSourcesHandler)),
});

app.http("ingestion-source-settings", {
  methods: ["PATCH", "OPTIONS"],
  authLevel: "anonymous",
  route: "ingestion/sources/{id}/settings",
  handler: withCors(withAdmin(sourceSettingsHandler)),
});

app.http("ingestion-settings", {
  methods: ["GET", "PATCH", "OPTIONS"],
  authLevel: "anonymous",
  route: "ingestion/settings",
  handler: withCors(withAdmin(globalSettingsHandler)),
});

app.http("ingestion-queue-stats", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "ingestion/queue/stats",
  handler: withCors(withAdmin(queueStatsHandler)),
});

app.http("ingestion-queue-messages", {
  methods: ["DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "ingestion/queue/messages",
  handler: withCors(withAdmin(queueMessagesHandler)),
});
