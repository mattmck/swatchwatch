/**
 * A job's hex count across both detection paths. The worker's `hexDetected` / `hexSnapped` only
 * count synchronous detections (it rebuilds them from its own totals on every write), while the
 * AI batch poller sums the detections it applies in `aiBatchApplyTotals` (`appliedHex`: matched
 * rows with a hex). `hexDetectedTotal` / `hexSnappedTotal` add the two so a batch-mode job does not
 * read as "0 hex detected".
 */

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Adds `hexDetectedTotal` / `hexSnappedTotal`; metrics without hex counters are returned as is. */
export function withHexDetectionTotals<T extends Record<string, unknown>>(metrics: T): T {
  const batchTotals = readRecord(metrics.aiBatchApplyTotals);
  if (!("hexDetected" in metrics) && !batchTotals) {
    return metrics;
  }
  return {
    ...metrics,
    // `appliedHex` counts matched rows with a hex; older totals only have `applied`.
    hexDetectedTotal:
      readCount(metrics.hexDetected) +
      readCount(batchTotals && "appliedHex" in batchTotals ? batchTotals.appliedHex : batchTotals?.applied),
    hexSnappedTotal: readCount(metrics.hexSnapped) + readCount(batchTotals?.hexSnapped),
  };
}
