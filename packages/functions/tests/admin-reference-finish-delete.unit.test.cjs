/**
 * DELETE /api/reference-admin/finishes/{id} refuses to delete an in-use finish type
 * (#224, decision 2a): 409 + usage counts when any shade (`shade.finishes` or the legacy
 * `shade.finish`) or finish_normalization alias still references it.
 *
 * Runs without a database. The fake below evaluates the delete statement against an in-memory
 * model, applying each usage guard ONLY when the SQL actually contains it, so dropping a guard
 * from the handler makes these tests fail.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const ADMIN = 7;
let state;
let sqlCalls;

function resetState() {
  sqlCalls = [];
  state = {
    finishTypes: new Map([
      [1, { name: "creme", displayName: "Creme" }],
      [2, { name: "chrome", displayName: "Chrome" }], // admin-added, used via shade.finishes
      [3, { name: "velvet", displayName: "Velvet" }], // unused
      [4, { name: "Jelly", displayName: "Jelly" }], // mixed-case name, used only via legacy shade.finish
    ]),
    shades: [
      { finish: "creme", finishes: ["creme"] },
      { finish: null, finishes: ["creme", "chrome"] },
      { finish: "chrome", finishes: ["chrome"] },
      { finish: " jelly ", finishes: [] },
    ],
    normalizations: [{ source: "cream", target: "creme" }],
  };
}
resetState();

function fakeQuery(sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ sql: text, params });

  if (/FROM\s+app_user/i.test(text)) {
    return { rows: [{ user_id: ADMIN, external_id: "ext-admin", email: "admin@test.dev", role: "admin" }] };
  }

  if (/DELETE\s+FROM\s+finish_type/i.test(text)) {
    const id = Number(params[0]);
    const type = state.finishTypes.get(id);
    if (!type) return { rows: [], rowCount: 0 };
    const key = type.name.trim().toLowerCase();
    const checksArray = /s\.finishes\s*@>\s*ARRAY\[t\.finish_key\]/i.test(text);
    const checksLegacy = /lower\(btrim\(s\.finish\)\)\s*=\s*t\.finish_key/i.test(text);
    const checksAliases = /FROM\s+finish_normalization/i.test(text);
    const shadeCount = state.shades.filter(
      (s) =>
        (checksArray && s.finishes.includes(key)) ||
        (checksLegacy && typeof s.finish === "string" && s.finish.trim().toLowerCase() === key)
    ).length;
    const normalizationCount = checksAliases ? state.normalizations.filter((n) => n.target === type.name).length : 0;
    const guarded = /u\.shade_count\s*=\s*0/i.test(text) && /u\.normalization_count\s*=\s*0/i.test(text);
    const deleted = !guarded || (shadeCount === 0 && normalizationCount === 0);
    if (deleted) state.finishTypes.delete(id);
    return {
      rows: [{ finishTypeId: id, name: type.name, displayName: type.displayName, shadeCount, normalizationCount, deleted }],
      rowCount: 1,
    };
  }

  // loadFinishCatalog
  if (/FROM\s+finish_normalization/i.test(text) && /FROM\s+finish_type/i.test(text)) {
    return {
      rows: [...state.finishTypes.values()].map((t) => ({ kind: "type", sourceValue: t.name, normalizedFinishName: t.name })),
    };
  }

  return { rows: [], rowCount: 0 };
}

// ---------------------------------------------------------------------------
// Module mocking (same approach as the other handler tests)
// ---------------------------------------------------------------------------

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
  app: { http: (name, opts) => { registeredRoutes[name] = opts; }, storageQueue: () => {}, timer: () => {} },
  output: { storageQueue: (opts) => ({ __type: "storageQueue", ...opts }) },
});
registerMock("jose", { createRemoteJWKSet: () => {}, jwtVerify: async () => { throw new Error("not used"); } });
const dbMock = {
  query: async (sql, params) => fakeQuery(sql, params),
  transaction: async () => { throw new Error("not used"); },
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const { finishTypeInUseMessage } = require("../dist/functions/admin-reference");
const { loadFinishCatalog, resetFinishAliasCache } = require("../dist/lib/finishes");

function fakeRequest(id) {
  const headers = new Map([["authorization", `Bearer dev:${ADMIN}`]]);
  const url = `http://localhost:7071/api/reference-admin/finishes/${id}`;
  return {
    method: "DELETE",
    url,
    headers: { get: (n) => headers.get(n.toLowerCase()) || null },
    params: { id: String(id) },
    query: new URL(url).searchParams,
    json: async () => ({}),
  };
}
const fakeContext = () => ({ log() {}, error() {}, warn() {}, invocationId: "test-invocation" });

async function deleteFinishType(id) {
  const route = registeredRoutes["admin-finish-item"];
  assert.ok(route, "admin-finish-item route should be registered");
  return route.handler(fakeRequest(id), fakeContext());
}

const catalogQueries = () => sqlCalls.filter((c) => /FROM\s+finish_normalization/i.test(c.sql) && /UNION ALL/i.test(c.sql));

beforeEach(() => {
  resetState();
  resetFinishAliasCache();
  process.env.AUTH_DEV_BYPASS = "true";
});
afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
});

describe("DELETE /api/reference-admin/finishes/{id} — in-use guard", () => {
  it("returns 409 with usage counts when shades use the finish type (finishes array + legacy finish)", async () => {
    const res = await deleteFinishType(2);
    assert.equal(res.status, 409);
    assert.deepEqual(
      { ...res.jsonBody, error: undefined },
      {
        error: undefined,
        code: "FINISH_TYPE_IN_USE",
        finishTypeId: 2,
        name: "chrome",
        shadeCount: 2,
        normalizationCount: 0,
      }
    );
    assert.equal(
      res.jsonBody.error,
      'Cannot delete finish "Chrome": it is still used by 2 shades. Remove it from those shades first.'
    );
    assert.ok(state.finishTypes.has(2), "the finish type must not be deleted");
  });

  it("counts a shade that only carries the finish in the legacy column (case-insensitive)", async () => {
    const res = await deleteFinishType(4);
    assert.equal(res.status, 409);
    assert.equal(res.jsonBody.shadeCount, 1);
    assert.match(res.jsonBody.error, /1 shade\b/);
    assert.ok(state.finishTypes.has(4));
  });

  it("reports finish_normalization aliases alongside shade usage", async () => {
    const res = await deleteFinishType(1);
    assert.equal(res.status, 409);
    assert.equal(res.jsonBody.shadeCount, 2);
    assert.equal(res.jsonBody.normalizationCount, 1);
    assert.match(res.jsonBody.error, /2 shades and 1 finish normalization\b/);
    assert.match(res.jsonBody.error, /delete or repoint its normalizations/);
  });

  it("deletes an unused finish type and resets the finish catalog cache", async () => {
    await loadFinishCatalog();
    assert.equal(catalogQueries().length, 1);
    await loadFinishCatalog();
    assert.equal(catalogQueries().length, 1, "second load is served from cache");

    const res = await deleteFinishType(3);
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.finishTypeId, 3);
    assert.ok(!state.finishTypes.has(3));

    const catalog = await loadFinishCatalog();
    assert.equal(catalogQueries().length, 2, "the catalog is reloaded after a delete");
    assert.ok(!catalog.validNames.has("velvet"));
  });

  it("keeps the finish catalog cache when the delete is refused", async () => {
    await loadFinishCatalog();
    const res = await deleteFinishType(2);
    assert.equal(res.status, 409);
    await loadFinishCatalog();
    assert.equal(catalogQueries().length, 1, "a refused delete changes nothing, so the cache stays valid");
  });

  it("checks usage and deletes in a single statement", async () => {
    await deleteFinishType(3);
    const statements = sqlCalls.filter((c) => /finish_type/i.test(c.sql) && !/UNION ALL/i.test(c.sql));
    assert.equal(statements.length, 1);
    assert.equal(statements[0].params[0], 3);
  });

  it("returns 404 for a missing finish type", async () => {
    const res = await deleteFinishType(999);
    assert.equal(res.status, 404);
  });
});

describe("finishTypeInUseMessage", () => {
  it("pluralizes and names only the uses that exist", () => {
    assert.equal(
      finishTypeInUseMessage("Chrome", 1, 0),
      'Cannot delete finish "Chrome": it is still used by 1 shade. Remove it from that shade first.'
    );
    assert.equal(
      finishTypeInUseMessage("Chrome", 0, 2),
      'Cannot delete finish "Chrome": it is still used by 2 finish normalizations. Delete or repoint its normalizations first.'
    );
  });
});
