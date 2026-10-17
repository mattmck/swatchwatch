const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// Mock @azure/storage-queue via require interception before loading the module
// ---------------------------------------------------------------------------

const queueCalls = [];
const STORAGE_QUEUE_ID = "@azure/storage-queue";
const storageQueueMock = {
  QueueServiceClient: {
    fromConnectionString: (connectionString) => {
      queueCalls.push({ type: "fromConnectionString", connectionString });
      return {
        getQueueClient: (queueName) => {
          queueCalls.push({ type: "getQueueClient", queueName });
          return {
            createIfNotExists: async () => {
              queueCalls.push({ type: "createIfNotExists" });
            },
            sendMessage: async (body) => {
              queueCalls.push({ type: "sendMessage", body });
            },
          };
        },
      };
    },
  },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === STORAGE_QUEUE_ID) {
    return STORAGE_QUEUE_ID;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
require.cache[STORAGE_QUEUE_ID] = {
  id: STORAGE_QUEUE_ID,
  filename: STORAGE_QUEUE_ID,
  loaded: true,
  exports: storageQueueMock,
};

delete process.env.INGESTION_JOB_QUEUE_NAME;
const {
  CHECKPOINT_METRICS_KEY,
  RESUME_MESSAGE_METRICS_KEY,
  CONTINUATION_QUEUED_STAGE,
  INGESTION_JOB_QUEUE_NAME,
  parseIngestionCheckpoint,
  readCheckpointFromMetrics,
  readResumeMessageFromMetrics,
  getWorkerTimeBudgetMs,
  enqueueIngestionContinuation,
} = require("../dist/lib/ingestion-continuation");

function validCheckpoint(overrides = {}) {
  return {
    nextPage: 2,
    recordOffset: 10,
    pagesCompleted: 1,
    recordsProcessed: 260,
    continuationCount: 1,
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

function validMessage(overrides = {}) {
  return {
    jobId: 5,
    userId: 1,
    queuedAt: "2026-10-14T00:00:00.000Z",
    request: { source: "HoloTacoShopify", exhaustive: true },
    requestedMetrics: { a: 1 },
    checkpoint: validCheckpoint(),
    ...overrides,
  };
}

describe("ingestion-continuation constants", () => {
  it("exposes the agreed metrics keys and stage", () => {
    assert.equal(CHECKPOINT_METRICS_KEY, "checkpoint");
    assert.equal(RESUME_MESSAGE_METRICS_KEY, "resumeMessage");
    assert.equal(CONTINUATION_QUEUED_STAGE, "continuation_queued");
    assert.equal(INGESTION_JOB_QUEUE_NAME, "ingestion-jobs");
  });
});

describe("parseIngestionCheckpoint", () => {
  it("returns a normalized checkpoint for valid input and drops unknown keys", () => {
    const parsed = parseIngestionCheckpoint({ ...validCheckpoint(), extra: "ignored" });
    assert.deepEqual(parsed, validCheckpoint());
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, 5, "x", [validCheckpoint()]]) {
      assert.equal(parseIngestionCheckpoint(value), null);
    }
  });

  it("rejects nextPage below 1", () => {
    assert.equal(parseIngestionCheckpoint(validCheckpoint({ nextPage: 0 })), null);
  });

  it("rejects negative, fractional, or non-numeric counters", () => {
    assert.equal(parseIngestionCheckpoint(validCheckpoint({ recordOffset: -1 })), null);
    assert.equal(parseIngestionCheckpoint(validCheckpoint({ pagesCompleted: 1.5 })), null);
    assert.equal(parseIngestionCheckpoint(validCheckpoint({ recordsProcessed: "3" })), null);
    assert.equal(parseIngestionCheckpoint(validCheckpoint({ continuationCount: NaN })), null);
  });

  it("rejects a missing updatedAt", () => {
    assert.equal(parseIngestionCheckpoint(validCheckpoint({ updatedAt: undefined })), null);
  });
});

describe("readCheckpointFromMetrics", () => {
  it("reads the checkpoint key", () => {
    assert.deepEqual(readCheckpointFromMetrics({ checkpoint: validCheckpoint() }), validCheckpoint());
  });

  it("returns null for missing metrics or malformed checkpoints", () => {
    assert.equal(readCheckpointFromMetrics(null), null);
    assert.equal(readCheckpointFromMetrics(undefined), null);
    assert.equal(readCheckpointFromMetrics({}), null);
    assert.equal(readCheckpointFromMetrics({ checkpoint: { nextPage: 1 } }), null);
  });
});

describe("readResumeMessageFromMetrics", () => {
  it("rejects non-positive jobId or userId, matching the worker's payload validation", () => {
    assert.equal(readResumeMessageFromMetrics({ resumeMessage: { ...validMessage(), jobId: 0 } }), null);
    assert.equal(readResumeMessageFromMetrics({ resumeMessage: { ...validMessage(), userId: 0 } }), null);
  });

  it("returns the stored message with a parsed checkpoint", () => {
    assert.deepEqual(readResumeMessageFromMetrics({ resumeMessage: validMessage() }), validMessage());
  });

  it("allows a message without a checkpoint", () => {
    const { checkpoint: _unused, ...message } = validMessage();
    const parsed = readResumeMessageFromMetrics({ resumeMessage: message });
    assert.deepEqual(parsed, message);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, "checkpoint"), false);
  });

  it("returns null when absent", () => {
    assert.equal(readResumeMessageFromMetrics({}), null);
    assert.equal(readResumeMessageFromMetrics(null), null);
  });

  it("returns null when required fields are malformed", () => {
    assert.equal(readResumeMessageFromMetrics({ resumeMessage: validMessage({ jobId: "5" }) }), null);
    assert.equal(readResumeMessageFromMetrics({ resumeMessage: validMessage({ userId: -1 }) }), null);
    assert.equal(readResumeMessageFromMetrics({ resumeMessage: validMessage({ queuedAt: 1 }) }), null);
    assert.equal(readResumeMessageFromMetrics({ resumeMessage: validMessage({ request: null }) }), null);
    assert.equal(
      readResumeMessageFromMetrics({ resumeMessage: validMessage({ requestedMetrics: [] }) }),
      null
    );
  });

  it("returns null when the checkpoint is present but malformed", () => {
    assert.equal(
      readResumeMessageFromMetrics({
        resumeMessage: validMessage({ checkpoint: validCheckpoint({ nextPage: 0 }) }),
      }),
      null
    );
  });
});

