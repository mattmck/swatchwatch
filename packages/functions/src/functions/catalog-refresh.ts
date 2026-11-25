import { app, InvocationContext, Timer } from "@azure/functions";
import {
  CATALOG_REFRESH_TRIGGER,
  catalogRefreshSchedule,
  countSkipsByReason,
  getCatalogRefreshConfig,
  planCatalogRefresh,
  SELECT_CATALOG_REFRESH_SOURCES_SQL,
  type CatalogRefreshSourceRow,
} from "../lib/catalog-refresh";
import { isRunnableConnectorSource } from "../lib/connectors/factories";
import { materializesShadeProductsByName } from "../lib/connectors/registry";
import type { SupportedConnectorSource } from "../lib/connectors/types";
import { query } from "../lib/db";
import { isFeatureEnabled } from "../lib/feature-flags";
import {
  INGESTION_JOB_QUEUE_NAME,
  sendIngestionQueueMessage,
  type IngestionJobQueueMessage,
} from "../lib/ingestion-continuation";
import {
  buildBulkRunRequest,
  buildRequestedMetrics,
  JOB_TYPE_CONNECTOR_VERIFY,
  withPipelineMetrics,
} from "../lib/ingestion-job-request";
import { admitIngestionJob, markIngestionJobFailed } from "../lib/ingestion-repo";
import { trackEvent, trackException } from "../lib/telemetry";

export interface CatalogRefreshDeps {
  isEnabled: () => boolean;
  loadSources: () => Promise<CatalogRefreshSourceRow[]>;
  admitJob: typeof admitIngestionJob;
  markJobFailed: typeof markIngestionJobFailed;
  sendMessage: typeof sendIngestionQueueMessage;
  trackEvent: typeof trackEvent;
  trackException: typeof trackException;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

const defaultDeps: CatalogRefreshDeps = {
  isEnabled: () => isFeatureEnabled("catalogRefresh"),
  loadSources: async () => (await query<CatalogRefreshSourceRow>(SELECT_CATALOG_REFRESH_SOURCES_SQL, [])).rows,
  admitJob: admitIngestionJob,
  markJobFailed: markIngestionJobFailed,
  sendMessage: sendIngestionQueueMessage,
  trackEvent,
  trackException,
  env: process.env,
  now: () => new Date(),
};

/**
 * Timer (#532): queue one ingestion job per eligible data source every night, each message made
 * visible after a staggered delay (a start delay, not a no-overlap guarantee). Each source is
 * admitted atomically (`admitIngestionJob`), so a bulk run overlapping the timer cannot queue a
 * second job for it. Does nothing (no query, no message) unless `CATALOG_REFRESH_ENABLED`
 * is exactly `true`. Each job is what an admin bulk run queues with default options (whole
 * catalog, catalog shades only, hex detection as the source settings allow, no hex overwrite),
 * with `triggeredByUserId: null` and `triggeredBy: "catalog_refresh"` in its metrics. Emits
 * `catalog_refresh.run` with the counts; a failing job alerts through `ingestion.job_failed`.
 */
export async function runCatalogRefresh(
  _timer: Timer,
  context: InvocationContext,
  deps: CatalogRefreshDeps = defaultDeps
): Promise<void> {
  if (!deps.isEnabled()) {
    context.log("[catalog-refresh] CATALOG_REFRESH_ENABLED is off; nothing queued");
    return;
  }

  try {
    const config = getCatalogRefreshConfig(deps.env);
    const rows = await deps.loadSources();
    const plan = planCatalogRefresh(
      rows,
      { isRunnable: isRunnableConnectorSource, isCatalogSource: materializesShadeProductsByName },
      config
    );

    const runAt = deps.now();
    const queuedAt = runAt.toISOString();
    const enqueued: Array<{ source: string; jobId: number; delaySeconds: number }> = [];
    const failed: string[] = [];
    // A source that gained a job between the plan and its admission (an overlapping bulk run).
    const busyAtAdmission: Array<{ name: string; reason: "already_running"; activeJobId: number }> = [];

    for (const source of plan.planned) {
      const request = buildBulkRunRequest(source.name as SupportedConnectorSource);
      const requestedMetrics = buildRequestedMetrics(request, null, CATALOG_REFRESH_TRIGGER);
      const scheduledStartAt = new Date(runAt.getTime() + source.delaySeconds * 1000).toISOString();
      const runMetrics = {
        queuedAt,
        queueName: INGESTION_JOB_QUEUE_NAME,
        catalogRefresh: true,
        scheduledStartAt,
        visibilityDelaySeconds: source.delaySeconds,
      };
      let jobId: number | null = null;
      try {
        const admission = await deps.admitJob(
          source.dataSourceId,
          JOB_TYPE_CONNECTOR_VERIFY,
          withPipelineMetrics(requestedMetrics, "queued", "queued", runMetrics)
        );
        if (!admission.admitted) {
          busyAtAdmission.push({ name: source.name, reason: "already_running", activeJobId: admission.activeJobId });
          continue;
        }
        const job = admission.job;
        jobId = job.jobId;
        const message: IngestionJobQueueMessage = {
          jobId: job.jobId,
          userId: null,
          queuedAt,
          request,
          requestedMetrics,
        };
        await deps.sendMessage(message, { visibilityTimeoutSeconds: source.delaySeconds });
        enqueued.push({ source: source.name, jobId: job.jobId, delaySeconds: source.delaySeconds });
      } catch (error) {
        failed.push(source.name);
        context.error(`[catalog-refresh] Could not queue ${source.name}`, error);
        deps.trackException(error, { area: "catalog-refresh", stage: "enqueue", source: source.name });
        if (jobId !== null) {
          try {
            await deps.markJobFailed(
              jobId,
              error instanceof Error ? error.message : String(error),
              withPipelineMetrics(requestedMetrics, "failed", "queue_enqueue", {
                ...runMetrics,
                failedAt: new Date().toISOString(),
                failedStage: "queue_enqueue",
              })
            );
          } catch (markError) {
            context.error(`[catalog-refresh] Could not mark job ${jobId} failed`, markError);
          }
        }
      }
    }

    const allSkipped = [...plan.skipped, ...busyAtAdmission];
    const skipsByReason = countSkipsByReason(allSkipped);
    context.log(
      `[catalog-refresh] queued ${enqueued.length} of ${plan.planned.length} planned sources; skipped ${allSkipped.length}`,
      { enqueued, failed, skipped: allSkipped }
    );
    deps.trackEvent("catalog_refresh.run", {
      sources: rows.length,
      planned: plan.planned.length,
      enqueued: enqueued.length,
      failed: failed.length,
      skipped: allSkipped.length,
      ...Object.fromEntries(Object.entries(skipsByReason).map(([reason, count]) => [`skipped_${reason}`, count])),
      staggerSeconds: config.staggerSeconds,
      maxSourcesPerRun: config.maxSourcesPerRun,
    });
  } catch (error) {
    context.error("[catalog-refresh] Run failed", error);
    deps.trackEvent("catalog_refresh.failed");
    deps.trackException(error, { area: "catalog-refresh", stage: "run" });
  }
}

app.timer("catalog-refresh", {
  schedule: catalogRefreshSchedule(),
  runOnStartup: false,
  handler: (timer, context) => runCatalogRefresh(timer, context),
});
