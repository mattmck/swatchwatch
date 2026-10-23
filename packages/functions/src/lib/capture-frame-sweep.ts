import { releaseCaptureFrame, type FrameBlobRow, type ReleaseDeps } from "./capture-frame-store";

/**
 * Capture frame sweep (Bottle Flow slice A). Frames of sessions that never reached a terminal
 * state (abandoned scans) keep their private blob until this hourly timer releases it, once the
 * frame's `image_asset` is older than the retention window (default 24 hours).
 *
 * Per row (see `releaseCaptureFrame`): not the owner's `{ownerId}/capture/` blob → skipped, row
 * untouched; blob deleted (404 counts as `blobMissing`) → row reset to the `inline://`
 * placeholder; a throwing delete → `failed`, row kept for the next run. Never reads or writes
 * `capture_frame.quality_json`, so the extracted label/barcode evidence outlives the bytes.
 */

export const DEFAULT_CAPTURE_FRAME_SWEEP_SCHEDULE = "0 0 * * * *";

export const CAPTURE_FRAME_SWEEP_LIMITS = {
  retentionSeconds: { fallback: 86_400, min: 3_600, max: 604_800 },
  batchSize: { fallback: 200, min: 1, max: 1_000 },
  maxPerRun: { fallback: 2_000, min: 1, max: 20_000 },
} as const;

export interface CaptureFrameSweepConfig {
  /** Minimum age (by `image_asset.captured_at`) before a frame blob is released. */
  retentionSeconds: number;
  /** Rows fetched per scan query. */
  batchSize: number;
  /** Most rows examined in one run (bounds the timer's run time). */
  maxPerRun: number;
}

function clampIntEnv(
  value: string | undefined,
  limits: { fallback: number; min: number; max: number }
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return limits.fallback;
  return Math.min(limits.max, Math.max(limits.min, parsed));
}

/** Sweep NCRONTAB schedule from `CAPTURE_FRAME_SWEEP_SCHEDULE` (default hourly). */
export function captureFrameSweepSchedule(env: NodeJS.ProcessEnv = process.env): string {
  return env.CAPTURE_FRAME_SWEEP_SCHEDULE?.trim() || DEFAULT_CAPTURE_FRAME_SWEEP_SCHEDULE;
}

export function getCaptureFrameSweepConfig(env: NodeJS.ProcessEnv = process.env): CaptureFrameSweepConfig {
  return {
    retentionSeconds: clampIntEnv(env.CAPTURE_FRAME_RETENTION_SECONDS, CAPTURE_FRAME_SWEEP_LIMITS.retentionSeconds),
    batchSize: clampIntEnv(env.CAPTURE_FRAME_SWEEP_BATCH_SIZE, CAPTURE_FRAME_SWEEP_LIMITS.batchSize),
    maxPerRun: clampIntEnv(env.CAPTURE_FRAME_SWEEP_MAX_PER_RUN, CAPTURE_FRAME_SWEEP_LIMITS.maxPerRun),
  };
}

/**
 * Keyset page of capture frames whose asset is past the retention window and not yet reset.
 * Params: $1 retention seconds, $2 last image_id seen, $3 limit. The `LIKE` on the owner's
 * `/capture/` prefix is only a prefilter, so frames that reference something else (a nail photo
 * attached by `imageId`) are not rescanned every hour; `isCaptureFrameStorageUrl` decides.
 */
export const SELECT_EXPIRED_CAPTURE_FRAMES_SQL = `SELECT ia.image_id::text AS "imageId",
       ia.owner_id::text AS "ownerId",
       ia.storage_url AS "storageUrl",
       ia.checksum_sha256 AS "checksum",
       cs.capture_uuid::text AS "captureId"
FROM capture_frame cf
JOIN image_asset ia ON ia.image_id = cf.image_id
JOIN capture_session cs ON cs.capture_session_id = cf.capture_session_id
WHERE ia.owner_type = 'user'
  AND ia.captured_at IS NOT NULL
  AND ia.captured_at < now() - make_interval(secs => $1)
  AND ia.storage_url NOT LIKE 'inline://%'
  AND ia.storage_url LIKE '%/' || ia.owner_id::text || '/capture/%'
  AND ia.image_id > $2
ORDER BY ia.image_id
LIMIT $3`;

export interface CaptureFrameSweepResult {
  /** Frames examined. */
  scanned: number;
  /** Frames whose row was reset to the placeholder (blob deleted or already gone). */
  released: number;
  /** Released frames whose blob was already missing (404). */
  blobMissing: number;
  /** Frames whose blob delete or row reset failed; retried on the next run. */
  failed: number;
  /** Frames left alone: not the owner's capture-prefix blob. */
  skipped: number;
  /** True when the run stopped at `maxPerRun` with frames possibly left. */
  truncated: boolean;
}

interface ExpiredFrameRow extends FrameBlobRow {
  ownerId: string;
}

/**
 * Release capture frames past the retention window, oldest id first, up to `config.maxPerRun`.
 * Per-row failures are counted, never thrown; a failure of the scan query throws.
 */
export async function sweepExpiredCaptureFrames(
  deps: ReleaseDeps & { log?: (message: string) => void },
  config: CaptureFrameSweepConfig
): Promise<CaptureFrameSweepResult> {
  const result: CaptureFrameSweepResult = {
    scanned: 0,
    released: 0,
    blobMissing: 0,
    failed: 0,
    skipped: 0,
    truncated: false,
  };

  let cursor = "0";
  while (result.scanned < config.maxPerRun) {
    const limit = Math.min(config.batchSize, config.maxPerRun - result.scanned);
    const page = await deps.query<ExpiredFrameRow>(SELECT_EXPIRED_CAPTURE_FRAMES_SQL, [
      config.retentionSeconds,
      cursor,
      limit,
    ]);
    if (page.rows.length === 0) break;

    const rows = page.rows.slice(0, limit);
    for (const row of rows) {
      result.scanned += 1;
      const outcome = await releaseCaptureFrame(row.ownerId, row, row.captureId, deps);
      if (outcome === "blobMissing") {
        result.released += 1;
        result.blobMissing += 1;
      } else {
        result[outcome] += 1;
      }
    }

    cursor = rows[rows.length - 1].imageId;
    if (page.rows.length < limit) break;
    if (result.scanned >= config.maxPerRun) result.truncated = true;
  }

  deps.log?.(
    `[capture-frame-sweep] scanned=${result.scanned} released=${result.released} blobMissing=${result.blobMissing} ` +
      `failed=${result.failed} skipped=${result.skipped} truncated=${result.truncated}`
  );
  return result;
}
