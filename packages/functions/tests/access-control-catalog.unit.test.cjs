/**
 * Shared-catalog access control (issue #47, findings F1 + F2).
 *
 *  F1: user input may only FILL an empty `shade.finishes`; it never rewrites a shared shade
 *      (exception: the caller's own `user_submitted` shade).
 *  F2: shades created through the user API are `user_submitted` + `created_by_user_id`, and are
 *      visible only to their creator / users holding them in inventory.
 *
 * Runs without a database. The fake DB below implements just the statements these handlers
 * issue, and it applies a guard (visibility predicate, "finishes is empty" guard) ONLY when the
 * SQL text actually contains it — so a handler that drops the guard visibly changes state.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

process.env.IMAGE_PROXY_SIGNING_KEY = "access-control-catalog-test-signing-key-0123456789";
delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const USER_A = 1;
const USER_B = 2;
const USERS = {
  [USER_A]: { user_id: USER_A, external_id: "ext-a", email: "a@test.dev", role: "user" },
  [USER_B]: { user_id: USER_B, external_id: "ext-b", email: "b@test.dev", role: "user" },
};

const CATALOG_SHADE = 100; // active, finishes ['creme']
const EMPTY_FINISH_SHADE = 101; // active, finishes []
const A_PRIVATE_SHADE = 200; // user_submitted by A
const B_PRIVATE_SHADE = 300; // user_submitted by B

let sqlCalls = [];
let state;

function resetState() {
  sqlCalls = [];
  const mk = (id, brandId, name, finish, finishes, status, createdBy) => ({
    id, brandId, name, finish, finishes, status, createdBy,
  });
  state = {
    nextShadeId: 1000,
    brands: new Map([["Acme", 1], ["Other", 2]]),
    nextBrandId: 10,
    shades: new Map(
      [
        { ...mk(CATALOG_SHADE, 1, "Catalog Red", "creme", ["creme"], "active", null), vendorHex: "#aa0000" },
        mk(EMPTY_FINISH_SHADE, 1, "Blank Blue", "creme", [], "active", null),
        { ...mk(A_PRIVATE_SHADE, 1, "A Secret", "creme", ["creme"], "user_submitted", USER_A), vendorHex: "#111111" },
        mk(B_PRIVATE_SHADE, 1, "B Secret", "creme", ["glitter"], "user_submitted", USER_B),
      ].map((s) => [s.id, s])
    ),
    inventory: new Set(), // `${userId}:${shadeId}`
  };
}
resetState();

function visibleTo(shade, userId) {
  return (
    shade.status !== "user_submitted" ||
    shade.createdBy === userId ||
    state.inventory.has(`${userId}:${shade.id}`)
  );
}

/**
 * True only if the SQL carries the real visibility predicate — `status <> 'user_submitted'` plus a
 * `created_by_user_id = $N` bound to the caller — so the fake enforces visibility only then. A
 * query that keeps the literal but drops (or mis-binds) the ownership check is treated as unguarded.
 */
function hasVisibilityGuard(sql, params, userId) {
  if (!/status\s*<>\s*'user_submitted'/i.test(sql)) return false;
  const owner = sql.match(/created_by_user_id\s*=\s*\$(\d+)/i);
  return Boolean(owner) && Number(params[Number(owner[1]) - 1]) === Number(userId);
}

function brandName(brandId) {
  for (const [name, id] of state.brands) if (id === brandId) return name;
  return null;
}

