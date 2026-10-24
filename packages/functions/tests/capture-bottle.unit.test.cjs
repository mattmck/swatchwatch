/**
 * Bottle flow prompts at the handler level (Bottle Flow slice A, Task 9): `nextFrame` on start,
 * frame, check, status and answer, the per-surface skip, the metadata the flow keeps, and the
 * flag-off parity pin (responses identical to before, no new keys). Runs without a database,
 * with the same fake-DB / require-interception harness as capture-check.unit.test.cjs.
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
    /** Frame rows that appear in the session once a frame INSERT runs (what the posted frame yielded). */
    onInsertFrames: [],
    /** The open question returned by the capture_question lookup; null = none. */
    openQuestion: null,
    /** image_asset rows written by the frame endpoint: { imageId, ownerId, storageUrl, checksum }. */
    assets: [],
    /** When set, INSERT INTO capture_frame throws (frame transaction failure). */
    failFrameInsert: false,
    /** When set, the bottle-flow metadata UPDATE throws. */
    failBottleUpdate: false,
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
    state.frames.push(...state.onInsertFrames);
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
    const rows = state.openQuestion ? [state.openQuestion] : [];
    return { rows, rowCount: rows.length };
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
    if (state.failBottleUpdate && params[1] && params[1].bottle) throw new Error("bottle update failed");
    for (const session of state.sessions.values()) {
      if (session.id === params[0]) {
        if (/\|\| \$2::jsonb/.test(norm) && params.length === 2) {
          session.metadata = { ...(session.metadata ?? {}), ...params[1] };
        }
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


// ---------------------------------------------------------------------------
// Fixtures for the bottle flow
// ---------------------------------------------------------------------------

const telemetry = require("../dist/lib/telemetry");
const realTrackEvent = telemetry.trackEvent;
let events;

const DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD";
const LOUD_HINT = { brandId: "3", name: "Loud Lacquer", source: "hint", raw: "loud" };
const FORBIDDEN_KEYS = ["nextFrame", "brandHint", "suggestedShade", "brandConflict"];

const start = (body) =>
  registeredRoutes["capture-start"].handler(
    fakeRequest({
      url: "http://localhost:7071/api/capture/start",
      headers: { authorization: `Bearer dev:${OWNER}` },
      body,
    }),
    fakeContext()
  );
const status = (opts) => invoke("capture-status", opts);
const answer = (body, opts = {}) => invoke("capture-answer", { ...opts, body });
const frame = (body, opts = {}) => invoke("capture-frame", { ...opts, body: { imageBlobUrl: DATA_URL, ...body } });

const poolRow = (shadeId, shadeName, over = {}) => ({
  shadeId: String(shadeId),
  brandId: "3",
  brand: "Loud Lacquer",
  shadeName,
  nameScore: null,
  colorDistance: null,
  ...over,
});
const labelFrame = (extracted, quality = {}) => ({ frameType: "label", quality: { ...quality, extracted } });
const glassFrame = (hex = "#B4004E") => ({
  frameType: "color",
  quality: { surface: "glass", extracted: { hex, hexConfidence: 0.9, source: "glass" }, ai: { glass: { modelCalls: 1 } } },
});

/** A session whose typed brand resolved to Loud Lacquer (what `start` stores with a hint). */
function useHintedSession(frames = [], bottleOver = {}) {
  state.sessions.get(CAPTURE_UUID).metadata = {
    brand: "loud",
    bottle: { brand: LOUD_HINT, prompts: {}, skipped: [], ...bottleOver },
  };
  state.frames = frames;
}

const bottleUpdates = () =>
  handlerCalls().filter((c) => /UPDATE capture_session/i.test(c.sql) && c.params[1] && c.params[1].bottle);
const surfaceEvents = () => events.filter((e) => e.name === "capture.surface_captured").map((e) => e.properties);
const deepNoKeys = (value, keys) => {
  const found = [];
  const walk = (node, at) => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (keys.includes(k)) found.push(`${at}.${k}`);
      walk(v, `${at}.${k}`);
    }
  };
  walk(value, "$");
  return found;
};

beforeEach(() => {
  events = [];
  telemetry.trackEvent = (name, properties) => events.push({ name, properties });
  process.env.AZURE_STORAGE_CONNECTION = "UseDevelopmentStorage=true";
});
afterEach(() => {
  telemetry.trackEvent = realTrackEvent;
  delete process.env.BOTTLE_CAPTURE_ENABLED;
  delete process.env.AZURE_STORAGE_CONNECTION;
});

