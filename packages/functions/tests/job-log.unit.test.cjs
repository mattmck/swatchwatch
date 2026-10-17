const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// JobLogger flushes through ingestion-repo; record those writes instead of hitting Postgres.
let metricWrites = [];
const repoPath = path.resolve(__dirname, "../dist/lib/ingestion-repo.js");
require.cache[repoPath] = {
  id: repoPath,
  filename: repoPath,
  loaded: true,
  exports: {
    updateIngestionJobMetrics: async (jobId, metrics) => {
      metricWrites.push({ jobId, metrics: JSON.parse(JSON.stringify(metrics)) });
    },
  },
};

const {
  appendJobLogEntries,
  compactJobLog,
  countJobLogLines,
  createJobLogEntry,
  getJobLogMaxEntries,
  resolveJobLogLimits,
  sanitizeJobLog,
} = require("../dist/lib/job-log");
const { JobLogger } = require("../dist/lib/job-logger");

function lines(count, { start = 0, level = () => "info" } = {}) {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    return {
      ts: new Date(Date.UTC(2026, 9, 14, 0, 0, index)).toISOString(),
      level: level(index),
      msg: `line ${index}`,
    };
  });
}

const limits = { maxEntries: 10, headEntries: 3 };

describe("compactJobLog", () => {
  it("leaves a log within the cap untouched", () => {
    const log = lines(10);
    assert.deepEqual(compactJobLog(log, limits), log);
  });

  it("keeps the head and the newest lines with one marker counting the rest", () => {
    const compacted = compactJobLog(lines(25), limits);

    assert.equal(compacted.length, 10);
    assert.deepEqual(
      compacted.slice(0, 3).map((entry) => entry.msg),
      ["line 0", "line 1", "line 2"]
    );
    const marker = compacted[3];
    assert.equal(marker.omitted.count, 16);
    assert.equal(marker.omitted.firstTs, lines(1, { start: 3 })[0].ts);
    assert.equal(marker.omitted.lastTs, lines(1, { start: 18 })[0].ts);
    assert.match(marker.msg, /16 earlier log lines omitted/);
    assert.deepEqual(
      compacted.slice(4).map((entry) => entry.msg),
      ["line 19", "line 20", "line 21", "line 22", "line 23", "line 24"]
    );
    assert.equal(countJobLogLines(compacted), 25, "no line is lost from the count");
  });

  it("grows the same marker on later compactions and keeps the head fixed", () => {
    let log = compactJobLog(lines(25), limits);
    log = compactJobLog([...log, ...lines(5, { start: 25 })], limits);

    assert.equal(log.length, 10);
    assert.equal(log[0].msg, "line 0");
    assert.equal(log.filter((entry) => entry.omitted).length, 1);
    assert.equal(log[3].omitted.count, 21);
    assert.equal(log[log.length - 1].msg, "line 29");
    assert.equal(countJobLogLines(log), 30);
  });

  it("counts omitted warnings and errors by level and names them in the marker", () => {
    const level = (index) => (index === 5 ? "error" : index === 6 || index === 7 ? "warn" : "info");
    const [, , , marker] = compactJobLog(lines(25, { level }), limits);

    assert.deepEqual(marker.omitted.byLevel, { info: 13, warn: 2, error: 1 });
    assert.match(marker.msg, /including 1 error and 2 warnings/);
  });

  it("folds stray extra markers into the single marker", () => {
    const first = compactJobLog(lines(25), limits);
    const second = compactJobLog(lines(25, { start: 100 }), limits);
    const merged = compactJobLog([...first, ...second], limits);

    assert.equal(merged.filter((entry) => entry.omitted).length, 1);
    assert.equal(countJobLogLines(merged), 50);
    assert.equal(merged.length, 10);
  });
});

