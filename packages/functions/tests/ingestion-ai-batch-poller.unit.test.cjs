const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// Module-level mocking via require interception (same style as handlers tests)
// ---------------------------------------------------------------------------

const registeredTimers = {};
const mockModules = {};
const originalResolve = Module._resolveFilename;

function registerMock(id, exports) {
  mockModules[id] = exports;
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) {
      return key;
    }
  }
  return originalResolve.call(this, request, parent, ...rest);
};

// Load the real continuation helpers before the mock shadows the relative import, so the
// poller exercises the real readResumeMessageFromMetrics while enqueue stays mocked.
const realContinuation = require(path.resolve(__dirname, "../dist/lib/ingestion-continuation.js"));

// Ordered record of side-effecting calls so tests can assert persist-before-enqueue.
let calls = [];
// Arguments the poller passed to batch parsing / shade apply (provenance threading).
let parseProvenanceArgs = [];
let appliedDetections = [];
let dbJob = null;
let awaitingJob = null;
let batchStatus = null;
// Per-batch statuses for jobs tracking several batches; falls back to batchStatus.
let batchStatusById = {};
let polledBatchIds = [];
let applyResult = null;
let onApply = () => {};
let onPoll = () => {};
let enqueueMock = async () => {};

registerMock("@azure/functions", {
  app: {
    timer: (name, opts) => {
      registeredTimers[name] = opts;
    },
  },
});

registerMock("../lib/telemetry", {
  trackMetric: () => {},
  trackEvent: () => {},
  trackException: () => {},
});

registerMock("../lib/ingestion-repo", {
  listIngestionJobsAwaitingAiBatch: async () => (awaitingJob ? [awaitingJob] : []),
  getIngestionJobById: async (jobId) => {
    if (!dbJob || dbJob.jobId !== jobId) return null;
    return { ...dbJob, metrics: structuredClone(dbJob.metrics) };
  },
  updateIngestionJobMetrics: async (jobId, metrics) => {
    calls.push({ type: "update", jobId, metrics: structuredClone(metrics) });
    dbJob.metrics = structuredClone(metrics);
  },
  // Mirrors the real conditional UPDATE ... AND status = 'running'.
  updateRunningIngestionJobMetrics: async (jobId, metrics) => {
    if (!dbJob || dbJob.status !== "running") return false;
    calls.push({ type: "update", jobId, metrics: structuredClone(metrics) });
    dbJob.metrics = structuredClone(metrics);
    return true;
  },
  markIngestionJobSucceeded: async (jobId, metrics) => {
    calls.push({ type: "succeeded", jobId, metrics: structuredClone(metrics) });
    dbJob.status = "succeeded";
    dbJob.metrics = structuredClone(metrics);
  },
  markIngestionJobFailed: async (jobId, error, metrics) => {
    calls.push({ type: "failed", jobId, error, metrics: structuredClone(metrics) });
    dbJob.status = "failed";
    dbJob.metrics = structuredClone(metrics);
  },
  applyAiBatchShadeDetections: async (dataSourceId, detections, overwrite) => {
    appliedDetections.push(structuredClone(detections));
    calls.push({ type: "apply", dataSourceId, count: detections.length, overwrite });
    onApply();
    return { ...applyResult };
  },
});

// HEX_DETECTION_SNAP_ENABLED tests swap this for a loader returning a solid-color PNG.
let imageLoader = async () => {
  throw new Error("image loader not configured");
};
let loadedImageUrls = [];
registerMock("../lib/detection-image", {
  loadDetectionImageBytes: async (url) => {
    loadedImageUrls.push(url);
    return imageLoader(url);
  },
});

let downloadedFileIds = [];
let inputImages = new Map();
registerMock("../lib/azure-openai-batch", {
  downloadBatchFileContent: async (fileId) => {
    downloadedFileIds.push(fileId);
    return "{}\n{}\n";
  },
  parseVisionHexBatchInputImages: () => new Map(inputImages),
  getVisionHexBatchStatus: async (batchId) => {
    polledBatchIds.push(batchId);
    onPoll(batchId);
    const status = batchStatusById[batchId] || batchStatus;
    if (status instanceof Error) throw status;
    return { ...status };
  },
  parseVisionHexBatchOutput: () => [{}, {}],
  parseVisionHexBatchDetections: async (_rows, provenance) => {
    parseProvenanceArgs.push(provenance ?? null);
    return [
    {
      customId: "ext-1",
      detection: {
        hex: "#112233",
        finishes: ["creme"],
        confidence: 0.8,
        method: "vision-direct",
        model: provenance?.deployment ?? null,
        promptVersion: provenance?.promptVersion ?? null,
      },
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
      error: null,
    },
    {
      customId: "ext-2",
      detection: null,
      usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
      error: "parse failure",
    },
    ];
  },
});

