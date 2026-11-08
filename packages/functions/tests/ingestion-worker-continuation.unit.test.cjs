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
// data_source.metadata of the job's source (source kind, image permission, …).
let sourceMetadata = {};
let sourceEnabled = true;
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
  getDataSourceByName: async () => ({ dataSourceId: 3, baseUrl: "https://shop.example", metadata: sourceMetadata, enabled: sourceEnabled, name: "HoloTacoShopify" }),
  upsertExternalProducts: async (_id, records) => ({
    processed: records.length,
    inserted: records.length,
    updated: 0,
    skipped: 0,
  }),
  materializeHoloTacoRecords: async (_dsId, records, options) => {
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
    events.push({ type: "pull", page: options.page, catalogCache: options.catalogCache, deadlineMs: options.deadlineMs });
    // A page may be a function of the pull (a crawling connector answering several pulls of one page).
    const entry = pages[options.page];
    const page = (typeof entry === "function" ? await entry(options) : entry) || { records: [], metadata: {} };
    return { source: this.source, records: page.records, metadata: { ...page.metadata }, ...(page.catalog ? { catalog: page.catalog } : {}) };
  }
}
registerMock("connectors/holo-taco-shopify", { HoloTacoShopifyConnector: FakeConnector });
registerMock("connectors/shopify-generic", { ShopifyGenericConnector: FakeConnector });
registerMock("connectors/open-beauty-facts", { OpenBeautyFactsConnector: FakeConnector });
registerMock("connectors/makeup-api", { MakeupApiConnector: FakeConnector });
registerMock("lib/connector-raw-storage", { saveConnectorRawSnapshot: async () => {} });
// Listing freshness (a complete catalog marks missing listings); recorded, no database.
let freshnessCalls = [];
registerMock("lib/listing-freshness", {
  markExternalProductsMissing: async (_client, dataSourceId, catalog) => {
    freshnessCalls.push({ dataSourceId, catalog });
    events.push({ type: "freshness" });
    return { marked: 0, cleared: 0, skipped: false };
  },
});
registerMock("lib/db", {
  transaction: async (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
  query: async () => ({ rows: [], rowCount: 0 }),
  getPool: () => ({}),
  closePool: async () => {},
});
registerMock("lib/auth", { withAdmin: (handler) => handler });
registerMock("lib/http", { withCors: (handler) => handler });
registerMock("lib/queue-management", { getQueueStats: async () => ({}), purgeQueue: async () => ({}) });

process.env.AzureWebJobsStorage = "UseDevelopmentStorage=true";
process.env.INGESTION_LOG_FLUSH_INTERVAL_MS = "120000";

const {
  processIngestionJobQueueMessage,
  resolveIngestionResumePoint,
} = require("../dist/functions/ingestion");
const { planPoisonedIngestionMessage } = require("../dist/functions/ingestion-worker");
const { readResumeMessageFromMetrics } = require("../dist/lib/ingestion-continuation");
const { ConnectorCheckpointSupersededError } = require("../dist/lib/connectors/types");

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
  freshnessCalls = [];
  job = { status: "queued", metrics: {} };
  fakeNow = 1_000_000;
  Date.now = () => fakeNow;
  sendMessageMock = async () => {};
  materializeMock = async (records) => ({ processed: records.length, hexDetected: records.length });
  sourceMetadata = {};
  sourceEnabled = true;
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

  it("keeps the start of the run and counts omitted lines when a continuation's log is full", async () => {
    pages[1] = { records: makeRecords(1, 34), metadata: {} };
    const resumeAt = checkpoint({ recordOffset: 20, recordsProcessed: 20, continuationCount: 1 });
    const earlierLogs = Array.from({ length: 500 }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 9, 14, 0, 0, i)).toISOString(),
      level: i === 300 ? "warn" : "info",
      msg: `invocation 1 line ${i}`,
    }));
    job = {
      status: "running",
      metrics: {
        pipeline: { status: "running", stage: "continuation_queued" },
        checkpoint: resumeAt,
        logs: earlierLogs,
      },
    };
    const chunkLabels = [];
    materializeMock = async (records, options) => {
      chunkLabels.push(options.chunkLabel);
      return { processed: records.length, hexDetected: records.length };
    };

    await processIngestionJobQueueMessage(makePayload({ checkpoint: resumeAt }), context);

    assert.equal(job.status, "succeeded");
    const logs = job.metrics.logs;
    assert.equal(logs.length, 500, "the stored log stays bounded");
    assert.equal(logs[0].msg, "invocation 1 line 0", "the first invocation's start survives");
    const markers = logs.filter((entry) => entry.omitted);
    assert.equal(markers.length, 1);
    const stored = logs.reduce((total, entry) => total + (entry.omitted ? entry.omitted.count : 1), 0);
    assert.ok(stored > 500, "omitted lines are counted, not dropped silently");
    assert.match(logs.at(-1).msg, /completed successfully/);
    assert.deepEqual(chunkLabels, ["Records 21–30 of 34 on page 1", "Records 31–34 of 34 on page 1"]);
    assert.ok(
      logs.some((entry) => entry.msg === "Records 21–30 of 34 on page 1: upserted 10 external products"),
      "each chunk's upsert is logged under its record range"
    );
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