describe("appendJobLogEntries / sanitizeJobLog", () => {
  it("drops malformed stored entries and bounds the result", () => {
    const stored = [
      ...lines(3),
      { ts: 1, level: "info", msg: "bad ts" },
      { ts: "x", level: "loud", msg: "bad level" },
      null,
      "nope",
    ];
    const result = appendJobLogEntries(stored, [createJobLogEntry("warn", "new", { a: 1 })], limits);
    assert.deepEqual(
      result.map((entry) => entry.msg),
      ["line 0", "line 1", "line 2", "new"]
    );
    assert.deepEqual(result[3].data, { a: 1 });
  });

  it("treats a non-array stored log as empty", () => {
    assert.deepEqual(sanitizeJobLog(undefined), []);
    assert.deepEqual(sanitizeJobLog({ logs: [] }), []);
  });

  it("drops a marker whose roll-up is malformed", () => {
    const result = sanitizeJobLog([
      { ts: "t", level: "info", msg: "marker", omitted: { count: "lots" } },
      { ts: "t", level: "info", msg: "ok", omitted: { count: 4, byLevel: { warn: 1, nope: 3 } } },
    ]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].omitted, { count: 4, byLevel: { warn: 1 } });
  });
});

describe("job log limits", () => {
  const original = process.env.INGESTION_JOB_LOG_MAX_ENTRIES;
  afterEach(() => {
    if (original === undefined) delete process.env.INGESTION_JOB_LOG_MAX_ENTRIES;
    else process.env.INGESTION_JOB_LOG_MAX_ENTRIES = original;
  });

  it("defaults to 500 entries with the first 100 kept", () => {
    delete process.env.INGESTION_JOB_LOG_MAX_ENTRIES;
    assert.equal(getJobLogMaxEntries(), 500);
    assert.deepEqual(resolveJobLogLimits(), { maxEntries: 500, headEntries: 100 });
  });

  it("reads and clamps INGESTION_JOB_LOG_MAX_ENTRIES", () => {
    process.env.INGESTION_JOB_LOG_MAX_ENTRIES = "1000";
    assert.equal(getJobLogMaxEntries(), 1000);
    process.env.INGESTION_JOB_LOG_MAX_ENTRIES = "5";
    assert.equal(getJobLogMaxEntries(), 100);
    process.env.INGESTION_JOB_LOG_MAX_ENTRIES = "999999";
    assert.equal(getJobLogMaxEntries(), 2000);
    process.env.INGESTION_JOB_LOG_MAX_ENTRIES = "lots";
    assert.equal(getJobLogMaxEntries(), 500);
  });
});

describe("JobLogger bounded log", () => {
  const context = { log: () => {}, warn: () => {}, error: () => {} };
  let logger;

  beforeEach(() => {
    metricWrites = [];
  });

  afterEach(async () => {
    await logger?.dispose({ flush: false });
  });

  it("keeps the first lines of a long run and rolls up the middle", () => {
    logger = new JobLogger({ jobId: 1, context, flushIntervalMs: 0, maxEntries: 10 });
    for (let index = 0; index < 40; index += 1) {
      logger.info(`step ${index}`);
    }
    const logs = logger.getEntries();

    assert.equal(logs.length, 10);
    assert.equal(logs[0].msg, "step 0");
    assert.equal(logs.filter((entry) => entry.omitted).length, 1);
    assert.equal(logs[logs.length - 1].msg, "step 39");
    assert.equal(countJobLogLines(logs), 40);
  });

  it("restores an earlier invocation's log ahead of its own lines, keeping the run's start", () => {
    const earlier = compactJobLog(lines(30), limits);
    logger = new JobLogger({ jobId: 1, context, flushIntervalMs: 0, maxEntries: 10 });
    logger.info("continuation started");
    logger.restoreEntries(earlier);
    logger.info("resuming");

    const logs = logger.getEntries();
    assert.equal(logs[0].msg, "line 0");
    assert.equal(logs.filter((entry) => entry.omitted).length, 1);
    assert.deepEqual(
      logs.slice(-2).map((entry) => entry.msg),
      ["continuation started", "resuming"]
    );
    assert.equal(countJobLogLines(logs), 32);
  });

  it("flushes again after a compaction even though the entry count did not change", async () => {
    logger = new JobLogger({ jobId: 3, context, flushIntervalMs: 0, maxEntries: 10 });
    for (let index = 0; index < 10; index += 1) logger.info(`step ${index}`);
    await logger.flush();
    logger.info("step 10");
    await logger.flush();
    await logger.flush();

    assert.equal(metricWrites.length, 2, "the second write carries the compacted log; the third is a no-op");
    assert.equal(metricWrites[1].metrics.logs.length, 10);
    assert.equal(metricWrites[1].metrics.logs.at(-1).msg, "step 10");
  });
});
