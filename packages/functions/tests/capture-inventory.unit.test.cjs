/**
 * Capture finalize inventory writes (`addToInventoryFromMatch` in functions/capture.ts).
 *
 * user_inventory_item holds at most one row per (user_id, shade_id) (uq_user_inventory_shade,
 * migration 014; idx_user_inventory_unique_shade, migration 013). A barcode (SKU) match must bump
 * the caller's existing row for the SKU's shade even when that row has no sku_id (added manually
 * or via a shade match), and a shade match must bump a row that carries a sku_id, instead of
 * inserting a second row and failing with a unique violation. The fake DB below enforces that
 * constraint, evaluates the inventory WHERE clauses and models a concurrent insert of the same
 * shade, so the handler's real SQL is exercised.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

for (const name of ["WEBSITE_INSTANCE_ID", "WEBSITE_SITE_NAME", "WEBSITE_HOSTNAME", "REDIS_URL", "REDIS_KEY"]) {
  delete process.env[name];
}
process.env.IMAGE_PROXY_SIGNING_KEY = "capture-inventory-unit-test-signing-key-0123456789";

const CALLER = 1;
const OTHER_USER = 2;
const USERS = {
  [CALLER]: { user_id: CALLER, external_id: "ext-caller", email: "caller@test.dev", role: "user" },
  [OTHER_USER]: { user_id: OTHER_USER, external_id: "ext-other", email: "other@test.dev", role: "user" },
};
const CAPTURE_UUID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = 4242;
const GTIN = "0123456789012";
const SKU_ID = 501;
const SHADE_ID = 77;
const SHADELESS_SKU_ID = 502;
const SHADELESS_GTIN = "0123456789029";

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

let state;
let sqlCalls;

function resetState({ inventory = [], metadata = { gtin: GTIN } } = {}) {
  sqlCalls = [];
  state = {
    nextId: 9000,
    clock: 0,
    metadata,
    inventory: inventory.map((row) => ({
      skuId: null,
      shadeId: null,
      quantity: 1,
      status: "owned",
      // Rows written by a concurrent, not-yet-committed transaction: invisible to SELECTs,
      // but an INSERT still conflicts with them (it waits for the commit, then conflicts).
      uncommitted: false,
      ...row,
    })),
  };
  for (const row of state.inventory) row.createdAt = state.clock++;
}

function uniqueViolation(constraint) {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: "23505",
    constraint,
  });
}

const COLUMN_TO_FIELD = {
  inventory_item_id: "id",
  user_id: "userId",
  sku_id: "skuId",
  shade_id: "shadeId",
};

/** Evaluates a WHERE clause of `col = $n`, `col IS [NOT] NULL`, AND, OR and parentheses. */
function evaluateWhere(clause, params, row) {
  const tokens = clause.match(/\(|\)|\bAND\b|\bOR\b|\w+\s+IS\s+NOT\s+NULL|\w+\s+IS\s+NULL|\w+\s*=\s*\$\d+/gi) || [];
  let pos = 0;
  const atom = () => {
    const token = tokens[pos++];
    if (token === "(") {
      const value = orExpr();
      assert.equal(tokens[pos++], ")", `unbalanced WHERE clause: ${clause}`);
      return value;
    }
    const isNull = token.match(/^(\w+)\s+IS\s+(NOT\s+)?NULL$/i);
    if (isNull) {
      const value = row[COLUMN_TO_FIELD[isNull[1].toLowerCase()]];
      return isNull[2] ? value !== null && value !== undefined : value === null || value === undefined;
    }
    const eq = token.match(/^(\w+)\s*=\s*\$(\d+)$/);
    assert.ok(eq, `unsupported WHERE token "${token}" in: ${clause}`);
    const field = COLUMN_TO_FIELD[eq[1].toLowerCase()];
    assert.ok(field, `unknown column ${eq[1]}`);
    const left = row[field];
    const right = params[Number(eq[2]) - 1];
    // SQL three-valued logic: comparing with NULL is never true.
    if (left === null || left === undefined || right === null || right === undefined) return false;
    return Number(left) === Number(right);
  };
  const andExpr = () => {
    let value = atom();
    while (/^AND$/i.test(tokens[pos] || "")) {
      pos += 1;
      value = atom() && value;
    }
    return value;
  };
  const orExpr = () => {
    let value = andExpr();
    while (/^OR$/i.test(tokens[pos] || "")) {
      pos += 1;
      value = andExpr() || value;
    }
    return value;
  };
  const result = orExpr();
  assert.equal(pos, tokens.length, `unparsed WHERE tokens in: ${clause}`);
  return result;
}

