/**
 * Inventory status model (issue #261): request validation, list filters and the inventory
 * upsert for `status`, `triedAt`, `purchasePrice`, `purchaseCurrency`, plus the derived
 * `isUntried`. Runs without a database (same require-interception mocking as
 * handlers.unit.test.cjs). Cross-user isolation for these fields is covered in
 * access-control.unit.test.cjs.
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const registeredRoutes = {};
let queryMock = async () => ({ rows: [] });
let transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });

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
const dbMock = {
  query: (...args) => queryMock(...args),
  transaction: (...args) => transactionMock(...args),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
registerMock("../lib/ai-color-detection", {
  detectHexWithAzureOpenAI: async () => ({ hex: "#ABCDEF", confidence: 0.9, finishes: [], provider: "azure-openai" }),
});
registerMock("../lib/blob-storage", {
  isCatalogStorageUrl: () => false,
  isUserMediaStorageUrl: () => false,
  readBlobFromStorageUrl: async () => {
    throw new Error("blob reads are not exercised here");
  },
});
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const inventory = require("../dist/lib/inventory");
require("../dist/functions/polishes");
require("../dist/functions/admin-users");

afterEach(() => {
  queryMock = async () => ({ rows: [] });
  transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });
  delete process.env.AUTH_DEV_BYPASS;
});

function fakeRequest({ method = "GET", url, params = {}, body } = {}) {
  return {
    method,
    url,
    headers: { get: (name) => (name.toLowerCase() === "authorization" ? "Bearer dev:1" : null) },
    params,
    json: async () => body,
  };
}

function fakeContext() {
  return { log: () => {}, error: () => {}, warn: () => {}, extraOutputs: { set: () => {}, get: () => undefined } };
}

const USER_ROW = { user_id: 1, external_id: "ext-1", email: null, role: "user" };

/** Auth succeeds; every other pool query is recorded and answered by `respond`. */
function mockPool(respond = () => ({ rows: [] })) {
  process.env.AUTH_DEV_BYPASS = "true";
  const calls = [];
  queryMock = async (text, params) => {
    if (/FROM\s+app_user/i.test(text)) return { rows: [USER_ROW] };
    calls.push({ text: String(text), params });
    return respond(String(text), params);
  };
  return calls;
}

/** Transaction client recording every statement; the inventory upsert returns an id. */
function mockTransaction() {
  const calls = [];
  transactionMock = async (cb) =>
    cb({
      query: async (text, params) => {
        calls.push({ text: String(text), params });
        if (/INSERT INTO user_inventory_item/.test(text)) return { rows: [{ inventoryItemId: "42" }] };
        return { rows: [] };
      },
    });
  return calls;
}

function upsertCall(calls) {
  const call = calls.find((c) => /INSERT INTO user_inventory_item/.test(c.text));
  assert.ok(call, "expected the inventory upsert");
  return call;
}

/** Param bound to `$n` in the upsert (1-based). */
const param = (call, n) => call.params[n - 1];

// ═══════════════════════════════════════════════════════════════════════════
// lib/inventory — pure validation helpers
// ═══════════════════════════════════════════════════════════════════════════

