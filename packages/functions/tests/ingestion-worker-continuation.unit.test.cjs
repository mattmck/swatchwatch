const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// Module-level mocking via require interception
// ---------------------------------------------------------------------------

const mockModules = {};
function registerMock(id, exports) {
  mockModules[id] = exports;
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) {
      return key;
    }
  }
  return originalResolve.call(this, request, parent, ...rest);
};

const registeredQueues = {};
registerMock("@azure/functions", {
  app: {
    http: () => {},
    storageQueue: (name, opts) => {
      registeredQueues[name] = opts;
    },
    timer: () => {},
  },
  output: {
    storageQueue: (opts) => ({ __type: "storageQueue", ...opts }),
  },
});

// Ordered log of side effects so tests can assert "persist before enqueue".
let events = [];
let sendMessageMock = async () => {};
registerMock("@azure/storage-queue", {
  QueueServiceClient: {
    fromConnectionString: () => ({
      getQueueClient: () => ({
        createIfNotExists: async () => {},
        sendMessage: async (body) => {
          const message = JSON.parse(Buffer.from(body, "base64").toString("utf8"));
          events.push({ type: "enqueue", message });
          await sendMessageMock(message);
        },
      }),
    }),
  },
});

// In-memory job row; JSON round-trips mimic jsonb (drops undefined keys).
const clone = (value) => JSON.parse(JSON.stringify(value));
let job = null;
const JOB_ID = 7;

let materializeMock = async (records) => ({ processed: records.length, hexDetected: records.length });
registerMock("ingestion-repo", {
  getIngestionJobById: async (jobId) =>
    job && jobId === JOB_ID
      ? { jobId: String(JOB_ID), source: "HoloTacoShopify", jobType: "x", status: job.status, metrics: clone(job.metrics) }
      : null,
  markIngestionJobRunning: async (_id, metrics) => {
    job.status = "running";
    job.metrics = clone(metrics);
    events.push({ type: "running", metrics: clone(metrics) });
  },
  updateIngestionJobMetrics: async (_id, metrics) => {
    job.metrics = clone(metrics);
    events.push({ type: "metrics", metrics: clone(metrics) });
  },
  markIngestionJobSucceeded: async (_id, metrics) => {
    job.status = "succeeded";
    job.metrics = clone(metrics);
    events.push({ type: "succeeded", metrics: clone(metrics) });
  },
  markIngestionJobFailed: async (_id, error, metrics) => {
    job.status = "failed";
    job.error = error;
    job.metrics = clone(metrics);
    events.push({ type: "failed", error, metrics: clone(metrics) });
  },
  getDataSourceByName: async () => ({ dataSourceId: 3, baseUrl: "https://shop.example" }),
  upsertExternalProducts: async (_id, records) => ({
    processed: records.length,
    inserted: records.length,
    updated: 0,
    skipped: 0,
  }),
  materializeHoloTacoRecords: async (_userId, _dsId, records, options) => {
    events.push({ type: "materialize", ids: records.map((r) => r.externalId) });
    return materializeMock(records, options);
  },
  materializeMakeupApiRecords: async () => ({}),
  cancelIngestionJob: async () => {},
  createIngestionJob: async () => ({}),
  ensureDataSourceByName: async () => ({}),
  ensureSupportedShopifyDataSources: async () => {},
  getGlobalSettings: async () => ({}),
  listDataSources: async () => [],
  listDataSourcesWithSettings: async () => [],
  listIngestionJobs: async () => [],
  updateDataSourceSettings: async () => ({}),
  updateGlobalSettings: async () => ({}),
});

