/**
 * PUT /api/reference-admin/finishes/{id} with a changed `name` renames the finish type and
 * cascades the rename atomically (#224 follow-up):
 *   - finish_type.name and every finish_normalization row targeting the old name change in ONE
 *     statement (the FK has no ON UPDATE CASCADE and is not deferrable);
 *   - shade.finishes / shade.detected_finishes entries are rewritten (case-insensitive, order kept,
 *     duplicates dropped), an empty finishes array is filled from a matching legacy finish, and the
 *     legacy shade.finish (raw vendor dedup key) is never written;
 *   - an alias old name -> new name is added;
 *   - 409 FINISH_TYPE_NAME_TAKEN when another finish type already has the name (any case);
 *   - caches (incl. the in-process finish catalog) are cleared only after a successful commit.
 *
 * Runs without a database. The fake below evaluates each statement against an in-memory model and
 * enforces the finish_normalization FK the way Postgres does (checked at the end of each
 * statement), so a handler that renamed without repointing in the same statement would fail here.
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
let transactions;
let failNext; // { match: RegExp, error } — makes the next matching statement throw

const key = (value) => value.trim().toLowerCase().replace(/\s+/g, " ");

function resetState() {
  sqlCalls = [];
  transactions = 0;
  failNext = null;
  state = {
    finishTypes: new Map([
      [1, { name: "creme", displayName: "Creme", description: null, sortOrder: 1 }],
      [2, { name: "Chrome", displayName: "Chrome", description: null, sortOrder: 20 }],
      [3, { name: "glitter", displayName: "Glitter", description: null, sortOrder: 6 }],
      [4, { name: "velvet", displayName: "Velvet", description: null, sortOrder: 21 }],
    ]),
    normalizations: [
      { source: "cream", target: "creme" },
      { source: "chrome finish", target: "Chrome" },
      { source: "mirror chrome", target: "Chrome" },
    ],
    shades: [
      { id: "A", finish: "chrome", finishes: ["chrome"], detected: null },
      { id: "B", finish: null, finishes: ["glitter", "Chrome"], detected: ["chrome", "glitter"] },
      { id: "C", finish: "Chrome ", finishes: [], detected: null }, // legacy only
      { id: "D", finish: "creme", finishes: ["creme"], detected: ["creme"] }, // untouched
      { id: "E", finish: null, finishes: ["mirror", "chrome", "glitter"], detected: null }, // dedupe
      { id: "F", finish: "creme", finishes: [], detected: ["chrome"] }, // detected only
    ],
  };
}
resetState();

function pgError(code, message) {
  return Object.assign(new Error(message), { code });
}

function typeRow(id) {
  const t = state.finishTypes.get(id);
  return {
    finishTypeId: id,
    name: t.name,
    displayName: t.displayName,
    description: t.description,
    sortOrder: t.sortOrder,
    createdAt: "2026-01-01 00:00:00+00",
    updatedAt: "2026-10-17 00:00:00+00",
    updatedByUserId: ADMIN,
  };
}

/** Apply `UPDATE finish_type SET a = $1, b = $2 ... WHERE finish_type_id = $n`. */
function applyFinishTypeUpdate(text, params) {
  const where = /WHERE\s+finish_type_id\s*=\s*\$(\d+)/i.exec(text);
  const id = Number(params[Number(where[1]) - 1]);
  const type = state.finishTypes.get(id);
  if (!type) return null;
  const setSection = /UPDATE\s+finish_type\s+SET([\s\S]*?)WHERE/i.exec(text)[1];
  const columns = { name: "name", display_name: "displayName", description: "description", sort_order: "sortOrder" };
  const next = { ...type };
  for (const [, column, index] of setSection.matchAll(/(\w+)\s*=\s*\$(\d+)/g)) {
    if (columns[column]) next[columns[column]] = params[Number(index) - 1];
  }
  if (next.name !== type.name) {
    for (const [otherId, other] of state.finishTypes) {
      if (otherId !== id && other.name === next.name) throw pgError("23505", "duplicate key finish_type_name_key");
    }
  }
  return { id, before: type, after: next };
}