describe("lib/inventory — parseInventoryFields", () => {
  const { parseInventoryFields, InventoryValidationError } = inventory;

  it("returns all-undefined for a body without inventory fields", () => {
    assert.deepEqual(parseInventoryFields({ quantity: 2 }), {
      status: undefined,
      triedAt: undefined,
      purchasePrice: undefined,
      purchaseCurrency: undefined,
      archiveReason: undefined,
      undoArchive: false,
    });
    assert.deepEqual(parseInventoryFields(null).status, undefined);
  });

  it("accepts every status value", () => {
    for (const status of ["owned", "wishlist", "destash", "archived"]) {
      assert.equal(parseInventoryFields({ status }).status, status);
    }
  });

  it("rejects unknown statuses, including the derived 'untried' and wrong case", () => {
    for (const status of ["untried", "Owned", "", "sold", 1, null]) {
      assert.throws(() => parseInventoryFields({ status }), InventoryValidationError, `status ${JSON.stringify(status)}`);
    }
  });

  it("normalizes triedAt dates and date-times to ISO UTC and keeps null (clear)", () => {
    assert.equal(parseInventoryFields({ triedAt: "2026-03-04" }).triedAt, "2026-03-04T00:00:00.000Z");
    assert.equal(parseInventoryFields({ triedAt: "2026-03-04T10:30:00+02:00" }).triedAt, "2026-03-04T08:30:00.000Z");
    assert.equal(parseInventoryFields({ triedAt: null }).triedAt, null);
  });

  it("rejects malformed, impossible and future triedAt values", () => {
    for (const triedAt of ["yesterday", "2026-02-30", "2026-03-04T10:30:00", 1700000000000, "2999-01-01"]) {
      assert.throws(() => parseInventoryFields({ triedAt }), InventoryValidationError, `triedAt ${triedAt}`);
    }
  });

  it("validates purchasePrice range and precision", () => {
    assert.equal(parseInventoryFields({ purchasePrice: 0 }).purchasePrice, 0);
    assert.equal(parseInventoryFields({ purchasePrice: 12.5 }).purchasePrice, 12.5);
    assert.equal(parseInventoryFields({ purchasePrice: 19.99 }).purchasePrice, 19.99);
    assert.equal(parseInventoryFields({ purchasePrice: null }).purchasePrice, null);
    for (const purchasePrice of [-1, 12.345, "12.50", Number.NaN, Infinity, 100_000_000]) {
      assert.throws(
        () => parseInventoryFields({ purchasePrice }),
        InventoryValidationError,
        `purchasePrice ${purchasePrice}`
      );
    }
  });

  it("validates and upper-cases purchaseCurrency", () => {
    assert.equal(parseInventoryFields({ purchaseCurrency: "usd" }).purchaseCurrency, "USD");
    assert.equal(parseInventoryFields({ purchaseCurrency: " EUR " }).purchaseCurrency, "EUR");
    assert.equal(parseInventoryFields({ purchaseCurrency: null }).purchaseCurrency, null);
    for (const purchaseCurrency of ["US", "DOLLARS", "U$D", 840]) {
      assert.throws(() => parseInventoryFields({ purchaseCurrency }), InventoryValidationError);
    }
  });

  it("accepts archiveReason only with status archived (D5c)", () => {
    assert.equal(parseInventoryFields({ status: "archived", archiveReason: "used_up" }).archiveReason, "used_up");
    assert.equal(parseInventoryFields({ status: "archived", archiveReason: "decluttered" }).archiveReason, "decluttered");
    for (const body of [
      { status: "archived", archiveReason: "used" },
      { status: "archived", archiveReason: "Used_Up" },
      { status: "archived", archiveReason: null },
      { archiveReason: "used_up" },
      { status: "wishlist", archiveReason: "used_up" },
    ]) {
      assert.throws(() => parseInventoryFields(body), InventoryValidationError, JSON.stringify(body));
    }
  });

  it("accepts undoArchive=true only without an archive status or reason", () => {
    assert.equal(parseInventoryFields({ status: "owned", quantity: 1, undoArchive: true }).undoArchive, true);
    assert.equal(parseInventoryFields({ undoArchive: false }).undoArchive, false);
    for (const body of [
      { undoArchive: "yes" },
      { status: "archived", undoArchive: true },
      { status: "archived", archiveReason: "used_up", undoArchive: true },
    ]) {
      assert.throws(() => parseInventoryFields(body), InventoryValidationError, JSON.stringify(body));
    }
  });

  it("lists only the clearable fields that were sent", () => {
    const fields = parseInventoryFields({ triedAt: null, purchaseCurrency: "usd" });
    assert.deepEqual(inventory.providedInventoryFields(fields), ["triedAt", "purchaseCurrency"]);
    assert.deepEqual(inventory.providedInventoryFields(parseInventoryFields({})), []);
  });
});

