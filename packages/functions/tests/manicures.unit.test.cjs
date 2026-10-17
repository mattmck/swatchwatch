/**
 * Mani log (issue #269): `/api/manicures` validation, wear-stat recomputation on
 * create / edit / delete, `inventory_event(used)` sync, and per-user access control.
 *
 * Runs without a database. Handlers are loaded from dist/ with `../lib/db` swapped for a small
 * in-memory fake that understands the mani-log statements (same require-interception approach
 * as handlers.unit.test.cjs). The fake recomputes wear stats the way the SQL in
 * `src/lib/manicure.ts` does (count / max / min over the user's manicures), so these tests check
 * WHICH rows each handler recomputes and that every statement is bound to the caller; the SQL
 * itself was verified against Postgres 16 (see the PR description).
 *
 * Users: OWNER = 1, ATTACKER = 2. OWNER holds shades 10, 11, 12; ATTACKER holds shade 20.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

process.env.IMAGE_PROXY_SIGNING_KEY = "manicures-unit-test-signing-key-0123456789abcdef";
process.env.AZURE_STORAGE_CONNECTION = "UseDevelopmentStorage=true";
process.env.SOURCE_IMAGE_CONTAINER = "source-images";
process.env.USER_MEDIA_CONTAINER = "nail-photos";
delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const OWNER = 1;
const ATTACKER = 2;
const USERS = {
  [OWNER]: { user_id: OWNER, external_id: "ext-owner", email: null, role: "user" },
  [ATTACKER]: { user_id: ATTACKER, external_id: "ext-attacker", email: null, role: "user" },
};
const OWNER_PHOTO = 777;
const ATTACKER_PHOTO = 888;
const PHOTO_URL = (name) => `http://127.0.0.1:10000/devstoreaccount1/nail-photos/${name}.jpg`;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
const registeredRoutes = {};
const mockModules = {};
function registerMock(id, exports) {
  mockModules[id] = exports;
}
const originalResolve = Module._resolveFilename;
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
  output: { storageQueue: (opts) => ({ __type: "storageQueue", ...opts }) },
});
registerMock("jose", {
  errors: { JOSEError: class JOSEError extends Error {} },
  createRemoteJWKSet: () => {},
  jwtVerify: async () => ({ payload: {} }),
});

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------
let state;
/** Every handler statement (auth lookups excluded): { via, sql, params }. */
let calls;
let transactionCount;

function resetState() {
  calls = [];
  transactionCount = 0;
  state = {
    inventory: [
      { id: 101, userId: OWNER, shadeId: 10, wearCount: 0, lastWornOn: null, triedOn: null },
      { id: 102, userId: OWNER, shadeId: 11, wearCount: 0, lastWornOn: null, triedOn: null },
      { id: 103, userId: OWNER, shadeId: 12, wearCount: 0, lastWornOn: null, triedOn: "2020-01-01" },
      { id: 201, userId: ATTACKER, shadeId: 20, wearCount: 0, lastWornOn: null, triedOn: null },
    ],
    images: new Map([
      [OWNER_PHOTO, { ownerId: OWNER, url: PHOTO_URL("owner") }],
      [ATTACKER_PHOTO, { ownerId: ATTACKER, url: PHOTO_URL("attacker") }],
    ]),
    nextManicureId: 1,
    manicures: new Map(), // id -> { userId, wornOn, notes, photo, polishes: [{ shadeId, role, position }] }
    events: [], // { inventoryItemId (null = detached, D8), userId, shadeId, manicureId }
  };
}
resetState();

const sqlOf = (sql) => String(sql).replace(/\s+/g, " ").trim();
const ids = (value) => (Array.isArray(value) ? value.map(Number) : []);
const midnight = (date) => (date ? new Date(`${date}T00:00:00Z`) : null);

function manicureRow(id, m) {
  const photo = m.photo ? state.images.get(m.photo) : null;
  return {
    id: String(id),
    wornOn: m.wornOn,
    notes: m.notes,
    photoImageId: m.photo ? String(m.photo) : null,
    photoStorageUrl: photo && photo.ownerId === m.userId ? photo.url : null,
    createdAt: new Date("2026-10-17T00:00:00Z"),
    updatedAt: new Date("2026-10-17T00:00:00Z"),
  };
}

/** Mirrors recomputeWearStats: derived from the user's manicures, tried_at only filled. */
function recompute(userId, shadeIds, fillTriedAt) {
  const rows = [];
  for (const item of state.inventory) {
    if (item.userId !== userId || !shadeIds.includes(item.shadeId)) continue;
    const dates = [...state.manicures.values()]
      .filter((m) => m.userId === userId && m.polishes.some((p) => p.shadeId === item.shadeId))
      .map((m) => m.wornOn)
      .sort();
    item.wearCount = dates.length;
    item.lastWornOn = dates.length ? dates[dates.length - 1] : null;
    if (fillTriedAt && !item.triedOn && dates.length) item.triedOn = dates[0];
    rows.push({
      shadeId: String(item.shadeId),
      inventoryItemId: String(item.id),
      wearCount: item.wearCount,
      lastWornAt: midnight(item.lastWornOn),
      triedAt: midnight(item.triedOn),
    });
  }
  return rows;
}

