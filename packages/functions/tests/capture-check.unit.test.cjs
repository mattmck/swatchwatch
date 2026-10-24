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
const { describe, it, before, beforeEach, afterEach } = require("node:test");
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
let blobUploads;
let blobDeletes;
let transactionCount;
let state;

function resetState() {
  blobUploads = [];
  blobDeletes = [];
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
    /** Row returned by the brand-hint lookup (`FROM brand b`); null = no catalog brand. */
    brandRow: null,
    /** Shade names returned by the closed-list query (`shade_name_canonical AS name`). */
    brandShadeNames: [],
    /** Rows returned by the brand-first pool query (`s.brand_id = ANY($1::bigint[])`). */
    bottleCandidates: [],
    /** Rows returned by the color-distance lookup of global candidates. */
    colorDistances: [],
    /** image_asset rows written by the frame endpoint: { imageId, ownerId, storageUrl, checksum }. */
    assets: [],
    /** When set, INSERT INTO capture_frame throws (frame transaction failure). */
    failFrameInsert: false,
    nextImageId: 900,
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

  // Start: the new session row.
  if (kind === "INSERT" && /INTO capture_session/i.test(norm)) {
    return { rows: [{ captureId: params[0], status: "processing" }], rowCount: 1 };
  }

  if (/FROM capture_session/i.test(norm) && kind === "SELECT") {
    const session = state.sessions.get(params[0]);
    if (session && Number(params[1]) === session.userId) {
      const { userId: _owner, ...row } = session;
      return { rows: [{ ...row }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // Frame retention: the release lookup (frames of a session whose asset is the caller's blob).
  if (/FROM capture_frame cf/i.test(norm) && /JOIN image_asset ia/i.test(norm)) {
    const rows = params[0] === SESSION_ID
      ? state.assets
          .filter((a) => a.ownerId === Number(params[1]) && !a.storageUrl.startsWith("inline://"))
          .map((a) => ({ imageId: String(a.imageId), storageUrl: a.storageUrl, checksum: a.checksum, captureId: CAPTURE_UUID }))
      : [];
    return { rows, rowCount: rows.length };
  }
  if (kind === "INSERT" && /INTO image_asset/i.test(norm)) {
    const asset = { imageId: state.nextImageId++, ownerId: Number(params[0]), storageUrl: params[1], checksum: params[2] };
    state.assets.push(asset);
    return { rows: [{ imageId: String(asset.imageId) }], rowCount: 1 };
  }
  if (kind === "INSERT" && /INTO capture_frame/i.test(norm)) {
    if (state.failFrameInsert) throw new Error("capture_frame insert failed");
    return { rows: [{ frameId: "77" }], rowCount: 1 };
  }
  if (kind === "UPDATE" && /UPDATE image_asset/i.test(norm)) {
    const asset = state.assets.find((a) => a.imageId === Number(params[0]) && a.ownerId === Number(params[2]));
    if (asset) asset.storageUrl = params[1];
    return { rows: [], rowCount: asset ? 1 : 0 };
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

  if (/FROM brand b/i.test(norm) && /brand_alias/i.test(norm)) {
    return { rows: state.brandRow ? [state.brandRow] : [], rowCount: state.brandRow ? 1 : 0 };
  }

  if (/shade_name_canonical AS name/i.test(norm) && /FROM shade s/i.test(norm)) {
    const rows = state.brandShadeNames.map((name) => ({ name }));
    return { rows, rowCount: rows.length };
  }

  if (/s\.brand_id = ANY\(\$1::bigint\[\]\)/i.test(norm) && /FROM shade s/i.test(norm)) {
    return { rows: state.bottleCandidates, rowCount: state.bottleCandidates.length };
  }

  if (/shade_id = ANY\(\$1::bigint\[\]\)/i.test(norm) && /s\.oklab_l/i.test(norm)) {
    return { rows: state.colorDistances, rowCount: state.colorDistances.length };
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

// OCR and label parsing answer from these, replaced per test (default: no OCR result).
let ocrImpl = async () => null;
let parseLabelImpl = async () => null;
registerMock("../lib/ocr", { extractTextFromImage: (...args) => ocrImpl(...args) });
registerMock("../lib/ocr-parser", { parseLabelText: (...args) => parseLabelImpl(...args) });
const BLOB_ACCOUNT = "https://acct.blob.core.windows.net";
const blobStorageMock = {
  checkStorageImageUrl: () => "not allowed",
  stripImageMetadata: async (bytes) => bytes,
  validateImageUpload: (contentType) => String(contentType || "").split(";")[0].trim().toLowerCase(),
  userMediaContainer: () => "nail-photos",
  isUserMediaStorageUrl: (url) => String(url).startsWith(`${BLOB_ACCOUNT}/nail-photos/`),
  storageUrlBlobName: (url) => String(url).replace(`${BLOB_ACCOUNT}/nail-photos/`, ""),
  uploadBytesToBlob: async (params) => {
    blobUploads.push(params);
    return `${BLOB_ACCOUNT}/${params.containerName}/${params.blobName}`;
  },
  deleteBlobFromStorageUrl: async (storageUrl, options) => {
    blobDeletes.push({ storageUrl, options });
    return true;
  },
};
registerMock("../lib/blob-storage", blobStorageMock);
registerMock("./blob-storage", blobStorageMock);

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
  const { captureId = CAPTURE_UUID, headers, body = {} } = opts;
  const route = registeredRoutes[routeName];
  assert.ok(route, `route ${routeName} should be registered`);
  const action = routeName.replace(/^capture-/, "");
  const req = fakeRequest({
    url: `http://localhost:7071/api/capture/${captureId}/${action}`,
    headers: { ...(userId !== undefined ? { authorization: `Bearer dev:${userId}` } : {}), ...(headers || {}) },
    params: { captureId },
    body,
  });
  return route.handler(req, fakeContext());
}

const check = (opts) => invoke("capture-check", opts);
const finalize = (opts) => invoke("capture-finalize", opts);
const addFrame = (body, opts = {}) => invoke("capture-frame", { ...opts, body });

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
  ocrImpl = async () => null;
  parseLabelImpl = async () => null;
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

// ═══════════════════════════════════════════════════════════════════════════
// Frame retention (Bottle Flow slice A): private blobs while a session is open
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/capture — frame retention", () => {
  const DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD";
  const frameBody = { frameType: "other", imageBlobUrl: DATA_URL };
  const insertedAsset = () => handlerCalls().filter((c) => /INSERT\s+INTO\s+image_asset/i.test(c.sql));

  beforeEach(() => {
    process.env.AZURE_STORAGE_CONNECTION = "UseDevelopmentStorage=true";
  });
  afterEach(() => {
    delete process.env.BOTTLE_CAPTURE_ENABLED;
    delete process.env.AZURE_STORAGE_CONNECTION;
  });

  it("flag on: a data-URL frame is stored as a private blob and the row points at it", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    const res = await addFrame(frameBody);
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(blobUploads.length, 1);
    assert.equal(blobUploads[0].containerName, "nail-photos");
    assert.match(blobUploads[0].blobName, new RegExp(`^${OWNER}/capture/${CAPTURE_UUID}/[0-9a-f]{64}-[0-9a-f-]{36}\\.jpg$`));
    assert.equal(blobUploads[0].contentType, "image/jpeg");
    assert.ok(Buffer.isBuffer(blobUploads[0].bytes));
    const inserts = insertedAsset();
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].params[0], OWNER);
    assert.equal(inserts[0].params[1], `${BLOB_ACCOUNT}/nail-photos/${blobUploads[0].blobName}`);
    assert.equal(blobDeletes.length, 0);
    assert.ok(!JSON.stringify(res.jsonBody).includes("nail-photos"), "the blob URL never reaches the response");
  });

  it("flag off: inline placeholder exactly as before and no upload", async () => {
    const res = await addFrame(frameBody);
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(blobUploads.length, 0);
    const inserts = insertedAsset();
    assert.equal(inserts.length, 1);
    assert.match(inserts[0].params[1], new RegExp(`^inline://capture/${CAPTURE_UUID}/[0-9a-f]{64}\\.jpg$`));
  });

  it("flag on but storage unconfigured: inline placeholder, no upload", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    delete process.env.AZURE_STORAGE_CONNECTION;
    const res = await addFrame(frameBody);
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(blobUploads.length, 0);
    assert.match(insertedAsset()[0].params[1], /^inline:\/\/capture\//);
  });

  it("a frame transaction that fails afterwards deletes the just-uploaded blob and returns 500", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    state.failFrameInsert = true;
    const res = await addFrame(frameBody);
    assert.equal(res.status, 500);
    assert.equal(blobUploads.length, 1);
    assert.equal(blobDeletes.length, 1);
    assert.equal(blobDeletes[0].storageUrl, `${BLOB_ACCOUNT}/nail-photos/${blobUploads[0].blobName}`);
    assert.deepEqual(blobDeletes[0].options, { allowedContainers: ["nail-photos"] });
  });

  it("a retried frame with identical bytes whose transaction fails deletes only its own blob", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    assert.equal((await addFrame(frameBody)).status, 201);
    const committed = state.assets[0].storageUrl;
    state.failFrameInsert = true;
    const res = await addFrame(frameBody);
    state.failFrameInsert = false;
    assert.equal(res.status, 500);
    assert.equal(blobUploads.length, 2);
    assert.notEqual(blobUploads[0].blobName, blobUploads[1].blobName, "identical bytes, separate blobs");
    assert.deepEqual(blobDeletes.map((d) => d.storageUrl), [`${BLOB_ACCOUNT}/nail-photos/${blobUploads[1].blobName}`]);
    assert.ok(!blobDeletes.some((d) => d.storageUrl === committed), "the first row's blob is untouched");
  });

  it("flag on: a frame added to a matched or unmatched session keeps the inline placeholder (no blob)", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    for (const status of ["matched", "unmatched"]) {
      sqlCalls = [];
      blobUploads = [];
      state.sessions.get(CAPTURE_UUID).status = status;
      const res = await addFrame(frameBody);
      assert.equal(res.status, 201, `${status}: ${JSON.stringify(res.jsonBody)}`);
      assert.equal(blobUploads.length, 0, status);
      assert.match(insertedAsset()[0].params[1], new RegExp(`^inline://capture/${CAPTURE_UUID}/[0-9a-f]{64}\\.jpg$`));
    }
  });

  it("finalize → matched releases each blob frame and resets its row to the placeholder", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    assert.equal((await addFrame(frameBody)).status, 201);
    assert.equal((await addFrame({ ...frameBody, imageBlobUrl: `${DATA_URL}AAAA` })).status, 201);
    const stored = state.assets.map((a) => a.storageUrl);
    assert.equal(stored.length, 2);

    const res = await finalize();
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "matched");
    assert.deepEqual(blobDeletes.map((d) => d.storageUrl).sort(), [...stored].sort());
    const resets = handlerCalls().filter((c) => /UPDATE\s+image_asset\s+SET\s+storage_url/i.test(c.sql));
    assert.equal(resets.length, 2);
    assert.ok(resets.every((c) => c.params[2] === OWNER && /^inline:\/\/capture\//.test(c.params[1])));
    assert.ok(state.assets.every((a) => a.storageUrl.startsWith("inline://capture/")));
  });

  it("finalize with the flag off still looks for blobs (none) and deletes nothing", async () => {
    assert.equal((await addFrame(frameBody)).status, 201);
    const res = await finalize();
    assert.equal(res.status, 200);
    assert.equal(blobDeletes.length, 0);
    assert.equal(handlerCalls().filter((c) => /UPDATE\s+image_asset/i.test(c.sql)).length, 0);
  });

  it("a release failure never fails finalize", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    assert.equal((await addFrame(frameBody)).status, 201);
    const original = blobStorageMock.deleteBlobFromStorageUrl;
    blobStorageMock.deleteBlobFromStorageUrl = async () => {
      throw new Error("storage down");
    };
    try {
      const res = await finalize();
      assert.equal(res.status, 200);
      assert.equal(res.jsonBody.status, "matched");
      assert.ok(state.assets.every((a) => !a.storageUrl.startsWith("inline://")), "row kept for the sweep");
    } finally {
      blobStorageMock.deleteBlobFromStorageUrl = original;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Glass color evidence (Bottle Flow slice A): the lacquer hex measured from a color frame
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/capture — glass color frames", () => {
  const sharp = require("sharp");
  const aiColorDetection = require("../dist/lib/ai-color-detection");
  const realRequest = aiColorDetection.requestAzureOpenAIChatCompletion;
  const AI_ENV = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_KEY", "AZURE_OPENAI_DEPLOYMENT_HEX"];
  let dataUrl;
  let chatCalls;
  let chatContent;

  const insertedFrame = () => {
    const inserts = handlerCalls().filter((c) => /INSERT\s+INTO\s+capture_frame/i.test(c.sql));
    assert.equal(inserts.length, 1);
    return inserts[0].params[3];
  };

  before(async () => {
    // Half skin, half magenta: the deterministic fallback must pick the magenta.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<rect width="32" height="64" fill="#F0C8A0"/><rect x="32" width="32" height="64" fill="#B4004E"/></svg>';
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  });

  beforeEach(() => {
    chatCalls = 0;
    chatContent = null;
    aiColorDetection.requestAzureOpenAIChatCompletion = async () => {
      chatCalls += 1;
      return chatContent === null
        ? { provider: "none", content: null, usage: null, deployment: null, reason: "missing_config" }
        : { provider: "azure-openai", content: chatContent, usage: null, deployment: "d" };
    };
  });
  afterEach(() => {
    aiColorDetection.requestAzureOpenAIChatCompletion = realRequest;
    delete process.env.BOTTLE_CAPTURE_ENABLED;
    for (const key of AI_ENV) delete process.env[key];
  });

  it("flag on: stores glass evidence with a 7-char uppercase hex and the audit", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    const res = await addFrame({ frameType: "color", imageBlobUrl: dataUrl });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const quality = insertedFrame();
    assert.equal(quality.extracted.source, "glass");
    assert.match(quality.extracted.hex, /^#[0-9A-F]{6}$/);
    assert.equal(quality.extracted.hexMethod, "palette-top");
    assert.equal(quality.extracted.hexConfidence, 0.3);
    assert.equal(quality.extracted.hexPromptVersion, "glass-palette-pick/2026-10-v1");
    assert.equal(quality.ai.glass.modelCalls, 0);
    assert.ok(quality.ai.glass.candidates.length >= 2);
    assert.ok(typeof quality.ai.processedAt === "string");
    assert.equal(chatCalls, 0, "an unconfigured model is never called");
  });

  it("flag on with the model configured: the model's chip becomes the hex", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    process.env.AZURE_OPENAI_ENDPOINT = "https://unit.openai.azure.com/";
    process.env.AZURE_OPENAI_KEY = "unit-test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "gpt-vision";
    chatContent = '{"choice":"A","confidence":0.8}';
    const res = await addFrame({ frameType: "color", imageBlobUrl: dataUrl });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const quality = insertedFrame();
    assert.equal(chatCalls, 1);
    assert.equal(quality.extracted.source, "glass");
    assert.equal(quality.extracted.hexMethod, "palette-pick-bottle");
    assert.equal(quality.extracted.hexConfidence, 0.8);
    assert.equal(quality.extracted.hex, quality.ai.glass.candidates.find((c) => c.label === "A").hex);
  });

  it("flag off: no extracted evidence and no model call, exactly as before", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://unit.openai.azure.com/";
    process.env.AZURE_OPENAI_KEY = "unit-test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "gpt-vision";
    chatContent = '{"choice":"A","confidence":0.8}';
    const res = await addFrame({ frameType: "color", imageBlobUrl: dataUrl });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const quality = insertedFrame();
    assert.equal(quality.extracted, undefined);
    assert.equal(quality.ai, undefined);
    assert.equal(chatCalls, 0);
  });

  it("a client-supplied glass source is never trusted", async () => {
    const res = await addFrame({
      frameType: "color",
      imageBlobUrl: dataUrl,
      quality: { extracted: { hex: "#112233", source: "glass", brand: "OPI" } },
    });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const quality = insertedFrame();
    assert.notEqual(quality.extracted.source, "glass");
    assert.equal(quality.extracted.brand, "OPI");
  });

  it("flag on: an image that yields no chips records the reason and no hex", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#B4004E" } }).png().toBuffer();
    const res = await addFrame({ frameType: "color", imageBlobUrl: `data:image/png;base64,${tiny.toString("base64")}` });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const quality = insertedFrame();
    assert.equal(quality.ai.glass.reason, "no_candidates");
    assert.equal(quality.extracted, undefined);
  });

  it("flag on: a non-color frame is not measured", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    const res = await addFrame({ frameType: "other", imageBlobUrl: dataUrl });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(insertedFrame().extracted, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Brand hint at session start (Bottle Flow slice A)
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/capture — start with a brand hint", () => {
  const start = (body) => {
    const route = registeredRoutes["capture-start"];
    assert.ok(route, "capture-start should be registered");
    return route.handler(
      fakeRequest({
        url: "http://localhost:7071/api/capture/start",
        headers: { authorization: `Bearer dev:${OWNER}` },
        body,
      }),
      fakeContext()
    );
  };
  const brandQueries = () => handlerCalls().filter((c) => /FROM brand b/i.test(c.sql));
  const sessionInsert = () => handlerCalls().find((c) => /INSERT INTO capture_session/i.test(c.sql));

  afterEach(() => {
    delete process.env.BOTTLE_CAPTURE_ENABLED;
  });

  it("flag on: a short typed hint is resolved in hint mode, echoed with the canonical name and stored as the session brand", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    // Realistic scores for "loud" vs "Loud Lacquer": similarity() = 5/12 ≈ 0.42 (below the 0.6
    // bar, so the read mode would miss it); word_similarity() = 1.0 and the name starts with it,
    // which is why the start handler resolves typed hints with RESOLVE_BRAND_HINT_SQL.
    state.brandRow = { brandId: "3", name: "Loud Lacquer", score: 1 };
    const res = await start({ metadata: { brand: "loud" } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(brandQueries().length, 1);
    assert.match(brandQueries()[0].sql, /word_similarity\(\$1::text, b\.name_canonical\)/);
    assert.match(brandQueries()[0].sql, /starts_with\(lower\(b\.name_canonical\), lower\(\$1::text\)\)/);
    assert.deepEqual(brandQueries()[0].params, ["loud"]);
    assert.deepEqual(res.jsonBody.brandHint, { raw: "loud", brandId: "3", name: "Loud Lacquer" });
    assert.equal(res.jsonBody.nextFrame.surface, "bottom", "a known brand goes straight to the sticker");
    const metadata = sessionInsert().params[2];
    assert.equal(metadata.brand, "loud", "the raw hint stays for the legacy resolver");
    assert.deepEqual(metadata.bottle, {
      brand: { brandId: "3", name: "Loud Lacquer", source: "hint", raw: "loud" },
      prompts: { "bottom:need_name": 1 },
      skipped: [],
      lastRejected: null,
      lastNextFrame: res.jsonBody.nextFrame,
    });
  });

  it("flag on: a hint with no catalog brand echoes the raw text", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    state.brandRow = null;
    const res = await start({ metadata: { brand: "loud" } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.deepEqual(res.jsonBody.brandHint, { raw: "loud", brandId: null, name: "loud" });
    assert.deepEqual(sessionInsert().params[2].bottle.brand, { brandId: null, name: "loud", source: "hint", raw: "loud" });
  });

  it("flag on: no hint means no brand query and no brandHint", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    const res = await start({ metadata: {} });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal("brandHint" in res.jsonBody, false);
    assert.equal(brandQueries().length, 0);
    assert.equal(res.jsonBody.nextFrame.surface, "front");
    assert.equal(sessionInsert().params[2].bottle.brand, undefined);
  });

  it("flag on: a blank or non-string hint is ignored", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    for (const brand of ["   ", 5, null]) {
      sqlCalls = [];
      const res = await start({ metadata: { brand } });
      assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
      assert.equal("brandHint" in res.jsonBody, false);
      assert.equal(brandQueries().length, 0);
    }
  });

  it("flag on: a client-sent metadata.bottle is dropped", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    const res = await start({ metadata: { bottle: { skipped: ["back"] } } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(sessionInsert().params[2].bottle.skipped.length, 0, "the client's skipped list is dropped");
  });

  it("flag on: a below-threshold brand row is no match and the capture still starts", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    state.brandRow = { brandId: "x", name: "Loud Lacquer", score: 0.1 };
    const res = await start({ metadata: { brand: "loud" } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.deepEqual(res.jsonBody.brandHint, { raw: "loud", brandId: null, name: "loud" });
  });

  it("flag off: a client-sent metadata.bottle is not stored either", async () => {
    const res = await start({ metadata: { brand: "loud", bottle: { brand: { brandId: "9", name: "Forged", source: "hint" }, skipped: ["front"] } } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const metadata = sessionInsert().params[2];
    assert.equal(metadata.bottle, undefined);
    assert.equal(metadata.brand, "loud");
  });

  it("flag off: today's start (no brandHint key, no nextFrame key, no brand query, no bottle metadata)", async () => {
    state.brandRow = { brandId: "3", name: "Loud Lacquer", score: 0.8 };
    const res = await start({ metadata: { brand: "loud" } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal("brandHint" in res.jsonBody, false);
    assert.equal("nextFrame" in res.jsonBody, false);
    assert.equal(brandQueries().length, 0);
    assert.equal(sessionInsert().params[2].bottle, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Vision read of the bottom sticker (Bottle Flow slice A)
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/capture — sticker vision read", () => {
  const sharp = require("sharp");
  const aiColorDetection = require("../dist/lib/ai-color-detection");
  const realRequest = aiColorDetection.requestAzureOpenAIChatCompletion;
  const AI_ENV = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_KEY", "AZURE_OPENAI_DEPLOYMENT_LABEL"];
  const UNICORN_JSON =
    '{"printedName":"unicorn skin","closestListed":"Unicorn Skin","brand":"Holo Taco","finish":"Holo","confidence":0.82}';
  let dataUrl;
  let chatRequests;
  let chatContent;

  const insertedFrame = () => {
    const inserts = handlerCalls().filter((c) => /INSERT\s+INTO\s+capture_frame/i.test(c.sql));
    assert.equal(inserts.length, 1);
    return inserts[0].params[3];
  };
  const shadeNameQueries = () => handlerCalls().filter((c) => /shade_name_canonical AS name/i.test(c.sql));
  const confidentOcr = (confidence = 0.9) => {
    ocrImpl = async () => ({ rawText: "HOLO TACO\nUNICORN SKIN", lines: [], barcodes: [], confidence, provider: "unit" });
    parseLabelImpl = async () => ({
      brand: "Holo Taco", shadeName: "Unicorn Skn", finish: null, collection: null, gtin: null, sizeMl: null,
      confidence, rawFields: {},
    });
  };
  const useHint = (brandId = "3") => {
    state.sessions.get(CAPTURE_UUID).metadata = {
      bottle: { brand: { brandId, name: "Holo Taco", source: "hint", raw: "holo taco" }, prompts: {}, skipped: [] },
    };
    state.frames = [];
  };

  before(async () => {
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#B4004E" } }).png().toBuffer();
    dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  });

  beforeEach(() => {
    chatRequests = [];
    chatContent = UNICORN_JSON;
    process.env.AZURE_OPENAI_ENDPOINT = "https://unit.openai.azure.com/";
    process.env.AZURE_OPENAI_KEY = "unit-test-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_LABEL = "gpt-label";
    aiColorDetection.requestAzureOpenAIChatCompletion = async (request) => {
      chatRequests.push(request);
      return chatContent === null
        ? { provider: "none", content: null, usage: null, deployment: null, reason: "missing_config" }
        : { provider: "azure-openai", content: chatContent, usage: null, deployment: "d" };
    };
  });
  afterEach(() => {
    aiColorDetection.requestAzureOpenAIChatCompletion = realRequest;
    delete process.env.BOTTLE_CAPTURE_ENABLED;
    for (const key of AI_ENV) delete process.env[key];
  });

  it("flag on, hinted brand: a closed-set read adds the listed shade name and the audit", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    useHint();
    state.brandShadeNames = ["Unicorn Skin", "Linear Holo"];
    confidentOcr(0.9);
    // The fake DB has no finish aliases, so the finish is answered under its canonical name.
    chatContent = UNICORN_JSON.replace('"Holo"', '"holographic"');
    const res = await addFrame({ frameType: "label", imageBlobUrl: dataUrl, quality: { surface: "bottom" } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const quality = insertedFrame();
    assert.equal(quality.extracted.shadeNameListed, "Unicorn Skin");
    assert.equal(quality.extracted.shadeName, "Unicorn Skn", "the more confident OCR field keeps its place");
    assert.equal(quality.extracted.finish, "holographic", "a field OCR did not read comes from vision");
    assert.equal(quality.extracted.source, "vision");
    assert.deepEqual(
      { ...quality.ai.sticker },
      { promptVersion: "sticker-read/2026-10-v1", closedSet: true, listedCount: 2, confidence: 0.82, modelCalls: 1 }
    );
    assert.equal(chatRequests.length, 1);
    assert.deepEqual(shadeNameQueries().map((c) => c.params), [[3, OWNER]]);
    const userMessage = JSON.stringify(chatRequests[0].buildPayload(false));
    assert.match(userMessage, /Unicorn Skin/);
    assert.match(userMessage, /bottom of the bottle/);
  });

  it("flag on, brand read from an earlier frame: it is resolved against the catalog first", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    state.sessions.get(CAPTURE_UUID).metadata = {};
    state.frames = [{ frameType: "label", quality: { extracted: { brand: "Holo Taco", brandConfidence: 0.9 } } }];
    state.brandRow = { brandId: "3", name: "Holo Taco", score: 0.9 };
    state.brandShadeNames = ["Unicorn Skin"];
    confidentOcr(0.9);
    const res = await addFrame({ frameType: "label", imageBlobUrl: dataUrl });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const quality = insertedFrame();
    assert.equal(quality.ai.sticker.closedSet, true);
    assert.equal(quality.extracted.shadeNameListed, "Unicorn Skin");
  });

  it("flag on, brand unknown and OCR usable: no vision read, the audit says so", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    state.sessions.get(CAPTURE_UUID).metadata = {};
    state.frames = [];
    confidentOcr(0.9);
    const res = await addFrame({ frameType: "label", imageBlobUrl: dataUrl });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const quality = insertedFrame();
    assert.equal(chatRequests.length, 0);
    assert.equal(quality.ai.sticker.modelCalls, 0);
    assert.equal(quality.ai.sticker.confidence, null);
    assert.equal(quality.extracted.shadeName, "Unicorn Skn");
    assert.equal(quality.extracted.shadeNameListed, undefined);
  });

  it("flag on, brand unknown and no OCR result: an open read still runs", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    state.sessions.get(CAPTURE_UUID).metadata = {};
    state.frames = [];
    chatContent = '{"printedName":"Unicorn Skin","closestListed":"Unicorn Skin","brand":"Holo Taco","confidence":0.7}';
    const res = await addFrame({ frameType: "label", imageBlobUrl: dataUrl });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const quality = insertedFrame();
    assert.equal(chatRequests.length, 1);
    assert.equal(shadeNameQueries().length, 0, "no brand, no list");
    assert.equal(quality.ai.sticker.closedSet, false);
    assert.equal(quality.ai.sticker.listedCount, 0);
    assert.equal(quality.extracted.shadeNameListed, undefined, "an open read never claims a listed name");
    assert.equal(quality.extracted.shadeName, "Unicorn Skin");
    assert.equal(quality.extracted.brand, "Holo Taco");
    assert.equal(quality.extracted.source, "vision");
  });

  it("flag on, the model fails: the frame keeps its OCR evidence and records no call result", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    useHint();
    state.brandShadeNames = ["Unicorn Skin"];
    confidentOcr(0.9);
    aiColorDetection.requestAzureOpenAIChatCompletion = async () => {
      throw new Error("model down");
    };
    const res = await addFrame({ frameType: "label", imageBlobUrl: dataUrl });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const quality = insertedFrame();
    assert.equal(quality.extracted.shadeName, "Unicorn Skn");
    assert.equal(quality.extracted.source, undefined);
    assert.equal(quality.ai.sticker.modelCalls, 1, "the call was sent");
    assert.equal(quality.ai.sticker.confidence, null);
  });

  it("flag on, a failing shade-name list falls back to an open read", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    useHint();
    const originalQuery = dbMock.query;
    dbMock.query = async (sql, params) => {
      if (/shade_name_canonical AS name/i.test(String(sql))) throw new Error("db down");
      return originalQuery(sql, params);
    };
    try {
      const res = await addFrame({ frameType: "label", imageBlobUrl: dataUrl });
      assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    } finally {
      dbMock.query = originalQuery;
    }
    assert.equal(insertedFrame().ai.sticker.closedSet, false);
  });

  it("flag on, a barcode frame is never vision-read", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    useHint();
    state.brandShadeNames = ["Unicorn Skin"];
    confidentOcr(0.9);
    const res = await addFrame({ frameType: "barcode", imageBlobUrl: dataUrl });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(chatRequests.length, 0);
    assert.equal(insertedFrame().ai?.sticker, undefined);
  });

  it("flag on, a remote-URL frame skips the vision read", async () => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
    useHint();
    state.brandShadeNames = ["Unicorn Skin"];
    confidentOcr(0.9);
    const originalCheck = blobStorageMock.checkStorageImageUrl;
    blobStorageMock.checkStorageImageUrl = () => null;
    try {
      const res = await addFrame({ frameType: "label", imageBlobUrl: `${BLOB_ACCOUNT}/source-images/sticker.jpg` });
      assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    } finally {
      blobStorageMock.checkStorageImageUrl = originalCheck;
    }
    assert.equal(chatRequests.length, 0);
    const quality = insertedFrame();
    assert.equal(quality.ai.sticker, undefined);
    assert.equal(quality.extracted.shadeName, "Unicorn Skn");
  });

  it("flag off: today's OCR-only path (no chat call, no shade list, no ai.sticker)", async () => {
    useHint();
    state.brandShadeNames = ["Unicorn Skin"];
    confidentOcr(0.9);
    const res = await addFrame({ frameType: "label", imageBlobUrl: dataUrl, quality: { surface: "bottom" } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    const quality = insertedFrame();
    assert.equal(chatRequests.length, 0);
    assert.equal(shadeNameQueries().length, 0);
    assert.equal(quality.ai.sticker, undefined);
    assert.deepEqual(quality.extracted, { brand: "Holo Taco", shadeName: "Unicorn Skn" });
  });

  it("flag off and no OCR result: nothing extracted, exactly as before", async () => {
    const res = await addFrame({ frameType: "label", imageBlobUrl: dataUrl });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(chatRequests.length, 0);
    assert.equal(insertedFrame().ai, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Brand-first bottle resolver (Bottle Flow slice A): check / finalize wiring
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/capture — brand-first resolver", () => {
  const telemetry = require("../dist/lib/telemetry");
  const realTrackEvent = telemetry.trackEvent;
  let events;

  const LOUD_HINT = { brandId: "3", name: "Loud Lacquer", source: "hint", raw: "loud" };
  const poolRow = (shadeId, shadeName, over = {}) => ({
    shadeId: String(shadeId),
    brandId: "3",
    brand: "Loud Lacquer",
    shadeName,
    nameScore: null,
    colorDistance: null,
    ...over,
  });
  const useBottleSession = (frames, brand = LOUD_HINT) => {
    state.sessions.get(CAPTURE_UUID).metadata = brand ? { bottle: { brand, prompts: {}, skipped: [] } } : {};
    state.frames = frames;
  };
  const labelFrame = (extracted, ai) => ({ frameType: "label", quality: { extracted, ...(ai ? { ai } : {}) } });
  const glassFrame = (hex = "#B4004E") => ({
    frameType: "color",
    quality: { extracted: { hex, hexConfidence: 0.9, source: "glass" }, ai: { glass: { modelCalls: 1 } } },
  });
  const resolvedEvents = () => events.filter((e) => e.name === "capture.resolved");
  const poolQueries = () => handlerCalls().filter((c) => /s\.brand_id = ANY/i.test(c.sql));

  beforeEach(() => {
    events = [];
    telemetry.trackEvent = (name, properties) => events.push({ name, properties });
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
  });
  afterEach(() => {
    telemetry.trackEvent = realTrackEvent;
    delete process.env.BOTTLE_CAPTURE_ENABLED;
  });

  it("flag on: a confident name in the hinted brand matches; no create card, no conflict", async () => {
    useBottleSession([labelFrame({ shadeName: "Big Apple Red" })]);
    state.bottleCandidates = [poolRow(SHADE_ID, "Big Apple Red", { nameScore: 0.97 })];
    const res = await check();
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.outcome, "matched");
    assert.equal(res.jsonBody.match.shadeId, String(SHADE_ID));
    assert.equal(res.jsonBody.match.brandId, "3");
    assert.equal("suggestedShade" in res.jsonBody, false);
    assert.equal("brandConflict" in res.jsonBody, false);
    assert.deepEqual(poolQueries().map((c) => [c.params[0], c.params[1], c.params[2]]), [[[3], OWNER, "Big Apple Red"]]);
    assertNoWrites();
  });

  it("flag on: no plausible shade in the brand gives the create card with the glass color", async () => {
    useBottleSession([labelFrame({ shadeName: "Moonlit", finish: "creme" }), glassFrame()]);
    state.bottleCandidates = [poolRow(11, "Other Shade", { nameScore: 0.2, colorDistance: 0.4 })];
    const res = await check();
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.outcome, "unmatched");
    assert.deepEqual(res.jsonBody.suggestedShade, {
      brandId: "3", brandName: "Loud Lacquer", brandSource: "hint", shadeName: "Moonlit", hex: "#B4004E", finish: "creme", gtin: null,
    });
    assert.deepEqual(res.jsonBody.candidates, [], "a create card sends no candidates, so the card shows");
    assertNoWrites();
  });

  it("flag on: candidates carry brandId and colorDistance when a glass hex exists", async () => {
    useBottleSession([labelFrame({ shadeName: "Big Appl" }), glassFrame()]);
    state.bottleCandidates = [poolRow(SHADE_ID, "Big Apple Red", { nameScore: 0.8, colorDistance: 0.08 })];
    const res = await check();
    assert.equal(res.jsonBody.outcome, "needs_question");
    assert.equal(res.jsonBody.questionKey, "candidate_select");
    assert.equal(res.jsonBody.candidates[0].brandId, "3");
    assert.equal(res.jsonBody.candidates[0].colorDistance, 0.08);
    assert.ok(res.jsonBody.suggestedShade, "None of these can show the card");
    const [, , , L, a, b] = poolQueries()[0].params;
    assert.ok([L, a, b].every((v) => typeof v === "number"));
  });

  it("flag on: a confident read of another brand is reported as a conflict and pools both brands", async () => {
    useBottleSession([
      labelFrame({ brand: "Holo Taco", brandConfidence: 0.85, shadeName: "Unicorn Skin" }),
    ]);
    state.brandRow = { brandId: "7", name: "Holo Taco", score: 0.9 };
    state.bottleCandidates = [poolRow(11, "Unicorn Skin", { nameScore: 0.7 })];
    const res = await check();
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.deepEqual(res.jsonBody.brandConflict, {
      hinted: { brandId: "3", name: "Loud Lacquer", source: "hint" },
      read: { brandId: "7", name: "Holo Taco", source: "read", confidence: 0.85 },
    });
    assert.deepEqual(poolQueries()[0].params[0], [3, 7]);
  });

  it("flag on, no brand at all: the trigram candidates are re-ranked by color distance", async () => {
    useBottleSession([labelFrame({ shadeName: "Big Apple Red" }), glassFrame()], null);
    state.shadeCandidates = [
      { shadeId: "21", brand: "OPI", shadeName: "Big Apple Red", score: 0.8 },
      { shadeId: "22", brand: "Essie", shadeName: "Big Apple Red", score: 0.8 },
    ];
    state.colorDistances = [{ shadeId: "21", distance: 0.09 }, { shadeId: "22", distance: 0.02 }];
    const res = await check();
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.outcome, "matched");
    assert.equal(res.jsonBody.match.shadeId, "22");
    assert.equal(res.jsonBody.match.colorDistance, 0.02);
    assert.equal("brandId" in res.jsonBody.match, false, "the global path does not know the brand id");
    assert.equal(poolQueries().length, 0);
  });

  it("flag off: no suggestedShade, brandConflict, brandId or colorDistance, and no pool query", async () => {
    delete process.env.BOTTLE_CAPTURE_ENABLED;
    useBottleSession([labelFrame({ shadeName: "Moonlit" }), glassFrame()]);
    state.shadeCandidates = [];
    const res = await check();
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.outcome, "needs_question");
    assert.equal("suggestedShade" in res.jsonBody, false);
    assert.equal("brandConflict" in res.jsonBody, false);
    assert.equal(poolQueries().length, 0);
    state.shadeCandidates = [{ shadeId: String(SHADE_ID), brand: "OPI", shadeName: "Big Apple Red", score: 0.95 }];
    const matched = await check();
    assert.deepEqual(Object.keys(matched.jsonBody.candidates[0]).sort(), ["confidence", "display", "entityId", "entityType", "ownership", "shadeId"]);
  });

  it("check emits capture.resolved with the method, brand lock, candidate count, model calls and frames", async () => {
    useBottleSession([
      labelFrame({ shadeName: "Big Apple Red" }, { sticker: { modelCalls: 1, confidence: 0.8 } }),
      glassFrame(),
    ]);
    state.bottleCandidates = [poolRow(SHADE_ID, "Big Apple Red", { nameScore: 0.97, colorDistance: 0.02 })];
    assert.equal((await check()).status, 200);
    assert.deepEqual(resolvedEvents().map((e) => e.properties), [
      { captureId: CAPTURE_UUID, method: "name", brandLocked: true, candidateCount: 1, modelCalls: 2, frames: 2 },
    ]);
  });

  it("check emits method barcode for a barcode hit, create_card and unmatched otherwise", async () => {
    state.sessions.get(CAPTURE_UUID).metadata = { gtin: GTIN };
    assert.equal((await check()).jsonBody.outcome, "matched");
    useBottleSession([labelFrame({ shadeName: "Moonlit" })]);
    state.bottleCandidates = [];
    await check();
    useBottleSession([labelFrame({ brand: "Nope", brandConfidence: 0.7, shadeName: "Moonlit" })], null);
    state.brandRow = null;
    state.shadeCandidates = [];
    await check();
    assert.deepEqual(resolvedEvents().map((e) => [e.properties.method, e.properties.brandLocked]), [
      ["barcode", false],
      ["create_card", true],
      ["unmatched", false],
    ]);
  });

  it("finalize emits capture.resolved and a create card finalizes unmatched with the audit", async () => {
    useBottleSession([labelFrame({ shadeName: "Moonlit" }), glassFrame()]);
    state.bottleCandidates = [];
    const res = await finalize();
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.status, "unmatched");
    assert.deepEqual(resolvedEvents().map((e) => e.properties), [
      { captureId: CAPTURE_UUID, method: "create_card", brandLocked: true, candidateCount: 0, modelCalls: 1, frames: 2 },
    ]);
    const update = handlerCalls().find((c) => /SET status = 'unmatched'/i.test(c.sql));
    assert.ok(update, "finalize stores the unmatched session");
    const resolver = update.params[2].resolver;
    assert.equal(resolver.step, "create_card");
    assert.equal(resolver.version, "bottle-v1");
    assert.equal(resolver.suggestedShade.shadeName, "Moonlit");
    assert.equal(resolver.modelCalls, 1);
  });

  it("flag off: finalize still emits capture.resolved with the legacy method", async () => {
    delete process.env.BOTTLE_CAPTURE_ENABLED;
    const res = await finalize();
    assert.equal(res.status, 200);
    assert.deepEqual(resolvedEvents().map((e) => e.properties), [
      { captureId: CAPTURE_UUID, method: "name", brandLocked: false, candidateCount: 1, modelCalls: 0, frames: 1 },
    ]);
  });
});
