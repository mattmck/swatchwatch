/**
 * Saved looks (`GET/POST/DELETE /api/looks`) unit tests. No database: the handler module loads from
 * dist/ with `@azure/functions`, `jose` and `../lib/db` swapped via require interception (same
 * approach as wishlist-share.unit.test.cjs). The fake DB honours `user_id = $n` predicates, so a
 * statement that dropped the user scope would visibly read or delete another user's looks.
 *
 * Users: OWNER = 1, OTHER = 2 (dev-bypass tokens `Bearer dev:<id>`).
 */
const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

process.env.AUTH_DEV_BYPASS = "true";
delete process.env.WEBSITE_INSTANCE_ID;
delete process.env.WEBSITE_HOSTNAME;
delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const OWNER = 1;
const OTHER = 2;
const USERS = {
  [OWNER]: { user_id: OWNER, external_id: "ext-owner", email: "owner@test.dev", role: "user" },
  [OTHER]: { user_id: OTHER, external_id: "ext-other", email: "other@test.dev", role: "user" },
};

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

let sqlCalls = [];
/** user_look rows: { id, userId, key, templateId, name, vibe, steps, savedAt } */
let rows = [];
let nextId = 1;
let clock = 0;

function resetDb() {
  sqlCalls = [];
  rows = [];
  nextId = 1;
  clock = Date.parse("2026-10-18T00:00:00Z");
}

function nowIso() {
  clock += 1000;
  return new Date(clock).toISOString();
}

/** The single user id a statement is scoped to, or undefined (unscoped = sees everyone). */
function boundUserId(sql, params) {
  const values = new Set(
    [...String(sql).matchAll(/\buser_id\s*=\s*\$(\d+)/gi)].map((m) => Number(params[Number(m[1]) - 1]))
  );
  return values.size === 1 ? [...values][0] : undefined;
}

function out(row) {
  return { id: row.key, templateId: row.templateId, name: row.name, vibe: row.vibe, steps: row.steps, savedAt: new Date(row.savedAt) };
}

function newestFirst(a, b) {
  return b.savedAt.localeCompare(a.savedAt) || b.id - a.id;
}

async function fakeQuery(sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ sql: text, params });

  if (/FROM\s+app_user/i.test(text) && /WHERE\s+user_id\s*=\s*\$1/i.test(text)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }

  if (!/user_look/i.test(text)) return { rows: [], rowCount: 0 };
  const userId = boundUserId(text, params);
  const scoped = () => rows.filter((r) => userId === undefined || r.userId === userId);

  if (/^\s*INSERT/i.test(text)) {
    const [uid, key, templateId, name, vibe, steps] = params;
    let row = rows.find((r) => r.userId === Number(uid) && r.key === key);
    if (row) {
      Object.assign(row, { templateId, name, vibe: JSON.parse(vibe), steps: JSON.parse(steps), savedAt: nowIso() });
    } else {
      row = { id: nextId++, userId: Number(uid), key, templateId, name, vibe: JSON.parse(vibe), steps: JSON.parse(steps), savedAt: nowIso() };
      rows.push(row);
    }
    return { rows: [out(row)], rowCount: 1 };
  }
  if (/^\s*DELETE/i.test(text) && /NOT IN|OFFSET/i.test(text)) {
    // Trim: keep the newest $2 of the scoped user's rows.
    const keep = new Set(scoped().sort(newestFirst).slice(0, Number(params[1])).map((r) => r.id));
    const before = rows.length;
    rows = rows.filter((r) => !(userId === undefined || r.userId === userId) || keep.has(r.id));
    return { rows: [], rowCount: before - rows.length };
  }
  if (/^\s*DELETE/i.test(text)) {
    const before = rows.length;
    rows = rows.filter((r) => !((userId === undefined || r.userId === userId) && r.key === params[1]));
    return { rows: [], rowCount: before - rows.length };
  }
  // SELECT
  const list = scoped().sort(newestFirst).slice(0, Number(params[1] ?? 1000)).map(out);
  return { rows: list, rowCount: list.length };
}

// ---------------------------------------------------------------------------
// Module mocking
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
  app: {
    http: (name, opts) => {
      registeredRoutes[name] = opts;
    },
    storageQueue: () => {},
    timer: () => {},
  },
});
registerMock("jose", {
  errors: { JOSEError: class JOSEError extends Error {} },
  createRemoteJWKSet: () => {},
  jwtVerify: async () => {
    throw new Error("JWT validation is not exercised here");
  },
});
const dbMock = {
  query: (sql, params) => fakeQuery(sql, params),
  transaction: async (cb) => cb({ query: (sql, params) => fakeQuery(sql, params) }),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);

for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

require("../dist/functions/looks.js");

