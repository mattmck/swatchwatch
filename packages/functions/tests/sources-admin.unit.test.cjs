const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Handler tests need db / jose / @azure/functions mocked before the dist modules load
// (same approach as admin-users.unit.test.cjs). The pure planners never touch the db.
const registeredRoutes = {};
let queryMock = async () => ({ rows: [] });
let transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });

const mockModules = {};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) return key;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
const dbMock = {
  query: (...args) => queryMock(...args),
  transaction: (...args) => transactionMock(...args),
  getPool: () => ({}),
  closePool: async () => {},
};
mockModules["@azure/functions"] = {
  app: { http: (name, opts) => { registeredRoutes[name] = opts; } },
};
mockModules["jose"] = {
  createRemoteJWKSet: () => () => {},
  jwtVerify: async () => { throw new Error("invalid JWT"); },
};
mockModules["../lib/db"] = dbMock;
mockModules["./db"] = dbMock;
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const {
  planPermissionChange,
  planEnabledChange,
  parsePermissionRequest,
  grantNoteSentence,
  isFetchableSource,
  sourcesAdminSql,
  toAdminSourceListItem,
} = require("../dist/lib/sources-admin");
require("../dist/functions/sources-admin");

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) delete require.cache[id];
});

const isPermissionOkStatus = (s) => s === "granted" || s === "not_needed";
const NOW = "2026-11-11T10:00:00.000Z";
const SHOPIFY = "HypnoticPolishShopify";

function state(overrides = {}) {
  return { name: SHOPIFY, enabled: false, metadata: {}, ...overrides };
}

const grant = {
  action: "granted",
  decidedAt: "2026-11-10",
  grantedBy: "Jo",
  channel: "email",
  summary: "OK to read the catalog",
  imagesGranted: false,
};