function polishRow(shade, userId) {
  const inInv = state.inventory.has(`${userId}:${shade.id}`);
  return {
    id: String(shade.id),
    shadeId: String(shade.id),
    inventoryItemId: inInv ? `inv-${userId}-${shade.id}` : null,
    userId: String(userId),
    brand: "Acme",
    name: shade.name,
    color: "",
    finish: shade.finish || "",
    finishes: [...shade.finishes],
    collection: "",
    swatchImageUrl: null,
    quantity: inInv ? 1 : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function fakeQuery(via, sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ via, sql: text, params });

  if (/FROM\s+app_user/i.test(text) && /WHERE\s+user_id\s*=\s*\$1/i.test(text)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }

  if (/^\s*INSERT\s+INTO\s+brand\b/i.test(text)) {
    if (!state.brands.has(params[0])) state.brands.set(params[0], state.nextBrandId++);
    return { rows: [], rowCount: 1 };
  }
  if (/^\s*SELECT\s+brand_id\s+FROM\s+brand/i.test(text)) {
    return { rows: [{ brand_id: state.brands.get(params[0]) }], rowCount: 1 };
  }

  // findOrCreateShade lookup: [brandId, name, finish, userId]
  if (/AS\s+own_submitted/i.test(text)) {
    const [brandId, name, finish, userId] = params;
    let matches = [...state.shades.values()].filter(
      (s) => s.brandId === brandId && s.name === name && (s.finish || "") === (finish || "")
    );
    if (hasVisibilityGuard(text, params, userId)) matches = matches.filter((s) => visibleTo(s, Number(userId)));
    matches.sort((a, b) => Number(a.status === "user_submitted") - Number(b.status === "user_submitted") || a.id - b.id);
    const rows = matches.slice(0, 1).map((s) => ({
      shade_id: s.id,
      own_submitted: s.status === "user_submitted" && s.createdBy === Number(userId),
    }));
    return { rows, rowCount: rows.length };
  }

  // getVisibleShade: [shadeId, userId]
  if (/AS\s+"ownSubmitted"/i.test(text)) {
    const shade = state.shades.get(Number(params[0]));
    const userId = Number(params[1]);
    if (!shade || (hasVisibilityGuard(text, params, userId) && !visibleTo(shade, userId))) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        ownSubmitted: shade.status === "user_submitted" && shade.createdBy === userId,
        brand: brandName(shade.brandId),
        shadeName: shade.name,
      }],
      rowCount: 1,
    };
  }

  if (/^\s*INSERT\s+INTO\s+shade\b/i.test(text)) {
    const cols = text.match(/INSERT\s+INTO\s+shade\s*\(([^)]*)\)/i)[1].split(",").map((c) => c.trim());
    const valuesText = text.match(/VALUES\s*\(([^)]*)\)/i)[1].split(",").map((v) => v.trim());
    const get = (col) => {
      const v = valuesText[cols.indexOf(col)];
      if (v === undefined) return undefined;
      const ph = v.match(/^\$(\d+)/);
      return ph ? params[Number(ph[1]) - 1] : v.replace(/^'|'$/g, "");
    };
    const shade = {
      id: state.nextShadeId++,
      brandId: get("brand_id"),
      name: get("shade_name_canonical"),
      finish: get("finish"),
      finishes: get("finishes") || [],
      status: get("status"),
      createdBy: get("created_by_user_id") === undefined ? null : get("created_by_user_id"),
    };
    state.shades.set(shade.id, shade);
    return { rows: [{ shade_id: shade.id }], rowCount: 1 };
  }

  if (/^\s*UPDATE\s+shade\b/i.test(text) && /\bfinishes\s*=/i.test(text)) {
    const shade = state.shades.get(Number(params[0]));
    if (!shade) return { rows: [], rowCount: 0 };
    const guarded = /cardinality\(COALESCE\(finishes/i.test(text);
    if (guarded && shade.finishes.length > 0) return { rows: [], rowCount: 0 };
    const isAppend = /unnest\(/i.test(text);
    shade.finishes = isAppend ? [...new Set([...shade.finishes, ...params[1]])] : [...params[1]];
    return { rows: [], rowCount: 1 };
  }
  // Color write: fill-only, unless the owner-override guard ($6) is bound to true.
  if (/^\s*UPDATE\s+shade\b/i.test(text) && /\bvendor_hex\s*=/i.test(text)) {
    const shade = state.shades.get(Number(params[0]));
    if (!shade) return { rows: [], rowCount: 0 };
    const override = /CASE\s+WHEN\s+\$6/i.test(text) && params[5] === true;
    if (params[2] != null && (override || shade.vendorHex == null)) shade.vendorHex = params[2];
    return { rows: [], rowCount: 1 };
  }
  if (/^\s*UPDATE\s+shade\b/i.test(text)) return { rows: [], rowCount: 1 };

  if (/INSERT\s+INTO\s+user_inventory_item/i.test(text)) {
    state.inventory.add(`${params[0]}:${params[1]}`);
    return { rows: [{ inventoryItemId: "9000" }], rowCount: 1 };
  }

  // Polish list/detail/match-image (POLISH_SELECT: $1 = caller).
  if (/FROM\s+shade\s+s\s+JOIN\s+brand\s+b[\s\S]*LEFT\s+JOIN\s+user_inventory_item/i.test(text)) {
    const userId = Number(params[0]);
    let shades = [...state.shades.values()];
    const idParam = text.match(/\bs\.shade_id\s*=\s*\$(\d+)/i);
    if (idParam) shades = shades.filter((s) => s.id === Number(params[Number(idParam[1]) - 1]));
    if (hasVisibilityGuard(text, params, userId)) shades = shades.filter((s) => visibleTo(s, userId));
    if (/ui\.inventory_item_id\s+IS\s+NOT\s+NULL/i.test(text) && /COALESCE\(ui\.quantity/i.test(text)) {
      shades = shades.filter((s) => state.inventory.has(`${userId}:${s.id}`));
    }
    if (/COUNT\(\*\)/i.test(text)) return { rows: [{ total: String(shades.length) }], rowCount: 1 };
    const rows = shades.map((s) => polishRow(s, userId));
    return { rows, rowCount: rows.length };
  }

  // Catalog shade detail: [shadeId]
  if (/FROM\s+shade\s+s\s+JOIN\s+brand\s+b\s+ON[\s\S]*WHERE\s+s\.shade_id\s*=\s*\$1/i.test(text)) {
    let shade = state.shades.get(Number(params[0]));
    if (shade && /s\.status\s*<>\s*'user_submitted'/i.test(text) && shade.status === "user_submitted") shade = undefined;
    if (!shade) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        shadeId: String(shade.id), brand: "Acme", brandId: "1", name: shade.name, finish: shade.finish,
        finishes: shade.finishes, collection: null, releaseYear: null, status: shade.status,
      }],
      rowCount: 1,
    };
  }

  return { rows: [], rowCount: 0 };
}