// ═══════════════════════════════════════════════════════════════════════════

describe("functions/capture — nextFrame at start", () => {
  beforeEach(() => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
  });

  it("no hint: the front is asked for, and the ask is recorded in the session metadata", async () => {
    const res = await start({ metadata: {} });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.deepEqual(res.jsonBody.nextFrame, {
      surface: "front",
      frameType: "label",
      prompt: "Show the front of the bottle",
      hint: "No front label? Show the box barcode instead",
      reason: "need_brand",
      optional: false,
    });
    const metadata = handlerCalls().find((c) => /INSERT INTO capture_session/i.test(c.sql)).params[2];
    assert.deepEqual(metadata.bottle.prompts, { "front:need_brand": 1 });
    assert.deepEqual(metadata.bottle.skipped, []);
    assert.deepEqual(metadata.bottle.lastNextFrame, res.jsonBody.nextFrame);
  });

  it("a resolved hint: the bottom is asked for first and the brand is kept", async () => {
    state.brandRow = { brandId: "3", name: "Loud Lacquer", score: 0.8 };
    const res = await start({ metadata: { brand: "loud" } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.nextFrame.surface, "bottom");
    assert.equal(res.jsonBody.nextFrame.reason, "need_name");
    assert.equal("hint" in res.jsonBody.nextFrame, false);
    const { bottle } = handlerCalls().find((c) => /INSERT INTO capture_session/i.test(c.sql)).params[2];
    assert.deepEqual(bottle.brand, { brandId: "3", name: "Loud Lacquer", source: "hint", raw: "loud" });
    assert.deepEqual(bottle.prompts, { "bottom:need_name": 1 });
  });

  it("a typed hint the catalog does not know still counts as a known brand", async () => {
    state.brandRow = null;
    const res = await start({ metadata: { brand: "loud" } });
    assert.equal(res.jsonBody.nextFrame.surface, "bottom");
  });
});