describe("planPermissionChange", () => {
  it("records asked without touching enabled", () => {
    const input = state({ enabled: true });
    const plan = planPermissionChange(input, { action: "asked", askedAt: "2026-11-09" }, 7, NOW);
    assert.equal(plan.ok, true);
    assert.equal(plan.action, "data_source.permission");
    assert.equal(plan.enabled, true);
    assert.deepEqual(plan.metadata.permission, {
      status: "asked",
      askedAt: "2026-11-09",
      recordedByUserId: 7,
      recordedAt: NOW,
    });
    assert.equal(plan.changes.enabled, undefined);
    assert.deepEqual(input.metadata, {});
  });

  it("grant on a pending store enables it and appends the notes sentence", () => {
    const plan = planPermissionChange(
      state({ metadata: { pendingApproval: true, notes: "x" } }),
      grant,
      7,
      NOW,
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.enabled, true);
    assert.equal("pendingApproval" in plan.metadata, false);
    assert.equal(plan.metadata.imagesPermitted, false);
    assert.equal(plan.metadata.permission.imagesGranted, false);
    assert.equal(plan.metadata.permission.recordedByUserId, 7);
    const sentence = grantNoteSentence({
      grantedBy: "Jo",
      displayName: "Hypnotic Polish",
      decidedAt: "2026-11-10",
      channel: "email",
      summary: "OK to read the catalog",
    });
    assert.equal(plan.metadata.notes, `x ${sentence}`);
    assert.deepEqual(plan.changes.enabled, { from: false, to: true });
    assert.deepEqual(plan.changes.pendingApproval, { from: true, to: null });
  });

  it("grant with no existing notes writes just the sentence, images granted syncs imagesPermitted", () => {
    const plan = planPermissionChange(state(), { ...grant, imagesGranted: true }, 7, NOW);
    assert.match(plan.metadata.notes, /^Acceptable use confirmed by Jo at Hypnotic Polish on 2026-11-10 via email: /);
    assert.equal(plan.metadata.imagesPermitted, true);
  });

  it("grant on an already granted source edits fields but leaves enabled, notes and askedAt alone", () => {
    const existing = state({
      enabled: false,
      metadata: {
        notes: "old note",
        permission: { status: "granted", askedAt: "2026-11-01", grantedBy: "Jp" },
      },
    });
    const plan = planPermissionChange(existing, grant, 7, NOW);
    assert.equal(plan.ok, true);
    assert.equal(plan.enabled, false);
    assert.equal(plan.metadata.notes, "old note");
    assert.equal(plan.metadata.permission.grantedBy, "Jo");
    assert.equal(plan.metadata.permission.askedAt, "2026-11-01");
    assert.equal(plan.changes.enabled, undefined);
    assert.equal(plan.changes.notes, undefined);
  });

  it("declined switches the source off", () => {
    const plan = planPermissionChange(
      state({ enabled: true }),
      { action: "declined", decidedAt: "2026-11-10", channel: "dm" },
      7,
      NOW,
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.enabled, false);
    assert.equal(plan.metadata.permission.status, "declined");
    assert.deepEqual(plan.changes.enabled, { from: true, to: false });
  });

  it("declined also turns images off in the permission and the metadata", () => {
    const plan = planPermissionChange(
      state({ enabled: true, metadata: { imagesPermitted: true } }),
      { action: "declined", decidedAt: "2026-11-10", channel: "dm" },
      7,
      NOW,
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.metadata.imagesPermitted, false);
    assert.equal(plan.metadata.permission.imagesGranted, false);
    assert.deepEqual(plan.changes.imagesPermitted, { from: true, to: false });
  });

  it("not_needed records the check date and note and changes nothing else", () => {
    const plan = planPermissionChange(
      state({ enabled: true, metadata: { notes: "n", imagesPermitted: true } }),
      { action: "not_needed", checkedAt: "2026-11-09", summary: "terms checked" },
      7,
      NOW,
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.action, "data_source.permission");
    assert.equal(plan.enabled, true);
    assert.deepEqual(plan.metadata.permission, {
      status: "not_needed",
      decidedAt: "2026-11-09",
      summary: "terms checked",
      recordedByUserId: 7,
      recordedAt: NOW,
    });
    assert.equal(plan.metadata.notes, "n");
    assert.equal(plan.metadata.imagesPermitted, true);
    assert.deepEqual(Object.keys(plan.changes), ["permission"]);
    const bare = planPermissionChange(state(), { action: "not_needed", checkedAt: "2026-11-09" }, 7, NOW);
    assert.equal("summary" in bare.metadata.permission, false);
  });

  it("images toggle on a granted source sets both flags", () => {
    const plan = planPermissionChange(
      state({ enabled: true, metadata: { permission: { status: "granted", imagesGranted: false }, imagesPermitted: false } }),
      { action: "images", imagesGranted: true },
      7,
      NOW,
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.action, "data_source.images");
    assert.equal(plan.metadata.imagesPermitted, true);
    assert.equal(plan.metadata.permission.imagesGranted, true);
    assert.equal(plan.metadata.permission.status, "granted");
  });

  it("images toggle on a non-granted source is 409 not_granted", () => {
    const plan = planPermissionChange(
      state({ metadata: { permission: { status: "asked" } } }),
      { action: "images", imagesGranted: true },
      7,
      NOW,
    );
    assert.equal(plan.ok, false);
    assert.equal(plan.status, 409);
    assert.equal(plan.code, "not_granted");
  });

  it("rejects a non-fetchable source", () => {
    const plan = planPermissionChange(state({ name: "Manual" }), { action: "asked", askedAt: "2026-11-09" }, 7, NOW);
    assert.equal(plan.ok, false);
    assert.equal(plan.status, 409);
    assert.equal(plan.code, "not_fetchable");
    assert.equal(isFetchableSource("Manual"), false);
    assert.equal(isFetchableSource(SHOPIFY), true);
  });
});