// ---------------------------------------------------------------------------
// Poison queue
// ---------------------------------------------------------------------------

describe("planPoisonedIngestionMessage", () => {
  const running = (metrics = {}) => ({ status: "running", metrics });

  it("fails a running job whose current message was poisoned", () => {
    assert.equal(planPoisonedIngestionMessage(running(), undefined).action, "fail");
    assert.equal(
      planPoisonedIngestionMessage(
        running({ checkpoint: checkpoint({ continuationCount: 2, recordOffset: 40 }) }),
        checkpoint({ continuationCount: 2 })
      ).action,
      "fail"
    );
  });

  it("fails a queued job whose first message never got to run", () => {
    assert.equal(planPoisonedIngestionMessage({ status: "queued", metrics: {} }, undefined).action, "fail");
  });

  it("ignores a stale duplicate from an older continuation generation", () => {
    const decision = planPoisonedIngestionMessage(
      running({ checkpoint: checkpoint({ continuationCount: 3 }) }),
      checkpoint({ continuationCount: 2 })
    );
    assert.equal(decision.action, "ignore");
    assert.match(decision.reason, /stale continuation 2/);
  });

  it("never touches jobs awaiting AI batches or already finished", () => {
    assert.equal(
      planPoisonedIngestionMessage(running({ pipeline: { stage: "awaiting_ai" } }), undefined).action,
      "ignore"
    );
    for (const status of ["succeeded", "failed", "cancelled"]) {
      assert.equal(planPoisonedIngestionMessage({ status, metrics: {} }, undefined).action, "ignore");
    }
    assert.equal(planPoisonedIngestionMessage(null, undefined).action, "ignore");
  });
});

describe("ingestion-job-poison handler", () => {
  const poisonHandler = () => registeredQueues["ingestion-job-poison"];

  it("listens on the poison queue of the ingestion queue", () => {
    assert.equal(poisonHandler().queueName, "ingestion-jobs-poison");
  });

  it("marks the job failed, keeps its metrics and records the poison stage", async () => {
    const dbCheckpoint = checkpoint({ continuationCount: 1, recordOffset: 25 });
    job = {
      status: "running",
      metrics: { checkpoint: dbCheckpoint, logs: [{ message: "hi" }], pipeline: { status: "running", stage: "materialize" } },
    };

    await poisonHandler().handler(
      JSON.stringify(makePayload({ checkpoint: checkpoint({ continuationCount: 1 }) })),
      context
    );

    assert.equal(job.status, "failed");
    assert.match(job.error, /ingestion-jobs-poison/);
    assert.deepEqual(job.metrics.checkpoint, dbCheckpoint);
    assert.deepEqual(job.metrics.logs, [{ message: "hi" }]);
    assert.equal(job.metrics.pipeline.status, "failed");
    assert.equal(job.metrics.pipeline.stage, "queue_poisoned");
    assert.equal(job.metrics.poisonQueue.lastStage, "materialize");
    assert.equal(job.metrics.poisonQueue.messageContinuationCount, 1);
  });

  it("leaves a job alone when the poisoned message is a stale duplicate", async () => {
    job = { status: "running", metrics: { checkpoint: checkpoint({ continuationCount: 2 }) } };

    await poisonHandler().handler(makePayload({ checkpoint: checkpoint({ continuationCount: 1 }) }), context);

    assert.equal(job.status, "running");
    assert.equal(events.filter((e) => e.type === "failed").length, 0);
  });

  it("leaves a job awaiting AI batches to the poller", async () => {
    job = { status: "running", metrics: { pipeline: { status: "running", stage: "awaiting_ai" } } };

    await poisonHandler().handler(makePayload(), context);

    assert.equal(job.status, "running");
  });
});

// ---------------------------------------------------------------------------
// Source kinds (brand sources plan, Task 3)
// ---------------------------------------------------------------------------

