/**
 * Nightly catalog refresh (#532): the pure planner (each skip reason, stagger, cap ordering),
 * config clamping, the internal feature flag, and the timer handler with the database, queue and
 * telemetry injected (flag off: nothing loaded or queued; flag on: one job per planned source).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const timers = {};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@azure/functions") {
    return {
      app: {
        timer: (name, opts) => {
          timers[name] = opts;
        },
        http: () => {},
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};
const refresh = require("../dist/lib/catalog-refresh");
const { runCatalogRefresh } = require("../dist/functions/catalog-refresh");
const { FEATURE_FLAGS, isFeatureEnabled, listPublicFeatureFlags } = require("../dist/lib/feature-flags");
Module._load = originalLoad;

const deps = {
  isRunnable: (name) => name !== "CosIng",
  isCatalogSource: (name) => name !== "CosIng" && name !== "OpenBeautyFacts",
};
const config = { staggerSeconds: 120, maxSourcesPerRun: 0 };
const row = (name, overrides = {}) => ({
  dataSourceId: overrides.dataSourceId ?? name.length,
  name,
  enabled: true,
  metadata: {},
  activeJobId: null,
  lastSucceededAt: null,
  ...overrides,
});

describe("catalog refresh config", () => {
  it("defaults to 07:30 UTC, a 120 s stagger and no cap, and clamps", () => {
    assert.equal(refresh.catalogRefreshSchedule({}), "0 30 7 * * *");
    assert.equal(refresh.catalogRefreshSchedule({ CATALOG_REFRESH_SCHEDULE: " 0 0 3 * * * " }), "0 0 3 * * *");
    assert.deepEqual(refresh.getCatalogRefreshConfig({}), { staggerSeconds: 120, maxSourcesPerRun: 0 });
    assert.equal(refresh.getCatalogRefreshConfig({ CATALOG_REFRESH_STAGGER_SECONDS: "-5" }).staggerSeconds, 0);
    assert.equal(refresh.getCatalogRefreshConfig({ CATALOG_REFRESH_STAGGER_SECONDS: "99999" }).staggerSeconds, 3600);
    assert.equal(refresh.getCatalogRefreshConfig({ CATALOG_REFRESH_STAGGER_SECONDS: "junk" }).staggerSeconds, 120);
    assert.equal(refresh.getCatalogRefreshConfig({ CATALOG_REFRESH_MAX_SOURCES_PER_RUN: "12" }).maxSourcesPerRun, 12);
    assert.equal(refresh.getCatalogRefreshConfig({ CATALOG_REFRESH_MAX_SOURCES_PER_RUN: "-1" }).maxSourcesPerRun, 0);
  });

  it("CATALOG_REFRESH_ENABLED is an internal flag, on only for exactly true", () => {
    assert.equal(FEATURE_FLAGS.catalogRefresh.env, "CATALOG_REFRESH_ENABLED");
    assert.equal(FEATURE_FLAGS.catalogRefresh.public, false);
    assert.equal(isFeatureEnabled("catalogRefresh", {}), false);
    assert.equal(isFeatureEnabled("catalogRefresh", { CATALOG_REFRESH_ENABLED: "1" }), false);
    assert.equal(isFeatureEnabled("catalogRefresh", { CATALOG_REFRESH_ENABLED: " TRUE " }), true);
    assert.equal("catalogRefresh" in listPublicFeatureFlags({ CATALOG_REFRESH_ENABLED: "true" }), false);
  });

  it("registers the catalog-refresh timer on the schedule", () => {
    assert.equal(timers["catalog-refresh"].schedule, "0 30 7 * * *");
    assert.equal(timers["catalog-refresh"].runOnStartup, false);
  });
});

describe("planCatalogRefresh", () => {
  it("gives every skip reason, blocked before disabled", () => {
    const plan = refresh.planCatalogRefresh(
      [
        row("BlockedShopify", { enabled: false, metadata: { blocked: "robots" } }),
        row("BlockedTrueShopify", { metadata: { blocked: true } }),
        row("PendingShopify", { enabled: false }),
        row("CosIng"),
        row("OpenBeautyFacts"),
        row("BusyShopify", { activeJobId: "77" }),
        row("GoodShopify", { dataSourceId: "5" }),
      ],
      deps,
      config
    );
    assert.deepEqual(plan.skipped, [
      { name: "BlockedShopify", reason: "blocked", detail: "robots" },
      { name: "BlockedTrueShopify", reason: "blocked", detail: "blocked" },
      { name: "PendingShopify", reason: "disabled" },
      { name: "CosIng", reason: "no_runnable_connector" },
      { name: "OpenBeautyFacts", reason: "not_catalog_source" },
      { name: "BusyShopify", reason: "already_running", activeJobId: 77 },
    ]);
    assert.deepEqual(plan.planned, [{ dataSourceId: 5, name: "GoodShopify", delaySeconds: 0, lastSucceededAt: null }]);
    assert.deepEqual(refresh.countSkipsByReason(plan.skipped), {
      disabled: 1,
      blocked: 2,
      no_runnable_connector: 1,
      not_catalog_source: 1,
      already_running: 1,
      capped: 0,
    });
  });

  it("orders by last success (never first, then oldest, then name) and staggers the delays", () => {
    const plan = refresh.planCatalogRefresh(
      [
        row("CShopify", { lastSucceededAt: "2026-11-20T07:00:00Z" }),
        row("AShopify", { lastSucceededAt: new Date("2026-11-24T07:00:00Z") }),
        row("ZShopify"),
        row("BShopify"),
        row("DShopify", { lastSucceededAt: "2026-11-01T07:00:00Z" }),
      ],
      deps,
      config
    );
    assert.deepEqual(
      plan.planned.map((p) => [p.name, p.delaySeconds]),
      [
        ["BShopify", 0],
        ["ZShopify", 120],
        ["DShopify", 240],
        ["CShopify", 360],
        ["AShopify", 480],
      ]
    );
    assert.equal(plan.planned[4].lastSucceededAt, "2026-11-24T07:00:00.000Z");
    assert.deepEqual(plan.skipped, []);
  });

  it("caps the run at the stalest sources and reports the rest as capped", () => {
    const plan = refresh.planCatalogRefresh(
      [
        row("FreshShopify", { lastSucceededAt: "2026-11-24T07:00:00Z" }),
        row("StaleShopify", { lastSucceededAt: "2026-10-01T07:00:00Z" }),
        row("NeverShopify"),
        row("OffShopify", { enabled: false }),
      ],
      deps,
      { staggerSeconds: 60, maxSourcesPerRun: 2 }
    );
    assert.deepEqual(
      plan.planned.map((p) => [p.name, p.delaySeconds]),
      [
        ["NeverShopify", 0],
        ["StaleShopify", 60],
      ]
    );
    assert.deepEqual(plan.skipped, [
      { name: "OffShopify", reason: "disabled" },
      { name: "FreshShopify", reason: "capped" },
    ]);
  });

  it("bounds the delay by the queue's 7-day visibility limit and allows no stagger", () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(`S${String(i).padStart(3, "0")}Shopify`, { dataSourceId: i + 1 }));
    const plan = refresh.planCatalogRefresh(rows, deps, { staggerSeconds: 3600, maxSourcesPerRun: 0 });
    assert.equal(plan.planned.at(-1).delaySeconds, refresh.MAX_QUEUE_VISIBILITY_DELAY_SECONDS);
    const flat = refresh.planCatalogRefresh(rows.slice(0, 3), deps, { staggerSeconds: 0, maxSourcesPerRun: 0 });
    assert.deepEqual(flat.planned.map((p) => p.delaySeconds), [0, 0, 0]);
  });

  it("only counts queued and running jobs as active", () => {
    assert.deepEqual([...refresh.ACTIVE_INGESTION_JOB_STATUSES], ["queued", "running"]);
    const sql = refresh.SELECT_CATALOG_REFRESH_SOURCES_SQL.replace(/\s+/g, " ");
    assert.match(sql, /j\.status IN \('queued', 'running'\)/);
    assert.match(sql, /j\.status = 'succeeded'/);
    assert.match(sql, /FROM data_source ds/);
  });
});

function makeTimerDeps(overrides = {}) {
  const calls = { loads: 0, jobs: [], messages: [], failed: [], events: [], exceptions: [] };
  let nextJobId = 100;
  const deps = {
    isEnabled: () => true,
    loadSources: async () => {
      calls.loads += 1;
      return [
        row("CirqueColorsShopify", { dataSourceId: "11", lastSucceededAt: "2026-11-20T07:30:00Z" }),
        row("ColoresDeCarolBigCartel", { dataSourceId: "12" }),
        row("OpenBeautyFacts", { dataSourceId: "13" }),
        row("CosIng", { dataSourceId: "14" }),
        row("IlnpWooCommerce", { dataSourceId: "15", activeJobId: "90" }),
        row("PahlishShopify", { dataSourceId: "16", enabled: false }),
      ];
    },
    createJob: async (dataSourceId, jobType, metrics, status) => {
      const jobId = nextJobId++;
      calls.jobs.push({ dataSourceId, jobType, metrics, status, jobId });
      return { jobId, startedAt: "2026-11-25T07:30:00Z" };
    },
    markJobFailed: async (jobId, message, metrics) => {
      calls.failed.push({ jobId, message, metrics });
    },
    sendMessage: async (message, options) => {
      calls.messages.push({ message, options });
    },
    trackEvent: (name, props) => calls.events.push({ name, props }),
    trackException: (error, props) => calls.exceptions.push({ error, props }),
    env: {},
    now: () => new Date("2026-11-25T07:30:00Z"),
    ...overrides,
  };
  return { deps, calls };
}

const context = { log: () => {}, warn: () => {}, error: () => {} };

describe("runCatalogRefresh", () => {
  it("does nothing while the flag is off", async () => {
    const { deps, calls } = makeTimerDeps({ isEnabled: () => false });
    await runCatalogRefresh({}, context, deps);
    assert.equal(calls.loads, 0);
    assert.deepEqual(calls.jobs, []);
    assert.deepEqual(calls.messages, []);
    assert.deepEqual(calls.events, []);
  });

  it("queues one staggered system job per eligible catalog source, like a bulk run", async () => {
    const { deps, calls } = makeTimerDeps();
    await runCatalogRefresh({}, context, deps);

    assert.deepEqual(
      calls.jobs.map((j) => [j.dataSourceId, j.jobType, j.status]),
      [
        [12, "connector_verify", "queued"],
        [11, "connector_verify", "queued"],
      ]
    );
    const [first, second] = calls.messages;
    assert.equal(first.message.request.source, "ColoresDeCarolBigCartel");
    assert.equal(first.options.visibilityTimeoutSeconds, 0);
    assert.equal(second.message.request.source, "CirqueColorsShopify");
    assert.equal(second.options.visibilityTimeoutSeconds, 120);
    for (const { message } of calls.messages) {
      assert.equal(message.userId, null);
      assert.deepEqual(
        {
          exhaustive: message.request.exhaustive,
          pageSize: message.request.pageSize,
          materializeToInventory: message.request.materializeToInventory,
          detectHexFromImage: message.request.detectHexFromImage,
          detectHexOnSuspiciousOnly: message.request.detectHexOnSuspiciousOnly,
          overwriteDetectedHex: message.request.overwriteDetectedHex,
        },
        {
          exhaustive: true,
          pageSize: 100,
          materializeToInventory: true,
          detectHexFromImage: true,
          detectHexOnSuspiciousOnly: false,
          overwriteDetectedHex: false,
        }
      );
      assert.equal(message.requestedMetrics.triggeredByUserId, null);
      assert.equal(message.requestedMetrics.triggeredBy, "catalog_refresh");
    }
    assert.equal(calls.jobs[1].metrics.catalogRefresh, true);
    assert.equal(calls.jobs[1].metrics.scheduledStartAt, "2026-11-25T07:32:00.000Z");
    assert.equal(calls.jobs[1].metrics.pipeline.status, "queued");

    assert.equal(calls.events.length, 1);
    assert.equal(calls.events[0].name, "catalog_refresh.run");
    assert.deepEqual(
      {
        sources: calls.events[0].props.sources,
        planned: calls.events[0].props.planned,
        enqueued: calls.events[0].props.enqueued,
        failed: calls.events[0].props.failed,
        skipped: calls.events[0].props.skipped,
        disabled: calls.events[0].props.skipped_disabled,
        notCatalog: calls.events[0].props.skipped_not_catalog_source,
        noConnector: calls.events[0].props.skipped_no_runnable_connector,
        running: calls.events[0].props.skipped_already_running,
      },
      { sources: 6, planned: 2, enqueued: 2, failed: 0, skipped: 4, disabled: 1, notCatalog: 1, noConnector: 1, running: 1 }
    );
  });

  it("marks a job failed when its message cannot be sent and keeps queueing the rest", async () => {
    const { deps, calls } = makeTimerDeps();
    let sends = 0;
    deps.sendMessage = async (message, options) => {
      sends += 1;
      if (sends === 1) throw new Error("queue down");
      calls.messages.push({ message, options });
    };
    await runCatalogRefresh({}, context, deps);
    assert.equal(calls.failed.length, 1);
    assert.equal(calls.failed[0].jobId, 100);
    assert.equal(calls.failed[0].message, "queue down");
    assert.equal(calls.failed[0].metrics.pipeline.status, "failed");
    assert.equal(calls.messages.length, 1);
    assert.equal(calls.events[0].props.enqueued, 1);
    assert.equal(calls.events[0].props.failed, 1);
  });

  it("reports a run that cannot load the sources", async () => {
    const { deps, calls } = makeTimerDeps({
      loadSources: async () => {
        throw new Error("db down");
      },
    });
    await runCatalogRefresh({}, context, deps);
    assert.deepEqual(calls.jobs, []);
    assert.equal(calls.events[0].name, "catalog_refresh.failed");
    assert.equal(calls.exceptions[0].props.stage, "run");
  });
});