function whereClause(text) {
  const match = text.match(/\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bLIMIT\b|\bRETURNING\b|$)/i);
  return match ? match[1] : "";
}

/** For `INSERT INTO t (cols) VALUES (...)`, a map of column -> bound value (literals as numbers or strings). */
function insertedRow(text, params) {
  const match = text.match(/INSERT\s+INTO\s+\w+\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i);
  assert.ok(match, `unparsable INSERT: ${text}`);
  const cols = match[1].split(",").map((c) => c.trim().toLowerCase());
  const values = match[2].split(",").map((v) => v.trim());
  const row = {};
  cols.forEach((col, i) => {
    const placeholder = values[i].match(/^\$(\d+)$/);
    const quoted = values[i].match(/^'(.*)'$/);
    row[col] = placeholder ? params[Number(placeholder[1]) - 1] : quoted ? quoted[1] : Number(values[i]);
  });
  return row;
}

function bumpRow(row, text) {
  assert.match(text, /quantity\s*=\s*(user_inventory_item\.)?quantity\s*\+\s*1/i);
  row.quantity += 1;
  // Inventory status (#291): capturing a bottle turns a wishlist/archived row into owned.
  const statusFlip = /status\s*=\s*CASE\s+WHEN\s+(?:user_inventory_item\.)?status\s+IN\s*\(\s*'wishlist'\s*,\s*'archived'\s*\)\s+THEN\s+'owned'\s+ELSE\s+(?:user_inventory_item\.)?status\s+END/i;
  if (statusFlip.test(text) && ["wishlist", "archived"].includes(row.status)) row.status = "owned";
  const skuFill = text.match(/sku_id\s*=\s*COALESCE\(\s*(?:user_inventory_item\.)?sku_id\s*,\s*(\$\d+|EXCLUDED\.sku_id)\s*\)/i);
  return skuFill;
}

function inventoryQuery(text, params) {
  if (/^\s*SELECT/i.test(text)) {
    let rows = state.inventory.filter((row) => !row.uncommitted && evaluateWhere(whereClause(text), params, row));
    rows.sort((a, b) => a.createdAt - b.createdAt);
    // `ORDER BY (sku_id = $n) DESC NULLS LAST, ...`: rows already carrying the SKU first.
    const preferSku = text.match(/ORDER\s+BY\s*\(\s*sku_id\s*=\s*\$(\d+)\s*\)\s*DESC/i);
    if (preferSku) {
      const skuId = Number(params[Number(preferSku[1]) - 1]);
      rows = [...rows.filter((r) => Number(r.skuId) === skuId), ...rows.filter((r) => Number(r.skuId) !== skuId)];
    }
    if (/\bLIMIT\s+1\b/i.test(text)) rows = rows.slice(0, 1);
    return { rows: rows.map((row) => ({ id: row.id })), rowCount: rows.length };
  }

  if (/^\s*UPDATE/i.test(text)) {
    const rows = state.inventory.filter((row) => evaluateWhere(whereClause(text), params, row));
    for (const row of rows) {
      const skuFill = bumpRow(row, text);
      if (skuFill && (row.skuId === null || row.skuId === undefined)) {
        row.skuId = params[Number(skuFill[1].slice(1)) - 1];
      }
    }
    return { rows: [], rowCount: rows.length };
  }

  if (/^\s*INSERT/i.test(text)) {
    const values = insertedRow(text, params);
    const candidate = {
      id: state.nextId++,
      userId: Number(values.user_id),
      skuId: values.sku_id ?? null,
      shadeId: values.shade_id ?? null,
      quantity: values.quantity,
      // Column default 'owned' when the INSERT omits status.
      status: values.status ?? "owned",
      uncommitted: false,
      createdAt: state.clock++,
    };
    const conflict =
      candidate.shadeId !== null &&
      state.inventory.find((row) => row.userId === candidate.userId && Number(row.shadeId) === Number(candidate.shadeId));
    if (conflict) {
      const onConflict = text.match(
        /ON\s+CONFLICT\s*\(\s*user_id\s*,\s*shade_id\s*\)\s*(WHERE\s+shade_id\s+IS\s+NOT\s+NULL\s+)?DO\s+UPDATE\s+SET([\s\S]*?)RETURNING/i
      );
      if (!onConflict) throw uniqueViolation("uq_user_inventory_shade");
      // Postgres only infers the partial idx_user_inventory_unique_shade as an arbiter when the
      // conflict target carries its predicate. Without it, a row inserted by a concurrent
      // transaction trips that non-arbiter index and the INSERT raises instead of updating
      // (verified against Postgres 16).
      if (conflict.uncommitted && !onConflict[1]) throw uniqueViolation("idx_user_inventory_unique_shade");
      conflict.uncommitted = false;
      const skuFill = bumpRow(conflict, onConflict[2]);
      if (skuFill && (conflict.skuId === null || conflict.skuId === undefined)) conflict.skuId = candidate.skuId;
      return { rows: [{ id: conflict.id }], rowCount: 1 };
    }
    state.inventory.push(candidate);
    return { rows: [{ id: candidate.id }], rowCount: 1 };
  }

  throw new Error(`unexpected user_inventory_item statement: ${text}`);
}

