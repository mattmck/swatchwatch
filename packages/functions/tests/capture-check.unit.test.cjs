/**
 * Capture check-only mode (#21): POST /api/capture/{captureId}/check runs the capture
 * resolver and reports the caller's relationship to the match (owned / wishlisted /
 * notOwned) without writing anything.
 *
 * Runs without a database. Handler modules load from dist/ with their dependencies
 * swapped out via require interception (same approach as access-control.unit.test.cjs).
 * Every SQL statement goes through a small in-memory fake DB that records the text and
 * bound params, so tests can assert that check issues no INSERT/UPDATE/DELETE (in
 * particular none on user_inventory_item or inventory_event) and that its queries are
 * scoped to the caller, and that finalize still adds to inventory afterwards.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const OWNER = 1;
const OTHER = 2;
const USERS = {
  [OWNER]: { user_id: OWNER, external_id: "ext-owner", email: "owner@test.dev", role: "user" },
  [OTHER]: { user_id: OTHER, external_id: "ext-other", email: "other@test.dev", role: "user" },
};

const CAPTURE_UUID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = 4242;
const SHADE_ID = 21;
const SKU_ID = 501;
const GTIN = "1234567890123";

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

/** Every SQL statement issued by handlers: { via, sql, params }. */
let sqlCalls;
let transactionCount;
let state;

function resetState() {
  sqlCalls = [];
  transactionCount = 0;
  state = {
    nextInventoryId: 9000,
    /** user_inventory_item rows. */
    inventory: [],
    sessions: new Map([
      [
        CAPTURE_UUID,
        {
          id: SESSION_ID,
          userId: OWNER,
          captureId: CAPTURE_UUID,
          status: "processing",
          topConfidence: null,
          acceptedEntityType: null,
          acceptedEntityId: null,
          metadata: { brand: "OPI", shadeName: "Big Apple Red" },
        },
      ],
    ]),
    /** capture_frame rows for the session. */
    frames: [{ frameType: "label", quality: { brand: "OPI", shadeName: "Big Apple Red" } }],
    /** Rows returned by the trigram shade-candidate query. */
    shadeCandidates: [{ shadeId: String(SHADE_ID), brand: "OPI", shadeName: "Big Apple Red", score: 0.95 }],
    barcodes: new Map([
      [GTIN, { skuId: String(SKU_ID), shadeId: String(SHADE_ID), brand: "OPI", productName: "Big Apple Red", shadeName: "Big Apple Red" }],
    ]),
  };
}
resetState();

function statementKind(sql) {
  const match = String(sql).trim().match(/^(WITH|SELECT|INSERT|UPDATE|DELETE)\b/i);
  return match ? match[1].toUpperCase() : "OTHER";
}

function isMutation(sql) {
  return ["INSERT", "UPDATE", "DELETE"].includes(statementKind(sql));
}

// `status` defaults to the #291 backfill rule (quantity > 0 → owned, else wishlist).
function addInventory(userId, { shadeId = null, skuId = null, quantity, status }) {
  const row = {
    inventoryItemId: state.nextInventoryId++,
    userId,
    shadeId,
    skuId,
    quantity,
    status: status ?? (quantity > 0 ? "owned" : "wishlist"),
  };
  state.inventory.push(row);
  return row;
}

function snapshot() {
  return JSON.stringify({
    inventory: state.inventory,
    sessions: [...state.sessions.entries()],
  });
}

