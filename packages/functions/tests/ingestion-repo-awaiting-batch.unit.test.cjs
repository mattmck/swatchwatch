const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Mock ../lib/db so the repo runs against canned rows shaped like node-postgres output
// ---------------------------------------------------------------------------

let rows = [];
const dbPath = path.resolve(__dirname, "../dist/lib/db.js");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async () => ({ rows }),
    transaction: async (cb) => cb({ query: async () => ({ rows: [] }) }),
  },
};

const { listIngestionJobsAwaitingAiBatch } = require("../dist/lib/ingestion-repo");

describe("listIngestionJobsAwaitingAiBatch", () => {
  it("returns numeric ids even though node-postgres returns BIGINT columns as strings", async () => {
    rows = [
      {
        jobId: "147",
        source: "RogueLacquerShopify",
        dataSourceId: "31",
        metrics: null,
        startedAt: "2026-10-15 00:39:58+00",
      },
    ];

    const [job] = await listIngestionJobsAwaitingAiBatch(10);

    // The poller compares this against a numeric queue payload (resumeMessage.jobId).
    assert.equal(job.jobId, 147);
    assert.equal(job.dataSourceId, 31);
    assert.deepEqual(job.metrics, {});
  });
});
