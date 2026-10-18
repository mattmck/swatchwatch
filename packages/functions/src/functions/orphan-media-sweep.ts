import { app, InvocationContext, Timer } from "@azure/functions";
import { deleteBlobFromStorageUrl, userMediaContainer } from "../lib/blob-storage";
import { query, transaction } from "../lib/db";
import {
  getOrphanMediaSweepConfig,
  orphanMediaSweepSchedule,
  sweepOrphanedUserMedia,
} from "../lib/orphan-media-sweep";
import { trackEvent, trackException, trackMetric } from "../lib/telemetry";

/**
 * Timer: delete orphaned owner-scoped media (#319). See `lib/orphan-media-sweep.ts` for the rules.
 * Emits `orphan_media_sweep.completed` (counts as properties) plus one `orphan_media_sweep.<count>`
 * metric per count, or `orphan_media_sweep.failed` when the run could not start or scan.
 */
export async function runOrphanMediaSweep(_timer: Timer, context: InvocationContext): Promise<void> {
  const config = getOrphanMediaSweepConfig();
  try {
    if (!process.env.AZURE_STORAGE_CONNECTION?.trim()) {
      context.warn("[orphan-media-sweep] AZURE_STORAGE_CONNECTION is not set; skipping sweep");
      trackEvent("orphan_media_sweep.skipped", { reason: "storage_not_configured" });
      return;
    }
    // Resolved once per run; throws when USER_MEDIA_CONTAINER equals the catalog container.
    const mediaContainer = userMediaContainer();

    const result = await sweepOrphanedUserMedia(
      {
        query,
        transaction,
        deleteBlob: (storageUrl) =>
          deleteBlobFromStorageUrl(storageUrl, { allowedContainers: [mediaContainer] }),
        log: (message) => context.log(message),
        warn: (message, error) => {
          context.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
          trackException(error, { area: "orphan-media-sweep", stage: "asset" });
        },
      },
      config
    );

    trackEvent("orphan_media_sweep.completed", { ...result, ...config });
    for (const name of ["scanned", "deleted", "blobMissing", "failed", "skipped"] as const) {
      trackMetric(`orphan_media_sweep.${name}`, result[name]);
    }
  } catch (error) {
    context.error("[orphan-media-sweep] Sweep failed", error);
    trackEvent("orphan_media_sweep.failed");
    trackException(error, { area: "orphan-media-sweep", stage: "run" });
  }
}

app.timer("orphan-media-sweep", {
  schedule: orphanMediaSweepSchedule(),
  runOnStartup: false,
  handler: runOrphanMediaSweep,
});
