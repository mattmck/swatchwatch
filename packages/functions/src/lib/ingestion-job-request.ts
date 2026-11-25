import type { IngestionJobRequest } from "./ingestion-continuation";
import type { SupportedConnectorSource } from "./connectors/types";

/**
 * Job request defaults and metrics shared by the ingestion endpoints and the nightly catalog
 * refresh timer (#532), so a scheduled refresh queues exactly what an admin bulk run queues.
 */

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_MAX_RECORDS = 20;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_SEARCH_TERM = "nail polish";
/** `ingestion_job.job_type` of every connector run. */
export const JOB_TYPE_CONNECTOR_VERIFY = "connector_verify";

export interface BulkRunOptions {
  materializeToInventory?: boolean;
  detectHexFromImage?: boolean;
  overwriteDetectedHex?: boolean;
}

/**
 * The request of one source in a bulk run (`POST /api/ingestion/bulk`): the whole catalog
 * (`exhaustive`, 100 per page), materialized into catalog shades and hex-detected unless the
 * options say otherwise (the source's own `detectHex` / image settings still apply in the
 * worker), never overwriting detected hexes. `materializeToInventory` is the historical name of
 * the catalog materialization switch: ingestion writes catalog rows only, never inventory.
 */
export function buildBulkRunRequest(
  source: SupportedConnectorSource,
  options: BulkRunOptions = {}
): IngestionJobRequest {
  return {
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
}

/**
 * The request echoed into `ingestion_job.metrics_json`. `triggeredByUserId` is the admin who
 * queued the job, or null for a system-started run (then `triggeredBy` names the system).
 */
export function buildRequestedMetrics(
  request: IngestionJobRequest,
  userId: number | null,
  triggeredBy?: string
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
    ...(triggeredBy ? { triggeredBy } : {}),
  };
}

export function withPipelineMetrics(
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