function handle(via, rawSql, params = []) {
  const sql = sqlOf(rawSql);
  if (/FROM app_user/i.test(sql)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [] };
  }
  calls.push({ via, sql, params });

  // resolveManicurePolishes
  if (/^SELECT inventory_item_id::text AS "inventoryItemId", shade_id::text AS "shadeId" FROM user_inventory_item/.test(sql)) {
    const [userId, shadeIds, itemIds] = [Number(params[0]), ids(params[1]), ids(params[2])];
    return {
      rows: state.inventory
        .filter((i) => i.userId === userId && (shadeIds.includes(i.shadeId) || itemIds.includes(i.id)))
        .map((i) => ({ inventoryItemId: String(i.id), shadeId: String(i.shadeId) })),
    };
  }
  if (/FROM user_inventory_item WHERE user_id = \$1 AND shade_id = ANY\(\$2::bigint\[\]\) ORDER BY inventory_item_id FOR UPDATE/.test(sql)) {
    return { rows: [] };
  }
  if (/^SELECT 1 FROM image_asset WHERE image_id = \$1 AND owner_type = 'user' AND owner_id = \$2/.test(sql)) {
    const image = state.images.get(Number(params[0]));
    return { rows: image && image.ownerId === Number(params[1]) ? [{ "?column?": 1 }] : [] };
  }
  if (/^INSERT INTO manicure \(user_id, worn_on, notes, photo_image_id\)/.test(sql)) {
    const id = state.nextManicureId++;
    state.manicures.set(id, {
      userId: Number(params[0]),
      wornOn: params[1],
      notes: params[2],
      photo: params[3] === null ? null : Number(params[3]),
      polishes: [],
    });
    return { rows: [{ manicureId: String(id) }] };
  }
  if (/^INSERT INTO manicure_polish/.test(sql)) {
    const m = state.manicures.get(Number(params[0]));
    params[1].forEach((shadeId, i) => m.polishes.push({ shadeId: Number(shadeId), role: params[2][i], position: params[3][i] }));
    return { rows: [] };
  }
  if (/^DELETE FROM manicure_polish WHERE manicure_id = \$1$/.test(sql)) {
    state.manicures.get(Number(params[0])).polishes = [];
    return { rows: [] };
  }
  if (/^SELECT manicure_id FROM manicure WHERE manicure_id = \$1 AND user_id = \$2 FOR UPDATE$/.test(sql)) {
    const m = state.manicures.get(Number(params[0]));
    return { rows: m && m.userId === Number(params[1]) ? [{ manicure_id: params[0] }] : [] };
  }
  if (/^SELECT DISTINCT shade_id::text AS "shadeId" FROM manicure_polish WHERE manicure_id = \$1$/.test(sql)) {
    const m = state.manicures.get(Number(params[0]));
    return { rows: [...new Set(m.polishes.map((p) => p.shadeId))].map((s) => ({ shadeId: String(s) })) };
  }
  if (/^UPDATE manicure SET worn_on/.test(sql)) {
    const m = state.manicures.get(Number(params[0]));
    if (m && m.userId === Number(params[1])) {
      if (params[2]) m.wornOn = params[2];
      if (params[5].includes("notes")) m.notes = params[3];
      if (params[5].includes("photoImageId")) m.photo = params[4] === null ? null : Number(params[4]);
    }
    return { rows: [] };
  }
  if (/^DELETE FROM manicure WHERE manicure_id = \$1 AND user_id = \$2$/.test(sql)) {
    const m = state.manicures.get(Number(params[0]));
    if (m && m.userId === Number(params[1])) {
      state.manicures.delete(Number(params[0]));
      state.events = state.events.filter((e) => e.manicureId !== Number(params[0])); // ON DELETE CASCADE
    }
    return { rows: [] };
  }
  if (/inventory_event/.test(sql)) {
    // syncManicureEvents: model the end state (one event per shade on the manicure, attached to
    // the caller's inventory row for it or detached when the polish is not in the collection).
    if (/^INSERT INTO inventory_event/.test(sql)) {
      const [userId, manicureId] = [Number(params[0]), Number(params[1])];
      const m = state.manicures.get(manicureId);
      state.events = state.events.filter((e) => e.manicureId !== manicureId);
      if (m && m.userId === userId) {
        for (const shadeId of new Set(m.polishes.map((p) => p.shadeId))) {
          const item = state.inventory.find((i) => i.userId === userId && i.shadeId === shadeId);
          state.events.push({ inventoryItemId: item ? item.id : null, userId, shadeId, manicureId });
        }
      }
    }
    // reattachInventoryEvents: the caller's detached events → their current row for the shade.
    if (/^UPDATE inventory_event ie SET inventory_item_id = ui\.inventory_item_id/.test(sql)) {
      const [userId, shadeIds] = [Number(params[0]), ids(params[1])];
      for (const e of state.events) {
        if (e.userId !== userId || e.inventoryItemId !== null || !shadeIds.includes(e.shadeId)) continue;
        const item = state.inventory.find((i) => i.userId === userId && i.shadeId === e.shadeId);
        if (item) e.inventoryItemId = item.id;
      }
    }
    return { rows: [], rowCount: 0 };
  }
  if (/^WITH target AS .* UPDATE user_inventory_item ui SET wear_count/.test(sql)) {
    return { rows: recompute(Number(params[0]), ids(params[1]), params[2] === true) };
  }
  if (/FROM manicure m LEFT JOIN image_asset ia/.test(sql)) {
    const userId = Number(params[0]);
    if (/WHERE m\.manicure_id = \$2 AND m\.user_id = \$1/.test(sql)) {
      const m = state.manicures.get(Number(params[1]));
      return { rows: m && m.userId === userId ? [manicureRow(params[1], m)] : [] };
    }
    const [from, to, shadeId, limit, offset] = params.slice(1);
    const all = [...state.manicures.entries()]
      .filter(([, m]) => m.userId === userId)
      .filter(([, m]) => (!from || m.wornOn >= from) && (!to || m.wornOn <= to))
      .filter(([, m]) => shadeId === null || m.polishes.some((p) => p.shadeId === Number(shadeId)))
      .sort(([ia, a], [ib, b]) => b.wornOn.localeCompare(a.wornOn) || ib - ia);
    return {
      rows: all.slice(offset, offset + limit).map(([id, m]) => ({ ...manicureRow(id, m), totalCount: String(all.length) })),
    };
  }
  if (/^SELECT COUNT\(\*\)::text AS total FROM manicure m/.test(sql)) {
    const userId = Number(params[0]);
    return { rows: [{ total: String([...state.manicures.values()].filter((m) => m.userId === userId).length) }] };
  }
  if (/FROM manicure_polish mp JOIN manicure m ON m\.manicure_id = mp\.manicure_id AND m\.user_id = \$1/.test(sql)) {
    const userId = Number(params[0]);
    const rows = [];
    for (const manicureId of ids(params[1])) {
      const m = state.manicures.get(manicureId);
      if (!m || m.userId !== userId) continue;
      for (const p of m.polishes) {
        const item = state.inventory.find((i) => i.userId === userId && i.shadeId === p.shadeId);
        rows.push({
          manicureId: String(manicureId),
          shadeId: String(p.shadeId),
          inventoryItemId: item ? String(item.id) : null,
          role: p.role,
          position: p.position,
          brand: "Brand",
          name: `Shade ${p.shadeId}`,
          vendorHex: "#AA0000",
          detectedHex: null,
          nameHex: null,
        });
      }
    }
    return { rows };
  }
  throw new Error(`Unexpected SQL in fake DB: ${sql.slice(0, 160)}`);
}

