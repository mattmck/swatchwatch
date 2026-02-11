import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  IngestionJobListResponse,
  IngestionJobRunRequest,
  IngestionJobRunResponse,
} from "swatchwatch-shared";
import { withAuth } from "../lib/auth";
import { withCors } from "../lib/http";
import {
  createIngestionJob,
  getDataSourceByName,
  getIngestionJobById,
  listIngestionJobs,
  materializeHoloTacoRecords,
  materializeMakeupApiRecords,
  markIngestionJobFailed,
  markIngestionJobSucceeded,
  upsertExternalProducts,
} from "../lib/ingestion-repo";
import { OpenBeautyFactsConnector } from "../lib/connectors/open-beauty-facts";
import { MakeupApiConnector } from "../lib/connectors/makeup-api";
import { HoloTacoShopifyConnector } from "../lib/connectors/holo-taco-shopify";
import { ProductConnector, SupportedConnectorSource } from "../lib/connectors/types";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_RECORDS = 20;
const DEFAULT_RECENT_DAYS = 120;
const MAX_PAGE_SIZE = 100;
const MAX_RECORDS = 200;
const MAX_RECENT_DAYS = 3650;
const DEFAULT_SEARCH_TERM = "nail polish";
const JOB_TYPE_CONNECTOR_VERIFY = "connector_verify";

const SUPPORTED_SOURCES: readonly SupportedConnectorSource[] = [
  "OpenBeautyFacts",
  "MakeupAPI",
  "HoloTacoShopify",
];

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

  throw new Error(`Unsupported connector source: ${source}`);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function runIngestionJob(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log(`POST /api/ingestion/jobs by user ${userId}`);

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

  const page = clampInt(body.page, DEFAULT_PAGE, 1, 50);
  const pageSize = clampInt(body.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const maxRecords = clampInt(body.maxRecords, DEFAULT_MAX_RECORDS, 1, MAX_RECORDS);
  const materializeToInventory = body.materializeToInventory !== false;
  const recentDays =
    body.recentDays === null || body.recentDays === undefined
      ? undefined
      : clampInt(body.recentDays, DEFAULT_RECENT_DAYS, 1, MAX_RECENT_DAYS);
  const searchTerm =
    typeof body.searchTerm === "string" && body.searchTerm.trim().length > 0
      ? body.searchTerm.trim()
      : DEFAULT_SEARCH_TERM;

  const requestedMetrics: Record<string, unknown> = {
    searchTerm,
    requestedPage: page,
    requestedPageSize: pageSize,
    maxRecords,
    recentDays: recentDays || null,
    materializeToInventory,
    triggeredByUserId: userId,
  };

  let jobId: number | null = null;

  try {
    const source = await getDataSourceByName(sourceInput);
    if (!source) {
      return {
        status: 404,
        jsonBody: { error: `Data source '${sourceInput}' not found in data_source table` },
      };
    }

    const job = await createIngestionJob(source.dataSourceId, JOB_TYPE_CONNECTOR_VERIFY, requestedMetrics);
    jobId = job.jobId;

    const connector = createConnector(sourceInput, source.baseUrl);
    const connectorResult = await connector.pullProducts({
      searchTerm,
      page,
      pageSize,
      maxRecords,
      recentDays,
    });

    const persistenceMetrics = await upsertExternalProducts(
      source.dataSourceId,
      connectorResult.records
    );

    const materializationMetrics =
      sourceInput === "MakeupAPI" && materializeToInventory
        ? await materializeMakeupApiRecords(userId, connectorResult.records)
        : sourceInput === "HoloTacoShopify" && materializeToInventory
          ? await materializeHoloTacoRecords(userId, source.dataSourceId, connectorResult.records)
        : null;

    const finalMetrics = {
      ...requestedMetrics,
      ...connectorResult.metadata,
      ...persistenceMetrics,
      ...(materializationMetrics || {}),
    };

    await markIngestionJobSucceeded(job.jobId, finalMetrics);
    const finalizedJob = await getIngestionJobById(job.jobId);

    if (!finalizedJob) {
      return {
        status: 500,
        jsonBody: { error: `Ingestion job ${job.jobId} completed but could not be loaded` },
      };
    }

    return {
      status: 201,
      jsonBody: { job: finalizedJob } satisfies IngestionJobRunResponse,
    };
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    context.error("Ingestion job execution failed:", error);

    if (jobId !== null) {
      try {
        await markIngestionJobFailed(jobId, message, requestedMetrics);
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
    return runIngestionJob(request, context, userId);
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

app.http("ingestion-jobs", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "ingestion/jobs",
  handler: withCors(withAuth(ingestionJobsHandler)),
});

app.http("ingestion-job-detail", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "ingestion/jobs/{id}",
  handler: withCors(withAuth(ingestionJobDetailHandler)),
});
