import { app, InvocationContext, Timer } from "@azure/functions";
import { deleteBlobFromStorageUrl, userMediaContainer } from "../lib/blob-storage";
import { getCaptureFrameSweepConfig, captureFrameSweepSchedule, sweepExpiredCaptureFrames } from "../lib/capture-frame-sweep";
import { query } from "../lib/db";
import { trackEvent, trackException, trackMetric } from "../lib/telemetry";

/**
 * Timer: release capture frame blobs older than the retention window (Bottle Flow slice A). See
 * `lib/capture-frame-sweep.ts` for the rules. Runs whether or not `BOTTLE_CAPTURE_ENABLED` is on,
 * so frames stored before the flag was switched off are still released. Emits
 * `capture_frame_sweep.completed` (counts as properties) plus one `capture_frame_sweep.<count>`
 * metric per count, or `capture_frame_sweep.failed` when the run could not start or scan.
 */
export async function runCaptureFrameSweep(_timer: Timer, context: InvocationContext): Promise<void> {
  const config = getCaptureFrameSweepConfig();
  try {
    if (!process.env.AZURE_STORAGE_CONNECTION?.trim()) {
      context.warn("[capture-frame-sweep] AZURE_STORAGE_CONNECTION is not set; skipping sweep");
      trackEvent("capture_frame_sweep.skipped", { reason: "storage_not_configured" });
      return;
    }
    // Resolved once per run; throws when USER_MEDIA_CONTAINER equals the catalog container.
    const mediaContainer = userMediaContainer();

    const result = await sweepExpiredCaptureFrames(
      {
        query,
        deleteBlob: (storageUrl) =>
          deleteBlobFromStorageUrl(storageUrl, { allowedContainers: [mediaContainer] }),
        log: (message) => context.log(message),
        warn: (message, error) => {
          context.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
          trackException(error, { area: "capture-frame-sweep", stage: "frame" });
        },
      },
      config
    );

    trackEvent("capture_frame_sweep.completed", { ...result, ...config });
    for (const name of ["scanned", "released", "blobMissing", "failed", "skipped"] as const) {
      trackMetric(`capture_frame_sweep.${name}`, result[name]);
    }
  } catch (error) {
    context.error("[capture-frame-sweep] Sweep failed", error);
    trackEvent("capture_frame_sweep.failed");
    trackException(error, { area: "capture-frame-sweep", stage: "run" });
  }
}

app.timer("capture-frame-sweep", {
  schedule: captureFrameSweepSchedule(),
  runOnStartup: false,
  handler: runCaptureFrameSweep,
});