describe("functions/capture — nextFrame after a frame", () => {
  beforeEach(() => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
  });

  it("a label frame that read a name with candidates asks for the glass; counters and resolver are stored", async () => {
    useHintedSession([]);
    state.bottleCandidates = [poolRow(SHADE_ID, "Big Apple Red", { nameScore: 0.8 })];
    state.onInsertFrames = [labelFrame({ shadeName: "Big Appl" }, { surface: "bottom" })];
    const res = await frame({ frameType: "label", quality: { surface: "bottom", extracted: { shadeName: "Big Appl" } } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.deepEqual(res.jsonBody.nextFrame, {
      surface: "glass",
      frameType: "color",
      prompt: "Turn it so we see the color",
      reason: "need_color",
      optional: true,
    });
    const updates = bottleUpdates();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].params[0], SESSION_ID);
    const patch = updates[0].params[1];
    assert.equal(patch.bottle.prompts["glass:need_color"], 1);
    assert.deepEqual(patch.bottle.brand, LOUD_HINT, "the jsonb || merge must not drop the brand");
    assert.deepEqual(patch.bottle.lastNextFrame, res.jsonBody.nextFrame);
    assert.equal(patch.bottle.lastRejected, null);
    assert.equal(patch.resolver.version, "bottle-v1");
    assert.deepEqual(surfaceEvents(), [
      { captureId: CAPTURE_UUID, surface: "bottom", frameType: "label", skipped: false, extracted: true },
    ]);
  });

  it("a glass frame after that: nothing more to ask", async () => {
    useHintedSession([labelFrame({ shadeName: "Big Appl" }, { surface: "bottom" })], {
      prompts: { "glass:need_color": 1 },
    });
    state.bottleCandidates = [poolRow(SHADE_ID, "Big Apple Red", { nameScore: 0.8, colorDistance: 0.02 })];
    state.onInsertFrames = [glassFrame()];
    const res = await frame({ frameType: "color", quality: { surface: "glass" } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.nextFrame, null);
    assert.equal(bottleUpdates()[0].params[1].bottle.lastNextFrame, null);
    assert.deepEqual(surfaceEvents(), [
      { captureId: CAPTURE_UUID, surface: "glass", frameType: "color", skipped: false, extracted: true },
    ]);
  });

  it("a matched session asks for nothing", async () => {
    useHintedSession([]);
    state.bottleCandidates = [poolRow(SHADE_ID, "Big Apple Red", { nameScore: 0.97 })];
    state.onInsertFrames = [labelFrame({ shadeName: "Big Apple Red" }, { surface: "bottom" })];
    const res = await frame({ frameType: "label", quality: { surface: "bottom", extracted: { shadeName: "Big Apple Red" } } });
    assert.equal(res.jsonBody.nextFrame, null);
  });

  it("a poor frame that added nothing is retried once, with the warning's hint", async () => {
    useHintedSession([]);
    state.onInsertFrames = [{ frameType: "label", quality: { surface: "bottom", brightness: 0.05, sharpness: 0.5 } }];
    const res = await frame({ frameType: "label", quality: { surface: "bottom", brightness: 0.05, sharpness: 0.5 } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.nextFrame.reason, "retry_quality");
    assert.equal(res.jsonBody.nextFrame.surface, "bottom");
    assert.equal(res.jsonBody.nextFrame.hint, "Looks dark — move into better light");
    assert.deepEqual(bottleUpdates()[0].params[1].bottle.lastRejected, { surface: "bottom", warning: "too-dark" });
    assert.equal(bottleUpdates()[0].params[1].bottle.prompts["bottom:retry_quality"], 1);
  });

  it("a poor frame that still produced evidence is not a retry", async () => {
    useHintedSession([]);
    state.bottleCandidates = [poolRow(SHADE_ID, "Big Apple Red", { nameScore: 0.8 })];
    const quality = { surface: "bottom", brightness: 0.05, sharpness: 0.5, extracted: { shadeName: "Big Appl" } };
    state.onInsertFrames = [labelFrame({ shadeName: "Big Appl" }, { surface: "bottom", brightness: 0.05, sharpness: 0.5 })];
    const res = await frame({ frameType: "label", quality });
    assert.notEqual(res.jsonBody.nextFrame?.reason, "retry_quality");
    assert.equal(bottleUpdates()[0].params[1].bottle.lastRejected, null);
  });

  it("a frame with an unknown surface is a plain frame and counts in no surface", async () => {
    useHintedSession([]);
    state.onInsertFrames = [{ frameType: "label", quality: { surface: "cap" } }];
    const res = await frame({ frameType: "label", quality: { surface: "cap" } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.deepEqual(surfaceEvents(), []);
    const resolver = bottleUpdates()[0].params[1].resolver;
    assert.deepEqual(resolver.audit.evidence.surfaces, {});
    assert.equal(res.jsonBody.nextFrame.surface, "bottom");
  });

  it("the frame cap ends the asking", async () => {
    useHintedSession(Array.from({ length: 5 }, () => ({ frameType: "other", quality: { surface: "cap" } })));
    state.onInsertFrames = [{ frameType: "other", quality: { surface: "cap" } }];
    const res = await frame({ frameType: "other" });
    assert.equal(res.jsonBody.nextFrame, null);
  });

  it("a decoded barcode frame carries the check and nextFrame", async () => {
    const VALID_GTIN = "4006381333931";
    state.barcodes.set(VALID_GTIN, { skuId: String(SKU_ID), shadeId: String(SHADE_ID), brand: "OPI", productName: "Big Apple Red", shadeName: "Big Apple Red" });
    state.sessions.get(CAPTURE_UUID).metadata = { bottle: { prompts: {}, skipped: [] } };
    state.frames = [];
    state.onInsertFrames = [{ frameType: "barcode", quality: { gtin: VALID_GTIN, extracted: { gtin: VALID_GTIN } } }];
    const res = await frame({ frameType: "barcode", quality: { gtin: VALID_GTIN } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.check.outcome, "matched");
    assert.equal(res.jsonBody.nextFrame, null);
  });

  it("a failure while planning does not fail the saved frame", async () => {
    useHintedSession([]);
    state.onInsertFrames = [];
    state.failBottleUpdate = true;
    const res = await frame({ frameType: "label", quality: { surface: "bottom" } });
    state.failBottleUpdate = false;
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.nextFrame, null);
  });
});

describe("functions/capture — skipping a surface", () => {
  beforeEach(() => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
  });

  it("skips the bottom, re-plans and tracks the skip", async () => {
    useHintedSession([]);
    const res = await answer({ skipSurface: "bottom" });
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.captureId, CAPTURE_UUID);
    assert.equal(res.jsonBody.status, "processing");
    assert.notEqual(res.jsonBody.nextFrame?.surface, "bottom");
    const patch = bottleUpdates()[0].params[1];
    assert.deepEqual(patch.bottle.skipped, ["bottom"]);
    assert.deepEqual(patch.bottle.brand, LOUD_HINT);
    assert.deepEqual(surfaceEvents(), [
      { captureId: CAPTURE_UUID, surface: "bottom", frameType: "label", skipped: true, extracted: false },
    ]);
  });

  it("any surface may be skipped, and skipping needs no open question", async () => {
    useHintedSession([]);
    state.openQuestion = null;
    for (const surface of ["front", "glass", "box"]) {
      const res = await answer({ skipSurface: surface });
      assert.equal(res.status, 200, `${surface}: ${JSON.stringify(res.jsonBody)}`);
    }
    assert.deepEqual(state.sessions.get(CAPTURE_UUID).metadata.bottle.skipped, ["front", "glass", "box"]);
  });

  it("an unknown surface is a 400 and writes nothing", async () => {
    useHintedSession([]);
    const res = await answer({ skipSurface: "cap" });
    assert.equal(res.status, 400);
    assert.equal(bottleUpdates().length, 0);
    assert.deepEqual(surfaceEvents(), []);
  });

  it("sending both an answer and skipSurface is a 400", async () => {
    useHintedSession([]);
    const res = await answer({ answer: "skip", skipSurface: "bottom" });
    assert.equal(res.status, 400);
  });

  it("another user's capture is a 404", async () => {
    useHintedSession([]);
    const res = await answer({ skipSurface: "bottom" }, { userId: OTHER });
    assert.equal(res.status, 404);
    assert.equal(bottleUpdates().length, 0);
  });

  it("a cancelled session is a 409", async () => {
    useHintedSession([]);
    state.sessions.get(CAPTURE_UUID).status = "cancelled";
    const res = await answer({ skipSurface: "bottom" });
    assert.equal(res.status, 409);
  });

  it("answer without skipSurface still requires an answer", async () => {
    useHintedSession([]);
    const res = await answer({});
    assert.equal(res.status, 400);
    assert.equal(res.jsonBody.error, "answer is required");
  });

  it("skipping each ask in turn walks front, box, bottom, glass and then stops", async () => {
    state.sessions.get(CAPTURE_UUID).metadata = { bottle: { prompts: {}, skipped: [] } };
    state.frames = [];
    const walked = [];
    let next = "front";
    while (next) {
      const res = await answer({ skipSurface: next });
      assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
      next = res.jsonBody.nextFrame?.surface ?? null;
      walked.push(next);
    }
    assert.deepEqual(walked, ["box", "bottom", "glass", null]);
  });
});

describe("functions/capture — nextFrame on check and status", () => {
  beforeEach(() => {
    process.env.BOTTLE_CAPTURE_ENABLED = "true";
  });

  it("check re-plans from its verdict, writes nothing and records no prompt", async () => {
    useHintedSession([labelFrame({ shadeName: "Big Appl" }, { surface: "bottom" })]);
    state.bottleCandidates = [poolRow(SHADE_ID, "Big Apple Red", { nameScore: 0.8 })];
    const res = await check();
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.nextFrame.surface, "glass");
    assert.equal(res.jsonBody.nextFrame.reason, "need_color");
    assertNoWrites();
  });

  it("check on a matched session says there is nothing more to ask", async () => {
    useHintedSession([labelFrame({ shadeName: "Big Apple Red" }, { surface: "bottom" })]);
    state.bottleCandidates = [poolRow(SHADE_ID, "Big Apple Red", { nameScore: 0.97 })];
    assert.equal((await check()).jsonBody.nextFrame, null);
  });

  it("status returns the last planned spec", async () => {
    const spec = {
      surface: "glass",
      frameType: "color",
      prompt: "Turn it so we see the color",
      reason: "need_color",
      optional: true,
    };
    useHintedSession([], { lastNextFrame: spec });
    const res = await status();
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.deepEqual(res.jsonBody.nextFrame, spec);
  });

  it("status with no stored spec is null", async () => {
    useHintedSession([]);
    assert.equal((await status()).jsonBody.nextFrame, null);
  });
});