registerMock("../lib/ingestion-continuation", {
  ...realContinuation,
  enqueueIngestionContinuation: (...args) => {
    calls.push({ type: "enqueue", message: structuredClone(args[0]) });
    return enqueueMock(...args);
  },
});

process.env.HEX_DETECTION_BATCH_ENABLED = "true";
require("../dist/functions/ingestion-ai-batch-poller");

const JOB_ID = 42;

function makeCheckpoint(overrides = {}) {
  return {
    nextPage: 3,
    recordOffset: 0,
    pagesCompleted: 2,
    recordsProcessed: 500,
    continuationCount: 4,
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

function makeResumeMessage(checkpoint = makeCheckpoint()) {
  return {
    jobId: JOB_ID,
    userId: 9,
    queuedAt: "2026-10-14T00:00:00.000Z",
    request: { source: "HoloTacoShopify", exhaustive: true, page: 1, pageSize: 250 },
    requestedMetrics: { requestedBy: 9 },
    checkpoint,
  };
}

function makeAwaitingMetrics({ batchId = "batch-1", resumeMessage, extra = {} } = {}) {
  return {
    pipeline: { status: "running", stage: "awaiting_ai", updatedAt: "2026-10-14T00:00:00.000Z" },
    aiBatch: { batchId, overwriteDetectedHex: false, requestCount: 2, status: "in_progress" },
    [realContinuation.CHECKPOINT_METRICS_KEY]: makeCheckpoint({ continuationCount: 3 }),
    logs: [],
    ...(resumeMessage ? { resumeMessage } : {}),
    ...extra,
  };
}

function seedJob(metrics) {
  dbJob = { jobId: JOB_ID, status: "running", metrics: structuredClone(metrics) };
  awaitingJob = {
    jobId: JOB_ID,
    source: "HoloTacoShopify",
    dataSourceId: 7,
    metrics: structuredClone(metrics),
    startedAt: "2026-10-14T00:00:00.000Z",
  };
}

function makeContext() {
  return { log: () => {}, error: () => {}, warn: () => {} };
}

async function runPoller() {
  const timer = registeredTimers["ingestion-ai-batch-poller"];
  assert.ok(timer, "poller timer should be registered");
  await timer.handler({}, makeContext());
}

beforeEach(() => {
  calls = [];
  parseProvenanceArgs = [];
  appliedDetections = [];
  loadedImageUrls = [];
  downloadedFileIds = [];
  inputImages = new Map();
  delete process.env.HEX_DETECTION_SNAP_ENABLED;
  batchStatus = {
    id: "batch-1",
    status: "completed",
    outputFileId: "file-out-1",
    errorFileId: null,
    requestCounts: { total: 2, completed: 2, failed: 0 },
  };
  applyResult = { processed: 2, applied: 1, appliedHex: 1, skippedNoDetection: 1, noShadeMatch: 0 };
  onApply = () => {};
  onPoll = () => {};
  enqueueMock = async () => {};
  batchStatusById = {};
  polledBatchIds = [];
});

describe("ingestion-ai-batch-poller completed batch", () => {
  it("persists checkpoint + continuation_queued before enqueueing the stored resume message", async () => {
    const resumeMessage = makeResumeMessage();
    seedJob(makeAwaitingMetrics({ resumeMessage }));

    await runPoller();

    const types = calls.map((c) => c.type);
    assert.deepEqual(types, ["apply", "update", "enqueue"]);

    const update = calls[1];
    assert.equal(update.jobId, JOB_ID);
    assert.equal(update.metrics.pipeline.status, "running");
    assert.equal(update.metrics.pipeline.stage, realContinuation.CONTINUATION_QUEUED_STAGE);
    assert.deepEqual(update.metrics.checkpoint, resumeMessage.checkpoint);
    assert.equal(
      Object.prototype.hasOwnProperty.call(update.metrics, realContinuation.RESUME_MESSAGE_METRICS_KEY),
      false,
      "resumeMessage must be consumed"
    );
    assert.equal(update.metrics.aiBatch.status, "completed");
    assert.equal(update.metrics.aiBatch.batchId, "batch-1");
    assert.equal(update.metrics.aiBatchApply.applied, 1);
    assert.equal(update.metrics.aiBatchApply.totalTokens, 165);
    assert.equal(update.metrics.aiBatchesCompleted, 1);
    assert.ok(
      update.metrics.logs.some((entry) => /continuation queued/.test(entry.msg)),
      "a continuation log entry should be appended"
    );

    assert.deepEqual(calls[2].message, resumeMessage);
    assert.equal(dbJob.status, "running", "job must not be marked succeeded");
  });

  it("marks the job succeeded when no resume message is stored", async () => {
    seedJob(makeAwaitingMetrics());

    await runPoller();

    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply", "succeeded"]
    );
    const done = calls[1].metrics;
    assert.equal(done.pipeline.status, "succeeded");
    assert.equal(done.pipeline.stage, "completed");
    assert.equal(typeof done.workerCompletedAt, "string");
    assert.equal(done.aiBatchesCompleted, 1);
    assert.equal(done.aiBatchApplyTotals.applied, 1);
  });

  it("marks the job failed at continuation_enqueue when enqueue throws", async () => {
    seedJob(makeAwaitingMetrics({ resumeMessage: makeResumeMessage() }));
    enqueueMock = async () => {
      throw new Error("queue unavailable");
    };

    await runPoller();

    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply", "update", "enqueue", "failed"]
    );
    const failed = calls[3];
    assert.match(failed.error, /Failed to enqueue continuation/);
    assert.match(failed.error, /queue unavailable/);
    assert.equal(failed.metrics.pipeline.status, "failed");
    assert.equal(failed.metrics.pipeline.stage, "continuation_enqueue");
    assert.equal(failed.metrics.failedStage, "continuation_enqueue");
    assert.equal(dbJob.status, "failed");
  });

  it("does not persist or enqueue when the job stops running during apply", async () => {
    seedJob(makeAwaitingMetrics({ resumeMessage: makeResumeMessage() }));
    onApply = () => {
      dbJob.status = "cancelled";
    };

    await runPoller();

    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply"]
    );
    assert.equal(dbJob.status, "cancelled");
  });

  it("fails instead of completing when the stored resume message is unusable", async () => {
    const resumeMessage = makeResumeMessage();
    delete resumeMessage.checkpoint;
    seedJob(makeAwaitingMetrics({ resumeMessage }));

    await runPoller();

    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply", "failed"]
    );
    assert.match(calls[1].error, /has no checkpoint/);
    assert.equal(calls[1].metrics.failedStage, "continuation_enqueue");
  });

  it("accumulates aiBatchApplyTotals across batches for the same job", async () => {
    seedJob(makeAwaitingMetrics({ resumeMessage: makeResumeMessage() }));
    await runPoller();
    assert.equal(dbJob.status, "running");

    // Simulate the worker resuming, then pausing again for a second batch on the last page.
    const { resumeMessage: _ignored, ...afterFirst } = dbJob.metrics;
    const secondMetrics = {
      ...afterFirst,
      pipeline: { status: "running", stage: "awaiting_ai", updatedAt: "2026-10-14T01:00:00.000Z" },
      aiBatch: { batchId: "batch-2", overwriteDetectedHex: false, requestCount: 2, status: "in_progress" },
    };
    seedJob(secondMetrics);
    calls = [];
    batchStatus = { ...batchStatus, id: "batch-2", outputFileId: "file-out-2" };
    applyResult = { processed: 3, applied: 2, appliedHex: 1, skippedNoDetection: 0, noShadeMatch: 1 };

    await runPoller();

    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply", "succeeded"]
    );
    const done = calls[1].metrics;
    assert.equal(done.aiBatchesCompleted, 2);
    assert.equal(done.aiBatchApply.applied, 2, "aiBatchApply reflects the latest batch only");
    assert.deepEqual(done.aiBatchApplyTotals, {
      processed: 5,
      applied: 3,
      appliedHex: 2,
      skippedNoDetection: 1,
      noShadeMatch: 1,
      outputRows: 4,
      parsedRows: 4,
      parseErrors: 2,
      hexSnapped: 0,
      rowsWithTokenUsage: 4,
      promptTokens: 300,
      completionTokens: 30,
      totalTokens: 330,
    });
  });
});