const dbMock = {
  query: async (sql, params) => handle("pool", sql, params),
  transaction: async (cb) => {
    transactionCount += 1;
    const snapshot = structuredClone(state);
    try {
      return await cb({ query: async (sql, params) => handle("tx", sql, params) });
    } catch (error) {
      state = snapshot; // ROLLBACK
      throw error;
    }
  },
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const manicureLib = require("../dist/lib/manicure");
require("../dist/functions/manicures");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fakeRequest({ method = "GET", path: p = "manicures", userId = OWNER, params = {}, body } = {}) {
  return {
    method,
    url: `http://localhost:7071/api/${p}`,
    headers: {
      get: (name) => (name.toLowerCase() === "authorization" && userId ? `Bearer dev:${userId}` : null),
    },
    params,
    json: async () => body,
  };
}
const fakeContext = () => ({ log() {}, error() {}, warn() {}, invocationId: "test-invocation" });

async function invoke(route, opts) {
  return registeredRoutes[route].handler(fakeRequest(opts), fakeContext());
}
const create = (body, userId = OWNER) => invoke("manicures-create", { method: "POST", body, userId });
const update = (id, body, userId = OWNER, method = "PATCH") =>
  invoke("manicures-mutate", { method, path: `manicures/${id}`, params: { id: String(id) }, body, userId });
const remove = (id, userId = OWNER) =>
  invoke("manicures-mutate", { method: "DELETE", path: `manicures/${id}`, params: { id: String(id) }, userId });
const list = (qs = "", userId = OWNER) => invoke("manicures-list", { path: `manicures${qs}`, userId });
const getOne = (id, userId = OWNER) =>
  invoke("manicures-list", { path: `manicures/${id}`, params: { id: String(id) }, userId });

/** "shade:wear_count:last_worn:tried" for the user's inventory rows. */
function stats(userId = OWNER) {
  return state.inventory
    .filter((i) => i.userId === userId)
    .map((i) => `${i.shadeId}:${i.wearCount}:${i.lastWornOn ?? "-"}:${i.triedOn ?? "-"}`)
    .join(" ");
}
const recomputeCalls = () => calls.filter((c) => /UPDATE user_inventory_item ui SET wear_count/.test(c.sql));
const mutations = () => calls.filter((c) => /^(INSERT|UPDATE|DELETE)\b/.test(c.sql) || /^WITH target/.test(c.sql));

beforeEach(() => {
  resetState();
  process.env.AUTH_DEV_BYPASS = "true";
});
afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
});

// ═══════════════════════════════════════════════════════════════════════════
// lib/manicure — pure validation
// ═══════════════════════════════════════════════════════════════════════════

