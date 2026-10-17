const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

delete process.env.AZURE_STORAGE_CONNECTION;

function mockDistModule(relativePath, exports) {
  const resolved = path.resolve(__dirname, "../dist/lib", relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// markIngestionJobFailed() emits the event the prod "ingestion job failed"
// alert queries (infrastructure/main.tf, AppEvents Name == "ingestion.job_failed").

const queries = [];
mockDistModule("db.js", {
  query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 1 };
  },
  transaction: async (callback) => callback({ query: async () => ({ rows: [] }) }),
});

const events = [];
mockDistModule("telemetry.js", {
  trackEvent: (name, properties) => events.push({ name, properties }),
  trackMetric: () => {},
  trackException: () => {},
});

const { markIngestionJobFailed } = require("../dist/lib/ingestion-repo");

describe("markIngestionJobFailed", () => {
  it("marks the job failed, then emits ingestion.job_failed with a truncated error", async () => {
    const longError = "x".repeat(800);
    await markIngestionJobFailed(42, longError, { stage: "materialize" });

    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /SET status = 'failed'/);
    assert.deepEqual(queries[0].params, [42, longError, { stage: "materialize" }]);

    assert.equal(events.length, 1);
    assert.equal(events[0].name, "ingestion.job_failed");
    assert.equal(events[0].properties.jobId, 42);
    assert.equal(events[0].properties.error.length, 500);
  });
});