async function fakeQuery(via, sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ via, sql: text, params });

  if (/FROM\s+app_user/i.test(text) && /WHERE\s+user_id\s*=\s*\$1/i.test(text)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }
  if (/FROM\s+capture_session/i.test(text) && /^\s*SELECT/i.test(text)) {
    const owned = params[0] === CAPTURE_UUID && Number(params[1]) === CALLER;
    const session = {
      id: SESSION_ID,
      captureId: CAPTURE_UUID,
      status: "processing",
      topConfidence: null,
      acceptedEntityType: null,
      acceptedEntityId: null,
      metadata: state.metadata,
    };
    return { rows: owned ? [session] : [], rowCount: owned ? 1 : 0 };
  }
  if (/FROM\s+capture_frame/i.test(text)) return { rows: [], rowCount: 0 };
  if (/FROM\s+barcode/i.test(text)) {
    if (params[0] === GTIN) {
      return { rows: [{ skuId: String(SKU_ID), shadeId: String(SHADE_ID), brand: "Brand", productName: "Polish", shadeName: "Shade" }], rowCount: 1 };
    }
    if (params[0] === SHADELESS_GTIN) {
      return { rows: [{ skuId: String(SHADELESS_SKU_ID), shadeId: null, brand: "Brand", productName: "Kit", shadeName: null }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  if (/FROM\s+sku\b/i.test(text)) {
    const shadeId = Number(params[0]) === SKU_ID ? SHADE_ID : null;
    return { rows: [{ shadeId }], rowCount: 1 };
  }
  // Shade-similarity resolver (brand + shade name evidence).
  if (/similarity\(/i.test(text) && /FROM\s+shade\s+s/i.test(text)) {
    return { rows: [{ shadeId: String(SHADE_ID), brand: "Brand", shadeName: "Shade", score: 0.99 }], rowCount: 1 };
  }
  // Shade visibility check in addToInventoryFromMatch (active catalog shade).
  if (/FROM\s+shade\s+s/i.test(text) && /user_submitted/i.test(text)) {
    return { rows: [{ "?column?": 1 }], rowCount: 1 };
  }
  if (/^\s*(INSERT|UPDATE|SELECT|DELETE)[\s\S]*?\buser_inventory_item\b/i.test(text) && !/FROM\s+shade\s+s/i.test(text)) {
    return inventoryQuery(text, params);
  }
  return { rows: [], rowCount: 0 };
}

const registeredRoutes = {};
const mockModules = {};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) return key;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
function registerMock(id, exports) {
  mockModules[id] = exports;
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

registerMock("@azure/functions", {
  app: { http: (name, opts) => (registeredRoutes[name] = opts), storageQueue: () => {}, timer: () => {} },
  output: { storageQueue: (opts) => ({ __type: "storageQueue", ...opts }) },
});
registerMock("jose", { createRemoteJWKSet: () => {}, jwtVerify: async () => { throw new Error("unused"); } });

const dbMock = {
  query: (sql, params) => fakeQuery("pool", sql, params),
  transaction: async (cb) => {
    // Roll back the fake inventory if the transaction body throws, like Postgres would.
    const snapshot = JSON.stringify(state.inventory);
    try {
      return await cb({ query: (sql, params) => fakeQuery("tx", sql, params) });
    } catch (error) {
      state.inventory = JSON.parse(snapshot);
      throw error;
    }
  },
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
registerMock("../lib/ocr", { extractTextFromImage: async () => null });
registerMock("../lib/ocr-parser", { parseLabelText: async () => null });
registerMock("../lib/ai-color-detection", { detectHexWithAzureOpenAI: async () => null });

require("../dist/functions/capture.js");

function fakeRequest(userId) {
  const headers = new Map([["authorization", `Bearer dev:${userId}`]]);
  const url = `http://localhost:7071/api/capture/${CAPTURE_UUID}/finalize`;
  return {
    method: "POST",
    url,
    headers: { get: (name) => headers.get(name.toLowerCase()) || null },
    params: { captureId: CAPTURE_UUID },
    query: new URL(url).searchParams,
    json: async () => ({}),
    text: async () => "{}",
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}
function fakeContext() {
  return {
    invocationId: "inv",
    log: () => {},
    warn: () => {},
    error: () => {},
    extraOutputs: { set: () => {}, get: () => undefined },
  };
}
async function finalize(userId = CALLER) {
  const route = registeredRoutes["capture-finalize"];
  assert.ok(route, "capture-finalize should be registered");
  return route.handler(fakeRequest(userId), fakeContext());
}

function rowsOf(userId) {
  return state.inventory
    .filter((row) => row.userId === userId)
    .map(({ userId: u, skuId, shadeId, quantity }) => ({
      userId: u,
      skuId: skuId === null ? null : Number(skuId),
      shadeId: shadeId === null ? null : Number(shadeId),
      quantity,
    }));
}

function statusesOf(userId) {
  return state.inventory.filter((row) => row.userId === userId).map((row) => row.status);
}

/** Every statement touching user_inventory_item binds only the caller's user id. */
function assertInventoryScopedToCaller() {
  const statements = sqlCalls.filter(
    (c) => /\buser_inventory_item\b/i.test(c.sql) && !/FROM\s+shade\s+s/i.test(c.sql)
  );
  assert.ok(statements.length > 0, "expected inventory statements");
  for (const call of statements) {
    const placeholders = [...call.sql.matchAll(/\buser_id\s*=\s*\$(\d+)/gi)].map((m) => Number(m[1]));
    if (/^\s*INSERT/i.test(call.sql)) {
      assert.equal(Number(insertedRow(call.sql, call.params).user_id), CALLER, `insert not bound to caller: ${call.sql}`);
      continue;
    }
    assert.ok(placeholders.length > 0, `inventory statement not scoped by user_id: ${call.sql}`);
    for (const n of placeholders) {
      assert.equal(Number(call.params[n - 1]), CALLER, `inventory statement bound to another user: ${call.sql}`);
    }
  }
}

function assertMatched(res) {
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.jsonBody)}`);
  assert.equal(res.jsonBody.status, "matched");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("capture finalize — barcode (SKU) match inventory write", () => {
  beforeEach(() => {
    process.env.AUTH_DEV_BYPASS = "true";
  });
  afterEach(() => {
    delete process.env.AUTH_DEV_BYPASS;
  });

  it("bumps an existing shade row that has no sku_id and records the SKU on it", async () => {
    resetState({ inventory: [{ id: 7001, userId: CALLER, shadeId: SHADE_ID, skuId: null, quantity: 2 }] });
    const res = await finalize();
    assertMatched(res);
    assert.deepEqual(rowsOf(CALLER), [{ userId: CALLER, skuId: SKU_ID, shadeId: SHADE_ID, quantity: 3 }]);
    assertInventoryScopedToCaller();
  });

  it("bumps an existing row for the SKU (unchanged behaviour)", async () => {
    resetState({ inventory: [{ id: 7001, userId: CALLER, shadeId: SHADE_ID, skuId: SKU_ID, quantity: 1 }] });
    assertMatched(await finalize());
    assert.deepEqual(rowsOf(CALLER), [{ userId: CALLER, skuId: SKU_ID, shadeId: SHADE_ID, quantity: 2 }]);
    assertInventoryScopedToCaller();
  });

  it("bumps a legacy SKU row without a shade rather than a separate shade row", async () => {
    resetState({
      inventory: [
        { id: 7001, userId: CALLER, shadeId: SHADE_ID, skuId: null, quantity: 4 },
        { id: 7002, userId: CALLER, shadeId: null, skuId: SKU_ID, quantity: 1 },
      ],
    });
    assertMatched(await finalize());
    assert.deepEqual(rowsOf(CALLER), [
      { userId: CALLER, skuId: null, shadeId: SHADE_ID, quantity: 4 },
      { userId: CALLER, skuId: SKU_ID, shadeId: null, quantity: 2 },
    ]);
  });

  it("inserts a new row when the caller holds neither the SKU nor its shade", async () => {
    resetState();
    assertMatched(await finalize());
    assert.deepEqual(rowsOf(CALLER), [{ userId: CALLER, skuId: SKU_ID, shadeId: SHADE_ID, quantity: 1 }]);
    assertInventoryScopedToCaller();
  });

  it("inserts a shade-less row for a SKU that has no shade", async () => {
    resetState({ metadata: { gtin: SHADELESS_GTIN } });
    assertMatched(await finalize());
    assert.deepEqual(rowsOf(CALLER), [{ userId: CALLER, skuId: SHADELESS_SKU_ID, shadeId: null, quantity: 1 }]);
  });

  it("never touches another user's rows for the same SKU or shade", async () => {
    resetState({
      inventory: [{ id: 8001, userId: OTHER_USER, shadeId: SHADE_ID, skuId: SKU_ID, quantity: 5 }],
    });
    assertMatched(await finalize());
    assert.deepEqual(rowsOf(OTHER_USER), [{ userId: OTHER_USER, skuId: SKU_ID, shadeId: SHADE_ID, quantity: 5 }]);
    assert.deepEqual(rowsOf(CALLER), [{ userId: CALLER, skuId: SKU_ID, shadeId: SHADE_ID, quantity: 1 }]);
    assertInventoryScopedToCaller();
  });

  it("bumps instead of failing when a concurrent finalize inserted the shade row first", async () => {
    resetState({
      inventory: [{ id: 7001, userId: CALLER, shadeId: SHADE_ID, skuId: SKU_ID, quantity: 1, uncommitted: true }],
    });
    assertMatched(await finalize());
    assert.deepEqual(rowsOf(CALLER), [{ userId: CALLER, skuId: SKU_ID, shadeId: SHADE_ID, quantity: 2 }]);
  });
});

describe("capture finalize — shade match inventory write", () => {
  beforeEach(() => {
    process.env.AUTH_DEV_BYPASS = "true";
  });
  afterEach(() => {
    delete process.env.AUTH_DEV_BYPASS;
  });

  const SHADE_EVIDENCE = { brand: "Brand", shadeName: "Shade" };

  it("bumps an existing row for the shade that carries a sku_id", async () => {
    resetState({
      metadata: SHADE_EVIDENCE,
      inventory: [{ id: 7001, userId: CALLER, shadeId: SHADE_ID, skuId: SKU_ID, quantity: 1 }],
    });
    assertMatched(await finalize());
    assert.deepEqual(rowsOf(CALLER), [{ userId: CALLER, skuId: SKU_ID, shadeId: SHADE_ID, quantity: 2 }]);
    assertInventoryScopedToCaller();
  });

  it("bumps instead of failing when a concurrent finalize inserted the shade row first", async () => {
    resetState({
      metadata: SHADE_EVIDENCE,
      inventory: [{ id: 7001, userId: CALLER, shadeId: SHADE_ID, skuId: null, quantity: 1, uncommitted: true }],
    });
    assertMatched(await finalize());
    assert.deepEqual(rowsOf(CALLER), [{ userId: CALLER, skuId: null, shadeId: SHADE_ID, quantity: 2 }]);
  });

  it("never touches another user's row for the same shade", async () => {
    resetState({
      metadata: SHADE_EVIDENCE,
      inventory: [{ id: 8001, userId: OTHER_USER, shadeId: SHADE_ID, skuId: null, quantity: 5 }],
    });
    assertMatched(await finalize());
    assert.deepEqual(rowsOf(OTHER_USER), [{ userId: OTHER_USER, skuId: null, shadeId: SHADE_ID, quantity: 5 }]);
    assert.deepEqual(rowsOf(CALLER), [{ userId: CALLER, skuId: null, shadeId: SHADE_ID, quantity: 1 }]);
    assertInventoryScopedToCaller();
  });
});

describe("capture finalize — inventory status (#291)", () => {
  beforeEach(() => {
    process.env.AUTH_DEV_BYPASS = "true";
  });
  afterEach(() => {
    delete process.env.AUTH_DEV_BYPASS;
  });

  const SHADE_EVIDENCE = { brand: "Brand", shadeName: "Shade" };

  for (const [label, metadata] of [
    ["barcode (SKU) match", undefined],
    ["shade match", SHADE_EVIDENCE],
  ]) {
    it(`${label}: inserts the new row as owned`, async () => {
      resetState(metadata ? { metadata } : {});
      assertMatched(await finalize());
      assert.deepEqual(statusesOf(CALLER), ["owned"]);
      const insert = sqlCalls.find((c) => /^\s*INSERT\s+INTO\s+user_inventory_item/i.test(c.sql));
      assert.equal(insertedRow(insert.sql, insert.params).status, "owned");
    });

    for (const from of ["wishlist", "archived"]) {
      it(`${label}: bumping a ${from} row for the shade makes it owned`, async () => {
        resetState({
          ...(metadata ? { metadata } : {}),
          inventory: [{ id: 7001, userId: CALLER, shadeId: SHADE_ID, skuId: null, quantity: 0, status: from }],
        });
        assertMatched(await finalize());
        assert.deepEqual(statusesOf(CALLER), ["owned"]);
        assert.equal(rowsOf(CALLER)[0].quantity, 1);
      });

      it(`${label}: a concurrent finalize's ${from} row is made owned through ON CONFLICT`, async () => {
        resetState({
          ...(metadata ? { metadata } : {}),
          inventory: [{ id: 7001, userId: CALLER, shadeId: SHADE_ID, skuId: null, quantity: 0, status: from, uncommitted: true }],
        });
        assertMatched(await finalize());
        assert.deepEqual(statusesOf(CALLER), ["owned"]);
        assert.equal(rowsOf(CALLER)[0].quantity, 1);
      });
    }

    it(`${label}: a destash row keeps its status when bumped`, async () => {
      resetState({
        ...(metadata ? { metadata } : {}),
        inventory: [{ id: 7001, userId: CALLER, shadeId: SHADE_ID, skuId: SKU_ID, quantity: 1, status: "destash" }],
      });
      assertMatched(await finalize());
      assert.deepEqual(statusesOf(CALLER), ["destash"]);
      assert.equal(rowsOf(CALLER)[0].quantity, 2);
    });
  }

  it("barcode match: another user's wishlist row is left alone", async () => {
    resetState({
      inventory: [{ id: 8001, userId: OTHER_USER, shadeId: SHADE_ID, skuId: SKU_ID, quantity: 0, status: "wishlist" }],
    });
    assertMatched(await finalize());
    assert.deepEqual(statusesOf(OTHER_USER), ["wishlist"]);
    assert.deepEqual(statusesOf(CALLER), ["owned"]);
    assertInventoryScopedToCaller();
  });
});