describe("lib/inventory — defaults and filters", () => {
  it("defaults a new row to owned unless the quantity is explicitly 0 (D5a)", () => {
    assert.equal(inventory.defaultStatusForNewItem(1), "owned");
    assert.equal(inventory.defaultStatusForNewItem(3), "owned");
    assert.equal(inventory.defaultStatusForNewItem(undefined), "owned");
    assert.equal(inventory.defaultStatusForNewItem(null), "owned");
    assert.equal(inventory.defaultStatusForNewItem(0), "wishlist");
    assert.equal(inventory.defaultStatusForNewItem(-1), "wishlist");
  });

  it("plans the archive-reason event for each status change (D5c)", () => {
    const plan = (prev, next, fields = {}) =>
      inventory.planArchiveEvent(prev, next, { archiveReason: undefined, undoArchive: false, ...fields });
    assert.deepEqual(plan("owned", "archived"), { kind: "insert", eventType: "used_up" });
    assert.deepEqual(plan("destash", "archived"), { kind: "insert", eventType: "decluttered" });
    assert.deepEqual(plan("owned", "archived", { archiveReason: "decluttered" }), { kind: "insert", eventType: "decluttered" });
    // Archiving something you never owned records a reason only when one is given.
    assert.deepEqual(plan("wishlist", "archived"), { kind: "none" });
    assert.deepEqual(plan(null, "archived"), { kind: "none" });
    assert.deepEqual(plan(null, "archived", { archiveReason: "used_up" }), { kind: "insert", eventType: "used_up" });
    // Already archived: a reason corrects the current archive, no reason changes nothing.
    assert.deepEqual(plan("archived", "archived", { archiveReason: "decluttered" }), { kind: "update", eventType: "decluttered" });
    assert.deepEqual(plan("archived", "archived"), { kind: "none" });
    // Undo removes the reason only when the row actually leaves archived.
    assert.deepEqual(plan("archived", "owned", { undoArchive: true }), { kind: "retract" });
    assert.deepEqual(plan("owned", "owned", { undoArchive: true }), { kind: "none" });
    // Rebuy (archived → wishlist) and restocking keep the history.
    assert.deepEqual(plan("archived", "wishlist"), { kind: "none" });
    assert.deepEqual(plan("archived", "owned"), { kind: "none" });
  });

  it("parses one or several statuses, de-duplicated in canonical order", () => {
    assert.deepEqual(inventory.parseStatusFilter(null), []);
    assert.deepEqual(inventory.parseStatusFilter(""), []);
    assert.deepEqual(inventory.parseStatusFilter("wishlist"), ["wishlist"]);
    assert.deepEqual(inventory.parseStatusFilter(" Archived ,owned,owned,"), ["owned", "archived"]);
  });

  it("rejects unknown status filter values", () => {
    assert.throws(() => inventory.parseStatusFilter("owned,untried"), /Invalid status filter "untried"/);
    assert.throws(() => inventory.parseStatusFilter("1 OR 1=1"), inventory.InventoryValidationError);
  });

  it("parses boolean flags strictly", () => {
    assert.equal(inventory.parseBooleanFlag("untried", null), false);
    assert.equal(inventory.parseBooleanFlag("untried", ""), false);
    for (const v of ["true", "TRUE", "1", "yes"]) assert.equal(inventory.parseBooleanFlag("untried", v), true);
    for (const v of ["false", "0", "no"]) assert.equal(inventory.parseBooleanFlag("untried", v), false);
    assert.throws(() => inventory.parseBooleanFlag("untried", "maybe"), /untried must be true or false/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/polishes — status / untried filters
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/polishes — list status filters", () => {
  const handler = () => registeredRoutes["polishes-list"].handler;

  async function list(qs, respond) {
    const calls = mockPool(respond ?? (() => ({ rows: [] })));
    const res = await handler()(fakeRequest({ url: `http://localhost:7071/api/polishes${qs}` }), fakeContext());
    return { res, calls };
  }

  it("filters by a single status with a bound text[] parameter", async () => {
    const { res, calls } = await list("?status=wishlist");
    assert.equal(res.status, 200);
    const sql = calls[0].text;
    const match = sql.match(/ui\.status = ANY\(\$(\d+)::text\[\]\)/);
    assert.ok(match, sql);
    assert.deepEqual(calls[0].params[Number(match[1]) - 1], ["wishlist"]);
    assert.equal(calls[0].params[0], 1, "$1 is the caller");
  });

  it("filters by several comma-separated statuses", async () => {
    const { res, calls } = await list("?status=destash,owned");
    assert.equal(res.status, 200);
    assert.ok(calls[0].params.some((p) => Array.isArray(p) && p.join() === "owned,destash"));
  });

  it("untried=true restricts to owned rows without tried_at", async () => {
    const { res, calls } = await list("?untried=true");
    assert.equal(res.status, 200);
    assert.match(calls[0].text, /\(ui\.status = 'owned' AND ui\.tried_at IS NULL\)/);
  });

  it("untried=false adds no condition", async () => {
    const { calls } = await list("?untried=false");
    assert.doesNotMatch(calls[0].text, /ui\.tried_at IS NULL\)/);
  });

  it("returns 400 for an unknown status or untried value without querying", async () => {
    for (const qs of ["?status=untried", "?status=owned,bogus", "?untried=perhaps"]) {
      const { res, calls } = await list(qs);
      assert.equal(res.status, 400, qs);
      assert.match(res.jsonBody.error, /status|untried/);
      assert.equal(calls.length, 0, `${qs} must not reach the database`);
    }
  });

  it("availability and scope=collection use the status column, never quantity", async () => {
    for (const [qs, expected] of [
      ["?availability=owned", /ui\.status = 'owned'/],
      ["?availability=wishlist", /ui\.status = 'wishlist'/],
      ["?scope=collection", /ui\.status = 'owned'/],
    ]) {
      const { calls } = await list(qs);
      assert.match(calls[0].text, expected, qs);
      assert.doesNotMatch(calls[0].text, /ui\.quantity, 0\)\s*(<=|>)/, qs);
    }
  });

  it("sortBy=status orders by the status column", async () => {
    const { calls } = await list("?sortBy=status&sortOrder=asc");
    assert.match(calls[0].text, /ORDER BY CASE ui\.status WHEN 'owned' THEN 0/);
  });

  it("selects the inventory status fields with a derived isUntried", async () => {
    const { res, calls } = await list("", () => ({
      rows: [
        {
          id: "5",
          brand: "OPI",
          name: "Red",
          finish: "creme",
          status: "owned",
          isUntried: true,
          triedAt: null,
          wearCount: 0,
          purchasePrice: 9.5,
          purchaseCurrency: "USD",
          totalCount: "1",
        },
      ],
    }));
    const sql = calls[0].text;
    for (const column of [
      /ui\.status,/,
      /COALESCE\(ui\.status = 'owned' AND ui\.tried_at IS NULL, false\) AS "isUntried"/,
      /ui\.tried_at\s+AS "triedAt"/,
      /ui\.last_worn_at\s+AS "lastWornAt"/,
      /ui\.wear_count\s+AS "wearCount"/,
      /ui\.purchase_price::float8\s+AS "purchasePrice"/,
      /ui\.purchase_currency\s+AS "purchaseCurrency"/,
    ]) {
      assert.match(sql, column);
    }
    const [polish] = res.jsonBody.polishes;
    assert.equal(polish.status, "owned");
    assert.equal(polish.isUntried, true);
    assert.equal(polish.purchasePrice, 9.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST / PUT — validation and the inventory upsert
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/polishes — create/update inventory fields", () => {
  const POLISH_ROW = { id: "9", shadeId: "9", brand: "OPI", name: "X", finish: "creme", status: "owned" };

  /** Pool: the target shade is visible and the reloaded polish row comes back. */
  function visibleShadePool() {
    return mockPool((text) => {
      if (/AS "ownSubmitted"/.test(text)) return { rows: [{ ownSubmitted: false, brand: "OPI", shadeName: "X" }] };
      return { rows: [POLISH_ROW] };
    });
  }

  async function put(body) {
    visibleShadePool();
    const tx = mockTransaction();
    const res = await registeredRoutes["polishes-mutate"].handler(
      fakeRequest({ method: "PUT", url: "http://localhost:7071/api/polishes/9", params: { id: "9" }, body }),
      fakeContext()
    );
    return { res, tx };
  }

  async function post(body) {
    visibleShadePool();
    const tx = mockTransaction();
    const res = await registeredRoutes["polishes-create"].handler(
      fakeRequest({ method: "POST", url: "http://localhost:7071/api/polishes", body }),
      fakeContext()
    );
    return { res, tx };
  }

  for (const [label, body] of [
    ["unknown status", { status: "untried" }],
    ["bad triedAt", { triedAt: "last week" }],
    ["negative purchasePrice", { purchasePrice: -2 }],
    ["string purchasePrice", { purchasePrice: "4.99" }],
    ["bad purchaseCurrency", { purchaseCurrency: "dollars" }],
  ]) {
    it(`PUT returns 400 for ${label} before any write`, async () => {
      const { res, tx } = await put(body);
      assert.equal(res.status, 400);
      assert.equal(tx.length, 0, "no transaction statement may run");
    });

    it(`POST returns 400 for ${label} before any write`, async () => {
      const { res, tx } = await post({ shadeId: "9", ...body });
      assert.equal(res.status, 400);
      assert.equal(tx.length, 0, "no transaction statement may run");
    });
  }

  it("PUT writes status, triedAt, purchasePrice and purchaseCurrency", async () => {
    const { res, tx } = await put({
      status: "destash",
      triedAt: "2026-05-01",
      purchasePrice: 14.5,
      purchaseCurrency: "gbp",
    });
    assert.equal(res.status, 200);
    const call = upsertCall(tx);
    assert.match(call.text, /ON CONFLICT \(user_id, shade_id\)/);
    assert.equal(param(call, 1), 1, "user_id is the caller");
    assert.equal(param(call, 10), "destash");
    assert.equal(param(call, 11), "2026-05-01T00:00:00.000Z");
    assert.equal(param(call, 12), 14.5);
    assert.equal(param(call, 13), "GBP");
    assert.deepEqual(param(call, 14), ["triedAt", "purchasePrice", "purchaseCurrency"]);
    assert.equal(param(call, 15), "destash", "a new row gets the requested status");
    assert.match(call.text, /status\s+= CASE WHEN \$10::text IS NULL THEN user_inventory_item\.status ELSE EXCLUDED\.status END/);
  });

  it("PUT without status keeps the stored status (no quantity-derived status on update)", async () => {
    const { res, tx } = await put({ quantity: 0 });
    assert.equal(res.status, 200);
    const call = upsertCall(tx);
    assert.equal(param(call, 3), 0);
    assert.equal(param(call, 10), null, "status not sent → existing status is kept on conflict");
    assert.deepEqual(param(call, 14), [], "no clearable field was sent");
  });

  it("PUT with null clears triedAt / purchase fields", async () => {
    const { res, tx } = await put({ triedAt: null, purchasePrice: null, purchaseCurrency: null });
    assert.equal(res.status, 200);
    const call = upsertCall(tx);
    assert.equal(param(call, 11), null);
    assert.equal(param(call, 12), null);
    assert.equal(param(call, 13), null);
    assert.deepEqual(param(call, 14), ["triedAt", "purchasePrice", "purchaseCurrency"]);
    assert.match(call.text, /tried_at\s+= CASE WHEN 'triedAt' = ANY\(\$14::text\[\]\) THEN EXCLUDED\.tried_at/);
  });

  it("POST without status: a new row defaults from quantity (owned when > 0)", async () => {
    const { res, tx } = await post({ shadeId: "9", quantity: 2 });
    assert.equal(res.status, 201);
    const call = upsertCall(tx);
    assert.equal(param(call, 10), null);
    assert.equal(param(call, 15), "owned");
  });

  it("POST without status or quantity creates an owned row (D5a)", async () => {
    const { res, tx } = await post({ shadeId: "9" });
    assert.equal(res.status, 201);
    const call = upsertCall(tx);
    assert.equal(param(call, 3), null);
    assert.equal(param(call, 15), "owned");
  });

  it("POST without status and quantity 0 still creates a wishlist row (legacy clients)", async () => {
    const { res, tx } = await post({ shadeId: "9", quantity: 0 });
    assert.equal(res.status, 201);
    assert.equal(param(upsertCall(tx), 15), "wishlist");
  });

  it("POST status=wishlist with a quantity keeps the explicit status", async () => {
    const { res, tx } = await post({ shadeId: "9", status: "wishlist", quantity: 1 });
    assert.equal(res.status, 201);
    assert.equal(param(upsertCall(tx), 15), "wishlist");
  });

  it("PUT and POST re-derive wear stats from the mani log (#269) without touching tried_at", async () => {
    for (const run of [() => put({ quantity: 1 }), () => post({ shadeId: "9", status: "owned" })]) {
      const { res, tx } = await run();
      assert.ok([200, 201].includes(res.status));
      const upsertIndex = tx.findIndex((c) => /INSERT INTO user_inventory_item/.test(c.text));
      const recompute = tx.findIndex((c) => /UPDATE user_inventory_item ui\s+SET wear_count/.test(c.text));
      assert.ok(recompute > upsertIndex, "wear stats are recomputed after the upsert, in the same transaction");
      assert.deepEqual(tx[recompute].params, [1, [9], false], "caller's row only, tried_at left as sent");
    }
  });

  /** Transaction where the caller's row currently has `previous` (null = no row). */
  function archiveTransaction(previous, { updatedEvents = 1 } = {}) {
    const calls = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          calls.push({ text: String(text), params });
          if (/SELECT status FROM user_inventory_item/.test(text)) return { rows: previous ? [{ status: previous }] : [] };
          if (/INSERT INTO user_inventory_item/.test(text)) {
            const sent = params[9] ?? previous ?? params[14];
            return { rows: [{ inventoryItemId: "42", status: sent }] };
          }
          if (/UPDATE inventory_event/.test(text)) return { rows: [], rowCount: updatedEvents };
          return { rows: [], rowCount: 0 };
        },
      });
    return calls;
  }

  async function putArchive(body, previous, options) {
    visibleShadePool();
    const tx = archiveTransaction(previous, options);
    const res = await registeredRoutes["polishes-mutate"].handler(
      fakeRequest({ method: "PUT", url: "http://localhost:7071/api/polishes/9", params: { id: "9" }, body }),
      fakeContext()
    );
    return { res, tx };
  }

  const eventCalls = (tx) => tx.filter((c) => /inventory_event/.test(c.text));

  it("PUT status=archived on an owned polish locks the caller's row and records used_up", async () => {
    const { res, tx } = await putArchive({ quantity: 0, status: "archived" }, "owned");
    assert.equal(res.status, 200);
    const lock = tx.find((c) => /SELECT status FROM user_inventory_item/.test(c.text));
    assert.match(lock.text, /WHERE user_id = \$1 AND shade_id = \$2 FOR UPDATE/);
    assert.deepEqual(lock.params, [1, 9]);
    const events = eventCalls(tx);
    assert.equal(events.length, 1);
    assert.match(events[0].text, /INSERT INTO inventory_event/);
    assert.deepEqual(events[0].params, ["42", "used_up", "owned"]);
  });

  it("PUT archiveReason=decluttered while archived corrects the current archive's reason", async () => {
    const { res, tx } = await putArchive({ status: "archived", archiveReason: "decluttered" }, "archived");
    assert.equal(res.status, 200);
    const events = eventCalls(tx);
    assert.equal(events.length, 1, "updated in place, no second event");
    assert.match(events[0].text, /UPDATE inventory_event/);
    assert.match(events[0].text, /inventory_item_id = \$1::bigint/);
    assert.deepEqual(events[0].params, ["42", ["used_up", "decluttered"], 24, "decluttered"]);
  });

  it("PUT archiveReason while archived inserts the reason when no recent one exists", async () => {
    const { tx } = await putArchive({ status: "archived", archiveReason: "used_up" }, "archived", { updatedEvents: 0 });
    const events = eventCalls(tx);
    assert.equal(events.length, 2);
    assert.match(events[1].text, /INSERT INTO inventory_event/);
    assert.deepEqual(events[1].params, ["42", "used_up", "archived"]);
  });

  it("PUT undoArchive restores owned and deletes only the caller's latest archive reason", async () => {
    const { res, tx } = await putArchive({ status: "owned", quantity: 1, undoArchive: true }, "archived");
    assert.equal(res.status, 200);
    assert.equal(param(upsertCall(tx), 10), "owned");
    const events = eventCalls(tx);
    assert.equal(events.length, 1);
    assert.match(events[0].text, /DELETE FROM inventory_event/);
    assert.match(events[0].text, /LIMIT 1/);
    assert.deepEqual(events[0].params, ["42", ["used_up", "decluttered"], 24]);
  });

  it("PUT status=wishlist (Rebuy) and ordinary edits write no inventory events", async () => {
    for (const body of [{ status: "wishlist" }, { quantity: 2 }, { status: "owned", quantity: 1 }]) {
      const { res, tx } = await put(body);
      assert.equal(res.status, 200);
      assert.equal(eventCalls(tx).length, 0, JSON.stringify(body));
      assert.ok(!tx.some((c) => /SELECT status FROM user_inventory_item/.test(c.text)), "no extra lock query");
    }
  });

  it("PUT rejects archiveReason without status archived before touching the DB", async () => {
    const { res, tx } = await putArchive({ archiveReason: "used_up" }, "owned");
    assert.equal(res.status, 400);
    assert.equal(tx.length, 0);
  });

  it("POST status=owned without quantity inserts one bottle", async () => {
    const { res, tx } = await post({ shadeId: "9", status: "owned" });
    assert.equal(res.status, 201);
    const call = upsertCall(tx);
    assert.equal(param(call, 15), "owned");
    assert.match(call.text, /COALESCE\(\$3::int, CASE WHEN \$15::text IN \('owned', 'destash'\) THEN 1 ELSE 0 END\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Admin account merge — duplicate inventory rows keep the strongest status
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/admin-users — merge inventory status", () => {
  /** Runs the merge handler and returns the SQL of the duplicate-inventory UPDATE. */
  async function mergeDuplicateInventorySql() {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async () => ({ rows: [{ ...USER_ROW, user_id: 2, role: "admin" }] });
    let mergeSql = null;
    transactionMock = async (cb) =>
      cb({
        query: async (text) => {
          const sql = String(text);
          if (/FROM app_user/.test(sql) && /WHERE user_id = ANY/.test(sql)) {
            return {
              rows: [
                { userId: 10, role: "user", email: null, externalId: "oid-source" },
                { userId: 20, role: "user", email: null, externalId: "oid-target" },
              ],
            };
          }
          if (/UPDATE user_inventory_item target/.test(sql)) mergeSql = sql;
          return { rows: [], rowCount: 0 };
        },
      });
    const res = await registeredRoutes["admin-users-merge"].handler(
      fakeRequest({
        method: "POST",
        url: "http://localhost:7071/api/users-admin/merge",
        body: { sourceUserId: 10, targetUserId: 20 },
      }),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.ok(mergeSql, "expected the duplicate-inventory merge UPDATE");
    return mergeSql;
  }

  /** Evaluates the merge's `status = CASE ... END` for a (source, target) status pair. */
  function statusEvaluator(sql) {
    const caseExpr = sql.match(/status = CASE([\s\S]*?)\bEND\b/);
    assert.ok(caseExpr, "status CASE expression");
    const whens = [...caseExpr[1].matchAll(/WHEN '(\w+)' IN \(source\.status, target\.status\) THEN '(\w+)'/g)];
    assert.ok(whens.length > 0, "precedence WHEN branches");
    assert.match(caseExpr[1], /ELSE target\.status\s*$/);
    return (source, target) => {
      for (const [, needle, result] of whens) {
        if (source === needle || target === needle) return result;
      }
      return target;
    };
  }

  it("keeps the strongest status: owned > destash > wishlist > archived", async () => {
    const { POLISH_STATUSES } = require("swatchwatch-shared");
    const merged = statusEvaluator(await mergeDuplicateInventorySql());
    const rank = ["owned", "destash", "wishlist", "archived"];
    assert.deepEqual([...rank].sort(), [...POLISH_STATUSES].sort(), "rank covers every status");
    for (const source of rank) {
      for (const target of rank) {
        const expected = rank[Math.min(rank.indexOf(source), rank.indexOf(target))];
        assert.equal(merged(source, target), expected, `source=${source} target=${target}`);
      }
    }
  });

  it("a destash bottle merged with a wishlist row stays destash, in either direction", async () => {
    const merged = statusEvaluator(await mergeDuplicateInventorySql());
    assert.equal(merged("destash", "wishlist"), "destash");
    assert.equal(merged("wishlist", "destash"), "destash");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration ↔ shared constant
// ═══════════════════════════════════════════════════════════════════════════

describe("migration 20261017061336791_inventory-status", () => {
  const fs = require("node:fs");
  const { POLISH_STATUSES } = require("swatchwatch-shared");
  const sql = fs.readFileSync(
    path.resolve(__dirname, "../migrations/20261017061336791_inventory-status.sql"),
    "utf8"
  );
  const [up, down] = sql.split("-- Down Migration");

  it("CHECK constraint allows exactly POLISH_STATUSES", () => {
    const match = up.match(/CHECK \(status IN \(([^)]*)\)\)/);
    assert.ok(match, "status CHECK constraint");
    const values = match[1].split(",").map((v) => v.trim().replace(/'/g, ""));
    assert.deepEqual(values, [...POLISH_STATUSES]);
    assert.ok(!values.includes("untried"), "untried is derived, never stored");
  });

  it("backfills wishlist from quantity <= 0 and owned otherwise", () => {
    assert.match(up, /SET status = CASE WHEN quantity <= 0 THEN 'wishlist' ELSE 'owned' END/);
  });

  it("adds the wear columns and has a Down section that drops them", () => {
    for (const column of ["status", "tried_at", "last_worn_at", "wear_count"]) {
      assert.match(up, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`));
      assert.match(down, new RegExp(`DROP COLUMN IF EXISTS ${column}\\b`));
    }
  });
});