describe("lib/manicure — parseManicureBody", () => {
  const { parseManicureBody, ManicureRequestError } = manicureLib;
  const NOW = new Date("2026-10-17T12:00:00Z");
  const rejects = (body, mode, pattern) =>
    assert.throws(
      () => parseManicureBody(body, mode, NOW),
      (err) => err instanceof ManicureRequestError && err.status === 400 && pattern.test(err.message)
    );

  it("create: defaults wornOn to today (UTC) and role to color, keeps array order", () => {
    const parsed = parseManicureBody({ polishes: [{ shadeId: "10" }, { inventoryItemId: 102, role: "topper" }] }, "create", NOW);
    assert.deepEqual(parsed, {
      wornOn: "2026-10-17",
      notes: undefined,
      photoImageId: undefined,
      polishes: [
        { shadeId: 10, role: "color" },
        { inventoryItemId: 102, role: "topper" },
      ],
    });
  });

  it("trims notes, turns blank notes into null and accepts a numeric-string photo id", () => {
    const parsed = parseManicureBody({ notes: "  ", photoImageId: "777", polishes: [{ shadeId: 1 }] }, "create", NOW);
    assert.equal(parsed.notes, null);
    assert.equal(parsed.photoImageId, 777);
    assert.equal(parseManicureBody({ notes: " cute ", polishes: [{ shadeId: 1 }] }, "create", NOW).notes, "cute");
  });

  it("accepts tomorrow (timezone slack) but rejects later dates, impossible dates and bad formats", () => {
    assert.equal(parseManicureBody({ wornOn: "2026-10-18", polishes: [{ shadeId: 1 }] }, "create", NOW).wornOn, "2026-10-18");
    rejects({ wornOn: "2026-10-19", polishes: [{ shadeId: 1 }] }, "create", /future/);
    rejects({ wornOn: "2026-02-30", polishes: [{ shadeId: 1 }] }, "create", /not a valid date/);
    rejects({ wornOn: "17/10/2026", polishes: [{ shadeId: 1 }] }, "create", /YYYY-MM-DD/);
    rejects({ wornOn: "1899-12-31", polishes: [{ shadeId: 1 }] }, "create", /1900-01-01/);
    rejects({ wornOn: null, polishes: [{ shadeId: 1 }] }, "update", /cannot be null/);
  });

  it("rejects missing, empty, oversized and malformed polish lists", () => {
    rejects({}, "create", /polishes is required/);
    rejects({ polishes: [] }, "create", /at least one/);
    rejects({ polishes: "10" }, "create", /must be an array/);
    rejects({ polishes: Array.from({ length: 21 }, (_, i) => ({ shadeId: i + 1 })) }, "create", /at most 20/);
    rejects({ polishes: [42] }, "create", /must be an object/);
    rejects({ polishes: [{}] }, "create", /exactly one of shadeId or inventoryItemId/);
    rejects({ polishes: [{ shadeId: 1, inventoryItemId: 2 }] }, "create", /exactly one/);
    rejects({ polishes: [{ shadeId: "12abc" }] }, "create", /positive integer/);
    rejects({ polishes: [{ shadeId: 0 }] }, "create", /positive integer/);
    rejects({ polishes: [{ shadeId: 1.5 }] }, "create", /positive integer/);
    rejects({ polishes: [{ shadeId: 1, role: "Color" }] }, "create", /role must be one of: base, color, accent, topper, other/);
  });

  it("rejects bad notes and photo ids", () => {
    rejects({ notes: 5, polishes: [{ shadeId: 1 }] }, "create", /notes must be a string/);
    rejects({ notes: "x".repeat(2001), polishes: [{ shadeId: 1 }] }, "create", /at most 2000/);
    rejects({ photoImageId: "abc", polishes: [{ shadeId: 1 }] }, "create", /photoImageId/);
    rejects({ photoImageId: -1, polishes: [{ shadeId: 1 }] }, "create", /photoImageId/);
  });

  it("update: every field is optional, null clears notes/photo, an empty body is rejected", () => {
    assert.deepEqual(parseManicureBody({ notes: null, photoImageId: null }, "update", NOW), {
      wornOn: undefined,
      notes: null,
      photoImageId: null,
      polishes: undefined,
    });
    rejects({}, "update", /Nothing to update/);
    rejects([], "update", /JSON object/);
    rejects({ polishes: [] }, "update", /at least one/);
  });
});

