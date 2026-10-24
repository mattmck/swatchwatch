/**
 * Admin shade finishes (functions/admin-shade-finishes, PUT /api/shades-admin/{id}/finishes):
 * catalog validation, admin-only access, sticky `finishes_source = 'admin'`, the
 * shade_category_change log, and that ingestion never changes an admin list
 * (lib/finish-text applyIngestedFinishes). No database: lib/db is replaced by a recording fake.
 */
const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const ADMIN = 99;
const USER = 2;
const USERS = {
  [ADMIN]: { user_id: ADMIN, external_id: "ext-admin", email: null, role: "admin" },
  [USER]: { user_id: USER, external_id: "ext-user", email: null, role: "user" },
};

const CATALOG_ROWS = [
  { kind: "type", sourceValue: "creme", normalizedFinishName: "creme", family: "solid" },
  { kind: "type", sourceValue: "holographic", normalizedFinishName: "holographic", family: "holo" },
  { kind: "type", sourceValue: "magnetic", normalizedFinishName: "magnetic", family: "shimmer" },
  { kind: "type", sourceValue: "thermal", normalizedFinishName: "thermal", family: "thermal" },
  { kind: "type", sourceValue: "topper", normalizedFinishName: "topper", family: null },
  { kind: "alias", sourceValue: "holo", normalizedFinishName: "holographic", family: null },
];

let sqlCalls = [];
let responder = () => undefined;

async function fakeQuery(via, sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ via, sql: text, params });
  if (/FROM\s+app_user/i.test(text) && /WHERE\s+user_id\s*=\s*\$1/i.test(text)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }
  if (/FROM\s+finish_normalization/i.test(text)) return { rows: CATALOG_ROWS, rowCount: CATALOG_ROWS.length };
  const result = responder(text, params, via);
  return result ?? { rows: [], rowCount: 0 };
}

const registeredRoutes = {};
const mockModules = {};
const originalResolve = Module._resolveFilename;
function registerMock(id, exports) {
  mockModules[id] = exports;
}
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) return key;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
registerMock("@azure/functions", {
  app: {
    http: (name, opts) => {
      registeredRoutes[name] = opts;
    },
  },
});
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), {
  query: (sql, params) => fakeQuery("pool", sql, params),
  transaction: async (cb) => cb({ query: (sql, params) => fakeQuery("tx", sql, params) }),
  getPool: () => ({}),
  closePool: async () => {},
});
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) delete require.cache[id];
});

const { parseShadeFinishesRequest } = require("../dist/functions/admin-shade-finishes");
const { applyIngestedFinishes } = require("../dist/lib/finish-text");
const { DEFAULT_FINISH_CATALOG, resetFinishAliasCache } = require("../dist/lib/finishes");

beforeEach(() => {
  sqlCalls = [];
  responder = () => undefined;
  resetFinishAliasCache();
  process.env.AUTH_DEV_BYPASS = "true";
});
afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
});

function invoke({ userId = ADMIN, id = "42", body, rawBody } = {}) {
  const route = registeredRoutes["admin-shade-finishes-set"];
  assert.ok(route, "route registered");
  const headers = new Map([["authorization", `Bearer dev:${userId}`]]);
  const request = {
    method: "PUT",
    url: `http://localhost:7071/api/shades-admin/${id}/finishes`,
    params: { id },
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    text: async () => (rawBody !== undefined ? rawBody : JSON.stringify(body)),
  };
  return route.handler(request, { log() {}, warn() {}, error() {}, invocationId: "test" });
}

function shadeRow(finishes, finishesSource = "rule") {
  return (sql) => (/FROM shade\s/i.test(sql) && /FOR UPDATE/i.test(sql) ? { rows: [{ finishes, finishesSource }] } : undefined);
}

describe("parseShadeFinishesRequest", () => {
  it("canonicalizes aliases, drops duplicates and keeps the primary first", () => {
    assert.deepEqual(parseShadeFinishesRequest({ finishes: ["Holo", "creme", "holographic"] }, DEFAULT_FINISH_CATALOG), {
      ok: true,
      finishes: ["holographic", "creme"],
    });
  });

  it("allows an empty list", () => {
    assert.deepEqual(parseShadeFinishesRequest({ finishes: [] }, DEFAULT_FINISH_CATALOG), { ok: true, finishes: [] });
  });

  it("rejects unknown finishes, non-arrays and non-strings", () => {
    const unknown = parseShadeFinishesRequest({ finishes: ["creme", "sparkle-dust"] }, DEFAULT_FINISH_CATALOG);
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /Unknown finishes: sparkle-dust/);
    assert.equal(parseShadeFinishesRequest({ finishes: "creme" }, DEFAULT_FINISH_CATALOG).ok, false);
    assert.equal(parseShadeFinishesRequest({ finishes: [1] }, DEFAULT_FINISH_CATALOG).ok, false);
    assert.equal(parseShadeFinishesRequest([], DEFAULT_FINISH_CATALOG).ok, false);
  });
});