describe("getWorkerTimeBudgetMs", () => {
  let saved;
  beforeEach(() => {
    saved = process.env.INGESTION_WORKER_TIME_BUDGET_MS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.INGESTION_WORKER_TIME_BUDGET_MS;
    else process.env.INGESTION_WORKER_TIME_BUDGET_MS = saved;
  });

  it("defaults to 240000 when unset or non-numeric", () => {
    delete process.env.INGESTION_WORKER_TIME_BUDGET_MS;
    assert.equal(getWorkerTimeBudgetMs(), 240_000);
    process.env.INGESTION_WORKER_TIME_BUDGET_MS = "abc";
    assert.equal(getWorkerTimeBudgetMs(), 240_000);
  });

  it("uses in-range values as-is", () => {
    process.env.INGESTION_WORKER_TIME_BUDGET_MS = "120000";
    assert.equal(getWorkerTimeBudgetMs(), 120_000);
  });

  it("clamps to [30000, 270000]", () => {
    process.env.INGESTION_WORKER_TIME_BUDGET_MS = "1000";
    assert.equal(getWorkerTimeBudgetMs(), 30_000);
    process.env.INGESTION_WORKER_TIME_BUDGET_MS = "999999";
    assert.equal(getWorkerTimeBudgetMs(), 270_000);
  });
});

describe("enqueueIngestionContinuation", () => {
  let saved;
  beforeEach(() => {
    saved = process.env.AzureWebJobsStorage;
    queueCalls.length = 0;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AzureWebJobsStorage;
    else process.env.AzureWebJobsStorage = saved;
  });

  it("sends the message as base64-encoded JSON to the ingestion queue", async () => {
    process.env.AzureWebJobsStorage = "UseDevelopmentStorage=true";
    const message = validMessage();

    await enqueueIngestionContinuation(message);

    assert.deepEqual(
      queueCalls.map((c) => c.type),
      ["fromConnectionString", "getQueueClient", "createIfNotExists", "sendMessage"]
    );
    assert.equal(queueCalls[0].connectionString, "UseDevelopmentStorage=true");
    assert.equal(queueCalls[1].queueName, "ingestion-jobs");
    const body = queueCalls[3].body;
    assert.match(body, /^[A-Za-z0-9+/]+=*$/, "body should be base64");
    assert.deepEqual(JSON.parse(Buffer.from(body, "base64").toString("utf8")), message);
  });

  it("throws a clear error when AzureWebJobsStorage is not configured", async () => {
    delete process.env.AzureWebJobsStorage;
    await assert.rejects(
      () => enqueueIngestionContinuation(validMessage()),
      /AzureWebJobsStorage environment variable not configured/
    );
    assert.equal(queueCalls.length, 0);
  });
});