// ---------------------------------------------------------------------------
// Module mocking (same approach as access-control.unit.test.cjs)
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
  query: (sql, params) => fakeQuery("pool", sql, params),
  transaction: async (cb) => cb({ query: (sql, params) => fakeQuery("tx", sql, params) }),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
registerMock("../lib/ai-color-detection", { detectHexWithAzureOpenAI: async () => ({}) });
registerMock("../lib/blob-storage", {
  BlobReadError: class extends Error {},
  BlobAccessDeniedError: class extends Error {},
  defaultReadableContainers: () => [],
  readBlobFromStorageUrl: async () => ({}),
  validateImageUpload: (c) => c,
  stripImageMetadata: async (b) => b,
});
registerMock("sharp", () => { throw new Error("sharp not expected"); });
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

require("../dist/functions/polishes");
require("../dist/functions/catalog");

function fakeRequest({ method = "GET", url = "http://localhost:7071/api/test", headers = {}, params = {}, body } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    url,
    headers: { get: (n) => headerMap.get(n.toLowerCase()) || null },
    params,
    query: new URL(url).searchParams,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body ?? {})).buffer,
  };
}
const fakeContext = () => ({ log() {}, error() {}, warn() {} });

async function invoke(routeName, { method, userId, ...rest } = {}) {
  const route = registeredRoutes[routeName];
  assert.ok(route, `route ${routeName} should be registered`);
  const req = fakeRequest({
    method: method || route.methods.find((m) => m !== "OPTIONS"),
    headers: userId !== undefined ? { authorization: `Bearer dev:${userId}` } : {},
    ...rest,
  });
  return route.handler(req, fakeContext());
}

const put = (userId, shadeId, body) =>
  invoke("polishes-mutate", {
    method: "PUT", userId,
    url: `http://localhost:7071/api/polishes/${shadeId}`, params: { id: String(shadeId) }, body,
  });
const post = (userId, body) =>
  invoke("polishes-create", { method: "POST", userId, url: "http://localhost:7071/api/polishes", body });
const getDetail = (userId, shadeId) =>
  invoke("polishes-list", {
    method: "GET", userId,
    url: `http://localhost:7071/api/polishes/${shadeId}`, params: { id: String(shadeId) },
  });
const getList = (userId, qs = "") =>
  invoke("polishes-list", { method: "GET", userId, url: `http://localhost:7071/api/polishes${qs}`, params: {} });

const calls = () => sqlCalls.filter((c) => !/FROM\s+app_user/i.test(c.sql));
const shadeInserts = () => calls().filter((c) => /^\s*INSERT\s+INTO\s+shade\b/i.test(c.sql));