async function fakeQuery(via, sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ via, sql: text, params });
  const kind = statementKind(text);
  const norm = text.replace(/\s+/g, " ");

  // Auth: dev-bypass user lookup.
  if (/FROM app_user/i.test(norm) && /WHERE user_id = \$1/i.test(norm)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }

  if (/FROM capture_session/i.test(norm) && kind === "SELECT") {
    const session = state.sessions.get(params[0]);
    if (session && Number(params[1]) === session.userId) {
      const { userId: _owner, ...row } = session;
      return { rows: [{ ...row }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  if (/FROM capture_frame/i.test(norm)) {
    return { rows: params[0] === SESSION_ID ? state.frames : [], rowCount: state.frames.length };
  }

  if (/FROM capture_question/i.test(norm) && kind === "SELECT") {
    return { rows: [], rowCount: 0 };
  }

  if (/FROM barcode bc/i.test(norm)) {
    // The resolver looks a scan up by every key it may be stored under (bc.gtin = ANY($1)).
    const keys = Array.isArray(params[0]) ? params[0] : [params[0]];
    const row = keys.map((key) => state.barcodes.get(key)).find(Boolean);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (/similarity\(/i.test(norm) && /FROM shade s/i.test(norm)) {
    return { rows: state.shadeCandidates, rowCount: state.shadeCandidates.length };
  }

  // Check: describe an accepted SKU / shade.
  if (/FROM sku s/i.test(norm) && /WHERE s\.sku_id = \$1/i.test(norm)) {
    return { rows: [{ shadeId: String(SHADE_ID), brand: "OPI", productName: "Big Apple Red", shadeName: "Big Apple Red" }], rowCount: 1 };
  }
  if (/FROM shade s LEFT JOIN brand b/i.test(norm) && /WHERE s\.shade_id = \$1/i.test(norm)) {
    return { rows: [{ brand: "OPI", shadeName: "Big Apple Red" }], rowCount: 1 };
  }

  // Finalize: shade visibility + SKU's shade.
  if (/s\.created_by_user_id/i.test(norm)) {
    return { rows: [{ "?column?": 1 }], rowCount: 1 };
  }
  if (/SELECT shade_id AS "shadeId" FROM sku/i.test(norm)) {
    return { rows: [{ shadeId: SHADE_ID }], rowCount: 1 };
  }

  if (/user_inventory_item/i.test(norm)) {
    if (kind === "SELECT" && /ANY\(\$2::bigint\[\]\)/i.test(norm)) {
      // Check's ownership lookup: user_id = $1 AND (shade_id = ANY($2) OR sku_id = ANY($3)).
      const userId = Number(params[0]);
      const shadeIds = new Set(params[1].map(String));
      const skuIds = new Set(params[2].map(String));
      const rows = state.inventory
        .filter((r) => r.userId === userId)
        .filter((r) => (r.shadeId !== null && shadeIds.has(String(r.shadeId))) || (r.skuId !== null && skuIds.has(String(r.skuId))))
        .map((r) => ({
          shadeId: r.shadeId === null ? null : String(r.shadeId),
          skuId: r.skuId === null ? null : String(r.skuId),
          quantity: r.quantity,
          status: r.status,
        }));
      return { rows, rowCount: rows.length };
    }
    if (kind === "SELECT" && /SELECT inventory_item_id AS id/i.test(norm)) {
      // Finalize's existing-row lookup.
      const userId = Number(params[0]);
      const entityId = Number(params[1]);
      const bySku = /sku_id = \$2/i.test(norm);
      const row = state.inventory.find((r) =>
        r.userId === userId && (bySku ? r.skuId === entityId : r.shadeId === entityId && r.skuId === null)
      );
      return { rows: row ? [{ id: row.inventoryItemId }] : [], rowCount: row ? 1 : 0 };
    }
    if (kind === "UPDATE") {
      const row = state.inventory.find((r) => r.inventoryItemId === Number(params[0]));
      if (row) {
        row.quantity += 1;
        if (/status = CASE WHEN status IN \('wishlist', 'archived'\) THEN 'owned'/i.test(norm)
          && ["wishlist", "archived"].includes(row.status)) {
          row.status = "owned";
        }
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (kind === "INSERT") {
      const withSku = /\(user_id, sku_id, shade_id, quantity, (status, )?notes\)/i.test(norm);
      const status = /'owned'/.test(norm) ? "owned" : undefined;
      const row = withSku
        ? addInventory(Number(params[0]), { skuId: Number(params[1]), shadeId: params[2], quantity: 1, status })
        : addInventory(Number(params[0]), { shadeId: Number(params[1]), quantity: 1, status });
      return { rows: [{ id: row.inventoryItemId }], rowCount: 1 };
    }
  }

  if (/UPDATE capture_session/i.test(norm)) {
    for (const session of state.sessions.values()) {
      if (session.id === params[0]) {
        const status = norm.match(/SET status = '(\w+)'/i);
        if (status) session.status = status[1];
        if (status && status[1] === "matched") {
          session.topConfidence = String(params[1]);
          session.acceptedEntityType = params[2];
          session.acceptedEntityId = String(params[3]);
        }
      }
    }
    return { rows: [], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
}

// ---------------------------------------------------------------------------
// Module-level mocking via require interception
// ---------------------------------------------------------------------------

const registeredRoutes = {};
const mockModules = {};
const originalResolve = Module._resolveFilename;

function registerMock(id, exports) {
  mockModules[id] = exports;
}

Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) {
      return key;
    }
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
  jwtVerify: async () => {
    throw new Error("JWT validation is not exercised in capture-check tests");
  },
});

const dbMock = {
  query: (sql, params) => fakeQuery("pool", sql, params),
  transaction: async (cb) => {
    transactionCount += 1;
    return cb({ query: (sql, params) => fakeQuery("tx", sql, params) });
  },
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
registerMock("./db", dbMock);

registerMock("../lib/ocr", { extractTextFromImage: async () => null });
registerMock("../lib/ocr-parser", { parseLabelText: async () => null });
registerMock("../lib/blob-storage", {
  checkStorageImageUrl: () => "not allowed",
  stripImageMetadata: async (bytes) => bytes,
  validateImageUpload: (contentType) => String(contentType || "").split(";")[0].trim().toLowerCase(),
});

for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

require("../dist/functions/capture");
const { classifyInventoryOwnership } = require("../dist/lib/inventory-relationship");

// ---------------------------------------------------------------------------
// Fake HttpRequest / InvocationContext
// ---------------------------------------------------------------------------

function fakeRequest({ method = "POST", url, headers = {}, params = {}, body } = {}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) headerMap.set(k.toLowerCase(), v);
  return {
    method,
    url,
    headers: { get: (name) => headerMap.get(name.toLowerCase()) || null },
    params,
    query: new URL(url).searchParams,
    json: async () => body,
  };
}

function fakeContext() {
  return { log: () => {}, error: () => {}, warn: () => {} };
}

async function invoke(routeName, opts = {}) {
  // `userId: undefined` means "no Authorization header", so don't use a default parameter.
  const userId = "userId" in opts ? opts.userId : OWNER;
  const { captureId = CAPTURE_UUID, headers } = opts;
  const route = registeredRoutes[routeName];
  assert.ok(route, `route ${routeName} should be registered`);
  const action = routeName.replace(/^capture-/, "");
  const req = fakeRequest({
    url: `http://localhost:7071/api/capture/${captureId}/${action}`,
    headers: { ...(userId !== undefined ? { authorization: `Bearer dev:${userId}` } : {}), ...(headers || {}) },
    params: { captureId },
    body: {},
  });
  return route.handler(req, fakeContext());
}

const check = (opts) => invoke("capture-check", opts);
const finalize = (opts) => invoke("capture-finalize", opts);

/** Non-auth statements issued by handlers. */
function handlerCalls() {
  return sqlCalls.filter((c) => !/FROM\s+app_user/i.test(c.sql));
}

function describeCall(call) {
  return `${call.sql.replace(/\s+/g, " ").trim().slice(0, 140)}... params=${JSON.stringify(call.params)}`;
}

/** Check must be strictly read-only. */
function assertNoWrites() {
  const mutations = handlerCalls().filter((c) => isMutation(c.sql));
  assert.deepEqual(mutations.map(describeCall), [], "check must not issue INSERT/UPDATE/DELETE");
  const inventoryWrites = handlerCalls().filter((c) =>
    /\b(INSERT\s+INTO|UPDATE)\s+(user_inventory_item|inventory_event)\b/i.test(c.sql)
  );
  assert.deepEqual(inventoryWrites.map(describeCall), [], "check must not write inventory or inventory_event");
  assert.equal(transactionCount, 0, "check must not open a transaction");
}

beforeEach(() => {
  resetState();
  process.env.AUTH_DEV_BYPASS = "true";
});

afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
});

// ═══════════════════════════════════════════════════════════════════════════

describe("lib/inventory-relationship — classifyInventoryOwnership", () => {
  it("no rows → notOwned", () => {
    assert.deepEqual(classifyInventoryOwnership([]), { relationship: "notOwned" });
  });

  it("status owned → owned with the owned rows' summed quantity", () => {
    assert.deepEqual(
      classifyInventoryOwnership([
        { shadeId: "21", skuId: null, quantity: 2, status: "owned" },
        { shadeId: "21", skuId: "501", quantity: "1", status: "owned" },
      ]),
      { relationship: "owned", quantity: 3 }
    );
  });

  it("status wishlist → wishlisted, whatever the quantity", () => {
    assert.deepEqual(classifyInventoryOwnership([{ shadeId: "21", skuId: null, quantity: 0, status: "wishlist" }]), {
      relationship: "wishlisted",
    });
    assert.deepEqual(classifyInventoryOwnership([{ shadeId: "21", skuId: null, quantity: 3, status: "wishlist" }]), {
      relationship: "wishlisted",
    });
  });

  it("quantity never decides ownership: an owned row with quantity 0 is still owned", () => {
    assert.deepEqual(classifyInventoryOwnership([{ shadeId: "21", skuId: null, quantity: 0, status: "owned" }]), {
      relationship: "owned",
      quantity: 0,
    });
  });

  it("only destash / archived rows → notOwned", () => {
    assert.deepEqual(
      classifyInventoryOwnership([
        { shadeId: "21", skuId: null, quantity: 1, status: "destash" },
        { shadeId: "21", skuId: "501", quantity: 2, status: "archived" },
      ]),
      { relationship: "notOwned" }
    );
  });

  it("an owned row wins over wishlist / destash / archived rows (only owned quantities count)", () => {
    assert.deepEqual(
      classifyInventoryOwnership([
        { shadeId: "21", skuId: null, quantity: 4, status: "wishlist" },
        { shadeId: "21", skuId: "501", quantity: 2, status: "owned" },
        { shadeId: "21", skuId: "502", quantity: 1, status: "destash" },
      ]),
      { relationship: "owned", quantity: 2 }
    );
  });
});

describe("functions/capture — check route", () => {
  it("registers POST capture/{captureId}/check", () => {
    const route = registeredRoutes["capture-check"];
    assert.ok(route);
    assert.equal(route.route, "capture/{captureId}/check");
    assert.deepEqual([...route.methods].sort(), ["OPTIONS", "POST"]);
  });

  it("returns 401 without a token and runs no SQL", async () => {
    const res = await check({ userId: undefined });
    assert.equal(res.status, 401);
    assert.deepEqual(handlerCalls(), []);
  });

  it("returns 400 for a non-UUID capture id", async () => {
    const res = await check({ captureId: "not-a-uuid" });
    assert.equal(res.status, 400);
    assertNoWrites();
  });
});

describe("functions/capture — check reports the caller's relationship to the match", () => {
  it("owned: status owned → owned with quantity", async () => {
    addInventory(OWNER, { shadeId: SHADE_ID, quantity: 2 });
    const res = await check();
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    const body = res.jsonBody;
    assert.equal(body.captureId, CAPTURE_UUID);
    assert.equal(body.status, "processing", "session status is reported unchanged");
    assert.equal(body.outcome, "matched");
    assert.equal(body.confidence, 0.95);
    assert.equal(body.match.entityType, "shade");
    assert.equal(body.match.entityId, String(SHADE_ID));
    assert.equal(body.match.shadeId, String(SHADE_ID));
    assert.equal(body.match.display, "OPI — Big Apple Red");
    assert.deepEqual(body.match.ownership, { relationship: "owned", quantity: 2 });
    assert.equal(body.candidates.length, 1);
    assert.deepEqual(body.candidates[0], body.match);
    assertNoWrites();
  });

  it("wishlisted: status wishlist row → wishlisted", async () => {
    addInventory(OWNER, { shadeId: SHADE_ID, quantity: 0 });
    const res = await check();
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody.match.ownership, { relationship: "wishlisted" });
    assertNoWrites();
  });

  it("status, not quantity, decides: a wishlist row with bottles is wishlisted", async () => {
    addInventory(OWNER, { shadeId: SHADE_ID, quantity: 2, status: "wishlist" });
    const res = await check();
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody.match.ownership, { relationship: "wishlisted" });
    assertNoWrites();
  });

  it("notOwned: an archived row does not count as owned", async () => {
    addInventory(OWNER, { shadeId: SHADE_ID, quantity: 1, status: "archived" });
    const res = await check();
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody.match.ownership, { relationship: "notOwned" });
    assertNoWrites();
  });

  it("notOwned: no inventory row (another user's row does not count)", async () => {
    addInventory(OTHER, { shadeId: SHADE_ID, quantity: 5 });
    const res = await check();
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody.match.ownership, { relationship: "notOwned" });
    assertNoWrites();
  });

  it("scopes the inventory lookup to the caller's user_id", async () => {
    await check();
    const lookups = handlerCalls().filter((c) => /user_inventory_item/i.test(c.sql));
    assert.equal(lookups.length, 1, "exactly one inventory lookup");
    assert.match(lookups[0].sql, /WHERE\s+user_id\s*=\s*\$1/i);
    assert.equal(lookups[0].params[0], OWNER);
    assert.deepEqual(lookups[0].params[1], [String(SHADE_ID)]);
  });

  it("barcode → SKU match counts a row on the SKU's shade as owned", async () => {
    state.sessions.get(CAPTURE_UUID).metadata = { gtin: GTIN };
    state.frames = [{ frameType: "barcode", quality: { gtin: GTIN } }];
    addInventory(OWNER, { shadeId: SHADE_ID, quantity: 1 });
    const res = await check();
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.outcome, "matched");
    assert.equal(res.jsonBody.match.entityType, "sku");
    assert.equal(res.jsonBody.match.entityId, String(SKU_ID));
    assert.equal(res.jsonBody.match.shadeId, String(SHADE_ID));
    assert.deepEqual(res.jsonBody.match.ownership, { relationship: "owned", quantity: 1 });
    assertNoWrites();
  });

  it("needs_question: reports candidates with ownership but opens no question", async () => {
    state.shadeCandidates = [
      { shadeId: String(SHADE_ID), brand: "OPI", shadeName: "Big Apple Red", score: 0.81 },
      { shadeId: "22", brand: "OPI", shadeName: "Big Apple Rouge", score: 0.78 },
    ];
    addInventory(OWNER, { shadeId: 22, quantity: 0 });
    const res = await check();
    assert.equal(res.status, 200);
    const body = res.jsonBody;
    assert.equal(body.outcome, "needs_question");
    assert.equal(body.questionKey, "candidate_select");
    assert.equal(body.match, undefined);
    assert.equal(body.confidence, 0.81);
    assert.deepEqual(
      body.candidates.map((c) => [c.entityId, c.ownership.relationship]),
      [
        [String(SHADE_ID), "notOwned"],
        ["22", "wishlisted"],
      ]
    );
    assertNoWrites();
    assert.equal(state.sessions.get(CAPTURE_UUID).status, "processing");
  });

  it("already-matched session: reports the accepted entity without re-resolving", async () => {
    Object.assign(state.sessions.get(CAPTURE_UUID), {
      status: "matched",
      topConfidence: "1",
      acceptedEntityType: "shade",
      acceptedEntityId: String(SHADE_ID),
    });
    addInventory(OWNER, { shadeId: SHADE_ID, quantity: 1 });
    const res = await check();
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "matched");
    assert.equal(res.jsonBody.outcome, "matched");
    assert.equal(res.jsonBody.match.display, "OPI — Big Apple Red");
    assert.deepEqual(res.jsonBody.match.ownership, { relationship: "owned", quantity: 1 });
    assert.equal(handlerCalls().filter((c) => /similarity\(|FROM capture_frame/i.test(c.sql)).length, 0);
    assertNoWrites();
  });

  it("cancelled session → 409 and no writes", async () => {
    state.sessions.get(CAPTURE_UUID).status = "cancelled";
    const res = await check();
    assert.equal(res.status, 409);
    assertNoWrites();
  });
});