describe("planEnabledChange", () => {
  for (const status of ["not_asked", "asked", "declined"]) {
    it(`turn on with permission ${status} needs override`, () => {
      const metadata = status === "not_asked" ? {} : { permission: { status } };
      const plan = planEnabledChange(state({ metadata }), { enabled: true });
      assert.equal(plan.ok, false);
      assert.equal(plan.status, 409);
      assert.equal(plan.code, "permission_required");
    });
  }

  it("override turns on, records override and status, keeps permission", () => {
    const permission = { status: "asked", askedAt: "2026-11-09" };
    const plan = planEnabledChange(
      state({ metadata: { pendingApproval: true, permission } }),
      { enabled: true, override: true },
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.action, "data_source.enable");
    assert.equal(plan.enabled, true);
    assert.equal(plan.changes.override, true);
    assert.equal(plan.changes.permissionStatus, "asked");
    assert.equal("pendingApproval" in plan.metadata, false);
    assert.deepEqual(plan.metadata.permission, permission);
  });

  it("granted turns on without override and without an override key in changes", () => {
    const plan = planEnabledChange(
      state({ metadata: { permission: { status: "granted" } } }),
      { enabled: true },
    );
    assert.equal(plan.ok, true);
    assert.equal("override" in plan.changes, false);
    assert.deepEqual(plan.changes.enabled, { from: false, to: true });
  });

  it("not_needed turns on without override", () => {
    const plan = planEnabledChange(
      state({ metadata: { verification: { termsScrapingClause: false } } }),
      { enabled: true },
    );
    assert.equal(plan.ok, true);
    assert.equal("override" in plan.changes, false);
  });

  it("is a no-op when the source is already in the requested state", () => {
    const on = planEnabledChange(state({ enabled: true }), { enabled: true });
    assert.equal(on.ok, true);
    assert.equal(on.noop, true);
    assert.deepEqual(on.changes, {});
    assert.equal(on.enabled, true);
    const off = planEnabledChange(state({ enabled: false }), { enabled: false });
    assert.equal(off.ok, true);
    assert.equal(off.noop, true);
    assert.deepEqual(off.changes, {});
    const real = planEnabledChange(state({ enabled: true }), { enabled: false });
    assert.equal(real.noop, undefined);
  });

  for (const name of ["OpenBeautyFacts", "MakeupAPI"]) {
    it(`turns on ${name} without override`, () => {
      const plan = planEnabledChange(state({ name, metadata: {} }), { enabled: true });
      assert.equal(plan.ok, true);
      assert.equal("override" in plan.changes, false);
    });
  }

  it("planner status equals the list mapper status for sample rows", () => {
    const samples = [
      { name: SHOPIFY, metadata: { verification: { termsScrapingClause: true } } },
      { name: SHOPIFY, metadata: { permission: { status: "granted" } } },
      { name: SHOPIFY, metadata: { verification: { termsScrapingClause: false } } },
      { name: "OpenBeautyFacts", metadata: {} },
      { name: "MakeupAPI", metadata: { pendingApproval: true } },
    ];
    for (const { name, metadata } of samples) {
      const mapped = toAdminSourceListItem(sourceRow({ name, metadata, enabled: false }));
      const plan = planEnabledChange(state({ name, metadata }), { enabled: true });
      assert.equal(plan.ok, isPermissionOkStatus(mapped.permission.status), `${name} ${JSON.stringify(metadata)}`);
    }
  });

  it("turning off works on any status", () => {
    const plan = planEnabledChange(state({ enabled: true, metadata: { permission: { status: "declined" } } }), {
      enabled: false,
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.action, "data_source.disable");
    assert.equal(plan.enabled, false);
  });

  it("rejects a non-fetchable source", () => {
    const plan = planEnabledChange(state({ name: "Manual" }), { enabled: false });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, "not_fetchable");
  });
});