// Connector pages keyed by page number.
let pages = {};
class FakeConnector {
  constructor(source) {
    this.source = source;
  }
  async pullProducts(options) {
    events.push({ type: "pull", page: options.page, catalogCache: options.catalogCache });
    const page = pages[options.page] || { records: [], metadata: {} };
    return { source: this.source, records: page.records, metadata: { ...page.metadata } };
  }
}
registerMock("connectors/holo-taco-shopify", { HoloTacoShopifyConnector: FakeConnector });
registerMock("connectors/shopify-generic", { ShopifyGenericConnector: FakeConnector });
registerMock("connectors/open-beauty-facts", { OpenBeautyFactsConnector: FakeConnector });
registerMock("connectors/makeup-api", { MakeupApiConnector: FakeConnector });
registerMock("lib/connector-raw-storage", { saveConnectorRawSnapshot: async () => {} });
registerMock("lib/auth", { withAdmin: (handler) => handler });
registerMock("lib/http", { withCors: (handler) => handler });
registerMock("lib/queue-management", { getQueueStats: async () => ({}), purgeQueue: async () => ({}) });

process.env.AzureWebJobsStorage = "UseDevelopmentStorage=true";
process.env.INGESTION_LOG_FLUSH_INTERVAL_MS = "120000";

const {
  processIngestionJobQueueMessage,
  resolveIngestionResumePoint,
} = require("../dist/functions/ingestion");
require("../dist/functions/ingestion-worker");
const { readResumeMessageFromMetrics } = require("../dist/lib/ingestion-continuation");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const context = { log: () => {}, warn: () => {}, error: () => {} };

function makeRecords(page, count) {
  return Array.from({ length: count }, (_, i) => ({ externalId: `p${page}-${i}` }));
}

