import { isStoreClosedIngestionJob } from "swatchwatch-shared";

/** How the admin views name a job whose store was closed or locked (#529). */
export const STORE_CLOSED_LABEL = "Store closed";

/** Hover text for a store-closed job: it is not an error. */
export const STORE_CLOSED_TITLE =
  "The store was password-locked or in maintenance. Nothing more was pulled or written; the next run tries again.";

/** Badge colors for a store-closed job: neither the green of a normal run nor the red of a failure. */
export const STORE_CLOSED_BADGE_CLASS = "border-violet-500/40 bg-violet-500/10 text-violet-700";

/** Reads `metrics.pipeline.stage` from a job's metrics, or null. */
export function pipelineStageOf(metrics: Record<string, unknown> | null | undefined): string | null {
  const pipeline = metrics?.pipeline;
  if (!pipeline || typeof pipeline !== "object") return null;
  const stage = (pipeline as Record<string, unknown>).stage;
  return typeof stage === "string" && stage.trim() ? stage : null;
}

/** The status word an admin table shows: "Store closed" for a store-closed run, else the raw status. */
export function ingestionJobStatusLabel(job: { status: string; stage?: string | null }): string {
  return isStoreClosedIngestionJob(job) ? STORE_CLOSED_LABEL : job.status;
}
