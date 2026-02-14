import { app, HttpRequest, HttpResponseInit, InvocationContext, output } from "@azure/functions";
import {
  IngestionJobListResponse,
  IngestionJobRunRequest,
  IngestionJobRunResponse,
} from "swatchwatch-shared";
import { withAdmin } from "../lib/auth";
import { withCors } from "../lib/http";
import { getQueueStats, purgeQueue } from "../lib/queue-management";
import {
  cancelIngestionJob,
  createIngestionJob,
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
  updateGlobalSettings,
  upsertExternalProducts,
} from "../lib/ingestion-repo";


import { JobLogger } from "../lib/job-logger";
import { OpenBeautyFactsConnector } from "../lib/connectors/open-beauty-facts";
import { MakeupApiConnector } from "../lib/connectors/makeup-api";
import { HoloTacoShopifyConnector } from "../lib/connectors/holo-taco-shopify";
import { ShopifyGenericConnector } from "../lib/connectors/shopify-generic";
import { ProductConnector, SupportedConnectorSource, SUPPORTED_SOURCES } from "../lib/connectors/types";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_RECORDS = 20;
const DEFAULT_RECENT_DAYS = 120;
const MAX_PAGE_SIZE = 100;
const MAX_RECORDS = 200;
const MAX_RECENT_DAYS = 3650;
const DEFAULT_SEARCH_TERM = "nail polish";
const JOB_TYPE_CONNECTOR_VERIFY = "connector_verify";
const INGESTION_QUEUE_CONNECTION_SETTING = "AzureWebJobsStorage";

export const INGESTION_JOB_QUEUE_NAME =
  (process.env.INGESTION_JOB_QUEUE_NAME || "ingestion-jobs").trim().toLowerCase();

const ingestionJobQueueOutput = output.storageQueue({
  queueName: INGESTION_JOB_QUEUE_NAME,
  connection: INGESTION_QUEUE_CONNECTION_SETTING,
});

// Supported sources are now derived from seed_data_sources.sql
// Run "npm run generate:types" to regenerate after adding new sources

interface NormalizedIngestionJobRequest {
  source: SupportedConnectorSource;
  searchTerm: string;
  page: number;
  pageSize: number;
  maxRecords: number;
  recentDays?: number;
  materializeToInventory: boolean;
  detectHexFromImage: boolean;
  overwriteDetectedHex: boolean;
  collectTrainingData: boolean;
}

export interface IngestionJobQueueMessage {
  jobId: number;
  userId: number;
  queuedAt: string;
  request: NormalizedIngestionJobRequest;
  requestedMetrics: Record<string, unknown>;
}

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

function isSupportedSource(value: string): value is SupportedConnectorSource {
  return (SUPPORTED_SOURCES as readonly string[]).includes(value);
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
    overwriteDetectedHex: body.overwriteDetectedHex === true,
    collectTrainingData: body.collectTrainingData === true,
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
    const source = await getDataSourceByName(normalizedRequest.source);
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
            jsonBody: { error: message, job: failedJob },
          };
        }
      } catch (markFailedError) {
        context.error("Failed to update ingestion job failure status:", markFailedError);
      }
    }

    return {
      status: 500,
      jsonBody: { error: message },
    };
  }
}

