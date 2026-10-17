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

  it("lists only the clearable fields that were sent", () => {
    const fields = parseInventoryFields({ triedAt: null, purchaseCurrency: "usd" });
    assert.deepEqual(inventory.providedInventoryFields(fields), ["triedAt", "purchaseCurrency"]);
    assert.deepEqual(inventory.providedInventoryFields(parseInventoryFields({})), []);
  });
});

describe("lib/inventory — defaults and filters", () => {
  it("defaults a new row's status from quantity exactly like the migration backfill", () => {
    assert.equal(inventory.defaultStatusForNewItem(1), "owned");
    assert.equal(inventory.defaultStatusForNewItem(3), "owned");
    assert.equal(inventory.defaultStatusForNewItem(0), "wishlist");
    assert.equal(inventory.defaultStatusForNewItem(-1), "wishlist");
    assert.equal(inventory.defaultStatusForNewItem(undefined), "wishlist");
    assert.equal(inventory.defaultStatusForNewItem(null), "wishlist");
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

  it("POST without status or quantity creates a wishlist row (legacy behavior)", async () => {
    const { res, tx } = await post({ shadeId: "9" });
    assert.equal(res.status, 201);
    const call = upsertCall(tx);
    assert.equal(param(call, 3), null);
    assert.equal(param(call, 15), "wishlist");
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

  it("POST status=owned without quantity inserts one bottle", async () => {
    const { res, tx } = await post({ shadeId: "9", status: "owned" });
    assert.equal(res.status, 201);
    const call = upsertCall(tx);
    assert.equal(param(call, 15), "owned");
    assert.match(call.text, /COALESCE\(\$3::int, CASE WHEN \$15::text IN \('owned', 'destash'\) THEN 1 ELSE 0 END\)/);
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