function checkNormalizationFk() {
  const names = new Set([...state.finishTypes.values()].map((t) => t.name));
  for (const n of state.normalizations) {
    if (!names.has(n.target)) {
      throw pgError("23503", `finish_normalization_normalized_finish_name_fkey: (${n.target}) is still referenced`);
    }
  }
}

function renameArray(values, oldKey, newKey) {
  const out = [];
  for (const value of values) {
    const next = key(value) === oldKey ? newKey : value;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

function fakeQuery(sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ sql: text, params });

  if (failNext && failNext.match.test(text)) {
    const { error } = failNext;
    failNext = null;
    throw error;
  }

  if (/FROM\s+app_user/i.test(text)) {
    return { rows: [{ user_id: ADMIN, external_id: "ext-admin", email: "admin@test.dev", role: "admin" }] };
  }

  // loadFinishCatalog
  if (/UNION ALL/i.test(text) && /FROM\s+finish_normalization/i.test(text)) {
    return {
      rows: [
        ...state.normalizations.map((n) => ({ kind: "alias", sourceValue: n.source, normalizedFinishName: n.target })),
        ...[...state.finishTypes.values()].map((t) => ({ kind: "type", sourceValue: t.name, normalizedFinishName: t.name })),
      ],
    };
  }

  // Lock + read the row being updated.
  if (/FROM\s+finish_type[\s\S]*FOR\s+UPDATE/i.test(text)) {
    const id = Number(params[0]);
    const t = state.finishTypes.get(id);
    return { rows: t ? [{ finishTypeId: id, name: t.name, displayName: t.displayName }] : [] };
  }

  // Name conflict check.
  if (/finish_type_id\s*<>\s*\$1/i.test(text)) {
    const id = Number(params[0]);
    const caseInsensitive = /lower\(/i.test(text);
    const wanted = String(params[1]);
    for (const [otherId, t] of state.finishTypes) {
      if (otherId === id) continue;
      if (caseInsensitive ? key(t.name) === wanted : t.name === wanted) {
        return { rows: [{ finishTypeId: otherId, name: t.name }] };
      }
    }
    return { rows: [] };
  }

  // Rename: finish_type + finish_normalization repoint (FK checked at END of the statement).
  if (/UPDATE\s+finish_type/i.test(text)) {
    const change = applyFinishTypeUpdate(text, params);
    if (!change) return { rows: [], rowCount: 0 };
    const snapshot = { types: new Map(state.finishTypes), norms: state.normalizations.map((n) => ({ ...n })) };
    state.finishTypes.set(change.id, change.after);
    let repointed = 0;
    if (/UPDATE\s+finish_normalization/i.test(text)) {
      const oldName = params[params.length - 1];
      for (const n of state.normalizations) {
        if (n.target === oldName) {
          n.target = change.after.name;
          repointed += 1;
        }
      }
    }
    try {
      checkNormalizationFk();
    } catch (error) {
      state.finishTypes = snapshot.types;
      state.normalizations = snapshot.norms;
      throw error;
    }
    const row = typeRow(change.id);
    return { rows: [/WITH\s+updated/i.test(text) ? { ...row, normalizationCount: repointed } : row], rowCount: 1 };
  }

  // Shade finish rewrite.
  if (/UPDATE\s+shade/i.test(text)) {
    const [oldKey, newKey] = params;
    let count = 0;
    for (const s of state.shades) {
      const inFinishes = s.finishes.some((f) => key(f) === oldKey);
      const legacyOnly = s.finishes.length === 0 && typeof s.finish === "string" && key(s.finish) === oldKey;
      const inDetected = Array.isArray(s.detected) && s.detected.some((f) => key(f) === oldKey);
      if (!inFinishes && !legacyOnly && !inDetected) continue;
      s.finishes = legacyOnly ? [newKey] : renameArray(s.finishes, oldKey, newKey);
      if (s.detected) s.detected = renameArray(s.detected, oldKey, newKey);
      count += 1;
    }
    return { rows: [{ shadeCount: count }], rowCount: 1 };
  }

  // Alias for the old spelling.
  if (/INSERT\s+INTO\s+finish_normalization/i.test(text)) {
    const [source, target] = params;
    if (state.normalizations.some((n) => key(n.source) === source)) return { rows: [], rowCount: 0 };
    state.normalizations.push({ source, target });
    checkNormalizationFk();
    return { rows: [{ finish_normalization_id: 99 }], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
}

/** Transaction: one client, all-or-nothing (state restored when the callback throws). */
async function fakeTransaction(callback) {
  transactions += 1;
  const snapshot = {
    types: new Map([...state.finishTypes].map(([id, t]) => [id, { ...t }])),
    norms: state.normalizations.map((n) => ({ ...n })),
    shades: state.shades.map((s) => ({ ...s, finishes: [...s.finishes], detected: s.detected && [...s.detected] })),
  };
  const client = { query: async (sql, params) => fakeQuery(sql, params), inTransaction: true };
  try {
    return await callback(client);
  } catch (error) {
    state.finishTypes = snapshot.types;
    state.normalizations = snapshot.norms;
    state.shades = snapshot.shades;
    throw error;
  }
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
  for (const k of Object.keys(mockModules)) {
    if (request === k || request.endsWith(k)) return k;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

registerMock("@azure/functions", {
  app: { http: (name, opts) => { registeredRoutes[name] = opts; }, storageQueue: () => {}, timer: () => {} },
  output: { storageQueue: (opts) => ({ __type: "storageQueue", ...opts }) },
});
registerMock("jose", { createRemoteJWKSet: () => {}, jwtVerify: async () => { throw new Error("not used"); } });
const outsideTransaction = [];
const dbMock = {
  query: async (sql, params) => {
    if (/finish_type|finish_normalization|shade/i.test(String(sql)) && !/UNION ALL/i.test(String(sql))) {
      outsideTransaction.push(String(sql));
    }
    return fakeQuery(sql, params);
  },
  transaction: (callback) => fakeTransaction(callback),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const {
  finishTypeNameTakenMessage,
  RENAME_SHADE_FINISHES_SQL,
  FINISH_NAME_CONFLICT_SQL,
  FINISH_RENAME_ALIAS_SQL,
} = require("../dist/functions/admin-reference");
const { loadFinishCatalog, resetFinishAliasCache } = require("../dist/lib/finishes");

function fakeRequest(id, body) {
  const headers = new Map([["authorization", `Bearer dev:${ADMIN}`]]);
  const url = `http://localhost:7071/api/reference-admin/finishes/${id}`;
  return {
    method: "PUT",
    url,
    headers: { get: (n) => headers.get(n.toLowerCase()) || null },
    params: { id: String(id) },
    query: new URL(url).searchParams,
    json: async () => body,
  };
}
const fakeContext = () => ({ log() {}, error() {}, warn() {}, invocationId: "test-invocation" });

async function putFinishType(id, body) {
  const route = registeredRoutes["admin-finish-item"];
  assert.ok(route, "admin-finish-item route should be registered");
  return route.handler(fakeRequest(id, body), fakeContext());
}

const catalogQueries = () => sqlCalls.filter((c) => /UNION ALL/i.test(c.sql));
const writes = () => sqlCalls.filter((c) => /^\s*(WITH|UPDATE|INSERT)/i.test(c.sql));
const shade = (id) => state.shades.find((s) => s.id === id);

beforeEach(() => {
  resetState();
  outsideTransaction.length = 0;
  resetFinishAliasCache();
  process.env.AUTH_DEV_BYPASS = "true";
});
afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
});

describe("PUT /api/reference-admin/finishes/{id} — rename cascade", () => {
  it("renames the type and cascades to normalizations, shade finishes and a new alias in one transaction", async () => {
    const res = await putFinishType(2, { name: "Mirror", displayName: "Mirror" });

    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.name, "Mirror");
    assert.equal(res.jsonBody.displayName, "Mirror");
    assert.deepEqual(res.jsonBody.rename, {
      previousName: "Chrome",
      shadeCount: 5,
      normalizationCount: 2,
      aliasCreated: true,
    });

    assert.equal(transactions, 1);
    assert.deepEqual(outsideTransaction, [], "every finish/shade statement runs on the transaction client");

    assert.equal(state.finishTypes.get(2).name, "Mirror");
    assert.deepEqual(
      state.normalizations.map((n) => [n.source, n.target]),
      [
        ["cream", "creme"],
        ["chrome finish", "Mirror"],
        ["mirror chrome", "Mirror"],
        ["chrome", "Mirror"],
      ]
    );
  });

  it("rewrites shade finishes case-insensitively, keeps order, drops duplicates and never writes legacy finish", async () => {
    await putFinishType(2, { name: "Mirror" });

    assert.deepEqual(shade("A").finishes, ["mirror"]);
    assert.deepEqual(shade("B").finishes, ["glitter", "mirror"], "order kept");
    assert.deepEqual(shade("B").detected, ["mirror", "glitter"]);
    assert.deepEqual(shade("C").finishes, ["mirror"], "legacy-only shade gets finishes filled");
    assert.deepEqual(shade("D").finishes, ["creme"], "unrelated shade untouched");
    assert.deepEqual(shade("E").finishes, ["mirror", "glitter"], "duplicate collapsed to its first position");
    assert.deepEqual(shade("F").finishes, [], "a detected-only match does not invent finishes");
    assert.deepEqual(shade("F").detected, ["mirror"]);

    // The legacy identity key stays the raw vendor value.
    assert.equal(shade("A").finish, "chrome");
    assert.equal(shade("C").finish, "Chrome ");

    const shadeCall = sqlCalls.find((c) => /UPDATE\s+shade/i.test(c.sql));
    assert.deepEqual(shadeCall.params, ["chrome", "mirror"], "shades are matched and written by finish key");
  });

  it("renaming SQL: one statement for name + repoint, legacy finish column never assigned", async () => {
    await putFinishType(2, { name: "Mirror" });
    const renameStatement = writes().find((c) => /UPDATE\s+finish_type/i.test(c.sql));
    assert.match(renameStatement.sql, /UPDATE\s+finish_normalization/i, "repoint must share the finish_type UPDATE statement");

    assert.doesNotMatch(RENAME_SHADE_FINISHES_SQL, /(^|[\s,])finish\s*=/m, "shade.finish must never be assigned");
    assert.match(RENAME_SHADE_FINISHES_SQL, /WITH ORDINALITY/i);
    assert.match(RENAME_SHADE_FINISHES_SQL, /ORDER BY d\.first_ord/i);
    assert.match(RENAME_SHADE_FINISHES_SQL, /detected_finishes\s*=/i);
    assert.match(FINISH_NAME_CONFLICT_SQL, /lower\(name\)/i, "conflict check is case-insensitive");
    assert.match(FINISH_RENAME_ALIAS_SQL, /ON CONFLICT \(source_value\) DO NOTHING/i);
  });

  it("returns 409 FINISH_TYPE_NAME_TAKEN when another finish type has the name, and changes nothing", async () => {
    const before = JSON.stringify(state);
    const res = await putFinishType(2, { name: "glitter" });

    assert.equal(res.status, 409);
    assert.deepEqual(res.jsonBody, {
      error: 'Cannot rename finish "Chrome" to "glitter": finish type "glitter" already exists.',
      code: "FINISH_TYPE_NAME_TAKEN",
      finishTypeId: 2,
      name: "Chrome",
      requestedName: "glitter",
      conflictingFinishTypeId: 3,
      conflictingName: "glitter",
    });
    assert.equal(writes().length, 0, "no write statement runs");
    assert.equal(JSON.stringify(state), before);
  });

  it("treats a differently-cased or spaced name of another type as taken", async () => {
    const res = await putFinishType(2, { name: "  GLITTER " });
    assert.equal(res.status, 409);
    assert.equal(res.jsonBody.code, "FINISH_TYPE_NAME_TAKEN");
    assert.equal(res.jsonBody.requestedName, "GLITTER");
    assert.equal(state.finishTypes.get(2).name, "Chrome");
  });

  it("allows a case-only rename: repoints normalizations (FK is exact), leaves shades, adds no alias", async () => {
    const res = await putFinishType(2, { name: "chrome" });

    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.name, "chrome");
    assert.deepEqual(res.jsonBody.rename, {
      previousName: "Chrome",
      shadeCount: 0,
      normalizationCount: 2,
      aliasCreated: false,
    });
    assert.equal(sqlCalls.filter((c) => /UPDATE\s+shade/i.test(c.sql)).length, 0);
    assert.equal(sqlCalls.filter((c) => /INSERT\s+INTO\s+finish_normalization/i.test(c.sql)).length, 0);
    assert.deepEqual(shade("B").finishes, ["glitter", "Chrome"]);
  });

  it("does not add an alias when one already claims the old spelling", async () => {
    state.normalizations.push({ source: "Velvet", target: "creme" });
    const res = await putFinishType(4, { name: "satin" });
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.rename.aliasCreated, false);
    assert.equal(state.normalizations.filter((n) => key(n.source) === "velvet").length, 1);
  });

  it("an update without a name change stays a plain update (no cascade, no rename summary)", async () => {
    const res = await putFinishType(2, { name: "Chrome", sortOrder: 30 });
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.sortOrder, 30);
    assert.equal("rename" in res.jsonBody, false);
    assert.equal(sqlCalls.filter((c) => /UPDATE\s+(shade|finish_normalization)/i.test(c.sql)).length, 0);
    assert.equal(sqlCalls.filter((c) => /finish_type_id\s*<>\s*\$1/i.test(c.sql)).length, 0);
  });

  it("returns 404 for a missing finish type", async () => {
    const res = await putFinishType(999, { name: "x" });
    assert.equal(res.status, 404);
    assert.equal(writes().length, 0);
  });

  it("maps a concurrent unique violation to 409", async () => {
    failNext = { match: /UPDATE\s+finish_type/i, error: pgError("23505", "duplicate key") };
    const res = await putFinishType(2, { name: "Mirror" });
    assert.equal(res.status, 409);
    assert.equal(res.jsonBody.code, "FINISH_TYPE_NAME_TAKEN");
  });
});