describe("processIngestionJobQueueMessage — source kinds", () => {
  const materializeOptions = async (metadata, request) => {
    sourceMetadata = metadata;
    pages[1] = { records: makeRecords(1, 3), metadata: { hasMore: false } };
    const seen = [];
    materializeMock = async (records, options) => {
      seen.push(options);
      return { processed: records.length };
    };
    await processIngestionJobQueueMessage(makePayload({ request: { source: "MooncatShopify", ...request } }), context);
    assert.ok(seen.length > 0, "expected a materialization call");
    return seen[0];
  };

  it("forces fill-only writes, no images and adoption for a retailer job", async () => {
    const options = await materializeOptions({ kind: "retailer" }, { overwriteDetectedHex: true });
    assert.equal(options.overwriteDetectedHex, false);
    assert.equal(options.storeImages, false);
    assert.equal(options.sourceKind, "retailer");
    assert.equal(options.sourceName, "MooncatShopify");
  });

  it("keeps a permitted retailer's images but still writes fill-only", async () => {
    const options = await materializeOptions(
      { kind: "retailer", imagesPermitted: true },
      { overwriteDetectedHex: true }
    );
    assert.equal(options.overwriteDetectedHex, false);
    assert.equal(options.storeImages, true);
  });

  it("fails the job on an unknown source kind instead of treating it as a brand", async () => {
    sourceMetadata = { kind: "wholesale" };
    pages[1] = { records: makeRecords(1, 3), metadata: { hasMore: false } };
    let materialized = 0;
    materializeMock = async (records) => {
      materialized += 1;
      return { processed: records.length };
    };
    try {
      await processIngestionJobQueueMessage(makePayload({ request: { source: "MooncatShopify" } }), context);
    } catch {
      // The worker may rethrow after marking the job failed.
    }
    assert.equal(materialized, 0);
    const failed = events.find((e) => e.type === "failed");
    assert.ok(failed, "expected the job to be marked failed");
    assert.match(String(failed.error), /Unknown source kind "wholesale"/);
  });

  it("keeps the request's overwrite flag for a brand source", async () => {
    const options = await materializeOptions({}, { overwriteDetectedHex: true });
    assert.equal(options.overwriteDetectedHex, true);
    assert.equal(options.storeImages, true);
    assert.equal(options.sourceKind, "brand");
  });
});