beforeEach(() => {
  resetState();
  process.env.AUTH_DEV_BYPASS = "true";
});
afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
});

// ═══════════════════════════════════════════════════════════════════════════
// F1 — finishes on shared shades are fill-only
// ═══════════════════════════════════════════════════════════════════════════

describe("F1 — user input cannot rewrite finishes on shared catalog shades", () => {
  const evil = { finishes: ["glitter", "holographic"], quantity: 1 };

  it("PUT by id with `finishes` leaves a non-empty finishes array untouched", async () => {
    const res = await put(USER_B, CATALOG_SHADE, evil);
    assert.equal(res.status, 200);
    assert.deepEqual(state.shades.get(CATALOG_SHADE).finishes, ["creme"]);
    assert.deepEqual(res.jsonBody.finishes, ["creme"], "response reflects the stored finishes, not the rejected input");
  });

  it("PUT by id with an empty `finishes` array cannot clear a shared shade", async () => {
    const res = await put(USER_B, CATALOG_SHADE, { finishes: [], quantity: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(state.shades.get(CATALOG_SHADE).finishes, ["creme"]);
  });

  it("PUT by id with legacy `finish` cannot append to a non-empty finishes array or change shade.finish", async () => {
    await put(USER_B, CATALOG_SHADE, { finish: "glitter", quantity: 1 });
    assert.deepEqual(state.shades.get(CATALOG_SHADE).finishes, ["creme"]);
    assert.equal(state.shades.get(CATALOG_SHADE).finish, "creme");
  });

  it("PUT brand+name matching an existing shade cannot rewrite its finishes", async () => {
    const res = await put(USER_B, CATALOG_SHADE, { brand: "Acme", name: "Catalog Red", finish: "creme", ...evil });
    assert.equal(res.status, 200);
    assert.deepEqual(state.shades.get(CATALOG_SHADE).finishes, ["creme"]);
  });

  it("POST adopting by shadeId cannot rewrite finishes", async () => {
    const res = await post(USER_B, { shadeId: String(CATALOG_SHADE), ...evil });
    assert.equal(res.status, 201);
    assert.deepEqual(state.shades.get(CATALOG_SHADE).finishes, ["creme"]);
    assert.deepEqual(res.jsonBody.finishes, ["creme"]);
  });

  it("POST brand+name matching an existing shade cannot rewrite finishes", async () => {
    const res = await post(USER_B, { brand: "Acme", name: "Catalog Red", finish: "creme", ...evil });
    assert.equal(res.status, 201);
    assert.deepEqual(state.shades.get(CATALOG_SHADE).finishes, ["creme"]);
  });

  it("every finishes write from a non-owner is guarded to fill an EMPTY array only", async () => {
    await put(USER_B, CATALOG_SHADE, evil);
    await post(USER_B, { shadeId: String(CATALOG_SHADE), ...evil });
    await post(USER_B, { brand: "Acme", name: "Catalog Red", finish: "creme", ...evil });
    const finishWrites = calls().filter((c) => /^\s*UPDATE\s+shade\b/i.test(c.sql) && /\bfinishes\s*=/i.test(c.sql));
    for (const w of finishWrites) {
      assert.match(w.sql, /cardinality\(COALESCE\(finishes,\s*ARRAY\[\]::text\[\]\)\)\s*=\s*0/i, w.sql);
      assert.doesNotMatch(w.sql, /\bfinish\s*=/i, "shade.finish (dedup key) must not be written");
    }
  });

  it("fills an EMPTY finishes array (PUT and POST adopt)", async () => {
    await put(USER_B, EMPTY_FINISH_SHADE, { finishes: ["glitter"], quantity: 1 });
    assert.deepEqual(state.shades.get(EMPTY_FINISH_SHADE).finishes, ["glitter"]);

    state.shades.get(EMPTY_FINISH_SHADE).finishes = [];
    await post(USER_B, { shadeId: String(EMPTY_FINISH_SHADE), finishes: ["matte"], quantity: 1 });
    assert.deepEqual(state.shades.get(EMPTY_FINISH_SHADE).finishes, ["matte"]);
  });

  it("the creator may replace finishes on their own user_submitted shade", async () => {
    const res = await put(USER_A, A_PRIVATE_SHADE, { finishes: ["glitter", "holographic"], quantity: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(state.shades.get(A_PRIVATE_SHADE).finishes, ["glitter", "holographic"]);

    await post(USER_A, { shadeId: String(A_PRIVATE_SHADE), finishes: ["matte"], quantity: 1 });
    assert.deepEqual(state.shades.get(A_PRIVATE_SHADE).finishes, ["matte"]);
  });

  it("finishes sent while creating a brand-new shade are stored on that new shade", async () => {
    const res = await post(USER_B, { brand: "Acme", name: "Brand New", finishes: ["matte"], quantity: 1 });
    assert.equal(res.status, 201);
    const [insert] = shadeInserts();
    assert.deepEqual(insert.params.at(-1), ["matte"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F2 — user-created shades are private until approved
// ═══════════════════════════════════════════════════════════════════════════

describe("F2 — user-submitted shades are private until approved", () => {
  it("creating a new brand+name shade stores status 'user_submitted' and created_by_user_id", async () => {
    const res = await post(USER_B, { brand: "Acme", name: "Fresh Shade", quantity: 1 });
    assert.equal(res.status, 201);
    const [insert] = shadeInserts();
    assert.ok(insert, "a shade must be inserted");
    assert.match(insert.sql, /'user_submitted'/);
    assert.doesNotMatch(insert.sql, /'active'/);
    assert.match(insert.sql, /created_by_user_id/);
    const created = [...state.shades.values()].find((s) => s.name === "Fresh Shade");
    assert.equal(created.status, "user_submitted");
    assert.equal(created.createdBy, USER_B);
  });

  it("the creator can see their own shade in detail and list; other users cannot", async () => {
    await post(USER_B, { brand: "Acme", name: "Fresh Shade", quantity: 1 });
    const created = [...state.shades.values()].find((s) => s.name === "Fresh Shade");

    assert.equal((await getDetail(USER_B, created.id)).status, 200);
    assert.equal((await getDetail(USER_A, created.id)).status, 404);

    const listB = await getList(USER_B);
    assert.ok(listB.jsonBody.polishes.some((p) => p.name === "Fresh Shade"));
    const listA = await getList(USER_A);
    assert.ok(!listA.jsonBody.polishes.some((p) => p.name === "Fresh Shade"));
  });

  it("list, count and detail queries carry the visibility predicate bound to the caller", async () => {
    await getList(USER_B, "?search=x");
    await getDetail(USER_B, CATALOG_SHADE);
    const polishQueries = calls().filter((c) => /LEFT\s+JOIN\s+user_inventory_item/i.test(c.sql));
    assert.ok(polishQueries.length >= 3, "expected list + count + detail queries");
    for (const q of polishQueries) {
      assert.match(
        q.sql,
        /s\.status\s*<>\s*'user_submitted'\s+OR\s+s\.created_by_user_id\s*=\s*\$1\s+OR\s+ui\.inventory_item_id\s+IS\s+NOT\s+NULL/i,
        q.sql
      );
      assert.equal(q.params[0], USER_B, "$1 must be the caller");
    }
  });

  it("another user's private shade is hidden from list and detail (404)", async () => {
    assert.equal((await getDetail(USER_A, B_PRIVATE_SHADE)).status, 404);
    const list = await getList(USER_A);
    assert.ok(!list.jsonBody.polishes.some((p) => p.id === String(B_PRIVATE_SHADE)));
    assert.equal(list.jsonBody.total, [...state.shades.values()].filter((s) => s.status !== "user_submitted" || s.createdBy === USER_A).length);
  });

  it("a user who holds a private shade in inventory can still see it", async () => {
    state.inventory.add(`${USER_A}:${B_PRIVATE_SHADE}`);
    assert.equal((await getDetail(USER_A, B_PRIVATE_SHADE)).status, 200);
  });

  it("POST adopting another user's user_submitted shade by id -> 404, nothing written", async () => {
    const res = await post(USER_A, { shadeId: String(B_PRIVATE_SHADE), quantity: 1 });
    assert.equal(res.status, 404);
    assert.equal(state.inventory.has(`${USER_A}:${B_PRIVATE_SHADE}`), false);
    assert.equal(calls().filter((c) => /^\s*(INSERT|UPDATE)/i.test(c.sql)).length, 0);
  });

  it("PUT on another user's user_submitted shade by id -> 404, nothing written", async () => {
    const res = await put(USER_A, B_PRIVATE_SHADE, { finishes: ["matte"], quantity: 1 });
    assert.equal(res.status, 404);
    assert.equal(state.inventory.has(`${USER_A}:${B_PRIVATE_SHADE}`), false);
    assert.deepEqual(state.shades.get(B_PRIVATE_SHADE).finishes, ["glitter"]);
    assert.equal(calls().filter((c) => /^\s*(INSERT|UPDATE)/i.test(c.sql)).length, 0);
  });

  it("brand+name matching another user's private shade does not link to it; caller gets their own row", async () => {
    const res = await post(USER_A, { brand: "Acme", name: "B Secret", finish: "creme", quantity: 1 });
    assert.equal(res.status, 201);
    assert.equal(state.inventory.has(`${USER_A}:${B_PRIVATE_SHADE}`), false, "must not link to B's private row");
    const [insert] = shadeInserts();
    assert.ok(insert, "a separate row is created for the caller");
    const mine = [...state.shades.values()].find((s) => s.name === "B Secret" && s.createdBy === USER_A);
    assert.ok(mine);
    assert.deepEqual(state.shades.get(B_PRIVATE_SHADE).finishes, ["glitter"], "B's row is untouched");
  });

  it("brand+name matching an active catalog shade reuses it (no new row)", async () => {
    const res = await post(USER_B, { brand: "Acme", name: "Catalog Red", finish: "creme", quantity: 1 });
    assert.equal(res.status, 201);
    assert.equal(shadeInserts().length, 0);
    assert.equal(state.inventory.has(`${USER_B}:${CATALOG_SHADE}`), true);
  });

  it("GET /api/catalog/shade/{id} returns 404 for a user_submitted shade and 200 for an active one", async () => {
    const hidden = await invoke("catalog-shade", {
      method: "GET", url: `http://localhost:7071/api/catalog/shade/${A_PRIVATE_SHADE}`, params: { id: String(A_PRIVATE_SHADE) },
    });
    assert.equal(hidden.status, 404);
    const shown = await invoke("catalog-shade", {
      method: "GET", url: `http://localhost:7071/api/catalog/shade/${CATALOG_SHADE}`, params: { id: String(CATALOG_SHADE) },
    });
    assert.equal(shown.status, 200);
  });
});

describe("edits to the caller's own submitted shade", () => {
  beforeEach(resetState);

  it("an owner's color correction replaces the stored value (shared shades stay fill-only)", async () => {
    const own = await put(USER_A, A_PRIVATE_SHADE, { vendorHex: "#222222" });
    assert.ok(own.status < 400, `owner update failed: ${own.status}`);
    assert.equal(state.shades.get(A_PRIVATE_SHADE).vendorHex, "#222222");

    const shared = await put(USER_B, CATALOG_SHADE, { vendorHex: "#000000" });
    assert.ok(shared.status < 500);
    assert.equal(state.shades.get(CATALOG_SHADE).vendorHex, "#aa0000", "shared catalog value must not be overwritten");
  });

  it("POST adopting your own submitted shade by id applies the same owner color rule as PUT", async () => {
    const own = await post(USER_A, { shadeId: String(A_PRIVATE_SHADE), quantity: 1, vendorHex: "#333333" });
    assert.ok(own.status < 400, `owner adopt failed: ${own.status}`);
    assert.equal(state.shades.get(A_PRIVATE_SHADE).vendorHex, "#333333");

    const shared = await post(USER_B, { shadeId: String(CATALOG_SHADE), quantity: 1, vendorHex: "#000000" });
    assert.ok(shared.status < 500);
    assert.equal(state.shades.get(CATALOG_SHADE).vendorHex, "#aa0000", "shared catalog value must not be overwritten");
  });

  it("a finish-only edit with unchanged brand + name updates the same shade instead of creating one", async () => {
    const before = state.shades.size;
    const res = await put(USER_A, A_PRIVATE_SHADE, { brand: "Acme", name: "A Secret", finishes: ["glitter"] });
    assert.ok(res.status < 400, `update failed: ${res.status}`);
    assert.equal(shadeInserts().length, 0, "no new shade may be created");
    assert.equal(state.shades.size, before);
    assert.deepEqual(state.shades.get(A_PRIVATE_SHADE).finishes, ["glitter"]);
  });
});
