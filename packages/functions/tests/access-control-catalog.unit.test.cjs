/**
 * Shared-catalog access control (issue #47, findings F1 + F2).
 *
 *  F1 (+ #224 decision 1b): user finishes and colors reach the catalog only when the request
 *      CREATES the shade; adopting, matching or updating a shared shade never writes it, not even
 *      to fill an empty value (exception: the caller's own `user_submitted` shade).
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
const A_MERGED_SHADE = 201; // user_submitted by A, retired by an admin merge into CATALOG_SHADE
const B_REJECTED_SHADE = 301; // user_submitted by B, rejected by an admin (stays private)

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
        { ...mk(B_PRIVATE_SHADE, 1, "B Secret", "creme", ["glitter"], "user_submitted", USER_B), vendorHex: "#ab0101" },
        {
          ...mk(A_MERGED_SHADE, 1, "Catalog Redd", "creme", ["creme"], "user_submitted", USER_A),
          reviewStatus: "merged",
          mergedInto: CATALOG_SHADE,
        },
        { ...mk(B_REJECTED_SHADE, 1, "B Rejected", "creme", ["creme"], "user_submitted", USER_B), reviewStatus: "rejected" },
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
 * True when the SQL excludes shades retired by an admin merge (`merged_into_shade_id IS NULL`);
 * the fake hides retired shades only then, so dropping the guard visibly leaks them.
 */
function hasMergedGuard(sql) {
  return /merged_into_shade_id\s+IS\s+NULL/i.test(sql);
}
const isRetired = (shade) => shade.mergedInto != null;

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

