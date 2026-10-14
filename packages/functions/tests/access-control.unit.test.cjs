/**
 * Access-control unit tests (issue #53): a user cannot read or modify another
 * user's inventory, capture sessions, or media.
 *
 * Runs without a database. Handler modules are loaded from dist/ with their
 * dependencies swapped out via require interception (same approach as
 * handlers.unit.test.cjs). Every SQL statement a handler issues is routed into
 * a tiny in-memory "fake DB" that:
 *   - records the SQL text + bound params, so tests can assert that queries
 *     touching user-owned tables carry a `user_id = $n` predicate bound to the
 *     *caller's* id, and
 *   - only returns the owner's rows when the query is scoped to the owner (or
 *     is not scoped at all), so a handler that forgot its user_id predicate
 *     would visibly leak/mutate the owner's data and fail these tests.
 *
 * Users: OWNER = 1 (owns inventory + capture session), ATTACKER = 2,
 * ADMIN = 99. All tokens use AUTH_DEV_BYPASS (`Bearer dev:<id>`).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");

// Must be set before handler modules load (the image proxy may read it eagerly).
const IMAGE_SIGNING_KEY = "access-control-unit-test-signing-key-0123456789";
process.env.IMAGE_PROXY_SIGNING_KEY = IMAGE_SIGNING_KEY;
delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const OWNER = 1;
const ATTACKER = 2;
const ADMIN = 99;
const USERS = {
  [OWNER]: { user_id: OWNER, external_id: "ext-owner", email: "owner@test.dev", role: "user" },
  [ATTACKER]: { user_id: ATTACKER, external_id: "ext-attacker", email: "attacker@test.dev", role: "user" },
  [ADMIN]: { user_id: ADMIN, external_id: "ext-admin", email: "admin@test.dev", role: "admin" },
};

const OWNED_SHADE_ID = 500;
const OWNER_CAPTURE_UUID = "11111111-1111-4111-8111-111111111111";
const OWNER_CAPTURE_SESSION_ID = 4242;
const OWNER_SECRET_NOTES = "owner-private-notes";
/** User-uploaded image assets: image_id -> owner. */
const OWNER_IMAGE_ID = 777;
const ATTACKER_IMAGE_ID = 888;
const IMAGE_ASSETS = new Map([
  [OWNER_IMAGE_ID, { ownerId: OWNER }],
  [ATTACKER_IMAGE_ID, { ownerId: ATTACKER }],
]);
/** Shades that exist in the shared catalog of the fake DB. */
const KNOWN_SHADES = new Set([OWNED_SHADE_ID]);

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

/** Every SQL statement issued by handlers, in order: { via, sql, params }. */
let sqlCalls = [];
let transactionCount = 0;
let state;