describe("ingestion-ai-batch-poller — appliedHex in totals written before it existed", () => {
  it("seeds a missing appliedHex from the earlier applied count", async () => {
    seedJob({
      ...makeAwaitingMetrics({}),
      aiBatchApplyTotals: { processed: 6, applied: 5, skippedNoDetection: 1 },
    });
    applyResult = { processed: 2, applied: 2, appliedHex: 1, skippedNoDetection: 0, noShadeMatch: 0 };

    await runPoller();

    const done = calls.find((c) => c.type === "succeeded").metrics;
    assert.equal(done.aiBatchApplyTotals.applied, 7);
    assert.equal(done.aiBatchApplyTotals.appliedHex, 6);
  });
});

function makeMultiBatchMetrics(entries, { resumeMessage } = {}) {
  return {
    pipeline: { status: "running", stage: "awaiting_ai", updatedAt: "2026-10-14T00:00:00.000Z" },
    aiBatch: { batchId: entries[entries.length - 1].batchId, status: "submitted" },
    aiBatches: entries.map((entry) => ({ overwriteDetectedHex: false, requestCount: 2, ...entry })),
    [realContinuation.CHECKPOINT_METRICS_KEY]: makeCheckpoint({ continuationCount: 3 }),
    logs: [],
    ...(resumeMessage ? { resumeMessage } : {}),
  };
}

