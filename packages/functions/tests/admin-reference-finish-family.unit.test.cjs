/**
 * `finish_type.family` (#320) through the API: admin create/update validate and store it,
 * `GET /api/reference/finishes` and the admin list return it, and `loadFinishCatalog()` exposes
 * it as `families` for dupe grading.
 *
 * Runs without a database (same require-interception mocking as the other handler tests). The fake
 * DB records every statement and answers the few shapes these handlers issue.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const ADMIN = 7;
let sqlCalls;
let finishTypes;

function resetState() {
  sqlCalls = [];
  finishTypes = new Map([
    [1, { name: "creme", displayName: "Creme", description: null, sortOrder: 1, family: "solid" }],
    [2, { name: "velvet", displayName: "Velvet", description: null, sortOrder: 20, family: null }],
  ]);
}
resetState();

function typeRow(id) {
  const t = finishTypes.get(id);
  return {
    finishTypeId: id,
    name: t.name,
    displayName: t.displayName,
    description: t.description,
    sortOrder: t.sortOrder,
    family: t.family,
    createdAt: "2026-01-01 00:00:00+00",
    updatedAt: "2026-10-18 00:00:00+00",
    updatedByUserId: ADMIN,
  };
}

function fakeQuery(sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ sql: text, params });

  if (/FROM\s+app_user/i.test(text)) {
    return { rows: [{ user_id: ADMIN, external_id: "ext-admin", email: "admin@test.dev", role: "admin" }] };
  }
  if (/UNION ALL/i.test(text) && /FROM\s+finish_normalization/i.test(text)) {
    return {
      rows: [
        { kind: "alias", sourceValue: "cream", normalizedFinishName: "creme", family: null },
        ...[...finishTypes.values()].map((t) => ({
          kind: "type",
          sourceValue: t.name,
          normalizedFinishName: t.name,
          family: t.family,
        })),
      ],
    };
  }
  if (/INSERT\s+INTO\s+finish_type/i.test(text)) {
    const columns = /INSERT\s+INTO\s+finish_type\s*\(([^)]*)\)/i.exec(text)[1].split(",").map((c) => c.trim());
    assert.ok(columns.includes("family"), "INSERT must write the family column");
    const [name, displayName, description, sortOrder, family] = params;
    const id = finishTypes.size + 1;
    finishTypes.set(id, { name, displayName, description, sortOrder, family });
    return { rows: [typeRow(id)], rowCount: 1 };
  }
  if (/FROM\s+finish_type[\s\S]*FOR\s+UPDATE/i.test(text)) {
    const id = Number(params[0]);
    const t = finishTypes.get(id);
    return { rows: t ? [{ finishTypeId: id, name: t.name, displayName: t.displayName }] : [] };
  }
  if (/UPDATE\s+finish_type/i.test(text)) {
    const id = Number(params[Number(/WHERE\s+finish_type_id\s*=\s*\$(\d+)/i.exec(text)[1]) - 1]);
    const t = finishTypes.get(id);
    const columns = { display_name: "displayName", description: "description", sort_order: "sortOrder", family: "family" };
    const setSection = /SET([\s\S]*?)WHERE/i.exec(text)[1];
    for (const [, column, index] of setSection.matchAll(/(\w+)\s*=\s*\$(\d+)/g)) {
      if (columns[column]) t[columns[column]] = params[Number(index) - 1];
    }
    return { rows: [typeRow(id)], rowCount: 1 };
  }
  if (/FROM\s+finish_type/i.test(text)) {
    assert.match(text, /\bfamily\b/, "finish type SELECTs must read family");
    return { rows: [...finishTypes.keys()].map(typeRow) };
  }
  return { rows: [], rowCount: 0 };
}

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
const dbMock = {
  query: async (sql, params) => fakeQuery(sql, params),
  transaction: async (callback) => callback({ query: async (sql, params) => fakeQuery(sql, params) }),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

require("../dist/functions/admin-reference");
require("../dist/functions/reference");
const { loadFinishCatalog, resetFinishAliasCache } = require("../dist/lib/finishes");
const { finishCompatibility } = require("swatchwatch-shared");

function fakeRequest({ method, url, id, body }) {
  const headers = new Map([["authorization", `Bearer dev:${ADMIN}`]]);
  return {
    method,
    url,
    headers: { get: (n) => headers.get(n.toLowerCase()) || null },
    params: id === undefined ? {} : { id: String(id) },
    query: new URL(url).searchParams,
    json: async () => body,
  };
}
const fakeContext = () => ({ log() {}, error() {}, warn() {}, invocationId: "test-invocation" });

const ADMIN_URL = "http://localhost:7071/api/reference-admin/finishes";
const postFinish = (body) =>
  registeredRoutes["admin-finishes"].handler(fakeRequest({ method: "POST", url: ADMIN_URL, body }), fakeContext());
const putFinish = (id, body) =>
  registeredRoutes["admin-finish-item"].handler(
    fakeRequest({ method: "PUT", url: `${ADMIN_URL}/${id}`, id, body }),
    fakeContext()
  );
const writes = () => sqlCalls.filter((c) => /^\s*(WITH|UPDATE|INSERT)/i.test(c.sql));

beforeEach(() => {
  resetState();
  resetFinishAliasCache();
  process.env.AUTH_DEV_BYPASS = "true";
});
afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
});

describe("POST /api/reference-admin/finishes — family", () => {
  it("stores a valid family (normalized) and returns it", async () => {
    const res = await postFinish({ name: "chrome", displayName: "Chrome", family: " Shimmer " });
    assert.equal(res.status, 201);
    assert.equal(res.jsonBody.family, "shimmer");
    const insert = writes().find((c) => /INSERT\s+INTO\s+finish_type/i.test(c.sql));
    assert.ok(insert.params.includes("shimmer"));
  });

  it("creates without a family when it is omitted or null", async () => {
    const omitted = await postFinish({ name: "chrome", displayName: "Chrome" });
    assert.equal(omitted.status, 201);
    assert.equal(omitted.jsonBody.family, null);
    const cleared = await postFinish({ name: "velour", displayName: "Velour", family: null });
    assert.equal(cleared.status, 201);
    assert.equal(cleared.jsonBody.family, null);
  });

  it("rejects an unknown family with 400 before writing", async () => {
    for (const family of ["sparkle", "holographic", 1]) {
      const res = await postFinish({ name: "chrome", displayName: "Chrome", family });
      assert.equal(res.status, 400, JSON.stringify(family));
      assert.match(res.jsonBody.error, /family must be one of/);
    }
    assert.deepEqual(writes(), []);
  });
});

describe("PUT /api/reference-admin/finishes/{id} — family", () => {
  it("a family-only update is accepted and writes `family`", async () => {
    const res = await putFinish(2, { family: "matte" });
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.family, "matte");
    const update = writes().find((c) => /UPDATE\s+finish_type/i.test(c.sql));
    assert.match(update.sql, /family = \$1/);
    assert.equal(update.params[0], "matte");
  });

  it("null clears the family", async () => {
    const res = await putFinish(1, { family: null });
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.family, null);
    assert.equal(finishTypes.get(1).family, null);
  });

  it("omitting family leaves it unchanged", async () => {
    const res = await putFinish(1, { displayName: "Crème" });
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.family, "solid");
    const update = writes().find((c) => /UPDATE\s+finish_type/i.test(c.sql));
    assert.doesNotMatch(update.sql, /\bfamily\b\s*=/);
  });

  it("rejects an unknown family with 400 before writing", async () => {
    const res = await putFinish(2, { family: "sparkle" });
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /family must be one of/);
    assert.deepEqual(writes(), []);
  });

  it("an empty body names family among the accepted fields", async () => {
    const res = await putFinish(2, {});
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /family/);
  });
});

describe("reading finish families", () => {
  it("GET /api/reference/finishes returns family (null when none)", async () => {
    const res = await registeredRoutes["reference-finishes"].handler(
      fakeRequest({ method: "GET", url: "http://localhost:7071/api/reference/finishes" }),
      fakeContext()
    );
    assert.equal(res.status, 200);
    const byName = Object.fromEntries(res.jsonBody.finishTypes.map((t) => [t.name, t]));
    assert.equal(byName.creme.family, "solid");
    assert.equal(byName.velvet.family, null);
  });

  it("GET /api/reference-admin/finishes returns family", async () => {
    const res = await registeredRoutes["admin-finishes"].handler(
      fakeRequest({ method: "GET", url: ADMIN_URL }),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.finishTypes.find((t) => t.name === "creme").family, "solid");
  });

  it("loadFinishCatalog exposes catalog families layered over the built-ins", async () => {
    finishTypes.get(2).family = "matte";
    const catalog = await loadFinishCatalog();
    assert.equal(catalog.families.creme, "solid");
    assert.equal(catalog.families.velvet, "matte");
    assert.equal(catalog.families.holographic, "holo", "built-ins missing from the catalog keep their family");
    assert.equal(finishCompatibility(["velvet"], ["creme"], catalog.families), "different");
  });
});