describe("functions/capture — check performs zero writes", () => {
  for (const [label, seed] of [
    ["owned", () => addInventory(OWNER, { shadeId: SHADE_ID, quantity: 3 })],
    ["wishlisted", () => addInventory(OWNER, { shadeId: SHADE_ID, quantity: 0 })],
    ["notOwned", () => {}],
  ]) {
    it(`${label}: no INSERT/UPDATE on user_inventory_item or inventory_event, state unchanged`, async () => {
      seed();
      const before = snapshot();
      const res = await check();
      assert.equal(res.status, 200);
      assertNoWrites();
      assert.equal(snapshot(), before, "inventory and session must be unchanged");
    });
  }

  it("repeated checks stay read-only", async () => {
    const before = snapshot();
    await check();
    await check();
    assertNoWrites();
    assert.equal(snapshot(), before);
  });
});

describe("functions/capture — check access control", () => {
  it("another user's session → 404, one caller-scoped lookup, no inventory query, no writes", async () => {
    addInventory(OWNER, { shadeId: SHADE_ID, quantity: 2 });
    const before = snapshot();
    const res = await check({ userId: OTHER });
    assert.equal(res.status, 404);
    assert.ok(!JSON.stringify(res.jsonBody).includes("Big Apple"), "must not leak the owner's match");
    const lookups = handlerCalls().filter((c) => /FROM\s+capture_session/i.test(c.sql));
    assert.equal(lookups.length, 1);
    assert.deepEqual(lookups[0].params, [CAPTURE_UUID, OTHER]);
    assert.equal(handlerCalls().filter((c) => /user_inventory_item|capture_frame/i.test(c.sql)).length, 0);
    assertNoWrites();
    assert.equal(snapshot(), before);
  });
});