function polishRow(shade, userId, text = "") {
  const inInv = state.inventory.has(`${userId}:${shade.id}`);
  // The row only carries `ownSubmitted` when the SQL projects it with the caller-bound predicate
  // (`created_by_user_id = $1`); the value is then evaluated like Postgres would.
  const ownSubmittedSql =
    /AS\s+"ownSubmitted"/i.test(text) &&
    /s\.status\s*=\s*'user_submitted'\s+AND\s+s\.created_by_user_id\s*=\s*\$1\s+AND\s+s\.merged_into_shade_id\s+IS\s+NULL/i.test(text);
  return {
    ...(ownSubmittedSql
      ? { ownSubmitted: shade.status === "user_submitted" && shade.createdBy === Number(userId) && !isRetired(shade) }
      : {}),
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
    vendorHex: shade.vendorHex ?? null,
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
    matches.sort(
      (a, b) =>
        Number(a.status === "user_submitted") - Number(b.status === "user_submitted") ||
        Number(isRetired(a)) - Number(isRetired(b)) ||
        a.id - b.id
    );
    const rows = matches.slice(0, 1).map((s) => ({
      shade_id: s.id,
      own_submitted: s.status === "user_submitted" && s.createdBy === Number(userId) && !isRetired(s),
      merged_into_shade_id: s.mergedInto ?? null,
    }));
    return { rows, rowCount: rows.length };
  }

  // getVisibleShade: [shadeId, userId]
  if (/AS\s+"ownSubmitted"/i.test(text) && !/AS\s+"inventoryItemId"/i.test(text)) {
    const shade = state.shades.get(Number(params[0]));
    const userId = Number(params[1]);
    if (!shade || (hasVisibilityGuard(text, params, userId) && !visibleTo(shade, userId))) return { rows: [], rowCount: 0 };
    if (hasMergedGuard(text) && isRetired(shade)) return { rows: [], rowCount: 0 };
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
  // Color write. Honors whichever COALESCE order the SQL uses: `COALESCE($3, vendor_hex)`
  // replaces, `COALESCE(vendor_hex, $3)` only fills NULL.
  if (/^\s*UPDATE\s+shade\b/i.test(text) && /\bvendor_hex\s*=/i.test(text)) {
    const shade = state.shades.get(Number(params[0]));
    if (!shade) return { rows: [], rowCount: 0 };
    const replaces = /vendor_hex\s*=\s*COALESCE\(\s*\$3\s*,\s*vendor_hex\s*\)/i.test(text);
    if (params[2] != null && (replaces || shade.vendorHex == null)) shade.vendorHex = params[2];
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
    if (hasMergedGuard(text)) shades = shades.filter((s) => !isRetired(s));
    if (/ui\.inventory_item_id\s+IS\s+NOT\s+NULL/i.test(text) && /COALESCE\(ui\.quantity/i.test(text)) {
      shades = shades.filter((s) => state.inventory.has(`${userId}:${s.id}`));
    }
    if (/COUNT\(\*\)\s+AS\s+total\b/i.test(text)) return { rows: [{ total: String(shades.length) }], rowCount: 1 };
    // The list query carries its total as a window column (COUNT(*) OVER() AS "totalCount").
    const withTotal = /"totalCount"/.test(text);
    const rows = shades.map((s) =>
      withTotal ? { ...polishRow(s, userId, text), totalCount: String(shades.length) } : polishRow(s, userId, text)
    );
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
// match-image (#105): real parsing and ranking, but a fixed palette instead of decoding pixels
// (registered after the cache loop so the real module loads against the mocked sharp).
{
  const realColorMatch = require(path.resolve(__dirname, "../dist/lib/color-match.js"));
  const colorMatchMock = {
    ...realColorMatch,
    extractImagePalette: async () => [{ hex: "#AA0000", fraction: 1, kind: "color" }],
  };
  registerMock("../lib/color-match", colorMatchMock);
  require.cache["../lib/color-match"] = { id: "../lib/color-match", filename: "../lib/color-match", loaded: true, exports: colorMatchMock };
}

require("../dist/functions/polishes");
const { DETECTED_HEX_METHOD_CLIENT_SUPPLIED } = require("../dist/lib/hex-provenance");
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
// F1 — user requests never write finishes on existing shared shades (#224 decision 1b)
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

  it("no request from a non-owner issues any UPDATE against a shared shade", async () => {
    const colors = { color: "Defaced", vendorHex: "#000000", detectedHex: "#000000", nameHex: "#000000" };
    assert.equal((await put(USER_B, CATALOG_SHADE, { ...evil, ...colors })).status, 200);
    assert.equal((await post(USER_B, { shadeId: String(CATALOG_SHADE), ...evil, ...colors })).status, 201);
    assert.equal(
      (await post(USER_B, { brand: "Acme", name: "Catalog Red", finish: "creme", ...evil, ...colors })).status,
      201
    );
    assert.equal(
      (await put(USER_B, CATALOG_SHADE, { brand: "Acme", name: "Catalog Red", finish: "creme", ...evil, ...colors })).status,
      200
    );
    const shadeWrites = calls().filter((c) => /^\s*UPDATE\s+shade\b/i.test(c.sql));
    assert.deepEqual(shadeWrites.map((c) => c.sql), [], "shared shades are read-only for users");
    assert.equal(shadeInserts().length, 0, "matching an existing shade must not create one");
    assert.ok(state.inventory.has(`${USER_B}:${CATALOG_SHADE}`), "the caller's inventory row is still written");
  });

  it("does not fill an EMPTY finishes array on a shared shade (PUT, POST adopt, POST brand+name)", async () => {
    await put(USER_B, EMPTY_FINISH_SHADE, { finishes: ["glitter"], quantity: 1 });
    assert.deepEqual(state.shades.get(EMPTY_FINISH_SHADE).finishes, []);

    await post(USER_B, { shadeId: String(EMPTY_FINISH_SHADE), finishes: ["matte"], quantity: 1 });
    assert.deepEqual(state.shades.get(EMPTY_FINISH_SHADE).finishes, []);

    await post(USER_B, { brand: "Acme", name: "Blank Blue", finish: "creme", finishes: ["matte"], quantity: 1 });
    assert.deepEqual(state.shades.get(EMPTY_FINISH_SHADE).finishes, []);
    assert.equal(shadeInserts().length, 0);
  });

  it("does not fill NULL color fields on a shared shade (PUT, POST adopt, POST brand+name)", async () => {
    await put(USER_B, EMPTY_FINISH_SHADE, { vendorHex: "#123456", quantity: 1 });
    await post(USER_B, { shadeId: String(EMPTY_FINISH_SHADE), vendorHex: "#123456", quantity: 1 });
    await post(USER_B, { brand: "Acme", name: "Blank Blue", finish: "creme", vendorHex: "#123456", quantity: 1 });
    assert.equal(state.shades.get(EMPTY_FINISH_SHADE).vendorHex, undefined);
    assert.equal(calls().filter((c) => /^\s*UPDATE\s+shade\b/i.test(c.sql)).length, 0);
  });

  it("the creator may replace finishes on their own user_submitted shade", async () => {
    const res = await put(USER_A, A_PRIVATE_SHADE, { finishes: ["glitter", "holographic"], quantity: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(state.shades.get(A_PRIVATE_SHADE).finishes, ["glitter", "holographic"]);

    await post(USER_A, { shadeId: String(A_PRIVATE_SHADE), finishes: ["matte"], quantity: 1 });
    assert.deepEqual(state.shades.get(A_PRIVATE_SHADE).finishes, ["matte"]);
  });

  it("finishes and colors sent while creating a brand-new shade are stored on that new shade", async () => {
    const res = await post(USER_B, {
      brand: "Acme", name: "Brand New", finishes: ["matte"], color: "Teal", vendorHex: "#00aaaa", quantity: 1,
    });
    assert.equal(res.status, 201);
    const [insert] = shadeInserts();
    assert.deepEqual(insert.params.at(-1), ["matte"]);
    assert.ok(insert.params.includes("Teal"), "color_name is written on create");
    assert.ok(insert.params.includes("#00aaaa"), "vendor_hex is written on create");
  });

  it("PUT that renames to a brand-new brand+name creates the shade with the request's finishes and colors", async () => {
    const res = await put(USER_B, CATALOG_SHADE, {
      brand: "Acme", name: "Renamed Fresh", finishes: ["glitter"], vendorHex: "#abcdef", quantity: 1,
    });
    assert.equal(res.status, 200);
    const [insert] = shadeInserts();
    assert.ok(insert, "a new shade is created");
    assert.deepEqual(insert.params.at(-1), ["glitter"]);
    assert.ok(insert.params.includes("#abcdef"));
    assert.deepEqual(state.shades.get(CATALOG_SHADE).finishes, ["creme"], "the original shared shade is untouched");
    assert.equal(state.shades.get(CATALOG_SHADE).vendorHex, "#aa0000");
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

  it("list and detail queries carry the visibility predicate bound to the caller", async () => {
    await getList(USER_B, "?search=x");
    await getDetail(USER_B, CATALOG_SHADE);
    const polishQueries = calls().filter((c) => /LEFT\s+JOIN\s+user_inventory_item/i.test(c.sql));
    assert.ok(polishQueries.length >= 2, "expected list + detail queries");
    assert.ok(polishQueries.some((q) => /"totalCount"/.test(q.sql)), "list query should carry the window total");
    for (const q of polishQueries) {
      assert.match(
        q.sql,
        /s\.status\s*<>\s*'user_submitted'\s+OR\s+s\.created_by_user_id\s*=\s*\$1\s+OR\s+ui\.inventory_item_id\s+IS\s+NOT\s+NULL/i,
        q.sql
      );
      assert.equal(q.params[0], USER_B, "$1 must be the caller");
    }
  });

  it("ownSubmitted is true only for the caller's own private shade, in detail and list", async () => {
    await post(USER_B, { brand: "Acme", name: "Fresh Shade", quantity: 1 });
    const created = [...state.shades.values()].find((s) => s.name === "Fresh Shade");

    assert.equal((await getDetail(USER_B, created.id)).jsonBody.ownSubmitted, true);
    const listB = await getList(USER_B);
    assert.equal(listB.jsonBody.polishes.find((p) => p.name === "Fresh Shade").ownSubmitted, true);
    // A shared catalog shade is never the caller's own submission.
    assert.equal((await getDetail(USER_B, CATALOG_SHADE)).jsonBody.ownSubmitted, false);
    assert.ok(listB.jsonBody.polishes.filter((p) => state.shades.get(Number(p.id)).createdBy !== USER_B).every((p) => p.ownSubmitted === false));
  });

  it("another user never sees ownSubmitted: true for someone else's private shade", async () => {
    // B's private shade is invisible to A (404) ...
    assert.equal((await getDetail(USER_A, B_PRIVATE_SHADE)).status, 404);
    // ... and even once A holds it in inventory (visible), it is not A's submission.
    state.inventory.add(`${USER_A}:${B_PRIVATE_SHADE}`);
    const held = await getDetail(USER_A, B_PRIVATE_SHADE);
    assert.equal(held.status, 200);
    assert.equal(held.jsonBody.ownSubmitted, false);
    const listA = await getList(USER_A);
    assert.ok(listA.jsonBody.polishes.every((p) => p.ownSubmitted !== true || state.shades.get(Number(p.id)).createdBy === USER_A));
    assert.equal(listA.jsonBody.polishes.find((p) => p.id === String(B_PRIVATE_SHADE)).ownSubmitted, false);
    // The creator still gets true for the same shade.
    assert.equal((await getDetail(USER_B, B_PRIVATE_SHADE)).jsonBody.ownSubmitted, true);
  });

  it("a creator's merged (retired) submission is not served, so ownSubmitted never marks it", async () => {
    assert.equal((await getDetail(USER_A, A_MERGED_SHADE)).status, 404);
    const listA = await getList(USER_A);
    assert.ok(!listA.jsonBody.polishes.some((p) => p.id === String(A_MERGED_SHADE)));
  });

  it("another user's private shade is hidden from list and detail (404)", async () => {
    assert.equal((await getDetail(USER_A, B_PRIVATE_SHADE)).status, 404);
    const list = await getList(USER_A);
    assert.ok(!list.jsonBody.polishes.some((p) => p.id === String(B_PRIVATE_SHADE)));
    assert.equal(
      list.jsonBody.total,
      [...state.shades.values()].filter((s) => !isRetired(s) && (s.status !== "user_submitted" || s.createdBy === USER_A)).length
    );
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

  it("an owner's color correction replaces the stored value (shared shades are never written)", async () => {
    const own = await put(USER_A, A_PRIVATE_SHADE, { vendorHex: "#222222", detectedHex: "#333333" });
    assert.ok(own.status < 400, `owner update failed: ${own.status}`);
    assert.equal(state.shades.get(A_PRIVATE_SHADE).vendorHex, "#222222");
    // A client-provided detected_hex records its provenance (#255) whenever it changes the value.
    const colorWrite = calls().find((c) => /^\s*UPDATE\s+shade\b/i.test(c.sql) && /\bdetected_hex_method\s*=/i.test(c.sql));
    assert.ok(colorWrite, "the color write must also set detected_hex_method");
    assert.match(colorWrite.sql, /\$4 IS NOT NULL AND detected_hex IS DISTINCT FROM \$4 THEN \$6/);
    assert.equal(colorWrite.params[5], DETECTED_HEX_METHOD_CLIENT_SUPPLIED);
    // The AI provenance of the replaced value no longer describes the new hex, so it is cleared.
    for (const column of ["detected_hex_confidence", "detected_hex_model", "detected_hex_prompt_version"]) {
      assert.match(
        colorWrite.sql,
        new RegExp(`${column} = CASE\\s+WHEN \\$4 IS NOT NULL AND detected_hex IS DISTINCT FROM \\$4 THEN NULL`),
        `${column} must be cleared when a client-supplied detected_hex replaces the value`
      );
    }

    const shared = await put(USER_B, CATALOG_SHADE, { vendorHex: "#000000" });
    assert.ok(shared.status < 400, `shared-shade request must succeed, got ${shared.status}`);
    assert.equal(state.shades.get(CATALOG_SHADE).vendorHex, "#aa0000", "shared catalog value must not be overwritten");
  });

  it("POST adopting your own submitted shade by id applies the same owner color rule as PUT", async () => {
    const own = await post(USER_A, { shadeId: String(A_PRIVATE_SHADE), quantity: 1, vendorHex: "#333333" });
    assert.ok(own.status < 400, `owner adopt failed: ${own.status}`);
    assert.equal(state.shades.get(A_PRIVATE_SHADE).vendorHex, "#333333");

    const shared = await post(USER_B, { shadeId: String(CATALOG_SHADE), quantity: 1, vendorHex: "#000000" });
    assert.ok(shared.status < 400, `shared-shade request must succeed, got ${shared.status}`);
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

// ═══════════════════════════════════════════════════════════════════════════
// Admin review queue (#45): reviewed submissions never leak to other users
// ═══════════════════════════════════════════════════════════════════════════

describe("admin review queue — rejected and merged submissions stay private", () => {
  it("a rejected submission stays hidden from other users (list, detail, adopt by id)", async () => {
    const list = await getList(USER_A);
    assert.equal(list.status, 200);
    assert.ok(!list.jsonBody.polishes.some((p) => p.id === String(B_REJECTED_SHADE)), "rejected shade leaked to another user's list");
    assert.equal((await getDetail(USER_A, B_REJECTED_SHADE)).status, 404);
    const adopt = await post(USER_A, { shadeId: String(B_REJECTED_SHADE) });
    assert.equal(adopt.status, 404);
    assert.ok(!state.inventory.has(`${USER_A}:${B_REJECTED_SHADE}`));
  });

  it("a rejected submission stays visible to its submitter", async () => {
    assert.equal((await getDetail(USER_B, B_REJECTED_SHADE)).status, 200);
    const list = await getList(USER_B);
    assert.ok(list.jsonBody.polishes.some((p) => p.id === String(B_REJECTED_SHADE)));
  });

  it("brand+name matching another user's rejected submission does not link to it", async () => {
    const res = await post(USER_A, { brand: "Acme", name: "B Rejected", finish: "creme" });
    assert.equal(res.status, 201);
    assert.notEqual(res.jsonBody.id, String(B_REJECTED_SHADE));
    assert.ok(!state.inventory.has(`${USER_A}:${B_REJECTED_SHADE}`));
  });

  it("a shade retired by a merge is hidden even from its creator (list, detail, adopt by id)", async () => {
    const list = await getList(USER_A);
    assert.ok(!list.jsonBody.polishes.some((p) => p.id === String(A_MERGED_SHADE)), "retired shade still listed");
    assert.equal((await getDetail(USER_A, A_MERGED_SHADE)).status, 404);
    const adopt = await post(USER_A, { shadeId: String(A_MERGED_SHADE) });
    assert.equal(adopt.status, 404);
    for (const call of calls().filter((c) => /LEFT\s+JOIN\s+user_inventory_item/i.test(c.sql))) {
      assert.match(call.sql, /merged_into_shade_id\s+IS\s+NULL/i, "polish queries must exclude retired shades");
    }
  });

  it("the creator re-adding a merged submission by brand+name lands on the merge target", async () => {
    const res = await post(USER_A, { brand: "Acme", name: "Catalog Redd", finish: "creme" });
    assert.equal(res.status, 201);
    assert.equal(shadeInserts().length, 0, "no new shade row is created");
    assert.ok(state.inventory.has(`${USER_A}:${CATALOG_SHADE}`), "inventory row points at the merge target");
    assert.ok(!state.inventory.has(`${USER_A}:${A_MERGED_SHADE}`));
  });

  it("another user's merged submission is never matched by brand+name", async () => {
    const res = await post(USER_B, { brand: "Acme", name: "Catalog Redd", finish: "creme" });
    assert.equal(res.status, 201);
    assert.ok(!state.inventory.has(`${USER_B}:${A_MERGED_SHADE}`));
    assert.ok(!state.inventory.has(`${USER_B}:${CATALOG_SHADE}`), "must not learn the private submission's merge target");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Photo match (#105): the catalog / wishlist scopes never reach other users' private shades
// ═══════════════════════════════════════════════════════════════════════════

describe("match-image scopes respect shade visibility", () => {
  // The palette is stubbed (one red color); the bytes only need to pass request validation.
  const redPngDataUrl = async () => `data:image/png;base64,${Buffer.from("not decoded").toString("base64")}`;
  const matchImage = async (userId, body) =>
    invoke("polishes-match-image", {
      method: "POST",
      userId,
      url: "http://localhost:7071/api/polishes/match-image",
      body: { image: await redPngDataUrl(), ...body },
    });
  const ids = (res) =>
    new Set([...res.jsonBody.matches, ...res.jsonBody.colorMatches.flatMap((g) => g.matches)].map((m) => m.polish.id));

  it("catalog scope: another user's private red shade never matches, the caller's own one may", async () => {
    const res = await matchImage(USER_A, { scope: "catalog", limit: 50, perColorLimit: 20 });
    assert.equal(res.status, 200);
    const seen = ids(res);
    assert.ok(seen.has(String(CATALOG_SHADE)), "the shared red shade should match");
    assert.ok(!seen.has(String(B_PRIVATE_SHADE)), "B's private shade leaked into A's catalog matches");
    assert.ok(!seen.has(String(A_MERGED_SHADE)), "merged submissions must stay hidden");

    const resB = await matchImage(USER_B, { scope: "catalog", limit: 50, perColorLimit: 20 });
    assert.ok(ids(resB).has(String(B_PRIVATE_SHADE)), "B still sees their own private shade");
    assert.ok(!ids(resB).has(String(A_PRIVATE_SHADE)), "A's private shade leaked into B's catalog matches");
  });

  it("every match-image query binds $1 to the caller and carries the visibility predicate", async () => {
    await matchImage(USER_B, { scope: "wishlist" });
    await matchImage(USER_B, { scope: "catalog" });
    const polishQueries = calls().filter((c) => /LEFT\s+JOIN\s+user_inventory_item/i.test(c.sql));
    assert.ok(polishQueries.length >= 2);
    for (const q of polishQueries) {
      assert.match(q.sql, /ui\.user_id\s*=\s*\$1/i);
      assert.match(q.sql, /s\.created_by_user_id\s*=\s*\$1/i);
      assert.equal(q.params[0], USER_B, "$1 must be the caller");
    }
  });
});