describe("rename cache invalidation", () => {
  it("reloads the finish catalog after a successful rename", async () => {
    await loadFinishCatalog();
    await loadFinishCatalog();
    assert.equal(catalogQueries().length, 1, "second load is served from cache");

    const res = await putFinishType(2, { name: "Mirror" });
    assert.equal(res.status, 200);

    const catalog = await loadFinishCatalog();
    assert.equal(catalogQueries().length, 2, "the catalog is reloaded after a rename");
    assert.ok(catalog.validNames.has("mirror"));
    assert.ok(!catalog.validNames.has("chrome"));
    assert.equal(catalog.aliases.get("chrome"), "mirror", "the old spelling resolves to the new name");
  });

  it("keeps the cache when the rename is refused (409)", async () => {
    await loadFinishCatalog();
    const res = await putFinishType(2, { name: "glitter" });
    assert.equal(res.status, 409);
    await loadFinishCatalog();
    assert.equal(catalogQueries().length, 1);
  });

  it("rolls everything back and keeps the cache when a cascade step fails", async () => {
    await loadFinishCatalog();
    failNext = { match: /UPDATE\s+shade/i, error: pgError("40P01", "deadlock detected") };

    const res = await putFinishType(2, { name: "Mirror" });

    assert.equal(res.status, 500);
    assert.equal(state.finishTypes.get(2).name, "Chrome", "finish_type rename rolled back");
    assert.equal(state.normalizations.filter((n) => n.target === "Chrome").length, 2, "repoint rolled back");
    await loadFinishCatalog();
    assert.equal(catalogQueries().length, 1, "a failed rename leaves the cache valid");
  });
});

describe("finishTypeNameTakenMessage", () => {
  it("names the finish, the requested name and the existing type", () => {
    assert.equal(
      finishTypeNameTakenMessage("Chrome", "Glitter", "glitter"),
      'Cannot rename finish "Chrome" to "Glitter": finish type "glitter" already exists.'
    );
  });
});