function resetState() {
  sqlCalls = [];
  transactionCount = 0;
  state = {
    nextInventoryId: 9000,
    inventory: new Map([
      [
        `${OWNER}:${OWNED_SHADE_ID}`,
        {
          inventoryItemId: "7001",
          userId: OWNER,
          shadeId: OWNED_SHADE_ID,
          quantity: 3,
          notes: OWNER_SECRET_NOTES,
          rating: 5,
          tags: ["owner-tag"],
        },
      ],
    ]),
    captureSessions: new Map([
      [
        OWNER_CAPTURE_UUID,
        {
          id: OWNER_CAPTURE_SESSION_ID,
          userId: OWNER,
          captureId: OWNER_CAPTURE_UUID,
          status: "processing",
          topConfidence: null,
          acceptedEntityType: null,
          acceptedEntityId: null,
          metadata: { pipeline: { status: "awaiting_frames" } },
        },
      ],
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

/** Placeholder numbers bound to a `user_id = $n` predicate (any alias). */
function userIdPlaceholders(sql) {
  return [...String(sql).matchAll(/\buser_id\s*=\s*\$(\d+)/gi)].map((m) => Number(m[1]));
}

/** For `INSERT INTO <table> (cols) VALUES ($a, $b, ...)`, the param bound to `column`. */
function insertedValue(sql, params, column) {
  const text = String(sql);
  const match = text.match(/INSERT\s+INTO\s+\w+\s*\(([^)]*)\)\s*VALUES\s*\(/i);
  if (!match) return undefined;
  const cols = match[1].split(",").map((c) => c.trim().toLowerCase());

  // Split the VALUES tuple on top-level commas (values may contain e.g. COALESCE($3, 0)).
  const values = [];
  let depth = 0;
  let current = "";
  for (const ch of text.slice(match.index + match[0].length)) {
    if (ch === "(") depth += 1;
    if (ch === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  values.push(current.trim());

  const idx = cols.indexOf(column);
  if (idx === -1 || !values[idx]) return undefined;
  const placeholder = values[idx].match(/\$(\d+)/);
  return placeholder ? params[Number(placeholder[1]) - 1] : undefined;
}

/**
 * The user id a statement is scoped to, or `undefined` if it is not scoped to a
 * single user (which, for user-owned tables, the fake treats as a leak).
 */
function boundUserId(sql, params) {
  const placeholders = userIdPlaceholders(sql);
  if (placeholders.length === 0) return undefined;
  const values = new Set(placeholders.map((n) => Number(params[n - 1])));
  return values.size === 1 ? [...values][0] : undefined;
}

function boundParam(sql, params, columnRegex) {
  const match = String(sql).match(columnRegex);
  return match ? params[Number(match[1]) - 1] : undefined;
}

function polishRow(shadeId, item) {
  return {
    id: String(shadeId),
    shadeId: String(shadeId),
    inventoryItemId: item ? item.inventoryItemId : null,
    userId: item ? String(item.userId) : null,
    brand: "Test Brand",
    name: `Shade ${shadeId}`,
    color: "",
    vendorHex: null,
    detectedHex: null,
    nameHex: null,
    finish: "creme",
    collection: "",
    quantity: item ? item.quantity : null,
    size: null,
    rating: item ? item.rating : null,
    notes: item ? item.notes : null,
    swatchImageUrl: null,
    tags: item ? item.tags : null,
    purchaseDate: null,
    expirationDate: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Inventory items visible to a query scoped to `userId` (undefined = unscoped = everything). */
function visibleInventory(userId, shadeId) {
  return [...state.inventory.values()].filter(
    (item) => item.shadeId === shadeId && (userId === undefined || item.userId === userId)
  );
}

async function fakeQuery(via, sql, params = []) {
  sqlCalls.push({ via, sql: String(sql), params });
  const text = String(sql);
  const kind = statementKind(text);

  // Auth: dev-bypass user lookup.
  if (/FROM\s+app_user/i.test(text) && /WHERE\s+user_id\s*=\s*\$1/i.test(text)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }

  if (/user_inventory_item/i.test(text)) {
    if (kind === "INSERT") {
      const userId = Number(insertedValue(text, params, "user_id"));
      const shadeId = Number(insertedValue(text, params, "shade_id"));
      const key = `${userId}:${shadeId}`;
      const existing = state.inventory.get(key);
      const item = existing || {
        inventoryItemId: String(state.nextInventoryId++),
        userId,
        shadeId,
        quantity: 0,
        notes: null,
        rating: null,
        tags: null,
      };
      const quantity = insertedValue(text, params, "quantity");
      const notes = insertedValue(text, params, "notes");
      const rating = insertedValue(text, params, "rating");
      if (quantity !== undefined && quantity !== null) item.quantity = quantity;
      if (notes !== undefined && notes !== null) item.notes = notes;
      if (rating !== undefined && rating !== null) item.rating = rating;
      state.inventory.set(key, item);
      return { rows: [{ inventoryItemId: item.inventoryItemId }], rowCount: 1 };
    }

    if (kind === "DELETE") {
      const userId = boundUserId(text, params);
      const shadeId = Number(boundParam(text, params, /\bshade_id\s*=\s*\$(\d+)/i));
      const victims = visibleInventory(userId, shadeId);
      for (const item of victims) state.inventory.delete(`${item.userId}:${item.shadeId}`);
      return { rows: victims.map((i) => ({ id: i.inventoryItemId })), rowCount: victims.length };
    }

    if (kind === "UPDATE") {
      // Not issued by the handlers under test today; treat an unscoped UPDATE as a leak.
      return { rows: [], rowCount: 0 };
    }

    // SELECT (polish list/detail + count)
    if (/COUNT\(\*\)/i.test(text)) {
      return { rows: [{ total: "1" }], rowCount: 1 };
    }
    const userId = boundUserId(text, params);
    const shadeParam = boundParam(text, params, /\bs\.shade_id\s*=\s*\$(\d+)/i);
    const shadeIds = (shadeParam !== undefined ? [Number(shadeParam)] : [OWNED_SHADE_ID]).filter(
      (id) => KNOWN_SHADES.has(id)
    );
    const rows = shadeIds.map((shadeId) => polishRow(shadeId, visibleInventory(userId, shadeId)[0]));
    return { rows, rowCount: rows.length };
  }

  if (/capture_session/i.test(text) && kind === "SELECT") {
    const captureUuid = boundParam(text, params, /capture_uuid\s*=\s*\$(\d+)/i);
    const session = state.captureSessions.get(captureUuid);
    const userId = boundUserId(text, params);
    if (session && (userId === undefined || userId === session.userId)) {
      const { userId: _owner, ...row } = session;
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Shade existence check (POST /polishes with shadeId).
  if (/FROM\s+shade\s+WHERE\s+shade_id\s*=\s*\$1/i.test(text) && kind === "SELECT") {
    return KNOWN_SHADES.has(Number(params[0])) ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // Image ownership lookups: only return the asset when scoped to its owner.
  if (/FROM\s+image_asset/i.test(text) && kind === "SELECT") {
    const imageId = Number(boundParam(text, params, /\bimage_id\s*=\s*\$(\d+)/i));
    const ownerParam = boundParam(text, params, /\bowner_id\s*=\s*\$(\d+)/i);
    const asset = IMAGE_ASSETS.get(imageId);
    if (asset && (ownerParam === undefined || Number(ownerParam) === asset.ownerId)) {
      return { rows: [{ imageId: String(imageId) }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  if (/INSERT\s+INTO\s+capture_session/i.test(text)) {
    return { rows: [{ captureId: params[0], status: "processing" }], rowCount: 1 };
  }
  if (/INSERT\s+INTO\s+image_asset/i.test(text)) {
    return { rows: [{ imageId: "500" }], rowCount: 1 };
  }
  if (/INSERT\s+INTO\s+capture_frame/i.test(text)) {
    return { rows: [{ frameId: "900" }], rowCount: 1 };
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
  output: {
    storageQueue: (opts) => ({ __type: "storageQueue", ...opts }),
  },
});

registerMock("jose", {
  createRemoteJWKSet: () => {},
  jwtVerify: async () => {
    throw new Error("JWT validation is not exercised in access-control tests");
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

// External side effects — each records whether it was reached.
let sideEffects;
function resetSideEffects() {
  sideEffects = { blobReads: [], ocrCalls: 0, labelParseCalls: 0, aiHexCalls: 0, stripCalls: 0 };
}
resetSideEffects();

registerMock("../lib/ai-color-detection", {
  detectHexWithAzureOpenAI: async () => {
    sideEffects.aiHexCalls += 1;
    return { hex: "#ABCDEF", confidence: 0.9, finishes: [], provider: "azure-openai" };
  },
});
registerMock("../lib/ocr", {
  extractTextFromImage: async () => {
    sideEffects.ocrCalls += 1;
    return null;
  },
});
registerMock("../lib/ocr-parser", {
  parseLabelText: async () => {
    sideEffects.labelParseCalls += 1;
    return null;
  },
});

class BlobReadError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "BlobReadError";
    this.status = status;
  }
}
class BlobAccessDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlobAccessDeniedError";
  }
}
registerMock("../lib/blob-storage", {
  BlobReadError,
  BlobAccessDeniedError,
  defaultReadableContainers: () => ["source-images"],
  readBlobFromStorageUrl: async (storageUrl) => {
    sideEffects.blobReads.push(storageUrl);
    return {
      bytes: Buffer.from("private-image-bytes"),
      contentType: "image/png",
      checksumSha256: "deadbeef",
      sizeBytes: 19,
      storageUrl,
    };
  },
  validateImageUpload: (contentType) => String(contentType || "").split(";")[0].trim().toLowerCase(),
  stripImageMetadata: async (bytes) => {
    sideEffects.stripCalls += 1;
    return bytes;
  },
});

// sharp is only used for on-the-fly image transforms; never reached without w/h/fm params.
registerMock("sharp", () => {
  throw new Error("sharp should not be invoked in access-control tests");
});

for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

// ---------------------------------------------------------------------------
// Fake HttpRequest / InvocationContext
// ---------------------------------------------------------------------------

function fakeRequest({ method = "GET", url = "http://localhost:7071/api/test", headers = {}, params = {}, body } = {}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) headerMap.set(k.toLowerCase(), v);
  return {
    method,
    url,
    headers: { get: (name) => headerMap.get(name.toLowerCase()) || null },
    params,
    query: new URL(url).searchParams,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
    arrayBuffer: async () =>
      body ? new TextEncoder().encode(JSON.stringify(body)).buffer : new ArrayBuffer(0),
  };
}

function fakeContext() {
  const outputs = new Map();
  return {
    log: () => {},
    error: () => {},
    warn: () => {},
    extraOutputs: { set: (b, v) => outputs.set(b, v), get: (b) => outputs.get(b) },
  };
}

function bearer(userId) {
  return { authorization: `Bearer dev:${userId}` };
}

async function invoke(routeName, { method, userId, headers, ...rest } = {}) {
  const route = registeredRoutes[routeName];
  assert.ok(route, `route ${routeName} should be registered`);
  const resolvedMethod = method || route.methods.find((m) => m !== "OPTIONS");
  const req = fakeRequest({
    method: resolvedMethod,
    headers: { ...(userId !== undefined ? bearer(userId) : {}), ...(headers || {}) },
    ...rest,
  });
  return route.handler(req, fakeContext());
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const USER_OWNED_TABLES = /\b(user_inventory_item|capture_session)\b/i;

/** Non-auth statements issued by handlers. */
function handlerCalls() {
  return sqlCalls.filter((c) => !/FROM\s+app_user/i.test(c.sql));
}

function describeCall(call) {
  return `${call.sql.replace(/\s+/g, " ").trim().slice(0, 160)}... params=${JSON.stringify(call.params)}`;
}

/**
 * Every statement touching a user-owned table must be scoped to the caller:
 *  - SELECT/DELETE/UPDATE: a `user_id = $n` predicate whose bound value is the caller
 *  - INSERT: the `user_id` column value is the caller
 * and no statement may bind any other known user's id.
 */
function assertScopedToCaller(callerId) {
  const touching = handlerCalls().filter((c) => USER_OWNED_TABLES.test(c.sql));
  assert.ok(touching.length > 0, "expected at least one query against a user-owned table");

  for (const call of touching) {
    const kind = statementKind(call.sql);
    if (kind === "INSERT" && /INSERT\s+INTO\s+(user_inventory_item|capture_session)\b/i.test(call.sql)) {
      assert.equal(
        Number(insertedValue(call.sql, call.params, "user_id")),
        callerId,
        `INSERT must bind user_id to the caller: ${describeCall(call)}`
      );
      continue;
    }
    if (kind === "UPDATE" && /UPDATE\s+capture_session\b/i.test(call.sql)) {
      // Session updates are keyed by the internal id returned from an owner-scoped lookup;
      // the attacker-path tests separately assert these never happen.
      continue;
    }
    const placeholders = userIdPlaceholders(call.sql);
    assert.ok(placeholders.length > 0, `missing user_id predicate: ${describeCall(call)}`);
    for (const n of placeholders) {
      assert.equal(
        Number(call.params[n - 1]),
        callerId,
        `user_id predicate $${n} must be bound to caller ${callerId}: ${describeCall(call)}`
      );
    }
  }

  for (const call of handlerCalls()) {
    for (const [otherId] of Object.entries(USERS)) {
      if (Number(otherId) === callerId) continue;
      const placeholders = userIdPlaceholders(call.sql);
      for (const n of placeholders) {
        assert.notEqual(
          Number(call.params[n - 1]),
          Number(otherId),
          `query bound another user's id (${otherId}): ${describeCall(call)}`
        );
      }
    }
  }
}

function assertNoMutations() {
  const mutations = handlerCalls().filter((c) => isMutation(c.sql));
  assert.deepEqual(
    mutations.map(describeCall),
    [],
    "no INSERT/UPDATE/DELETE may be issued for an unauthorized request"
  );
}

function assertOwnerInventoryUnchanged() {
  const item = state.inventory.get(`${OWNER}:${OWNED_SHADE_ID}`);
  assert.ok(item, "owner's inventory row must still exist");
  assert.equal(item.quantity, 3);
  assert.equal(item.notes, OWNER_SECRET_NOTES);
  assert.equal(item.rating, 5);
  assert.equal(item.inventoryItemId, "7001");
}

function assertOwnerSessionUnchanged() {
  const session = state.captureSessions.get(OWNER_CAPTURE_UUID);
  assert.equal(session.status, "processing");
  assert.equal(session.userId, OWNER);
}

function assertNoOwnerDataInBody(body) {
  const serialized = JSON.stringify(body ?? null);
  assert.ok(!serialized.includes(OWNER_SECRET_NOTES), `response leaked owner's notes: ${serialized}`);
  assert.ok(!serialized.includes("owner-tag"), `response leaked owner's tags: ${serialized}`);
  assert.ok(!serialized.includes('"7001"'), `response leaked owner's inventoryItemId: ${serialized}`);
}

// ---------------------------------------------------------------------------
// Load handler modules (they register routes via the mocked app.http)
// ---------------------------------------------------------------------------

require("../dist/functions/polishes");
require("../dist/functions/capture");
require("../dist/functions/ingestion");
require("../dist/functions/admin-users");
require("../dist/functions/admin-reference");
require("../dist/functions/voice");
require("../dist/functions/images");
const imageProxy = require("../dist/lib/image-proxy");

beforeEach(() => {
  resetState();
  resetSideEffects();
  process.env.AUTH_DEV_BYPASS = "true";
});

afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
  delete process.env.AZURE_AD_B2C_TENANT;
  delete process.env.AZURE_AD_B2C_CLIENT_ID;
});

// Routes that operate on a single user's data and must require authentication.
const USER_SCOPED_REQUESTS = [
  { route: "polishes-list", method: "GET", url: "http://localhost:7071/api/polishes", params: {} },
  {
    route: "polishes-list",
    method: "GET",
    url: `http://localhost:7071/api/polishes/${OWNED_SHADE_ID}`,
    params: { id: String(OWNED_SHADE_ID) },
  },
  {
    route: "polishes-create",
    method: "POST",
    url: "http://localhost:7071/api/polishes",
    body: { brand: "B", name: "N" },
  },
  {
    route: "polishes-mutate",
    method: "PUT",
    url: `http://localhost:7071/api/polishes/${OWNED_SHADE_ID}`,
    params: { id: String(OWNED_SHADE_ID) },
    body: { quantity: 0 },
  },
  {
    route: "polishes-mutate",
    method: "DELETE",
    url: `http://localhost:7071/api/polishes/${OWNED_SHADE_ID}`,
    params: { id: String(OWNED_SHADE_ID) },
  },
  { route: "capture-start", method: "POST", url: "http://localhost:7071/api/capture/start", body: {} },
  { route: "voice-process", method: "POST", url: "http://localhost:7071/api/voice", body: {} },
  {
    route: "capture-frame",
    method: "POST",
    url: `http://localhost:7071/api/capture/${OWNER_CAPTURE_UUID}/frame`,
    params: { captureId: OWNER_CAPTURE_UUID },
    body: { frameType: "label", imageBlobUrl: "data:image/png;base64,YWJj" },
  },
  {
    route: "capture-finalize",
    method: "POST",
    url: `http://localhost:7071/api/capture/${OWNER_CAPTURE_UUID}/finalize`,
    params: { captureId: OWNER_CAPTURE_UUID },
    body: {},
  },
  {
    route: "capture-status",
    method: "GET",
    url: `http://localhost:7071/api/capture/${OWNER_CAPTURE_UUID}/status`,
    params: { captureId: OWNER_CAPTURE_UUID },
  },
  {
    route: "capture-answer",
    method: "POST",
    url: `http://localhost:7071/api/capture/${OWNER_CAPTURE_UUID}/answer`,
    params: { captureId: OWNER_CAPTURE_UUID },
    body: { answer: "yes" },
  },
];

function requestLabel(r) {
  return `${r.method} ${new URL(r.url).pathname} (${r.route})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Authentication is required on every user-scoped route
// ═══════════════════════════════════════════════════════════════════════════

describe("access control — unauthenticated requests are rejected with 401", () => {
  for (const r of USER_SCOPED_REQUESTS) {
    it(`${requestLabel(r)} without Authorization header (dev bypass on)`, async () => {
      const res = await invoke(r.route, { ...r, userId: undefined });
      assert.equal(res.status, 401);
      assert.deepEqual(handlerCalls(), [], "no handler SQL may run before authentication");
      assertOwnerInventoryUnchanged();
      assertOwnerSessionUnchanged();
    });

    it(`${requestLabel(r)} without Authorization header (production mode)`, async () => {
      delete process.env.AUTH_DEV_BYPASS;
      const res = await invoke(r.route, { ...r, userId: undefined });
      assert.equal(res.status, 401);
      assert.deepEqual(sqlCalls, []);
    });

    it(`${requestLabel(r)} with a dev token for a non-existent user`, async () => {
      const res = await invoke(r.route, { ...r, userId: 31337 });
      assert.equal(res.status, 401);
      assert.deepEqual(handlerCalls(), []);
    });
  }

  it("dev tokens are not accepted when AUTH_DEV_BYPASS is off", async () => {
    delete process.env.AUTH_DEV_BYPASS;
    const res = await invoke("polishes-list", {
      method: "GET",
      userId: OWNER,
      url: "http://localhost:7071/api/polishes",
      params: {},
    });
    assert.equal(res.status, 401);
    assert.deepEqual(sqlCalls, []);
  });

  it("rejects malformed dev tokens", async () => {
    const res = await invoke("polishes-list", {
      method: "GET",
      headers: { authorization: "Bearer dev:1 OR 1=1" },
      url: "http://localhost:7071/api/polishes",
      params: {},
    });
    assert.equal(res.status, 401);
    assert.deepEqual(sqlCalls, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Admin-only routes reject regular users
// ═══════════════════════════════════════════════════════════════════════════

describe("access control — admin routes reject non-admin users", () => {
  const adminRouteNames = Object.keys(registeredRoutes)
    .filter((name) => /^(ingestion-|admin-)/.test(name) || name === "polishes-recalc-hex")
    .sort();

  it("discovers the expected admin route families", () => {
    for (const expected of [
      "admin-users-list",
      "admin-users-merge",
      "admin-finishes",
      "admin-jobs",
      "ingestion-jobs",
      "ingestion-job-detail",
      "ingestion-settings",
      "polishes-recalc-hex",
    ]) {
      assert.ok(adminRouteNames.includes(expected), `expected admin route ${expected} to be registered`);
    }
  });

  for (const name of adminRouteNames) {
    const methods = registeredRoutes[name].methods.filter((m) => m !== "OPTIONS");
    for (const method of methods) {
      const params = { id: "1" };
      const url = `http://localhost:7071/api/${registeredRoutes[name].route.replace(/\{(\w+)\??\}/g, "1")}`;

      it(`${method} ${name} → 403 for a regular user`, async () => {
        const res = await invoke(name, { method, userId: ATTACKER, url, params, body: {} });
        assert.equal(res.status, 403);
        assert.deepEqual(handlerCalls().map(describeCall), [], "admin handler body must not run");
        assert.equal(transactionCount, 0);
        assert.equal(sideEffects.blobReads.length + sideEffects.aiHexCalls, 0);
      });

      it(`${method} ${name} → 401 without credentials`, async () => {
        const res = await invoke(name, { method, url, params, body: {} });
        assert.equal(res.status, 401);
        assert.deepEqual(sqlCalls, []);
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Polishes / inventory
// ═══════════════════════════════════════════════════════════════════════════

describe("access control — polishes inventory is scoped to the caller", () => {
  const detailUrl = `http://localhost:7071/api/polishes/${OWNED_SHADE_ID}`;

  it("owner sanity check: owner sees their own inventory fields", async () => {
    const res = await invoke("polishes-list", {
      method: "GET",
      userId: OWNER,
      url: detailUrl,
      params: { id: String(OWNED_SHADE_ID) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.notes, OWNER_SECRET_NOTES);
    assert.equal(res.jsonBody.inventoryItemId, "7001");
    assertScopedToCaller(OWNER);
  });

  it("GET detail by another user never returns the owner's inventory fields", async () => {
    // Shades are a shared catalog, so the shade itself may be visible; the private part is
    // the inventory overlay (quantity, notes, rating, tags, inventoryItemId).
    const res = await invoke("polishes-list", {
      method: "GET",
      userId: ATTACKER,
      url: detailUrl,
      params: { id: String(OWNED_SHADE_ID) },
    });
    assert.ok([200, 403, 404].includes(res.status), `unexpected status ${res.status}: ${JSON.stringify(res.jsonBody)}`);
    assertNoOwnerDataInBody(res.jsonBody);
    if (res.status === 200) {
      assert.equal(res.jsonBody.inventoryItemId, null);
      assert.equal(res.jsonBody.quantity, null);
      assert.equal(res.jsonBody.notes, null);
    }
    assertScopedToCaller(ATTACKER);
    assertNoMutations();
  });

  it("GET detail returns 404 and performs no mutation when no row is visible to the caller", async () => {
    const res = await invoke("polishes-list", {
      method: "GET",
      userId: ATTACKER,
      url: "http://localhost:7071/api/polishes/999",
      params: { id: "999" },
    });
    assert.equal(res.status, 404);
    assertScopedToCaller(ATTACKER);
    assertNoMutations();
  });

  it("GET list by another user is scoped to the caller and leaks no owner inventory", async () => {
    const res = await invoke("polishes-list", {
      method: "GET",
      userId: ATTACKER,
      url: "http://localhost:7071/api/polishes?scope=collection&search=shade",
      params: {},
    });
    assert.equal(res.status, 200);
    assertNoOwnerDataInBody(res.jsonBody);
    for (const polish of res.jsonBody.polishes) {
      assert.ok(polish.inventoryItemId == null, "attacker must not see the owner's inventory rows");
    }
    assertScopedToCaller(ATTACKER);
    assertNoMutations();
  });

  it("DELETE by another user returns 404 and leaves the owner's row intact", async () => {
    const res = await invoke("polishes-mutate", {
      method: "DELETE",
      userId: ATTACKER,
      url: detailUrl,
      params: { id: String(OWNED_SHADE_ID) },
    });
    assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
    assertScopedToCaller(ATTACKER);
    const deletes = handlerCalls().filter((c) => statementKind(c.sql) === "DELETE");
    assert.equal(deletes.length, 1, "only the caller-scoped DELETE may be attempted");
    assertOwnerInventoryUnchanged();
  });

  it("DELETE by the owner removes only the owner's row (positive control)", async () => {
    state.inventory.set(`${ATTACKER}:${OWNED_SHADE_ID}`, {
      inventoryItemId: "8001",
      userId: ATTACKER,
      shadeId: OWNED_SHADE_ID,
      quantity: 1,
      notes: "attacker notes",
      rating: null,
      tags: null,
    });
    const res = await invoke("polishes-mutate", {
      method: "DELETE",
      userId: OWNER,
      url: detailUrl,
      params: { id: String(OWNED_SHADE_ID) },
    });
    assert.equal(res.status, 200);
    assert.equal(state.inventory.has(`${OWNER}:${OWNED_SHADE_ID}`), false);
    assert.equal(state.inventory.has(`${ATTACKER}:${OWNED_SHADE_ID}`), true);
    assertScopedToCaller(OWNER);
  });

  it("PUT by another user only writes the caller's own inventory row", async () => {
    // PUT is an upsert into the *caller's* inventory for the shade, so it may succeed — but it
    // must never touch the owner's row.
    const res = await invoke("polishes-mutate", {
      method: "PUT",
      userId: ATTACKER,
      url: detailUrl,
      params: { id: String(OWNED_SHADE_ID) },
      body: { quantity: 0, notes: "pwned", rating: 1 },
    });
    assert.ok(res.status < 500, `unexpected status ${res.status}: ${JSON.stringify(res.jsonBody)}`);
    assertScopedToCaller(ATTACKER);
    assertOwnerInventoryUnchanged();
    assertNoOwnerDataInBody(res.jsonBody);

    const inventoryWrites = handlerCalls().filter(
      (c) => isMutation(c.sql) && /user_inventory_item/i.test(c.sql)
    );
    assert.ok(inventoryWrites.length > 0);
    for (const write of inventoryWrites) {
      assert.match(write.sql, /ON CONFLICT \(user_id, shade_id\)/i, "upsert must be keyed on (user_id, shade_id)");
    }
  });

  it("POST create binds the inventory row to the caller", async () => {
    const res = await invoke("polishes-create", {
      method: "POST",
      userId: ATTACKER,
      url: "http://localhost:7071/api/polishes",
      body: { shadeId: String(OWNED_SHADE_ID), quantity: 1 },
    });
    assert.ok(res.status < 500, `unexpected status ${res.status}: ${JSON.stringify(res.jsonBody)}`);
    assertScopedToCaller(ATTACKER);
    assertOwnerInventoryUnchanged();
  });

  // Shades are a shared catalog: a regular user may backfill missing color data,
  // but must never overwrite a value other users already see. Every shade write
  // from a user route must therefore be fill-only: `col = COALESCE(col, $n)`.
  const SHADE_COLOR_COLUMNS = ["color_name", "vendor_hex", "detected_hex", "name_hex"];

  function assertShadeWritesAreFillOnly() {
    const shadeWrites = handlerCalls().filter((c) => /^\s*UPDATE\s+shade\b/i.test(c.sql));
    assert.ok(shadeWrites.length > 0, "expected a shade backfill write (guards against a vacuous pass)");
    for (const write of shadeWrites) {
      for (const col of SHADE_COLOR_COLUMNS) {
        if (!new RegExp(`\\b${col}\\s*=`, "i").test(write.sql)) continue;
        assert.match(
          write.sql,
          new RegExp(`\\b${col}\\s*=\\s*COALESCE\\(\\s*${col}\\s*,\\s*\\$\\d+\\s*\\)`, "i"),
          `non-admin shade write may only fill NULL ${col}: ${describeCall(write)}`
        );
      }
    }
  }

  it("PUT with color fields by a regular user only fills missing shared shade data", async () => {
    const res = await invoke("polishes-mutate", {
      method: "PUT",
      userId: ATTACKER,
      url: detailUrl,
      params: { id: String(OWNED_SHADE_ID) },
      body: { vendorHex: "#000000", detectedHex: "#000000", color: "Defaced" },
    });
    assert.ok(res.status < 500);
    assertShadeWritesAreFillOnly();
  });

  it("POST adopting an existing shade with color fields only fills missing shared shade data", async () => {
    const res = await invoke("polishes-create", {
      method: "POST",
      userId: ATTACKER,
      url: "http://localhost:7071/api/polishes",
      body: { shadeId: String(OWNED_SHADE_ID), quantity: 1, vendorHex: "#000000", color: "Defaced" },
    });
    assert.ok(res.status < 500);
    assertShadeWritesAreFillOnly();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Capture sessions
// ═══════════════════════════════════════════════════════════════════════════

describe("access control — capture sessions are scoped to the owner", () => {
  const CAPTURE_ATTACKS = USER_SCOPED_REQUESTS.filter(
    (r) => r.route.startsWith("capture-") && r.route !== "capture-start"
  );

  for (const r of CAPTURE_ATTACKS) {
    it(`${requestLabel(r)} by another user → 404, no mutation, no side effects`, async () => {
      const res = await invoke(r.route, { ...r, userId: ATTACKER });
      assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
      assertNoOwnerDataInBody(res.jsonBody);
      assert.ok(!JSON.stringify(res.jsonBody).includes("awaiting_frames"), "leaked owner's session metadata");

      assertScopedToCaller(ATTACKER);
      assertNoMutations();
      assert.equal(transactionCount, 0, "no transaction may be opened for another user's session");
      assert.equal(sideEffects.stripCalls, 0, "image must not be processed");
      assert.equal(sideEffects.ocrCalls, 0, "OCR must not run");
      assert.equal(sideEffects.blobReads.length, 0, "no blob reads");
      assertOwnerSessionUnchanged();

      const lookups = handlerCalls().filter((c) => /FROM\s+capture_session/i.test(c.sql));
      assert.equal(lookups.length, 1, "exactly one owner-scoped session lookup");
      assert.deepEqual(lookups[0].params, [OWNER_CAPTURE_UUID, ATTACKER]);
    });
  }

  for (const r of CAPTURE_ATTACKS.filter((x) => x.route === "capture-status")) {
    it(`${requestLabel(r)} by the owner succeeds (positive control)`, async () => {
      const res = await invoke(r.route, { ...r, userId: OWNER });
      assert.equal(res.status, 200);
      assert.equal(res.jsonBody.captureId, OWNER_CAPTURE_UUID);
      assertScopedToCaller(OWNER);
    });
  }

  it("capture-start binds the new session to the caller", async () => {
    const res = await invoke("capture-start", {
      method: "POST",
      userId: ATTACKER,
      url: "http://localhost:7071/api/capture/start",
      body: {},
    });
    assert.equal(res.status, 201);
    assertScopedToCaller(ATTACKER);
  });

  function seedAttackerSession() {
    const attackerUuid = "22222222-2222-4222-8222-222222222222";
    state.captureSessions.set(attackerUuid, {
      id: 5151,
      userId: ATTACKER,
      captureId: attackerUuid,
      status: "processing",
      topConfidence: null,
      acceptedEntityType: null,
      acceptedEntityId: null,
      metadata: null,
    });
    return attackerUuid;
  }

  it("capture-frame refuses to attach an image_asset owned by another user", async () => {
    // The attacker owns this session, but image 777 belongs to the owner.
    const attackerUuid = seedAttackerSession();
    const res = await invoke("capture-frame", {
      method: "POST",
      userId: ATTACKER,
      url: `http://localhost:7071/api/capture/${attackerUuid}/frame`,
      params: { captureId: attackerUuid },
      body: { frameType: "label", imageId: OWNER_IMAGE_ID },
    });
    assert.ok([400, 403, 404].includes(res.status), `expected rejection, got ${res.status}`);

    const ownershipChecks = handlerCalls().filter((c) => /FROM\s+image_asset/i.test(c.sql));
    assert.equal(ownershipChecks.length, 1, "image ownership must be verified");
    assert.match(ownershipChecks[0].sql, /owner_id\s*=\s*\$\d+/i);
    assert.ok(ownershipChecks[0].params.map(Number).includes(ATTACKER), "ownership check bound to caller");
    assertNoMutations();
    assert.equal(transactionCount, 0);
  });

  it("capture-frame accepts an image_asset owned by the caller (positive control)", async () => {
    const attackerUuid = seedAttackerSession();
    const res = await invoke("capture-frame", {
      method: "POST",
      userId: ATTACKER,
      url: `http://localhost:7071/api/capture/${attackerUuid}/frame`,
      params: { captureId: attackerUuid },
      body: { frameType: "other", imageId: ATTACKER_IMAGE_ID },
    });
    assert.equal(res.status, 201, `unexpected status ${res.status}: ${JSON.stringify(res.jsonBody)}`);
    const frameInsert = handlerCalls().find((c) => /INSERT\s+INTO\s+capture_frame/i.test(c.sql));
    assert.ok(frameInsert);
    assert.equal(Number(frameInsert.params[1]), ATTACKER_IMAGE_ID);
    assert.equal(state.captureSessions.get(OWNER_CAPTURE_UUID).status, "processing");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Media: /api/images/{id} must only serve ids minted by the server (#47)
// ═══════════════════════════════════════════════════════════════════════════

describe("images signed-id (requires #47)", () => {
  // Expected id format after #47: `<base64url(storageUrl)>.<base64url(hmac)>`, keyed by
  // IMAGE_PROXY_SIGNING_KEY. Valid ids are minted via the library so these tests do not
  // depend on the exact HMAC construction.
  const PRIVATE_URL = "https://swatchwatchacct.blob.core.windows.net/user-uploads/user-1/private-photo.png";
  const OTHER_URL = "https://swatchwatchacct.blob.core.windows.net/user-uploads/user-2/other-photo.png";

  function b64url(input) {
    return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function mintId(sourceUrl) {
    const proxyUrl = imageProxy.toImageProxyUrl("http://localhost:7071/api/polishes", sourceUrl);
    const id = new URL(proxyUrl).pathname.split("/").pop();
    return decodeURIComponent(id);
  }

  async function getImage(id) {
    return invoke("images", {
      method: "GET",
      url: `http://localhost:7071/api/images/${encodeURIComponent(id)}`,
      params: { id },
    });
  }

  function assertRejected(res) {
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    assert.deepEqual(sideEffects.blobReads, [], "blob storage must not be read for an unverified id");
  }

  it("server-minted ids use the signed `<payload>.<signature>` format", () => {
    const id = mintId(PRIVATE_URL);
    assert.match(id, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("serves an image for a server-minted signed id (positive control)", async () => {
    const res = await getImage(mintId(PRIVATE_URL));
    assert.equal(res.status, 200);
    assert.deepEqual(sideEffects.blobReads, [PRIVATE_URL]);
  });

  it("rejects a forged unsigned id (plain base64url of a storage URL)", async () => {
    assertRejected(await getImage(b64url(PRIVATE_URL)));
  });

  it("rejects an id with an empty signature", async () => {
    assertRejected(await getImage(`${b64url(PRIVATE_URL)}.`));
  });

  it("rejects an id with a garbage signature", async () => {
    assertRejected(await getImage(`${b64url(PRIVATE_URL)}.${b64url("not-a-real-mac")}`));
  });

  it("rejects an id signed with the wrong key", async () => {
    const forgedMac = crypto.createHmac("sha256", "attacker-key").update(b64url(PRIVATE_URL)).digest();
    const forgedMacOverUrl = crypto.createHmac("sha256", "attacker-key").update(PRIVATE_URL).digest();
    assertRejected(await getImage(`${b64url(PRIVATE_URL)}.${b64url(forgedMac)}`));
    assertRejected(await getImage(`${b64url(PRIVATE_URL)}.${b64url(forgedMacOverUrl)}`));
  });

  it("rejects a valid signature transplanted onto a different URL", async () => {
    const legit = mintId(OTHER_URL);
    const signature = legit.split(".").pop();
    assertRejected(await getImage(`${b64url(PRIVATE_URL)}.${signature}`));
  });

  it("rejects a tampered signature (single character flipped)", async () => {
    const legit = mintId(PRIVATE_URL);
    const last = legit.slice(-1);
    const tampered = legit.slice(0, -1) + (last === "A" ? "B" : "A");
    assertRejected(await getImage(tampered));
  });
});