describe("parsePermissionRequest", () => {
  it("accepts valid bodies", () => {
    assert.equal(parsePermissionRequest({ action: "asked", askedAt: "2026-11-09" }).ok, true);
    const g = parsePermissionRequest({ ...grant, grantedBy: "  Jo  " });
    assert.equal(g.ok, true);
    assert.equal(g.value.grantedBy, "Jo");
    assert.equal(parsePermissionRequest({ action: "images", imagesGranted: true }).ok, true);
    assert.deepEqual(parsePermissionRequest({ action: "not_needed", checkedAt: "2026-11-09" }), {
      ok: true,
      value: { action: "not_needed", checkedAt: "2026-11-09" },
    });
    assert.deepEqual(parsePermissionRequest({ action: "not_needed", checkedAt: "2026-11-09", summary: " ok " }).value, {
      action: "not_needed",
      checkedAt: "2026-11-09",
      summary: "ok",
    });
  });

  it("rejects bad input", () => {
    assert.equal(parsePermissionRequest({ action: "asked", askedAt: "2026-1-5" }).ok, false);
    assert.equal(parsePermissionRequest({ action: "nope" }).ok, false);
    assert.equal(parsePermissionRequest({ action: "not_needed" }).ok, false);
    assert.equal(parsePermissionRequest({ action: "not_needed", checkedAt: "yesterday" }).ok, false);
    assert.equal(parsePermissionRequest({ action: "not_needed", checkedAt: "2026-11-09", summary: "x".repeat(501) }).ok, false);
    assert.equal(parsePermissionRequest({ ...grant, channel: "carrier-pigeon" }).ok, false);
    assert.equal(parsePermissionRequest({ ...grant, grantedBy: "   " }).ok, false);
    assert.equal(parsePermissionRequest({ ...grant, summary: "x".repeat(501) }).ok, false);
    assert.equal(parsePermissionRequest(null).ok, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════════════════

const ADMIN = 2;
const OTHER = 10;
const savedEnv = {};
beforeEach(() => {
  for (const key of ["AUTH_DEV_BYPASS", "WEBSITE_INSTANCE_ID", "WEBSITE_HOSTNAME"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AUTH_DEV_BYPASS = "true";
  queryMock = async () => ({ rows: [] });
  transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fakeContext() {
  return { log() {}, warn() {}, error() {}, invocationId: "test-invocation" };
}
function fakeRequest({ method = "GET", url = "http://localhost/api/sources-admin", headers = {}, params = {}, body }) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    url,
    params,
    headers: { get: (name) => h.get(name.toLowerCase()) ?? null },
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}
function authedQuery(handler) {
  return async (sql, params) => {
    if (/SELECT user_id, external_id, email/.test(sql)) {
      const id = params[0];
      return {
        rows: [{ user_id: id, external_id: `ext-${id}`, email: `u${id}@test.dev`, role: id === ADMIN ? "admin" : "user", suspended: false }],
      };
    }
    return handler(sql, params);
  };
}
function call(route, { as = ADMIN, ...rest } = {}) {
  return registeredRoutes[route].handler(
    fakeRequest({ ...rest, headers: { authorization: `Bearer dev:${as}` } }),
    fakeContext()
  );
}

function sourceRow(overrides = {}) {
  return {
    dataSourceId: "5",
    name: SHOPIFY,
    baseUrl: "https://hypnotic.example",
    enabled: false,
    metadata: { currency: "EUR", notes: "Existing note." },
    lastJobId: "99",
    lastJobStatus: "succeeded",
    lastJobStartedAt: "2026-11-10T10:00:00.000Z",
    lastJobFinishedAt: "2026-11-10T10:05:00.000Z",
    lastJobProcessed: "120",
    liveListings: "42",
    shades: "40",
    ...overrides,
  };
}

/** Records every statement; the FOR UPDATE select returns `current` (or no row). */
function txRecorder(current) {
  const statements = [];
  transactionMock = async (cb) =>
    cb({
      query: async (sql, params) => {
        statements.push({ sql, params });
        if (/FOR UPDATE/.test(sql)) return { rows: current ? [current] : [] };
        return { rows: [], rowCount: 1 };
      },
    });
  return statements;
}

describe("toAdminSourceListItem", () => {
  it("maps counts to numbers and derives permission, kind and connector", () => {
    const item = toAdminSourceListItem(sourceRow({ enabled: true }));
    assert.equal(item.dataSourceId, 5);
    assert.equal(item.liveListings, 42);
    assert.equal(item.shades, 40);
    assert.equal(item.kind, "brand");
    assert.equal(item.fetchable, true);
    assert.equal(item.permission.status, "not_asked");
    assert.equal(item.onWithoutOk, true);
    assert.equal(item.imagesPermitted, true);
    assert.equal(item.currency, "EUR");
    assert.deepEqual(item.lastJob, {
      jobId: "99",
      status: "succeeded",
      startedAt: "2026-11-10T10:00:00.000Z",
      finishedAt: "2026-11-10T10:05:00.000Z",
      recordsProcessed: 120,
    });
  });

  it("a metadata.brand names the source", () => {
    assert.equal(toAdminSourceListItem(sourceRow({ metadata: { brand: " Bee's Knees " } })).displayName, "Bee's Knees");
    assert.equal(toAdminSourceListItem(sourceRow({ metadata: { brand: "" } })).displayName, "Hypnotic Polish");
  });

  it("an open-data source derives not_needed and is never on without an OK", () => {
    const item = toAdminSourceListItem(sourceRow({ name: "MakeupAPI", enabled: true, metadata: {} }));
    assert.equal(item.fetchable, true);
    assert.equal(item.permission.status, "not_needed");
    assert.equal(item.onWithoutOk, false);
  });

  it("a source without jobs has lastJob null", () => {
    const item = toAdminSourceListItem(sourceRow({ lastJobId: null, lastJobStatus: null, lastJobProcessed: null }));
    assert.equal(item.lastJob, null);
  });
});

describe("sources admin SQL", () => {
  it("returns job timestamps as ISO-8601 UTC text", () => {
    const sql = sourcesAdminSql(false);
    assert.match(sql, /to_char\(lj\.started_at AT TIME ZONE 'UTC'/);
    assert.match(sql, /to_char\(lj\.finished_at AT TIME ZONE 'UTC'/);
  });
});

describe("functions/sources-admin", () => {
  for (const [route, method, params] of [
    ["sources-admin-list", "GET", {}],
    ["sources-admin-item", "GET", { id: "5" }],
    ["sources-admin-permission", "PUT", { id: "5" }],
    ["sources-admin-enabled", "PUT", { id: "5" }],
  ]) {
    it(`${route}: a regular user gets 403 and nothing runs`, async () => {
      const seen = [];
      queryMock = authedQuery(async (sql) => {
        seen.push(sql);
        return { rows: [] };
      });
      const statements = txRecorder(null);
      const res = await call(route, { as: OTHER, method, params, body: { enabled: false } });
      assert.equal(res.status, 403);
      assert.deepEqual(seen, []);
      assert.deepEqual(statements, []);
    });
  }

  it("GET list maps rows", async () => {
    queryMock = authedQuery(async () => ({ rows: [sourceRow({ enabled: true })] }));
    const res = await call("sources-admin-list");
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.sources.length, 1);
    assert.equal(res.jsonBody.sources[0].liveListings, 42);
    assert.equal(res.jsonBody.sources[0].onWithoutOk, true);
  });

  it("GET item returns notes and history; unknown id is 404, bad id 400", async () => {
    queryMock = authedQuery(async (sql, params) => {
      if (/FROM data_source ds/.test(sql)) return { rows: params[0] === 5 ? [sourceRow()] : [] };
      if (/FROM admin_audit_event/.test(sql)) {
        assert.match(sql, /changes->>'dataSourceId'/);
        return {
          rows: [
            {
              auditEventId: "3",
              actorUserId: "2",
              actorLabel: "a@test.dev",
              targetUserId: null,
              action: "data_source.enable",
              changes: { dataSourceId: 5 },
              note: null,
              createdAt: "2026-11-10 11:00:00+00",
            },
          ],
        };
      }
      return { rows: [] };
    });
    const ok = await call("sources-admin-item", { params: { id: "5" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.jsonBody.notes, "Existing note.");
    assert.equal(ok.jsonBody.history[0].auditEventId, 3);
    assert.equal(ok.jsonBody.history[0].targetUserId, undefined);
    assert.equal((await call("sources-admin-item", { params: { id: "6" } })).status, 404);
    assert.equal((await call("sources-admin-item", { params: { id: "abc" } })).status, 400);
  });

  const detailQuery = () =>
    authedQuery(async (sql) => (/FROM data_source ds/.test(sql) ? { rows: [sourceRow()] } : { rows: [] }));

  const grantBody = {
    action: "granted",
    decidedAt: "2026-11-10",
    grantedBy: "Jo",
    channel: "email",
    summary: "OK to read the catalog",
    imagesGranted: true,
  };

  it("PUT permission granted: one lock, one UPDATE, one audit row, then reloads", async () => {
    queryMock = detailQuery();
    const statements = txRecorder({ name: SHOPIFY, enabled: false, metadata: {} });
    const res = await call("sources-admin-permission", { method: "PUT", params: { id: "5" }, body: grantBody });
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.source.dataSourceId, 5);
    assert.equal(statements.length, 3);
    assert.match(statements[0].sql, /SELECT[\s\S]*FOR UPDATE/);
    assert.match(statements[1].sql, /UPDATE data_source\s+SET enabled = \$2, metadata = \$3::jsonb/);
    assert.equal(statements[1].params[1], true);
    assert.match(statements[2].sql, /INSERT INTO admin_audit_event/);
    assert.equal(statements[2].params[0], ADMIN);
    assert.equal(statements[2].params[1], null);
    assert.equal(statements[2].params[2], "data_source.permission");
    assert.equal(JSON.parse(statements[2].params[3]).dataSourceId, 5);
  });

  it("PUT permission: invalid body and invalid JSON are 400, unknown id 404", async () => {
    queryMock = detailQuery();
    txRecorder({ name: SHOPIFY, enabled: false, metadata: {} });
    const bad = await call("sources-admin-permission", { method: "PUT", params: { id: "5" }, body: { action: "nope" } });
    assert.equal(bad.status, 400);
    const noBody = await call("sources-admin-permission", { method: "PUT", params: { id: "5" } });
    assert.equal(noBody.status, 400);
    const badId = await call("sources-admin-permission", { method: "PUT", params: { id: "abc" }, body: grantBody });
    assert.equal(badId.status, 400);
    txRecorder(null);
    const missing = await call("sources-admin-permission", { method: "PUT", params: { id: "5" }, body: grantBody });
    assert.equal(missing.status, 404);
  });

  it("PUT enabled true on a not_asked source is 409 permission_required and writes nothing", async () => {
    queryMock = detailQuery();
    const statements = txRecorder({ name: SHOPIFY, enabled: false, metadata: {} });
    const res = await call("sources-admin-enabled", { method: "PUT", params: { id: "5" }, body: { enabled: true } });
    assert.equal(res.status, 409);
    assert.equal(res.jsonBody.code, "permission_required");
    assert.equal(statements.length, 1);
    assert.match(statements[0].sql, /FOR UPDATE/);
  });

  it("PUT enabled true with override succeeds and the audit changes carry override", async () => {
    queryMock = detailQuery();
    const statements = txRecorder({ name: SHOPIFY, enabled: false, metadata: {} });
    const res = await call("sources-admin-enabled", {
      method: "PUT",
      params: { id: "5" },
      body: { enabled: true, override: true },
    });
    assert.equal(res.status, 200);
    assert.equal(statements.length, 3);
    assert.equal(statements[2].params[2], "data_source.enable");
    assert.match(statements[2].params[3], /"override":true/);
  });

  it("PUT enabled to the current state is 200 with no UPDATE and no audit row", async () => {
    queryMock = detailQuery();
    const statements = txRecorder({ name: SHOPIFY, enabled: true, metadata: {} });
    const res = await call("sources-admin-enabled", { method: "PUT", params: { id: "5" }, body: { enabled: true } });
    assert.equal(res.status, 200);
    assert.equal(statements.length, 1);
    assert.match(statements[0].sql, /FOR UPDATE/);
  });

  it("PUT enabled: a non-boolean enabled and an unknown id", async () => {
    queryMock = detailQuery();
    txRecorder(null);
    const bad = await call("sources-admin-enabled", { method: "PUT", params: { id: "5" }, body: { enabled: "yes" } });
    assert.equal(bad.status, 400);
    const missing = await call("sources-admin-enabled", { method: "PUT", params: { id: "5" }, body: { enabled: false } });
    assert.equal(missing.status, 404);
  });
});
