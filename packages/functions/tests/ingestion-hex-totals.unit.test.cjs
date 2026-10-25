/**
 * Unit tests for lib/ingestion-hex-totals — a job's hex count across sync and batch detection.
 *
 * Covers:
 * - withHexDetectionTotals() adds the poller's applied batch detections to the worker's sync
 *   `hexDetected` (and batch `hexSnapped` to `hexSnapped`) as `hexDetectedTotal` / `hexSnappedTotal`
 * - sync-only and batch-only jobs, unreadable values counted as 0, metrics without hex counters untouched
 * - every ingestion_job metrics write and the job reads (list, detail) carry the totals
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

delete process.env.AZURE_STORAGE_CONNECTION;

function mockDistModule(relativePath, exports) {
  const resolved = path.resolve(__dirname, "../dist/lib", relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const queries = [];
let nextRows = [];
mockDistModule("db.js", {
  query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: nextRows, rowCount: 1 };
  },
  transaction: async (callback) => callback({ query: async () => ({ rows: [] }) }),
});
mockDistModule("telemetry.js", {
  trackEvent: () => {},
  trackMetric: () => {},
  trackException: () => {},
});

const { withHexDetectionTotals } = require("../dist/lib/ingestion-hex-totals");
const repo = require("../dist/lib/ingestion-repo");

describe("withHexDetectionTotals", () => {
  it("adds applied batch detections to the sync count", () => {
    const metrics = withHexDetectionTotals({
      hexDetected: 13,
      hexSnapped: 11,
      aiBatchApplyTotals: { applied: 476, hexSnapped: 30, processed: 480 },
    });
    assert.equal(metrics.hexDetected, 13, "the sync count stays as the worker wrote it");
    assert.equal(metrics.hexDetectedTotal, 489);
    assert.equal(metrics.hexSnappedTotal, 41);
  });

  it("prefers appliedHex (matched rows with a hex) over applied, which also counts finishes-only rows", () => {
    const metrics = withHexDetectionTotals({
      hexDetected: 3,
      aiBatchApplyTotals: { applied: 50, appliedHex: 44 },
    });
    assert.equal(metrics.hexDetectedTotal, 47);
  });

  it("counts a batch-only job (the worker detected nothing synchronously)", () => {
    const metrics = withHexDetectionTotals({
      hexDetected: 0,
      aiBatchApplyTotals: { applied: 50 },
    });
    assert.equal(metrics.hexDetectedTotal, 50);
    assert.equal(metrics.hexSnappedTotal, 0);
  });

  it("equals the sync count before any batch was applied", () => {
    const metrics = withHexDetectionTotals({ hexDetected: 7, hexSnapped: 2 });
    assert.equal(metrics.hexDetectedTotal, 7);
    assert.equal(metrics.hexSnappedTotal, 2);
  });

  it("treats unreadable values as 0", () => {
    const metrics = withHexDetectionTotals({
      hexDetected: "12",
      aiBatchApplyTotals: { applied: Number.NaN, hexSnapped: null },
    });
    assert.equal(metrics.hexDetectedTotal, 0);
    assert.equal(metrics.hexSnappedTotal, 0);
  });

  it("leaves metrics without hex counters untouched", () => {
    const input = { stage: "materialize" };
    assert.equal(withHexDetectionTotals(input), input);
    assert.deepEqual(withHexDetectionTotals(input), { stage: "materialize" });
  });
});

describe("ingestion_job metrics writes and reads carry the hex totals", () => {
  const metrics = { hexDetected: 2, aiBatchApplyTotals: { applied: 40 } };

  beforeEach(() => {
    queries.length = 0;
    nextRows = [];
  });

  for (const [name, call] of [
    ["markIngestionJobRunning", () => repo.markIngestionJobRunning(1, metrics)],
    ["updateIngestionJobMetrics", () => repo.updateIngestionJobMetrics(1, metrics)],
    ["updateRunningIngestionJobMetrics", () => repo.updateRunningIngestionJobMetrics(1, metrics)],
    ["markIngestionJobSucceeded", () => repo.markIngestionJobSucceeded(1, metrics)],
    ["markIngestionJobFailed", () => repo.markIngestionJobFailed(1, "boom", metrics)],
  ]) {
    it(`${name} stores hexDetectedTotal`, async () => {
      await call();
      assert.equal(queries.length, 1);
      const stored = queries[0].params.find((param) => param && typeof param === "object");
      assert.equal(stored.hexDetectedTotal, 42);
    });
  }

  it("getIngestionJobById derives the totals for rows written before they existed", async () => {
    nextRows = [{ jobId: "9", status: "succeeded", metrics: { ...metrics } }];
    const job = await repo.getIngestionJobById(9);
    assert.equal(job.metrics.hexDetectedTotal, 42);
  });

  it("listIngestionJobs derives the totals too", async () => {
    nextRows = [{ jobId: "9", status: "succeeded", metrics: { ...metrics }, total: "1" }];
    const { jobs } = await repo.listIngestionJobs(5);
    assert.equal(jobs[0].metrics.hexDetectedTotal, 42);
  });
});