describe("processIngestionJobQueueMessage — disabled source", () => {
  it("fails the job at start with stage source_disabled and never pulls", async () => {
    sourceEnabled = false;
    pages[1] = { records: makeRecords(1, 5), metadata: {} };

    await processIngestionJobQueueMessage(makePayload(), context);

    assert.equal(events.filter((e) => e.type === "pull").length, 0);
    assert.equal(enqueued().length, 0);
    const failed = events.find((e) => e.type === "failed");
    assert.ok(failed, "expected the job to be marked failed");
    assert.equal(failed.error, "Source HoloTacoShopify is disabled; the job was not run");
    assert.equal(failed.metrics.failedStage, "source_disabled");
// ---------------------------------------------------------------------------
// Crawling connectors (sitemap + JSON-LD): partial pulls with catalogComplete === false
// ---------------------------------------------------------------------------

describe("processIngestionJobQueueMessage — partial crawl pulls", () => {
  const partial = (crawledPages, extra = {}) => ({
    records: [],
    metadata: { catalogComplete: false, crawledPages, totalPages: 400, crawlPullEstimateMs: 10000, ...extra },
  });
  const complete = (records) => ({
    records,
    metadata: { catalogComplete: true, crawledPages: 400, totalPages: 400, sourcePageCount: 1 },
    catalog: { externalIds: records.map((record) => record.externalId), complete: true },
  });
  // Answers the pulls of page 1 in order; every pull spends `spendMs` of the clock.
  const sequence = (results, spendMs = 1000) => {
    let call = 0;
    return async () => {
      fakeNow += spendMs;
      return results[Math.min(call++, results.length - 1)];
    };
  };
  const pulls = () => events.filter((e) => e.type === "pull");

  for (const exhaustive of [false, true]) {
    it(`pulls the same page again until the crawl is complete (exhaustive: ${exhaustive})`, async () => {
      pages[1] = sequence([partial(150), partial(300), complete(makeRecords(1, 3))]);

      await processIngestionJobQueueMessage(makePayload({ request: { exhaustive } }), context);

      assert.deepEqual(pulls().map((e) => e.page), [1, 1, 1]);
      assert.deepEqual(materializeCalls(), [["p1-0", "p1-1", "p1-2"]]);
      assert.equal(job.status, "succeeded");
      assert.equal(enqueued().length, 0);
      // Partial pulls never run listing freshness; the complete one does, once.
      assert.equal(freshnessCalls.length, 1);
      assert.deepEqual(freshnessCalls[0].catalog.externalIds, ["p1-0", "p1-1", "p1-2"]);
      assert.ok(events.findIndex((e) => e.type === "freshness") < events.findIndex((e) => e.type === "materialize"));
    });
  }

  it("passes the invocation deadline to every pull", async () => {
    process.env.INGESTION_WORKER_TIME_BUDGET_MS = "60000";
    const startedAt = fakeNow;
    pages[1] = sequence([partial(150), complete(makeRecords(1, 1))]);

    await processIngestionJobQueueMessage(makePayload(), context);

    assert.deepEqual(pulls().map((e) => e.deadlineMs), [startedAt + 60000, startedAt + 60000]);
  });

  it("saves the crawl progress after a partial pull", async () => {
    pages[1] = sequence([partial(150), complete(makeRecords(1, 1))]);

    await processIngestionJobQueueMessage(makePayload(), context);

    const firstPull = events.findIndex((e) => e.type === "pull");
    const saved = events.slice(firstPull).find((e) => e.type === "metrics");
    assert.equal(saved.metrics.crawledPages, 150);
    assert.equal(saved.metrics.catalogComplete, false);
  });

  it("hands off to a continuation at the same page when another pull would not fit the budget", async () => {
    process.env.INGESTION_WORKER_TIME_BUDGET_MS = "60000";
    // 35 s spent + a 30 s pull estimate >= 60 s.
    pages[1] = sequence([partial(150, { crawlPullEstimateMs: 30000 })], 35000);

    await processIngestionJobQueueMessage(makePayload(), context);

    assert.equal(pulls().length, 1);
    assert.equal(materializeCalls().length, 0);
    const messages = enqueued();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].checkpoint.nextPage, 1);
    assert.equal(messages[0].checkpoint.recordOffset, 0);
    assert.equal(messages[0].checkpoint.continuationCount, 1);
    assert.equal(job.status, "running");
    assert.equal(job.metrics.pipeline.stage, "continuation_queued");
  });

  it("runs listing freshness when a continuation's pull completes the crawl, and not again", async () => {
    pages[1] = sequence([complete(makeRecords(1, 2))]);
    const first = makePayload({ checkpoint: checkpoint({ continuationCount: 1 }) });
    job = { status: "running", metrics: { checkpoint: checkpoint({ continuationCount: 1 }) } };

    await processIngestionJobQueueMessage(first, context);
    assert.equal(freshnessCalls.length, 1);

    // A later continuation of the same job carries the freshness totals and skips it.
    freshnessCalls = [];
    events = [];
    pages[1] = sequence([complete(makeRecords(1, 2))]);
    const again = { ...job.metrics.checkpoint, nextPage: 1, recordOffset: 0, continuationCount: 2 };
    assert.equal(job.metrics.workerTotals.persistence.listingsMarkedMissing, 0);
    job = { status: "running", metrics: { ...job.metrics, checkpoint: again } };
    await processIngestionJobQueueMessage(makePayload({ checkpoint: again }), context);
    assert.equal(pulls().length, 1);
    assert.equal(freshnessCalls.length, 0);
  });

  it("logs one warning per page the crawl gave up on and keeps the list out of the job metrics", async () => {
    pages[1] = sequence([
      partial(150, { failedPages: 2, failedThisPull: [{ url: "https://x.example/a", reason: "HTTP 503" }, { url: "https://x.example/b", reason: "HTTP 500" }] }),
      complete(makeRecords(1, 1)),
    ]);

    await processIngestionJobQueueMessage(makePayload(), context);

    const warnings = (job.metrics.logs || []).filter((entry) => /Crawl gave up on a page/.test(entry.msg));
    assert.equal(warnings.length, 2);
    assert.equal(warnings[0].level, "warn");
    assert.match(warnings[0].msg, /https:\/\/x\.example\/a \(HTTP 503\)/);
    assert.equal(job.metrics.failedThisPull, undefined);
    assert.equal(job.metrics.failedPages, 2);
  });

  it("stops after a partial pull when the job was cancelled, without writing or pulling again", async () => {
    pages[1] = async () => {
      job.status = "cancelled";
      return partial(150);
    };

    await processIngestionJobQueueMessage(makePayload({ request: { exhaustive: true } }), context);

    assert.equal(pulls().length, 1);
    assert.equal(job.status, "cancelled");
    const pullIndex = events.findIndex((e) => e.type === "pull");
    assert.ok(!events.slice(pullIndex).some((e) => ["metrics", "enqueue", "succeeded", "failed"].includes(e.type)));
  });

  it("stops without processing or queueing when a newer invocation superseded the crawl checkpoint", async () => {
    pages[1] = async () => {
      throw new ConnectorCheckpointSupersededError("SitemapJsonLd checkpoint superseded");
    };

    await processIngestionJobQueueMessage(makePayload(), context);

    assert.equal(materializeCalls().length, 0);
    assert.equal(enqueued().length, 0);
    assert.equal(job.status, "running");
    const pullIndex = events.findIndex((e) => e.type === "pull");
    assert.ok(!events.slice(pullIndex).some((e) => ["metrics", "succeeded", "failed"].includes(e.type)));
  });
});