describe("functions/capture — finalize is unchanged by check", () => {
  it("check then finalize: finalize still adds the match to inventory", async () => {
    const checked = await check();
    assert.deepEqual(checked.jsonBody.match.ownership, { relationship: "notOwned" });
    assertNoWrites();

    const res = await finalize();
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "matched");
    const inserts = handlerCalls().filter((c) => /INSERT\s+INTO\s+user_inventory_item/i.test(c.sql));
    assert.equal(inserts.length, 1, "finalize inserts one inventory row");
    assert.equal(inserts[0].params[0], OWNER);
    assert.deepEqual(
      state.inventory.map((r) => [r.userId, r.shadeId, r.quantity]),
      [[OWNER, SHADE_ID, 1]]
    );
    assert.equal(state.sessions.get(CAPTURE_UUID).status, "matched");

    // A check after the explicit add reports it as owned.
    const after = await check();
    assert.equal(after.jsonBody.status, "matched");
    assert.deepEqual(after.jsonBody.match.ownership, { relationship: "owned", quantity: 1 });
  });

  it("finalize on an owned shade still bumps the quantity", async () => {
    addInventory(OWNER, { shadeId: SHADE_ID, quantity: 2 });
    await check();
    const res = await finalize();
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "matched");
    assert.equal(
      handlerCalls().filter((c) => /UPDATE\s+user_inventory_item/i.test(c.sql)).length,
      1
    );
    assert.equal(state.inventory[0].quantity, 3);
  });

  it("check reports wishlisted; finalize then makes the row owned and check reports owned", async () => {
    addInventory(OWNER, { shadeId: SHADE_ID, quantity: 0 });
    const before = await check();
    assert.deepEqual(before.jsonBody.match.ownership, { relationship: "wishlisted" });
    assertNoWrites();

    const res = await finalize();
    assert.equal(res.status, 200);
    assert.equal(state.inventory[0].status, "owned");

    const after = await check();
    assert.deepEqual(after.jsonBody.match.ownership, { relationship: "owned", quantity: 1 });
  });
});