function checkpoint(overrides = {}) {
  return {
    nextPage: 1,
    recordOffset: 0,
    pagesCompleted: 0,
    recordsProcessed: 0,
    continuationCount: 0,
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

function makePayload(overrides = {}) {
  const { request, ...rest } = overrides;
  return {
    jobId: JOB_ID,
    userId: 1,
    queuedAt: "2026-10-14T00:00:00.000Z",
    request: {
      source: "HoloTacoShopify",
      searchTerm: "nail polish",
      page: 1,
      pageSize: 100,
      maxRecords: 200,
      materializeToInventory: true,
      detectHexFromImage: true,
      detectHexOnSuspiciousOnly: false,
      overwriteDetectedHex: false,
      collectTrainingData: false,
      exhaustive: false,
      ...(request || {}),
    },
    requestedMetrics: { searchTerm: "nail polish" },
    ...rest,
  };
}

const materializeCalls = () => events.filter((e) => e.type === "materialize").map((e) => e.ids);
const enqueued = () => events.filter((e) => e.type === "enqueue").map((e) => e.message);

// Fake clock so tests can spend the worker's time budget deterministically.
const realDateNow = Date.now;
let fakeNow = 0;

beforeEach(() => {
  events = [];
  pages = {};
  job = { status: "queued", metrics: {} };
  fakeNow = 1_000_000;
  Date.now = () => fakeNow;
  sendMessageMock = async () => {};
  materializeMock = async (records) => ({ processed: records.length, hexDetected: records.length });
  delete process.env.INGESTION_WORKER_TIME_BUDGET_MS;
  delete process.env.HEX_DETECTION_BATCH_ENABLED;
  delete process.env.HEX_DETECTION_BATCH_MAX_IN_FLIGHT;
});

afterEach(() => {
  Date.now = realDateNow;
});

// ---------------------------------------------------------------------------
// Resume rule
// ---------------------------------------------------------------------------

describe("resolveIngestionResumePoint", () => {
  it("starts fresh when neither the message nor the job has a checkpoint", () => {
    assert.deepEqual(resolveIngestionResumePoint(undefined, null), {
      action: "start",
      checkpoint: null,
      source: "fresh",
    });
  });

  it("drops a message whose continuationCount is behind the job's", () => {
    const decision = resolveIngestionResumePoint(
      checkpoint({ continuationCount: 1 }),
      checkpoint({ continuationCount: 2 })
    );
    assert.equal(decision.action, "drop");
  });

  it("treats a message without a checkpoint as generation 0", () => {
    assert.equal(
      resolveIngestionResumePoint(undefined, checkpoint({ continuationCount: 1 })).action,
      "drop"
    );
    const redelivered = resolveIngestionResumePoint(undefined, checkpoint({ recordOffset: 10 }));
    assert.equal(redelivered.action, "start");
    assert.equal(redelivered.source, "database");
    assert.equal(redelivered.checkpoint.recordOffset, 10);
  });

  it("resumes from the further-along checkpoint when generations match (DB wins ties)", () => {
    const dbAhead = resolveIngestionResumePoint(
      checkpoint({ continuationCount: 1, recordOffset: 10 }),
      checkpoint({ continuationCount: 1, recordOffset: 20 })
    );
    assert.equal(dbAhead.source, "database");
    assert.equal(dbAhead.checkpoint.recordOffset, 20);

    const messageAhead = resolveIngestionResumePoint(
      checkpoint({ continuationCount: 1, nextPage: 3 }),
      checkpoint({ continuationCount: 1, nextPage: 2, recordOffset: 50 })
    );
    assert.equal(messageAhead.source, "message");
    assert.equal(messageAhead.checkpoint.nextPage, 3);

    const tie = resolveIngestionResumePoint(checkpoint({ continuationCount: 1 }), checkpoint({ continuationCount: 1 }));
    assert.equal(tie.source, "database");
  });

  it("trusts the message when the job's checkpoint write was lost", () => {
    const decision = resolveIngestionResumePoint(
      checkpoint({ continuationCount: 2, recordOffset: 5 }),
      checkpoint({ continuationCount: 1, recordOffset: 30 })
    );
    assert.equal(decision.source, "message");
    assert.equal(decision.checkpoint.recordOffset, 5);
  });
});

// ---------------------------------------------------------------------------
// Worker behaviour
// ---------------------------------------------------------------------------

describe("processIngestionJobQueueMessage — continuations", () => {
  it("persists a checkpoint after each chunk and hands off when the time budget is spent", async () => {
    process.env.INGESTION_WORKER_TIME_BUDGET_MS = "60000";
    pages[1] = { records: makeRecords(1, 34), metadata: {} };
    // 2s per record -> 20s per 10-record chunk; after two chunks 40s + 20s estimate >= 60s.
    materializeMock = async (records) => {
      fakeNow += records.length * 2000;
      return { processed: records.length, hexDetected: records.length };
    };

    await processIngestionJobQueueMessage(makePayload(), context);

    assert.deepEqual(materializeCalls().map((ids) => [ids[0], ids.length]), [
      ["p1-0", 10],
      ["p1-10", 10],
    ]);

    // Per-chunk checkpoint after the first chunk, still at generation 0.
    const chunkSave = events.find(
      (e) => e.type === "metrics" && e.metrics.checkpoint && e.metrics.checkpoint.recordOffset === 10
    );
    assert.ok(chunkSave, "expected a checkpoint save after the first chunk");
    assert.equal(chunkSave.metrics.checkpoint.continuationCount, 0);

    const messages = enqueued();
    assert.equal(messages.length, 1);
    assert.deepEqual(
      { ...messages[0].checkpoint, updatedAt: undefined },
      {
        nextPage: 1,
        recordOffset: 20,
        pagesCompleted: 0,
        recordsProcessed: 20,
        continuationCount: 1,
        updatedAt: undefined,
      }
    );
    assert.equal(messages[0].jobId, JOB_ID);
    assert.equal(messages[0].request.source, "HoloTacoShopify");

    // The checkpoint + stage were persisted BEFORE the enqueue.
    const enqueueIndex = events.findIndex((e) => e.type === "enqueue");
    const lastSaveBefore = events
      .slice(0, enqueueIndex)
      .filter((e) => e.type === "metrics")
      .pop();
    assert.equal(lastSaveBefore.metrics.pipeline.stage, "continuation_queued");
    assert.equal(lastSaveBefore.metrics.checkpoint.continuationCount, 1);
    assert.equal(lastSaveBefore.metrics.checkpoint.recordOffset, 20);
    assert.ok(!events.slice(enqueueIndex).some((e) => e.type === "metrics"), "no writes after enqueue");

    assert.equal(job.status, "running");
    assert.equal(job.metrics.pipeline.stage, "continuation_queued");
    assert.equal(job.metrics.recordsProcessed, 20);
  });

  it("marks the job failed with a clear stage when the continuation cannot be enqueued", async () => {
    process.env.INGESTION_WORKER_TIME_BUDGET_MS = "30000";
    pages[1] = { records: makeRecords(1, 34), metadata: {} };
    materializeMock = async (records) => {
      fakeNow += 31_000;
      return { processed: records.length };
    };
    sendMessageMock = async () => {
      throw new Error("queue unavailable");
    };

    await processIngestionJobQueueMessage(makePayload(), context);

    assert.equal(job.status, "failed");
    assert.equal(job.metrics.pipeline.stage, "continuation_enqueue");
    assert.match(job.error, /queue unavailable/);
  });

  it("resumes mid-page and keeps cumulative totals, carried poller metrics and logs", async () => {
    pages[1] = { records: makeRecords(1, 34), metadata: {} };
    const resumeAt = checkpoint({ recordOffset: 20, recordsProcessed: 20, continuationCount: 1 });
    job = {
      status: "running",
      metrics: {
        searchTerm: "nail polish",
        pipeline: { status: "running", stage: "continuation_queued" },
        checkpoint: resumeAt,
        workerTotals: {
          persistence: { processed: 20, inserted: 20, updated: 0, skipped: 0 },
          materialization: { processed: 20, hexDetected: 20 },
        },
        recordsProcessed: 20,
        aiBatchApplyTotals: { processed: 15, applied: 12 },
        aiBatchesCompleted: 2,
        logs: [{ ts: "2026-10-14T00:00:00.000Z", level: "info", msg: "first invocation log" }],
      },
    };

    await processIngestionJobQueueMessage(makePayload({ checkpoint: resumeAt }), context);

    assert.deepEqual(materializeCalls().map((ids) => [ids[0], ids.length]), [
      ["p1-20", 10],
      ["p1-30", 4],
    ]);
    assert.equal(enqueued().length, 0);
    assert.equal(job.status, "succeeded");
    assert.equal(job.metrics.recordsProcessed, 34);
    assert.equal(job.metrics.inserted, 34);
    assert.equal(job.metrics.hexDetected, 34);
    assert.deepEqual(job.metrics.aiBatchApplyTotals, { processed: 15, applied: 12 });
    assert.equal(job.metrics.aiBatchesCompleted, 2);
    assert.equal(job.metrics.resumeMessage, undefined);
    assert.ok(job.metrics.logs.some((entry) => entry.msg === "first invocation log"));
  });

  it("preserves poller metrics on the running write that starts a continuation", async () => {
    pages[2] = { records: makeRecords(2, 3), metadata: { hasMore: false } };
    const resumeAt = checkpoint({ nextPage: 2, pagesCompleted: 1, recordsProcessed: 30, continuationCount: 1 });
    job = {
      status: "running",
      metrics: {
        checkpoint: resumeAt,
        aiBatchApplyTotals: { applied: 30 },
        aiBatchesCompleted: 1,
        pipeline: { status: "running", stage: "continuation_queued" },
      },
    };

    await processIngestionJobQueueMessage(
      makePayload({ checkpoint: resumeAt, request: { exhaustive: true } }),
      context
    );

    const runningWrite = events.find((e) => e.type === "running");
    assert.deepEqual(runningWrite.metrics.aiBatchApplyTotals, { applied: 30 });
    assert.equal(runningWrite.metrics.aiBatchesCompleted, 1);
    assert.deepEqual(events.filter((e) => e.type === "pull").map((e) => e.page), [2]);
    assert.equal(job.status, "succeeded");
    assert.equal(job.metrics.pagesFetched, 2);
    assert.equal(job.metrics.recordsProcessed, 33);
    assert.deepEqual(job.metrics.aiBatchApplyTotals, { applied: 30 });
  });

  it("drops a stale message without touching the job", async () => {
    pages[1] = { records: makeRecords(1, 34), metadata: {} };
    job = {
      status: "running",
      metrics: { checkpoint: checkpoint({ recordOffset: 20, continuationCount: 2 }) },
    };
    const before = clone(job);

    await processIngestionJobQueueMessage(
      makePayload({ checkpoint: checkpoint({ recordOffset: 10, continuationCount: 1 }) }),
      context
    );

    assert.deepEqual(events, []);
    assert.deepEqual(job, before);
  });

  it("resumes a redelivered current message from the further-along DB checkpoint", async () => {
    pages[1] = { records: makeRecords(1, 34), metadata: {} };
    job = {
      status: "running",
      metrics: {
        pipeline: { status: "running", stage: "materialize_inventory" },
        checkpoint: checkpoint({ recordOffset: 30, recordsProcessed: 30, continuationCount: 1 }),
      },
    };

    await processIngestionJobQueueMessage(
      makePayload({ checkpoint: checkpoint({ recordOffset: 10, recordsProcessed: 10, continuationCount: 1 }) }),
      context
    );

    assert.deepEqual(materializeCalls().map((ids) => ids[0]), ["p1-30"]);
    assert.equal(job.status, "succeeded");
    assert.equal(job.metrics.recordsProcessed, 34);
  });

  it("resumes a redelivered first message from the job's generation-0 checkpoint", async () => {
    pages[1] = { records: makeRecords(1, 34), metadata: {} };
    job = {
      status: "running",
      metrics: { checkpoint: checkpoint({ recordOffset: 10, recordsProcessed: 10 }) },
    };

    await processIngestionJobQueueMessage(makePayload(), context);

    assert.deepEqual(materializeCalls().map((ids) => ids[0]), ["p1-10", "p1-20", "p1-30"]);
    assert.equal(job.status, "succeeded");
  });

  it("stops when a duplicate worker of the same generation saved a later checkpoint", async () => {
    pages[1] = { records: makeRecords(1, 34), metadata: {} };
    materializeMock = async (records) => {
      // Another delivery of the same message got further while this chunk ran.
      job.metrics = {
        ...job.metrics,
        checkpoint: checkpoint({ recordOffset: 30, recordsProcessed: 30, continuationCount: 0 }),
      };
      return { processed: records.length };
    };

    await processIngestionJobQueueMessage(makePayload(), context);

    assert.equal(materializeCalls().length, 1);
    assert.equal(job.metrics.checkpoint.recordOffset, 30, "the further-along checkpoint is not regressed");
    const firstMaterialize = events.findIndex((e) => e.type === "materialize");
    assert.ok(!events.slice(firstMaterialize).some((e) => e.type === "metrics"), "no writes after losing ownership");
  });

  it("stops between chunks when the job is cancelled, without overwriting its status", async () => {
    pages[1] = { records: makeRecords(1, 34), metadata: {} };
    materializeMock = async (records) => {
      job.status = "cancelled";
      return { processed: records.length };
    };

    await processIngestionJobQueueMessage(makePayload(), context);

    assert.equal(materializeCalls().length, 1);
    assert.equal(job.status, "cancelled");
    assert.ok(!events.some((e) => e.type === "succeeded" || e.type === "failed"));
    const cancelIndex = events.findIndex((e) => e.type === "materialize");
    assert.ok(!events.slice(cancelIndex).some((e) => e.type === "metrics"), "no writes after cancel");
  });

  it("keeps ingesting while AI batches run, then waits for all of them", async () => {
    process.env.HEX_DETECTION_BATCH_ENABLED = "true";
    pages[1] = { records: makeRecords(1, 100), metadata: {} };
    pages[2] = { records: makeRecords(2, 20), metadata: {} };
    let batchNumber = 0;
    materializeMock = async (records) => ({
      processed: records.length,
      aiBatch: { batchId: `batch-${++batchNumber}`, status: "submitted", requestCount: records.length },
    });

    await processIngestionJobQueueMessage(
      makePayload({ request: { exhaustive: true, pageSize: 100 } }),
      context
    );

    // Every chunk is materialized in this invocation; no pause between batches.
    assert.deepEqual(materializeCalls().map((ids) => ids.length), [50, 50, 20]);
    assert.equal(enqueued().length, 0);
    assert.equal(job.status, "running");
    assert.equal(job.metrics.pipeline.stage, "awaiting_ai");
    assert.equal(job.metrics.resumeMessage, undefined, "no work remains once batches finish");
    assert.deepEqual(
      job.metrics.aiBatches.map((b) => [b.batchId, b.status, b.requestCount]),
      [
        ["batch-1", "submitted", 50],
        ["batch-2", "submitted", 50],
        ["batch-3", "submitted", 20],
      ]
    );
    assert.equal(job.metrics.recordsProcessed, 120);
  });

  it("completes normally when no chunk submitted a batch", async () => {
    process.env.HEX_DETECTION_BATCH_ENABLED = "true";
    pages[1] = { records: makeRecords(1, 60), metadata: {} };
    materializeMock = async (records) => ({ processed: records.length, hexDetectionSkippedUnchanged: records.length });

    await processIngestionJobQueueMessage(makePayload({ request: { pageSize: 100 } }), context);

    assert.equal(job.status, "succeeded");
    assert.equal(job.metrics.pipeline.stage, "completed");
  });

  it("pauses with a resume message once the in-flight batch cap is reached", async () => {
    process.env.HEX_DETECTION_BATCH_ENABLED = "true";
    process.env.HEX_DETECTION_BATCH_MAX_IN_FLIGHT = "2";
    pages[1] = { records: makeRecords(1, 100), metadata: {} };
    pages[2] = { records: makeRecords(2, 100), metadata: {} };
    let batchNumber = 0;
    materializeMock = async (records) => ({
      processed: records.length,
      aiBatch: { batchId: `batch-${++batchNumber}`, status: "submitted", requestCount: records.length },
    });

    await processIngestionJobQueueMessage(
      makePayload({ request: { exhaustive: true, pageSize: 100 } }),
      context
    );

    assert.deepEqual(materializeCalls().map((ids) => ids.length), [50, 50]);
    assert.equal(job.metrics.pipeline.stage, "awaiting_ai");
    assert.equal(job.metrics.aiBatches.length, 2);
    const resumeMessage = readResumeMessageFromMetrics(job.metrics);
    assert.ok(resumeMessage, "the poller needs a resume message to continue the job");
    assert.equal(resumeMessage.checkpoint.nextPage, 2);
    assert.equal(resumeMessage.checkpoint.recordOffset, 0);
  });

  it("counts only pending batches toward the cap on a continuation", async () => {
    process.env.HEX_DETECTION_BATCH_ENABLED = "true";
    process.env.HEX_DETECTION_BATCH_MAX_IN_FLIGHT = "2";
    pages[2] = { records: makeRecords(2, 100), metadata: { hasMore: false } };
    const cp = checkpoint({ nextPage: 2, pagesCompleted: 1, recordsProcessed: 100, continuationCount: 1 });
    job = {
      status: "running",
      metrics: {
        checkpoint: cp,
        aiBatches: [
          { batchId: "batch-1", status: "completed", overwriteDetectedHex: false },
          { batchId: "batch-2", status: "completed", overwriteDetectedHex: false },
        ],
      },
    };
    let batchNumber = 2;
    materializeMock = async (records) => ({
      processed: records.length,
      aiBatch: { batchId: `batch-${++batchNumber}`, status: "submitted", requestCount: records.length },
    });

    await processIngestionJobQueueMessage(
      makePayload({ checkpoint: cp, request: { exhaustive: true, pageSize: 100 } }),
      context
    );

    assert.deepEqual(materializeCalls().map((ids) => ids.length), [50, 50]);
    assert.equal(job.metrics.pipeline.stage, "awaiting_ai");
    assert.equal(job.metrics.resumeMessage, undefined);
    assert.deepEqual(
      job.metrics.aiBatches.map((b) => [b.batchId, b.status]),
      [
        ["batch-1", "completed"],
        ["batch-2", "completed"],
        ["batch-3", "submitted"],
        ["batch-4", "submitted"],
      ]
    );
  });

  it("stores a resumeMessage for the next page when pausing for an AI batch", async () => {
    process.env.HEX_DETECTION_BATCH_ENABLED = "true";
    process.env.HEX_DETECTION_BATCH_MAX_IN_FLIGHT = "1";
    pages[1] = { records: makeRecords(1, 30), metadata: {} };
    materializeMock = async (records) => ({
      processed: records.length,
      batchRequestsQueued: records.length,
      aiBatch: { batchId: "batch-1", status: "submitted", requestCount: records.length },
    });

    const payload = makePayload({ request: { exhaustive: true, pageSize: 30 } });
    await processIngestionJobQueueMessage(payload, context);

    // Batch mode processes up to INGESTION_BATCH_CHUNK_SIZE (50) records as one unit.
    assert.deepEqual(materializeCalls().map((ids) => ids.length), [30]);
    assert.equal(enqueued().length, 0);
    assert.equal(job.status, "running");
    assert.equal(job.metrics.pipeline.stage, "awaiting_ai");
    assert.equal(job.metrics.checkpoint.nextPage, 2);
    assert.equal(job.metrics.checkpoint.continuationCount, 0);

    const resumeMessage = readResumeMessageFromMetrics(job.metrics);
    assert.ok(resumeMessage, "resumeMessage should parse with the shared contract reader");
    assert.equal(resumeMessage.jobId, JOB_ID);
    assert.deepEqual(resumeMessage.request, payload.request);
    assert.deepEqual(
      { ...resumeMessage.checkpoint, updatedAt: undefined },
      {
        nextPage: 2,
        recordOffset: 0,
        pagesCompleted: 1,
        recordsProcessed: 30,
        continuationCount: 1,
        updatedAt: undefined,
      }
    );
  });

  it("caps batch-mode chunks at 50 records so a sync fallback stays bounded", async () => {
    process.env.HEX_DETECTION_BATCH_ENABLED = "true";
    pages[1] = { records: makeRecords(1, 100), metadata: {} };
    materializeMock = async (records) => ({ processed: records.length });

    await processIngestionJobQueueMessage(makePayload({ request: { pageSize: 100 } }), context);

    assert.deepEqual(materializeCalls().map((ids) => ids.length), [50, 50]);
    assert.equal(job.status, "succeeded");
  });

  it("switches to synchronous chunks for the rest of the job after a batch fallback", async () => {
    process.env.HEX_DETECTION_BATCH_ENABLED = "true";
    pages[1] = { records: makeRecords(1, 80), metadata: {} };
    const batchFlags = [];
    materializeMock = async (records, options) => {
      batchFlags.push(options.useBatchForHexDetection);
      // The first (batch-sized) chunk hits the enqueued-token limit and falls back.
      return { processed: records.length, batchFallbacks: batchFlags.length === 1 ? 1 : 0 };
    };

    await processIngestionJobQueueMessage(makePayload({ request: { pageSize: 100 } }), context);

    assert.deepEqual(materializeCalls().map((ids) => ids.length), [50, 10, 10, 10]);
    assert.deepEqual(batchFlags, [true, false, false, false]);
    assert.equal(job.metrics.hexBatchDegraded, true);
    assert.equal(job.status, "succeeded");
  });

  it("keeps synchronous chunks on a continuation of a job whose batch already failed", async () => {
    process.env.HEX_DETECTION_BATCH_ENABLED = "true";
    pages[1] = { records: makeRecords(1, 40), metadata: {} };
    const cp = checkpoint({ recordOffset: 20, recordsProcessed: 20, continuationCount: 1 });
    job = { status: "running", metrics: { checkpoint: cp, hexBatchDegraded: true } };
    const batchFlags = [];
    materializeMock = async (records, options) => {
      batchFlags.push(options.useBatchForHexDetection);
      return { processed: records.length };
    };

    await processIngestionJobQueueMessage(makePayload({ checkpoint: cp }), context);

    assert.deepEqual(materializeCalls().map((ids) => ids.length), [10, 10]);
    assert.deepEqual(batchFlags, [false, false]);
  });

  it("omits the resumeMessage when the paused unit was the last one", async () => {
    process.env.HEX_DETECTION_BATCH_ENABLED = "true";
    pages[1] = { records: makeRecords(1, 30), metadata: { hasMore: false } };
    materializeMock = async (records) => ({
      processed: records.length,
      aiBatch: { batchId: "batch-1", status: "submitted", requestCount: records.length },
    });

    await processIngestionJobQueueMessage(makePayload({ request: { exhaustive: true } }), context);
    assert.equal(job.metrics.pipeline.stage, "awaiting_ai");
    assert.equal(job.metrics.resumeMessage, undefined);

    // Non-exhaustive single-page runs are also final after their last chunk.
    events = [];
    job = { status: "queued", metrics: {} };
    await processIngestionJobQueueMessage(makePayload(), context);
    assert.equal(job.metrics.pipeline.stage, "awaiting_ai");
    assert.equal(job.metrics.resumeMessage, undefined);
  });

  it("ignores messages while the job is awaiting an AI batch", async () => {
    job = {
      status: "running",
      metrics: { pipeline: { status: "running", stage: "awaiting_ai" } },
    };
    await processIngestionJobQueueMessage(makePayload({ checkpoint: checkpoint({ continuationCount: 1 }) }), context);
    assert.deepEqual(events, []);
  });
});

describe("ingestion-worker — checkpoint payload validation", () => {
  it("marks the job failed when the checkpoint is malformed", async () => {
    job = { status: "running", metrics: {} };
    const handler = registeredQueues["ingestion-job-worker"].handler;
    const payload = makePayload({ checkpoint: { nextPage: 0, recordOffset: -1 } });

    await handler(payload, context);

    assert.equal(job.status, "failed");
    assert.match(job.error, /checkpoint is invalid/);
    assert.equal(materializeCalls().length, 0);
  });

  it("passes a valid checkpoint through to the worker", async () => {
    pages[1] = { records: makeRecords(1, 34), metadata: {} };
    job = { status: "running", metrics: { checkpoint: checkpoint({ continuationCount: 1 }) } };
    const handler = registeredQueues["ingestion-job-worker"].handler;

    await handler(
      makePayload({ checkpoint: checkpoint({ recordOffset: 30, recordsProcessed: 30, continuationCount: 1 }) }),
      context
    );

    assert.deepEqual(materializeCalls().map((ids) => ids[0]), ["p1-30"]);
    assert.equal(job.status, "succeeded");
  });

  it("hands every page pull the same per-job catalog cache", async () => {
    pages[1] = { records: makeRecords(1, 2), metadata: { sourcePageCount: 2 } };
    pages[2] = { records: makeRecords(2, 2), metadata: { sourcePageCount: 2 } };
    const handler = registeredQueues["ingestion-job-worker"].handler;

    await handler(makePayload({ request: { exhaustive: true } }), context);

    const caches = events.filter((e) => e.type === "pull").map((e) => e.catalogCache);
    assert.equal(caches.length, 2);
    assert.ok(caches[0] && typeof caches[0].load === "function");
    assert.equal(caches[0], caches[1]);
  });

  it("passes detectHexOnSuspiciousOnly from the payload through to materialization", async () => {
    pages[1] = { records: makeRecords(1, 3), metadata: {} };
    const seenOptions = [];
    materializeMock = async (records, options) => {
      seenOptions.push(options.detectHexOnSuspiciousOnly);
      return { processed: records.length };
    };
    const handler = registeredQueues["ingestion-job-worker"].handler;

    await handler(makePayload({ request: { detectHexOnSuspiciousOnly: true } }), context);

    assert.deepEqual(seenOptions, [true]);
  });

  it("rejects a non-boolean detectHexOnSuspiciousOnly as an invalid payload", async () => {
    job = { status: "running", metrics: {} };
    const handler = registeredQueues["ingestion-job-worker"].handler;

    await handler(makePayload({ request: { detectHexOnSuspiciousOnly: "sometimes" } }), context);

    assert.equal(job.status, "failed");
    assert.equal(materializeCalls().length, 0);
  });
});