describe("lib/manicure — parseManicureListQuery", () => {
  const { parseManicureListQuery } = manicureLib;
  const q = (s) => parseManicureListQuery(new URLSearchParams(s));

  it("defaults to page 1 / 50 with no filters and caps pageSize at 200", () => {
    assert.deepEqual(q(""), { from: null, to: null, shadeId: null, page: 1, pageSize: 50 });
    assert.equal(q("pageSize=1000").pageSize, 200);
    assert.deepEqual(q("from=2026-10-01&to=2026-10-31&shadeId=10&page=2"), {
      from: "2026-10-01",
      to: "2026-10-31",
      shadeId: 10,
      page: 2,
      pageSize: 50,
    });
  });

  it("rejects bad dates, reversed ranges and bad paging", () => {
    assert.throws(() => q("from=2026-13-01"), /not a valid date/);
    assert.throws(() => q("from=2026-10-31&to=2026-10-01"), /on or before/);
    assert.throws(() => q("page=0"), /positive integer/);
    assert.throws(() => q("shadeId=1;DROP"), /positive integer/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Routes + authentication
// ═══════════════════════════════════════════════════════════════════════════

describe("manicures routes", () => {
  it("registers list/get, create and mutate routes with CORS preflight", () => {
    assert.deepEqual(registeredRoutes["manicures-list"].methods, ["GET", "OPTIONS"]);
    assert.equal(registeredRoutes["manicures-list"].route, "manicures/{id?}");
    assert.deepEqual(registeredRoutes["manicures-create"].methods, ["POST", "OPTIONS"]);
    assert.deepEqual(registeredRoutes["manicures-mutate"].methods, ["PUT", "PATCH", "DELETE", "OPTIONS"]);
    assert.equal(registeredRoutes["manicures-mutate"].route, "manicures/{id}");
  });

  for (const [label, run] of [
    ["GET list", () => list("", null)],
    ["GET one", () => getOne(1, null)],
    ["POST", () => create({ polishes: [{ shadeId: 10 }] }, null)],
    ["PATCH", () => update(1, { notes: "x" }, null)],
    ["DELETE", () => remove(1, null)],
  ]) {
    it(`${label} without a token → 401 and no SQL`, async () => {
      const res = await run();
      assert.equal(res.status, 401);
      assert.deepEqual(calls, []);
    });
  }

  it("rejects non-numeric ids with 400 before any SQL", async () => {
    for (const res of [await getOne("12abc"), await update("1x", { notes: "a" }), await remove("-3")]) {
      assert.equal(res.status, 400);
    }
    assert.deepEqual(calls, []);
  });

  it("rejects an invalid JSON body with 400", async () => {
    const res = await registeredRoutes["manicures-create"].handler(
      { ...fakeRequest({ method: "POST" }), json: async () => { throw new SyntaxError("bad json"); } },
      fakeContext()
    );
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /valid JSON/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Wear stats: create / edit / delete recompute from the mani log
// ═══════════════════════════════════════════════════════════════════════════

describe("manicures — wear stats", () => {
  it("logging a mani sets tried_at if null, bumps wear_count and sets last_worn_at, in one transaction", async () => {
    const res = await create({
      wornOn: "2026-10-10",
      notes: "first",
      polishes: [{ shadeId: 10, role: "base" }, { inventoryItemId: 103, role: "color" }, { shadeId: 10, role: "topper" }],
    });
    assert.equal(res.status, 201);
    assert.equal(transactionCount, 1);
    // Shade 12 keeps its earlier tried_at; shade 10 counts once although it has two roles.
    assert.equal(stats(), "10:1:2026-10-10:2026-10-10 11:0:-:- 12:1:2026-10-10:2020-01-01");
    assert.deepEqual(
      res.jsonBody.wearStats.map((s) => [s.shadeId, s.wearCount, s.lastWornAt, s.triedAt]),
      [
        ["10", 1, "2026-10-10T00:00:00.000Z", "2026-10-10T00:00:00.000Z"],
        ["12", 1, "2026-10-10T00:00:00.000Z", "2020-01-01T00:00:00.000Z"],
      ]
    );
    assert.deepEqual(
      res.jsonBody.polishes.map((p) => [p.shadeId, p.role, p.position, p.inventoryItemId]),
      [
        ["10", "base", 0, "101"],
        ["12", "color", 1, "103"],
        ["10", "topper", 2, "101"],
      ]
    );
    assert.equal(res.jsonBody.wornOn, "2026-10-10");
    assert.equal(res.jsonBody.notes, "first");
    // One inventory_event(used) per inventory row.
    assert.deepEqual(state.events.map((e) => e.inventoryItemId).sort(), [101, 103]);
    // The recompute covers exactly the referenced shades and fills tried_at.
    const [rc] = recomputeCalls();
    assert.deepEqual(rc.params, [OWNER, [10, 12], true]);
  });

  it("last_worn_at is the latest wear, not the latest logged one; tried_at is set only when null", async () => {
    await create({ wornOn: "2026-10-14", polishes: [{ shadeId: 10 }] });
    await create({ wornOn: "2026-10-01", polishes: [{ shadeId: 10 }] }); // back-dated
    assert.equal(stats().split(" ")[0], "10:2:2026-10-14:2026-10-14");
  });

  it("editing recomputes old and new polishes (swap, date move) instead of inc/dec", async () => {
    const first = await create({ wornOn: "2026-10-10", polishes: [{ shadeId: 10 }, { shadeId: 11, role: "accent" }] });
    await create({ wornOn: "2026-10-12", polishes: [{ shadeId: 10 }] });
    assert.equal(stats(), "10:2:2026-10-12:2026-10-10 11:1:2026-10-10:2026-10-10 12:0:-:2020-01-01");

    calls = [];
    const res = await update(first.jsonBody.id, { wornOn: "2026-10-15", polishes: [{ shadeId: 10 }, { shadeId: 12, role: "topper" }] });
    assert.equal(res.status, 200);
    // 11 dropped out (wear 0, last worn cleared, tried_at kept); 12 gained a wear; 10 moved later.
    assert.equal(stats(), "10:2:2026-10-15:2026-10-10 11:0:-:2026-10-10 12:1:2026-10-15:2020-01-01");
    const [rc] = recomputeCalls();
    assert.deepEqual(rc.params[1].slice().sort(), [10, 11, 12]);
    assert.deepEqual(state.events.filter((e) => e.manicureId === Number(first.jsonBody.id)).map((e) => e.inventoryItemId).sort(), [101, 103]);
    assert.deepEqual(res.jsonBody.wearStats.map((s) => s.shadeId), ["10", "11", "12"]);
  });

  it("a notes-only edit keeps the polishes and still recomputes their stats", async () => {
    const first = await create({ wornOn: "2026-10-10", polishes: [{ shadeId: 10 }] });
    calls = [];
    const res = await update(first.jsonBody.id, { notes: "chipped on day 3" }, OWNER, "PUT");
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.notes, "chipped on day 3");
    assert.equal(res.jsonBody.polishes.length, 1);
    assert.ok(!calls.some((c) => /DELETE FROM manicure_polish/.test(c.sql)), "polishes untouched");
    assert.deepEqual(recomputeCalls()[0].params[1], [10]);
    assert.equal(stats().split(" ")[0], "10:1:2026-10-10:2026-10-10");
  });

  it("deleting recomputes the polishes it used and removes its events", async () => {
    const first = await create({ wornOn: "2026-10-10", polishes: [{ shadeId: 10 }, { shadeId: 11 }] });
    await create({ wornOn: "2026-10-08", polishes: [{ shadeId: 10 }] });
    const res = await remove(first.jsonBody.id);
    assert.equal(res.status, 200);
    // tried_at is only ever filled (when null), never rewritten or cleared by the mani log.
    assert.equal(stats(), "10:1:2026-10-08:2026-10-10 11:0:-:2026-10-10 12:0:-:2020-01-01");
    assert.equal(state.manicures.size, 1);
    assert.ok(state.events.every((e) => e.manicureId !== Number(first.jsonBody.id)));
    assert.deepEqual(res.jsonBody.wearStats.map((s) => [s.shadeId, s.wearCount]), [["10", 1], ["11", 0]]);
  });

  it("an edit may keep a polish the user has since removed from the collection", async () => {
    const first = await create({ wornOn: "2026-10-10", polishes: [{ shadeId: 11 }] });
    state.inventory = state.inventory.filter((i) => i.id !== 102); // DELETE /api/polishes/11
    const res = await update(first.jsonBody.id, { polishes: [{ shadeId: 11 }, { shadeId: 10, role: "topper" }] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody.polishes.map((p) => [p.shadeId, p.inventoryItemId]), [["11", null], ["10", "101"]]);
  });

  it("deleting a polish from the collection keeps its wear events; re-adding re-attaches them (D8, #317)", async () => {
    const first = await create({ wornOn: "2026-10-10", polishes: [{ shadeId: 10 }, { shadeId: 11, role: "accent" }] });
    const manicureId = Number(first.jsonBody.id);
    // DELETE /api/polishes/11: inventory_event.inventory_item_id is ON DELETE SET NULL.
    state.inventory = state.inventory.filter((i) => i.id !== 102);
    for (const e of state.events) if (e.inventoryItemId === 102) e.inventoryItemId = null;

    // An edit keeps the detached event (it is keyed by shade, not by the deleted row).
    await update(manicureId, { notes: "still have the photo" });
    const eventFor = (shadeId) => state.events.find((e) => e.manicureId === manicureId && e.shadeId === shadeId);
    assert.deepEqual(eventFor(11), { inventoryItemId: null, userId: OWNER, shadeId: 11, manicureId });
    assert.equal(eventFor(10).inventoryItemId, 101);

    // Re-adding the polish (POST /api/polishes recomputes wear stats) re-attaches the event.
    state.inventory.push({ id: 104, userId: OWNER, shadeId: 11, wearCount: 0, lastWornOn: null, triedOn: null });
    const client = { query: async (sql, params) => handle("client", sql, params) };
    const rows = await manicureLib.recomputeWearStats(client, OWNER, [11], { fillTriedAt: false });
    assert.equal(eventFor(11).inventoryItemId, 104);
    assert.deepEqual(rows.map((r) => [r.inventoryItemId, r.wearCount]), [["104", 1]]);
  });

  it("event sync and re-attach SQL are keyed by user + shade and bound to the caller", async () => {
    await create({ polishes: [{ shadeId: 10 }] });
    const eventCalls = calls.filter((c) => /inventory_event/.test(c.sql));
    assert.ok(eventCalls.length >= 4, "re-attach + delete / update / insert");
    for (const call of eventCalls) {
      assert.equal(Number(call.params[0]), OWNER, call.sql);
      assert.match(call.sql, /ie\.user_id = \$1/, call.sql);
    }
    const reattach = eventCalls.find((c) => /^UPDATE inventory_event ie SET inventory_item_id = ui\.inventory_item_id/.test(c.sql));
    assert.match(reattach.sql, /ie\.inventory_item_id IS NULL/);
    assert.match(reattach.sql, /ui\.user_id = \$1 AND ui\.shade_id = ie\.shade_id/);
    const reattachAt = calls.indexOf(reattach);
    assert.ok(reattachAt < calls.indexOf(recomputeCalls()[0]), "re-attach runs before the recompute");
    const insert = eventCalls.find((c) => /^INSERT INTO inventory_event/.test(c.sql));
    assert.match(insert.sql, /\(inventory_item_id, user_id, shade_id, event_type, event_payload, manicure_id\)/);
    assert.match(insert.sql, /LEFT JOIN user_inventory_item ui ON ui\.user_id = m\.user_id AND ui\.shade_id = mp\.shade_id/);
    const del = eventCalls.find((c) => /^DELETE FROM inventory_event/.test(c.sql));
    assert.match(del.sql, /ie\.shade_id NOT IN/);
  });

  it("the recompute SQL derives stats from the mani log (count / max / min), never inc/dec", async () => {
    await create({ polishes: [{ shadeId: 10 }] });
    const { sql } = recomputeCalls()[0];
    assert.match(sql, /COUNT\(DISTINCT m\.manicure_id\)/);
    assert.match(sql, /MAX\(m\.worn_on\)/);
    assert.match(sql, /COALESCE\(ui\.tried_at, w\.first_worn_on/);
    assert.match(sql, /WHERE m\.user_id = \$1/);
    assert.match(sql, /WHERE ui\.user_id = \$1/);
    assert.doesNotMatch(sql, /wear_count\s*[+-]\s*1/);
  });

  it("a failed reference rolls the whole log back (no manicure, no stat change)", async () => {
    const res = await create({ polishes: [{ shadeId: 10 }, { shadeId: 20 }] });
    assert.equal(res.status, 404);
    assert.equal(state.manicures.size, 0);
    assert.equal(stats(), "10:0:-:- 11:0:-:- 12:0:-:2020-01-01");
    assert.ok(!calls.some((c) => /INSERT INTO manicure/.test(c.sql)), "validation happens before any insert");
  });

  it("rejects the same polish twice in the same role", async () => {
    const res = await create({ polishes: [{ shadeId: 10 }, { inventoryItemId: 101 }] });
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /same role/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Read paths
// ═══════════════════════════════════════════════════════════════════════════

describe("manicures — list and get", () => {
  it("lists newest first with date range, shade filter and paging", async () => {
    await create({ wornOn: "2026-09-30", polishes: [{ shadeId: 11 }] });
    await create({ wornOn: "2026-10-05", polishes: [{ shadeId: 10 }] });
    await create({ wornOn: "2026-10-12", polishes: [{ shadeId: 10 }, { shadeId: 12 }] });

    let res = await list("?from=2026-10-01&to=2026-10-31");
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody.manicures.map((m) => m.wornOn), ["2026-10-12", "2026-10-05"]);
    assert.equal(res.jsonBody.total, 2);

    res = await list("?shadeId=12");
    assert.deepEqual(res.jsonBody.manicures.map((m) => m.wornOn), ["2026-10-12"]);

    res = await list("?page=2&pageSize=2");
    assert.deepEqual([res.jsonBody.page, res.jsonBody.pageSize, res.jsonBody.total], [2, 2, 3]);
    assert.equal(res.jsonBody.manicures.length, 1);

    res = await list("?page=9&pageSize=2");
    assert.equal(res.jsonBody.total, 3, "page past the end still reports the total");

    res = await list("?from=2026-10-31&to=2026-10-01");
    assert.equal(res.status, 400);
  });

  it("returns an owner-scoped v3 photo URL for the caller's own photo", async () => {
    const created = await create({ photoImageId: OWNER_PHOTO, polishes: [{ shadeId: 10 }] });
    assert.equal(created.status, 201);
    assert.equal(created.jsonBody.photoImageId, String(OWNER_PHOTO));
    assert.match(created.jsonBody.photoUrl, /^http:\/\/localhost:7071\/api\/images\/v3\./);
    const res = await getOne(created.jsonBody.id);
    assert.match(res.jsonBody.photoUrl, /\/api\/images\/v3\.[^.]+\.[^.]+\.1\./, "bound to owner id 1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Access control: only the caller's own manicures, inventory and photos
// ═══════════════════════════════════════════════════════════════════════════

describe("manicures — access control", () => {
  /** Every handler statement touching user data is bound to the caller's id. */
  function assertScopedTo(userId) {
    for (const c of calls) {
      if (!/\b(manicure m|user_inventory_item|image_asset)\b/.test(c.sql)) continue;
      const placeholders = [...c.sql.matchAll(/\b(?:user_id|owner_id)\s*=\s*\$(\d+)/g)].map((m) => Number(m[1]));
      assert.ok(placeholders.length > 0, `statement is not user-scoped: ${c.sql.slice(0, 120)}`);
      for (const n of placeholders) {
        assert.equal(Number(c.params[n - 1]), userId, `statement bound to another user: ${c.sql.slice(0, 120)}`);
      }
    }
  }

  async function ownerManicure() {
    const res = await create({ wornOn: "2026-10-10", notes: "owner secret", photoImageId: OWNER_PHOTO, polishes: [{ shadeId: 10 }] });
    calls = [];
    return res.jsonBody.id;
  }

  it("another user cannot list or read the owner's manicures", async () => {
    const id = await ownerManicure();
    const listed = await list("", ATTACKER);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.jsonBody.manicures, []);
    assert.equal(listed.jsonBody.total, 0);
    const got = await getOne(id, ATTACKER);
    assert.equal(got.status, 404);
    assert.doesNotMatch(JSON.stringify([listed.jsonBody, got.jsonBody]), /owner secret/);
    assertScopedTo(ATTACKER);
  });

  it("another user cannot edit or delete the owner's manicure (404, nothing written)", async () => {
    const id = await ownerManicure();
    const before = structuredClone(state);
    for (const res of [
      await update(id, { notes: "pwned", polishes: [{ shadeId: 20 }] }, ATTACKER),
      await update(id, { notes: "pwned" }, ATTACKER, "PUT"),
      await remove(id, ATTACKER),
    ]) {
      assert.equal(res.status, 404);
    }
    assert.deepEqual(state, before);
    assert.deepEqual(mutations(), [], "no writes for a manicure the caller does not own");
    assertScopedTo(ATTACKER);
  });

  it("cannot reference another user's inventory item or a shade they do not hold (404)", async () => {
    for (const polishes of [[{ shadeId: 10 }], [{ inventoryItemId: 101 }], [{ shadeId: 99999 }]]) {
      const res = await create({ polishes }, ATTACKER);
      assert.equal(res.status, 404);
      assert.match(res.jsonBody.error, /not in your collection/);
    }
    assert.equal(state.manicures.size, 0);
    assert.equal(stats(OWNER), "10:0:-:- 11:0:-:- 12:0:-:2020-01-01", "owner's stats untouched");
    assertScopedTo(ATTACKER);
  });

  it("cannot swap another user's polish into their own manicure on edit", async () => {
    const created = await create({ polishes: [{ shadeId: 20 }] }, ATTACKER);
    assert.equal(created.status, 201);
    const res = await update(created.jsonBody.id, { polishes: [{ shadeId: 20 }, { shadeId: 11 }] }, ATTACKER);
    assert.equal(res.status, 404);
    assert.equal(stats(OWNER), "10:0:-:- 11:0:-:- 12:0:-:2020-01-01");
  });

  it("cannot attach another user's photo (create or edit)", async () => {
    let res = await create({ photoImageId: OWNER_PHOTO, polishes: [{ shadeId: 20 }] }, ATTACKER);
    assert.equal(res.status, 404);
    assert.match(res.jsonBody.error, /Photo not found/);
    const own = await create({ polishes: [{ shadeId: 20 }] }, ATTACKER);
    res = await update(own.jsonBody.id, { photoImageId: OWNER_PHOTO }, ATTACKER);
    assert.equal(res.status, 404);
    assert.equal(state.manicures.get(Number(own.jsonBody.id)).photo, null);
    // Positive control: their own photo works.
    res = await update(own.jsonBody.id, { photoImageId: ATTACKER_PHOTO }, ATTACKER);
    assert.equal(res.status, 200);
    assert.match(res.jsonBody.photoUrl, /\/api\/images\/v3\.[^.]+\.[^.]+\.2\./);
  });

  it("the owner's own reads and writes are scoped to the owner (positive control)", async () => {
    const id = await ownerManicure();
    await update(id, { notes: "updated", polishes: [{ shadeId: 11 }] });
    await list("?from=2026-01-01");
    await remove(id);
    assertScopedTo(OWNER);
  });

  it("body userId spoofing is ignored", async () => {
    const res = await create({ userId: OWNER, user_id: OWNER, polishes: [{ shadeId: 20 }] }, ATTACKER);
    assert.equal(res.status, 201);
    assert.equal(state.manicures.get(Number(res.jsonBody.id)).userId, ATTACKER);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration ↔ shared constants
// ═══════════════════════════════════════════════════════════════════════════

describe("migration 20261017063740704_manicure-log", () => {
  const fs = require("node:fs");
  const shared = require("swatchwatch-shared");
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/20261017063740704_manicure-log.sql"), "utf8");
  const [up, down] = sql.split("-- Down Migration");

  it("role CHECK matches MANICURE_POLISH_ROLES", () => {
    const match = up.match(/CHECK \(role IN \(([^)]*)\)\)/);
    assert.ok(match);
    const roles = match[1].split(",").map((v) => v.trim().replace(/'/g, ""));
    assert.deepEqual(roles, [...shared.MANICURE_POLISH_ROLES]);
  });

  it("notes CHECK matches MAX_MANICURE_NOTES_LENGTH", () => {
    assert.match(up, new RegExp(`char_length\\(notes\\) <= ${shared.MAX_MANICURE_NOTES_LENGTH}`));
  });

  it("has a Down section that drops everything the Up section adds", () => {
    assert.ok(down, "missing -- Down Migration");
    for (const stmt of [
      /DROP TABLE IF EXISTS manicure_polish/,
      /DROP TABLE IF EXISTS manicure;/,
      /DROP COLUMN IF EXISTS manicure_id/,
      /DROP INDEX IF EXISTS idx_inventory_event_manicure/,
    ]) {
      assert.match(down, stmt);
    }
  });
});

describe("migration 20261017232537776_inventory-event-keep-wear-history (D8, #317)", () => {
  const fs = require("node:fs");
  const sql = fs.readFileSync(
    path.join(__dirname, "../migrations/20261017232537776_inventory-event-keep-wear-history.sql"),
    "utf8"
  );
  const [up, down] = sql.split("-- Down Migration");

  it("detaches events on inventory delete instead of cascading, keyed by user + shade", () => {
    assert.match(up, /ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES app_user\(user_id\) ON DELETE CASCADE/);
    assert.match(up, /ADD COLUMN IF NOT EXISTS shade_id BIGINT REFERENCES shade\(shade_id\) ON DELETE CASCADE/);
    assert.match(up, /ALTER COLUMN user_id SET NOT NULL/);
    assert.match(up, /ALTER COLUMN inventory_item_id DROP NOT NULL/);
    assert.match(up, /REFERENCES user_inventory_item\(inventory_item_id\) ON DELETE SET NULL/);
    assert.doesNotMatch(up, /user_inventory_item\(inventory_item_id\) ON DELETE CASCADE/, "the inventory FK must not cascade");
    // Backfill happens before NOT NULL.
    assert.ok(up.indexOf("UPDATE inventory_event ie") < up.indexOf("SET NOT NULL"));
  });

  it("has a Down section that restores the cascading NOT NULL FK and drops the new columns", () => {
    assert.ok(down, "missing -- Down Migration");
    for (const stmt of [
      /DELETE FROM inventory_event WHERE inventory_item_id IS NULL/,
      /REFERENCES user_inventory_item\(inventory_item_id\) ON DELETE CASCADE/,
      /ALTER COLUMN inventory_item_id SET NOT NULL/,
      /DROP INDEX IF EXISTS idx_inventory_event_user_shade/,
      /DROP INDEX IF EXISTS idx_inventory_event_item/,
      /DROP COLUMN IF EXISTS shade_id/,
      /DROP COLUMN IF EXISTS user_id/,
    ]) {
      assert.match(down, stmt);
    }
  });
});