function completedStatus(id) {
  return {
    id,
    status: "completed",
    outputFileId: `file-out-${id}`,
    errorFileId: null,
    requestCounts: { total: 2, completed: 2, failed: 0 },
  };
}

describe("ingestion-ai-batch-poller with several batches per job", () => {
  it("applies completed batches and keeps waiting while others still run", async () => {
    seedJob(
      makeMultiBatchMetrics([
        { batchId: "batch-1", status: "submitted" },
        { batchId: "batch-2", status: "submitted" },
      ])
    );
    batchStatusById = {
      "batch-1": completedStatus("batch-1"),
      "batch-2": { ...completedStatus("batch-2"), status: "in_progress", outputFileId: null },
    };

    await runPoller();

    assert.deepEqual(polledBatchIds, ["batch-1", "batch-2"]);
    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply", "update", "update"]
    );
    assert.equal(dbJob.status, "running");
    assert.equal(dbJob.metrics.pipeline.stage, "awaiting_ai");
    assert.deepEqual(
      dbJob.metrics.aiBatches.map((b) => [b.batchId, b.status]),
      [
        ["batch-1", "completed"],
        ["batch-2", "in_progress"],
      ]
    );
    assert.equal(dbJob.metrics.aiBatchesCompleted, 1);
  });

  it("does not write progress metrics when the job is cancelled while a batch is applied", async () => {
    seedJob(
      makeMultiBatchMetrics([
        { batchId: "batch-1", status: "submitted" },
        { batchId: "batch-2", status: "submitted" },
      ])
    );
    const before = structuredClone(dbJob.metrics);
    batchStatusById = {
      "batch-1": completedStatus("batch-1"),
      "batch-2": completedStatus("batch-2"),
    };
    onApply = () => {
      dbJob.status = "cancelled";
    };

    await runPoller();

    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply"]
    );
    assert.equal(dbJob.status, "cancelled");
    assert.deepEqual(dbJob.metrics, before);
  });

  it("does not write awaiting_ai metrics when the job is cancelled while batches are polled", async () => {
    seedJob(
      makeMultiBatchMetrics([
        { batchId: "batch-1", status: "submitted" },
        { batchId: "batch-2", status: "submitted" },
      ])
    );
    const before = structuredClone(dbJob.metrics);
    batchStatusById = {
      "batch-1": { ...completedStatus("batch-1"), status: "in_progress", outputFileId: null },
      "batch-2": { ...completedStatus("batch-2"), status: "in_progress", outputFileId: null },
    };
    onPoll = () => {
      dbJob.status = "cancelled";
    };

    await runPoller();

    assert.deepEqual(calls, []);
    assert.deepEqual(dbJob.metrics, before);
  });

  it("does not re-poll applied batches and completes the job when the last one finishes", async () => {
    seedJob(
      makeMultiBatchMetrics([
        { batchId: "batch-1", status: "completed" },
        { batchId: "batch-2", status: "in_progress" },
      ])
    );
    batchStatusById = { "batch-2": completedStatus("batch-2") };

    await runPoller();

    assert.deepEqual(polledBatchIds, ["batch-2"]);
    // The last pending batch goes straight to the final write.
    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply", "succeeded"]
    );
    assert.equal(dbJob.status, "succeeded");
    assert.equal(dbJob.metrics.pipeline.stage, "completed");
    assert.ok(dbJob.metrics.aiBatches.every((b) => b.status === "completed"));
  });

  it("applies every batch that finished in the same poll", async () => {
    seedJob(
      makeMultiBatchMetrics([
        { batchId: "batch-1", status: "submitted" },
        { batchId: "batch-2", status: "submitted" },
        { batchId: "batch-3", status: "submitted" },
      ])
    );
    batchStatusById = {
      "batch-1": completedStatus("batch-1"),
      "batch-2": completedStatus("batch-2"),
      "batch-3": completedStatus("batch-3"),
    };

    await runPoller();

    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply", "update", "apply", "update", "apply", "succeeded"]
    );
    const done = calls[calls.length - 1].metrics;
    assert.equal(done.aiBatchesCompleted, 3);
    assert.equal(done.aiBatchApplyTotals.applied, 3);
  });

  it("enqueues the stored resume message once all batches are applied", async () => {
    const resumeMessage = makeResumeMessage();
    seedJob(
      makeMultiBatchMetrics(
        [
          { batchId: "batch-1", status: "submitted" },
          { batchId: "batch-2", status: "submitted" },
        ],
        { resumeMessage }
      )
    );
    batchStatusById = {
      "batch-1": completedStatus("batch-1"),
      "batch-2": completedStatus("batch-2"),
    };

    await runPoller();

    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply", "update", "apply", "update", "enqueue"]
    );
    assert.equal(dbJob.metrics.pipeline.stage, realContinuation.CONTINUATION_QUEUED_STAGE);
    assert.deepEqual(calls[calls.length - 1].message, resumeMessage);
  });

  it("retries a batch whose status lookup errors instead of failing the job", async () => {
    seedJob(
      makeMultiBatchMetrics([
        { batchId: "batch-1", status: "submitted" },
        { batchId: "batch-2", status: "in_progress" },
      ])
    );
    batchStatusById = {
      "batch-1": completedStatus("batch-1"),
      "batch-2": new Error("Azure OpenAI batch status request timed out"),
    };

    await runPoller();

    assert.deepEqual(polledBatchIds, ["batch-1", "batch-2"]);
    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply", "update", "update"]
    );
    assert.equal(dbJob.status, "running");
    assert.equal(dbJob.metrics.pipeline.stage, "awaiting_ai");
    assert.deepEqual(
      dbJob.metrics.aiBatches.map((b) => [b.batchId, b.status]),
      [
        ["batch-1", "completed"],
        ["batch-2", "in_progress"],
      ],
      "the errored batch keeps its last known status for the next poll"
    );
    assert.ok(dbJob.metrics.logs.some((entry) => /status lookup failed/.test(entry.msg)));
  });

  it("still applies later completed batches when an earlier batch failed", async () => {
    seedJob(
      makeMultiBatchMetrics([
        { batchId: "batch-1", status: "submitted" },
        { batchId: "batch-2", status: "submitted" },
      ])
    );
    batchStatusById = {
      "batch-1": { ...completedStatus("batch-1"), status: "failed", outputFileId: null },
      "batch-2": completedStatus("batch-2"),
    };

    await runPoller();

    assert.deepEqual(polledBatchIds, ["batch-1", "batch-2"]);
    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply", "failed"]
    );
    assert.match(calls[1].error, /batch-1 ended with status failed/);
    assert.equal(dbJob.metrics.aiBatchesCompleted, 1);
    assert.deepEqual(
      dbJob.metrics.aiBatches.map((b) => [b.batchId, b.status]),
      [
        ["batch-1", "failed"],
        ["batch-2", "completed"],
      ]
    );
  });

  it("fails the job for a failure persisted by an earlier poll", async () => {
    seedJob(
      makeMultiBatchMetrics([
        { batchId: "batch-1", status: "failed" },
        { batchId: "batch-2", status: "in_progress" },
      ])
    );
    batchStatusById = { "batch-2": completedStatus("batch-2") };

    await runPoller();

    assert.deepEqual(polledBatchIds, ["batch-2"]);
    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply", "failed"]
    );
    assert.match(calls[1].error, /batch-1 ended with status failed/);
    assert.equal(dbJob.status, "failed");
  });

  it("fails the job when a batch fails, after applying the ones that completed", async () => {
    seedJob(
      makeMultiBatchMetrics([
        { batchId: "batch-1", status: "submitted" },
        { batchId: "batch-2", status: "submitted" },
      ])
    );
    batchStatusById = {
      "batch-1": completedStatus("batch-1"),
      "batch-2": { ...completedStatus("batch-2"), status: "expired", outputFileId: null },
    };

    await runPoller();

    assert.deepEqual(
      calls.map((c) => c.type),
      ["apply", "update", "failed"]
    );
    assert.match(calls[2].error, /batch-2 ended with status expired/);
    assert.equal(dbJob.metrics.failedStage, "awaiting_ai");
    assert.deepEqual(
      dbJob.metrics.aiBatches.map((b) => [b.batchId, b.status]),
      [
        ["batch-1", "completed"],
        ["batch-2", "expired"],
      ]
    );
  });
});