describe("PUT /api/shades-admin/{id}/finishes", () => {
  it("is admin-only", async () => {
    const res = await invoke({ userId: USER, body: { finishes: ["creme"] } });
    assert.equal(res.status, 403);
    assert.ok(!sqlCalls.some((c) => /UPDATE shade/i.test(c.sql)));
  });

  it("writes the list as admin, logs before/after and never touches the legacy finish", async () => {
    responder = shadeRow(["creme", "shimmer"]);
    const res = await invoke({ body: { finishes: ["thermal", "magnetic"] } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody, { shadeId: "42", finishes: ["thermal", "magnetic"], finishesSource: "admin", changed: true });

    const update = sqlCalls.find((c) => /UPDATE shade/i.test(c.sql));
    assert.ok(update && update.via === "tx");
    assert.match(update.sql, /finishes_source = 'admin'/);
    assert.doesNotMatch(update.sql, /\bfinish\s*=/);
    assert.deepEqual(update.params, [42, ["thermal", "magnetic"]]);

    const log = sqlCalls.find((c) => /INSERT INTO shade_category_change/i.test(c.sql));
    assert.ok(log && log.via === "tx");
    assert.match(log.sql, /'finishes'/);
    assert.deepEqual(JSON.parse(log.params[1]), { finishes: ["creme", "shimmer"], finishesSource: "rule" });
    assert.deepEqual(JSON.parse(log.params[2]), { finishes: ["thermal", "magnetic"], finishesSource: "admin" });
    assert.equal(log.params[3], ADMIN);
  });

  it("skips the write when the admin list is already exactly that", async () => {
    responder = shadeRow(["creme"], "admin");
    const res = await invoke({ body: { finishes: ["creme"] } });
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.changed, false);
    assert.ok(!sqlCalls.some((c) => /UPDATE shade|INSERT INTO shade_category_change/i.test(c.sql)));
  });

  it("makes a rule list sticky even when the finishes are unchanged", async () => {
    responder = shadeRow(["creme"], "rule");
    const res = await invoke({ body: { finishes: ["creme"] } });
    assert.equal(res.jsonBody.changed, true);
    assert.ok(sqlCalls.some((c) => /UPDATE shade/i.test(c.sql)));
  });

  it("answers 404 for a missing, merged or private user_submitted shade", async () => {
    const res = await invoke({ body: { finishes: ["creme"] } });
    assert.equal(res.status, 404);
    const read = sqlCalls.find((c) => /FOR UPDATE/i.test(c.sql));
    assert.match(read.sql, /status <> 'user_submitted'/);
    assert.match(read.sql, /merged_into_shade_id IS NULL/);
  });

  it("validates the id and the body before touching the shade", async () => {
    assert.equal((await invoke({ id: "abc", body: { finishes: [] } })).status, 400);
    assert.equal((await invoke({ rawBody: "{not json" })).status, 400);
    const unknown = await invoke({ body: { finishes: ["glitterbomb"] } });
    assert.equal(unknown.status, 400);
    assert.ok(!sqlCalls.some((c) => /FROM shade\s/i.test(c.sql)));
  });
});

describe("ingestion never changes an admin finish list", () => {
  it("applyIngestedFinishes leaves an admin list untouched, even for tag finishes", () => {
    assert.equal(applyIngestedFinishes(["creme"], { finishes: ["shimmer"], source: "tags" }, DEFAULT_FINISH_CATALOG, "admin"), null);
    assert.equal(applyIngestedFinishes([], { finishes: ["jelly"], source: "description" }, DEFAULT_FINISH_CATALOG, "admin"), null);
    assert.deepEqual(
      applyIngestedFinishes(["creme"], { finishes: ["shimmer"], source: "tags" }, DEFAULT_FINISH_CATALOG, "rule"),
      ["creme", "shimmer"]
    );
  });
});