after(() => {
  Module._resolveFilename = originalResolve;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRequest({ method, url, headers = {}, body }) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) headerMap.set(k.toLowerCase(), v);
  return {
    method,
    url,
    headers: { get: (name) => headerMap.get(name.toLowerCase()) ?? null },
    params: {},
    query: new URL(url).searchParams,
    text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const context = { log: () => {}, error: () => {}, warn: () => {}, invocationId: "test" };

async function call(method, { userId, body, query = "" } = {}) {
  const route = registeredRoutes.looks;
  assert.ok(route, "looks route should be registered");
  const req = fakeRequest({
    method,
    url: `http://localhost:7071/api/looks${query}`,
    headers: userId !== undefined ? { authorization: `Bearer dev:${userId}` } : {},
    body,
  });
  return route.handler(req, context);
}

function look(templateId = "office-neutral", shadeId = "12") {
  const steps = [
    { role: "base", label: "Base", hex: "#E8D5C4", source: "owned", shadeId, brand: "Essie", name: "Ballet Slippers" },
    { role: "accent", label: "Accent nail", hex: "#A8846A", source: "template" },
  ];
  return {
    id: `${templateId}:${shadeId},-`,
    templateId,
    name: "Office Neutral",
    vibe: { occasion: "work", mood: "soft", finish: null, ownedOnly: false },
    steps,
  };
}

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("looks route", () => {
  it("registers GET, POST, DELETE and OPTIONS on /api/looks", () => {
    assert.deepEqual([...registeredRoutes.looks.methods].sort(), ["DELETE", "GET", "OPTIONS", "POST"]);
    assert.equal(registeredRoutes.looks.route, "looks");
  });

  it("requires authentication for every method", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await call(method, { body: look(), query: "?key=x" });
      assert.equal(res.status, 401, method);
    }
  });
});

describe("POST /api/looks", () => {
  it("saves a look and returns it with savedAt", async () => {
    const res = await call("POST", { userId: OWNER, body: look() });
    assert.equal(res.status, 201);
    assert.equal(res.jsonBody.id, "office-neutral:12,-");
    assert.match(res.jsonBody.savedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, OWNER);
  });

  it("upserts the same look key instead of duplicating it", async () => {
    await call("POST", { userId: OWNER, body: look() });
    const again = await call("POST", { userId: OWNER, body: { ...look(), name: "Renamed" } });
    assert.equal(again.status, 201);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Renamed");
  });

  it("rejects malformed bodies with 400", async () => {
    for (const body of ["not json", { ...look(), id: "office-neutral:99,-" }, { ...look(), steps: [] }, [look()]]) {
      const res = await call("POST", { userId: OWNER, body });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.ok(res.jsonBody.error);
    }
    assert.equal(rows.length, 0);
  });

  it("rejects steps whose JSON would exceed the database byte limit with 400, not a 500", async () => {
    const wide = "€".repeat(160); // 3 bytes each in UTF-8: within the character limits, over the byte budget
    const steps = Array.from({ length: 4 }, (_, i) => ({
      role: "accent", label: "€".repeat(40), hex: "#A8846A", source: "owned", shadeId: String(i + 1), brand: "€".repeat(120), name: wide,
    }));
    const body = { ...look(), steps, id: `office-neutral:${steps.map((s) => s.shadeId).join(",")}` };
    const res = await call("POST", { userId: OWNER, body });
    assert.ok(res.status === 400 || res.status === 413, String(res.status));
    assert.equal(rows.length, 0);
  });

  it("rejects oversized bodies", async () => {
    const res = await call("POST", { userId: OWNER, body: { ...look(), padding: "x".repeat(20_000) } });
    assert.equal(res.status, 413);
  });

  it("stores only validated fields (no client-chosen user id)", async () => {
    await call("POST", { userId: OWNER, body: { ...look(), userId: OTHER } });
    assert.equal(rows[0].userId, OWNER);
    const insert = sqlCalls.find((c) => /^\s*INSERT/i.test(c.sql));
    assert.equal(insert.params[0], OWNER);
  });

  it("keeps at most 30 looks per user, dropping the oldest, without touching other users", async () => {
    await call("POST", { userId: OTHER, body: look("milk-bath", "7") });
    for (let i = 1; i <= 32; i++) await call("POST", { userId: OWNER, body: look("office-neutral", String(i)) });
    const owned = rows.filter((r) => r.userId === OWNER);
    assert.equal(owned.length, 30);
    assert.ok(!owned.some((r) => r.key === "office-neutral:1,-" || r.key === "office-neutral:2,-"));
    assert.equal(rows.filter((r) => r.userId === OTHER).length, 1);
  });
});

describe("GET /api/looks", () => {
  it("lists only the caller's looks, newest first", async () => {
    await call("POST", { userId: OWNER, body: look("office-neutral", "1") });
    await call("POST", { userId: OTHER, body: look("milk-bath", "7") });
    await call("POST", { userId: OWNER, body: look("office-neutral", "2") });
    const res = await call("GET", { userId: OWNER });
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody.looks.map((l) => l.id), ["office-neutral:2,-", "office-neutral:1,-"]);
    assert.equal(typeof res.jsonBody.looks[0].savedAt, "string");

    const other = await call("GET", { userId: OTHER });
    assert.deepEqual(other.jsonBody.looks.map((l) => l.id), ["milk-bath:7,-"]);
  });
});

describe("DELETE /api/looks?key=", () => {
  it("deletes the caller's look", async () => {
    await call("POST", { userId: OWNER, body: look() });
    const res = await call("DELETE", { userId: OWNER, query: `?key=${encodeURIComponent("office-neutral:12,-")}` });
    assert.equal(res.status, 204);
    assert.equal(rows.length, 0);
  });

  it("cannot delete another user's look (404, row kept)", async () => {
    await call("POST", { userId: OWNER, body: look() });
    const res = await call("DELETE", { userId: OTHER, query: `?key=${encodeURIComponent("office-neutral:12,-")}` });
    assert.equal(res.status, 404);
    assert.equal(rows.length, 1);
  });

  it("requires a key", async () => {
    const res = await call("DELETE", { userId: OWNER });
    assert.equal(res.status, 400);
  });
});