describe("functions/capture — flag off parity", () => {
  const session = () => state.sessions.get(CAPTURE_UUID);
  const roundTrip = (value) => JSON.parse(JSON.stringify(value));

  it("start, frame, check, status and answer keep today's shapes and grow no bottle keys", async () => {
    const started = await start({ metadata: { brand: "loud" } });
    assert.equal(started.status, 201, JSON.stringify(started.jsonBody));
    assert.deepEqual(roundTrip({ ...started.jsonBody, captureId: "<id>" }), {
      captureId: "<id>",
      status: "processing",
      uploadUrls: [],
      guidanceConfig: { recommendedFrameTypes: ["barcode", "label", "color"], maxFrames: 6 },
    });
    const insert = handlerCalls().find((c) => /INSERT INTO capture_session/i.test(c.sql));
    assert.equal(insert.params[2].bottle, undefined);

    const framed = await frame({ frameType: "other" });
    assert.equal(framed.status, 201, JSON.stringify(framed.jsonBody));
    assert.deepEqual(roundTrip(framed.jsonBody), {
      received: true,
      captureId: CAPTURE_UUID,
      frameId: "77",
      status: "processing",
    });
    assert.equal(bottleUpdates().length, 0, "no bottle metadata update");
    assert.equal(
      handlerCalls().filter((c) => /UPDATE capture_session/i.test(c.sql)).length,
      1,
      "only the ingest metadata update, as before"
    );

    const checked = await check();
    assert.equal(checked.status, 200, JSON.stringify(checked.jsonBody));
    const owned = {
      entityType: "shade",
      entityId: String(SHADE_ID),
      shadeId: String(SHADE_ID),
      display: "OPI — Big Apple Red",
      confidence: 0.95,
      ownership: { relationship: "notOwned" },
    };
    assert.deepEqual(roundTrip(checked.jsonBody), {
      captureId: CAPTURE_UUID,
      status: "processing",
      outcome: "matched",
      confidence: 0.95,
      match: owned,
      candidates: [owned],
    });

    const statused = await status();
    assert.equal(statused.status, 200, JSON.stringify(statused.jsonBody));
    assert.deepEqual(Object.keys(roundTrip(statused.jsonBody)).sort(), ["captureId", "metadata", "status"]);
    assert.equal("bottle" in statused.jsonBody.metadata, false);

    state.openQuestion = {
      id: "5",
      key: "brand_shade",
      prompt: "Which polish is this?",
      type: "text",
      options: null,
      status: "open",
      createdAt: "2026-10-23 00:00:00+00",
    };
    const answered = await answer({ answer: "skip" });
    assert.equal(answered.status, 200, JSON.stringify(answered.jsonBody));
    assert.deepEqual(roundTrip(answered.jsonBody), {
      captureId: CAPTURE_UUID,
      status: "processing",
      question: {
        id: "5",
        key: "brand_shade",
        prompt: "Which polish is this?",
        type: "text",
        status: "open",
        createdAt: "2026-10-23 00:00:00+00",
      },
    });

    for (const body of [started.jsonBody, framed.jsonBody, checked.jsonBody, statused.jsonBody, answered.jsonBody]) {
      assert.deepEqual(deepNoKeys(body, FORBIDDEN_KEYS), []);
    }
    assert.equal(surfaceEvents().length, 0);
    assert.equal(session().metadata.bottle, undefined);
  });

  it("answer with skipSurface alone is still 'answer is required'", async () => {
    const res = await answer({ skipSurface: "bottom" });
    assert.equal(res.status, 400);
    assert.equal(res.jsonBody.error, "answer is required");
  });

  it("answer plus skipSurface is rejected as not enabled", async () => {
    const res = await answer({ answer: "skip", skipSurface: "bottom" });
    assert.equal(res.status, 400);
    assert.equal(res.jsonBody.error, "skipSurface is not enabled");
  });

  it("a frame naming a surface is a plain frame", async () => {
    const res = await frame({ frameType: "label", quality: { surface: "bottom" } });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal("nextFrame" in res.jsonBody, false);
    assert.equal(surfaceEvents().length, 0);
  });
});