export async function processIngestionJobQueueMessage(
  payload: IngestionJobQueueMessage,
  context: InvocationContext
): Promise<void> {
  const requestedMetrics = payload.requestedMetrics || buildRequestedMetrics(payload.request, payload.userId);
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
    });

    const existingJob = await getIngestionJobById(payload.jobId);
    if (!existingJob) {
      logger.warn(`Job ${payload.jobId} not found in database, ignoring queue message`);
      await logger.dispose();
      return;
    }

    if (existingJob.status === "succeeded" || existingJob.status === "cancelled") {
      logger.info(`Job ${payload.jobId} already ${existingJob.status}, ignoring queue message`);
      await logger.dispose();
      return;
    }

    if (existingJob.status === "failed") {
      logger.info(`Job ${payload.jobId} already failed, ignoring queue message`);
      await logger.dispose();
      return;
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
      page: payload.request.page,
      pageSize: payload.request.pageSize,
      maxRecords: payload.request.maxRecords,
      recentDays: payload.request.recentDays,
    });

    const connector = createConnector(payload.request.source, source.baseUrl);
    const connectorResult = await connector.pullProducts({
      searchTerm: payload.request.searchTerm,
      page: payload.request.page,
      pageSize: payload.request.pageSize,
      maxRecords: payload.request.maxRecords,
      recentDays: payload.request.recentDays,
    });

    logger.info(`Connector returned ${connectorResult.records.length} records`, connectorResult.metadata);

    // Upsert external products
    stage = "upsert_external_products";
    logger.updateBaseMetrics(withPipelineMetrics(requestedMetrics, "running", stage, {
      queuedAt: payload.queuedAt,
      ...connectorResult.metadata,
    }));
    logger.info(`Upserting ${connectorResult.records.length} external products`);

    const persistenceMetrics = await upsertExternalProducts(
      source.dataSourceId,
      connectorResult.records
    );
    logger.info(`Upsert complete`, persistenceMetrics as unknown as Record<string, unknown>);

    let materializationMetrics: Record<string, unknown> | null = null;

    if (payload.request.source === "MakeupAPI" && payload.request.materializeToInventory) {
      stage = "materialize_inventory";
      logger.updateBaseMetrics(withPipelineMetrics(requestedMetrics, "running", stage, {
        queuedAt: payload.queuedAt,
        ...connectorResult.metadata,
        ...persistenceMetrics,
      }));

      const materializeStartTime = Date.now();
      logger.info(`Materializing MakeupAPI records to inventory`, {
        recordCount: connectorResult.records.length,
        userId: payload.userId,
      });

      try {
        materializationMetrics = (await materializeMakeupApiRecords(
          payload.userId,
          connectorResult.records
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

    if (payload.request.source === "HoloTacoShopify" && payload.request.materializeToInventory) {
      stage = "materialize_inventory";
      logger.updateBaseMetrics(withPipelineMetrics(requestedMetrics, "running", stage, {
        queuedAt: payload.queuedAt,
        ...connectorResult.metadata,
        ...persistenceMetrics,
      }));

      const materializeStartTime = Date.now();
      logger.info(`Materializing HoloTaco records to inventory`, {
        recordCount: connectorResult.records.length,
        userId: payload.userId,
        dataSourceId: source.dataSourceId,
        detectHexFromImage: payload.request.detectHexFromImage,
        overwriteDetectedHex: payload.request.overwriteDetectedHex,
      });

      try {
        materializationMetrics = (await materializeHoloTacoRecords(
          payload.userId,
          source.dataSourceId,
          connectorResult.records,
          {
            detectHexFromImage: payload.request.detectHexFromImage,
            overwriteDetectedHex: payload.request.overwriteDetectedHex,
          }
        )) as unknown as Record<string, unknown>;

        const materializeDuration = Date.now() - materializeStartTime;
        logger.info(`HoloTaco materialization complete`, {
          ...materializationMetrics,
          durationMs: materializeDuration,
          recordsProcessed: connectorResult.records.length,
        });
      } catch (materializeError) {
        const materializeDuration = Date.now() - materializeStartTime;
        logger.error(`HoloTaco materialization failed`, {
          error: getErrorMessage(materializeError),
          durationMs: materializeDuration,
          recordCount: connectorResult.records.length,
          detectHexFromImage: payload.request.detectHexFromImage,
          overwriteDetectedHex: payload.request.overwriteDetectedHex,
        });
        throw materializeError;
      }
    }

    // Build final metrics with logs
    const baseMetrics = {
      ...requestedMetrics,
      ...connectorResult.metadata,
      ...persistenceMetrics,
      ...(materializationMetrics || {}),
    };
    logger.updateBaseMetrics(withPipelineMetrics(baseMetrics, "succeeded", "completed", {
      queuedAt: payload.queuedAt,
      workerCompletedAt: new Date().toISOString(),
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
    const sources = await listDataSources(true);
    return {
      status: 200,
      jsonBody: { sources },
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
        jsonBody: { error: result.error || "Failed to purge queue" },
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