describe("ingestion-ai-batch-poller detected-hex provenance", () => {
  it("passes each batch's submit-time deployment and prompt version through to the shade apply", async () => {
    seedJob(
      makeMultiBatchMetrics([
        { batchId: "batch-1", status: "submitted", deployment: "hex-batch-deploy", promptVersion: "vision-direct/v-test" },
      ])
    );
    batchStatusById = { "batch-1": completedStatus("batch-1") };

    await runPoller();

    assert.deepEqual(parseProvenanceArgs, [
      { deployment: "hex-batch-deploy", promptVersion: "vision-direct/v-test" },
    ]);
    assert.equal(appliedDetections.length, 1);
    const [withHex, withoutHex] = appliedDetections[0];
    assert.deepEqual(withHex.provenance, {
      confidence: 0.8,
      method: "vision-direct",
      model: "hex-batch-deploy",
      promptVersion: "vision-direct/v-test",
    });
    assert.equal(withoutHex.provenance, null);
  });

  it("passes null provenance for legacy single-batch jobs that never recorded it", async () => {
    seedJob(makeAwaitingMetrics());
    await runPoller();
    assert.deepEqual(parseProvenanceArgs, [{ deployment: null, promptVersion: null }]);
  });
});

describe("ingestion-ai-batch-poller job log", () => {
  const runningStatus = (id, status = "in_progress") => ({
    ...completedStatus(id),
    status,
    outputFileId: null,
  });
  const pollerLines = () => dbJob.metrics.logs.filter((entry) => entry.msg.startsWith("[poller]"));

  it("logs a running batch only when its status changes, not on every poll", async () => {
    seedJob(makeMultiBatchMetrics([{ batchId: "batch-1", status: "submitted" }]));
    batchStatusById = { "batch-1": runningStatus("batch-1") };

    await runPoller();
    await runPoller();
    await runPoller();

    const lines = pollerLines();
    assert.equal(lines.length, 1, "three polls of an unchanged batch log one line");
    assert.match(lines[0].msg, /Batch batch-1 is in_progress/);
    assert.equal(lines[0].data.previousStatus, "submitted");

    batchStatusById = { "batch-1": runningStatus("batch-1", "finalizing") };
    await runPoller();
    assert.equal(pollerLines().length, 2);
    assert.match(pollerLines()[1].msg, /finalizing/);
  });

  it("keeps the start of the run when appending to a full job log", async () => {
    const fullLog = Array.from({ length: 500 }, (_, index) => ({
      ts: `2026-10-14T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      level: index === 250 ? "error" : "info",
      msg: `worker line ${index}`,
    }));
    seedJob({
      ...makeMultiBatchMetrics([{ batchId: "batch-1", status: "submitted" }]),
      logs: fullLog,
    });
    batchStatusById = { "batch-1": completedStatus("batch-1") };

    await runPoller();

    const logs = dbJob.metrics.logs;
    assert.equal(logs.length, 500);
    assert.equal(logs[0].msg, "worker line 0", "the first line of the run survives");
    const markers = logs.filter((entry) => entry.omitted);
    assert.equal(markers.length, 1);
    assert.ok(markers[0].omitted.count >= 1);
    assert.match(markers[0].msg, /earlier log line/);
    assert.match(logs[logs.length - 1].msg, /^\[poller\]/, "the newest line is the poller's");
  });
});

describe("ingestion-ai-batch-poller detected-hex snapping (HEX_DETECTION_SNAP_ENABLED)", () => {
  const sharp = require("sharp");
  // The measured palette of a solid #102030 image is one chip; the model's #112233 is close to it.
  const solidPng = () =>
    sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 0x10, g: 0x20, b: 0x30 } } })
      .png()
      .toBuffer();

  function seedSnapJob(extraBatch = {}) {
    const metrics = makeAwaitingMetrics({ resumeMessage: makeResumeMessage() });
    metrics.aiBatch = { ...metrics.aiBatch, inputFileId: "file-in-1", ...extraBatch };
    seedJob(metrics);
  }

  it("leaves detections untouched and never reads the input file while the flag is off", async () => {
    seedSnapJob();
    inputImages = new Map([["ext-1", "https://api.example/api/images/v2.abc"]]);

    await runPoller();

    assert.deepEqual(downloadedFileIds, ["file-out-1"], "only the output file is downloaded");
    assert.deepEqual(loadedImageUrls, []);
    assert.equal(appliedDetections[0][0].detectedHex, "#112233");
    assert.equal(appliedDetections[0][0].provenance.method, "vision-direct");
    assert.equal(calls.find((c) => c.type === "update").metrics.aiBatchApply.hexSnapped, 0);
  });

  it("snaps each detection to the image its batch row was shown and records vision-snap", async () => {
    process.env.HEX_DETECTION_SNAP_ENABLED = "true";
    seedSnapJob();
    inputImages = new Map([["ext-1", "https://api.example/api/images/v2.abc"]]);
    imageLoader = solidPng;

    await runPoller();

    assert.deepEqual(downloadedFileIds, ["file-out-1", "file-in-1"]);
    assert.deepEqual(loadedImageUrls, ["https://api.example/api/images/v2.abc"]);
    const [applied] = appliedDetections[0];
    assert.equal(applied.externalId, "ext-1");
    assert.equal(applied.detectedHex, "#102030", "the measured chip replaces the model hex");
    assert.equal(applied.provenance.method, "vision-snap");
    assert.equal(applied.provenance.confidence, 0.8, "confidence is untouched");
    assert.equal(appliedDetections[0][1].detectedHex, null, "rows without a detection pass through");
    const update = calls.find((c) => c.type === "update");
    assert.equal(update.metrics.aiBatchApply.hexSnapped, 1);
    assert.equal(update.metrics.aiBatchApplyTotals.hexSnapped, 1);
  });

  it("keeps the model hex when the palette has no chip close enough", async () => {
    process.env.HEX_DETECTION_SNAP_ENABLED = "true";
    seedSnapJob();
    inputImages = new Map([["ext-1", "https://api.example/api/images/v2.abc"]]);
    imageLoader = () =>
      sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 0xf4, g: 0xf4, b: 0xf4 } } })
        .png()
        .toBuffer();

    await runPoller();

    const [applied] = appliedDetections[0];
    assert.equal(applied.detectedHex, "#112233");
    assert.equal(applied.provenance.method, "vision-direct");
    assert.equal(calls.find((c) => c.type === "update").metrics.aiBatchApply.hexSnapped, 0);
  });

  it("keeps the model hex when the image cannot be loaded or the batch has no input file", async () => {
    process.env.HEX_DETECTION_SNAP_ENABLED = "true";
    seedSnapJob();
    inputImages = new Map([["ext-1", "https://api.example/api/images/v2.abc"]]);
    imageLoader = async () => {
      throw new Error("blob gone");
    };
    await runPoller();
    assert.equal(appliedDetections[0][0].detectedHex, "#112233");
    assert.equal(appliedDetections[0][0].provenance.method, "vision-direct");
    assert.equal(dbJob.status, "running", "a snap failure never fails the batch");

    calls = [];
    appliedDetections = [];
    downloadedFileIds = [];
    seedSnapJob({ inputFileId: undefined });
    await runPoller();
    assert.deepEqual(downloadedFileIds, ["file-out-1"]);
    assert.equal(appliedDetections[0][0].provenance.method, "vision-direct");
  });
});
