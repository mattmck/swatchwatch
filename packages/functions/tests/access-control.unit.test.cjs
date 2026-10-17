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
 * Nail photos (#270): the owner's inventory item 7001 carries a private nail photo in the
 * `nail-photos` container; another user must get 404 on every nail-photo route and must not be
 * able to read the photo through the image proxy with their own token.
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
/** Distinctive inventory-status values (issue #261) so a leak is detectable in any response. */
const OWNER_PURCHASE_PRICE = 42.42;
const OWNER_TRIED_AT = "2026-02-03T04:05:06.000Z";
/** User-uploaded image assets: image_id -> owner. */
const OWNER_IMAGE_ID = 777;
const ATTACKER_IMAGE_ID = 888;
const IMAGE_ASSETS = new Map([
  [OWNER_IMAGE_ID, { ownerId: OWNER }],
  [ATTACKER_IMAGE_ID, { ownerId: ATTACKER }],
]);
/** Owner's inventory row (shade OWNED_SHADE_ID) and its private nail photo (#270). */
const OWNER_INVENTORY_ITEM_ID = 7001;
const OWNER_NAIL_PHOTO_IMAGE_ID = 6100;
const OWNER_NAIL_PHOTO_URL = "https://swatchwatchacct.blob.core.windows.net/nail-photos/1/7001/owner-nail.jpg";
/** Shades that exist in the shared catalog of the fake DB. */
const KNOWN_SHADES = new Set([OWNED_SHADE_ID]);

/**
 * Asserts that no absolute URL anywhere in `value` (serialized as JSON) points at Azure
 * Blob Storage. Each URL is parsed and its hostname compared exactly / by strict
 * `.blob.core.windows.net` suffix, never by substring (CodeQL
 * js/incomplete-url-substring-sanitization). Also requires at least one URL to be found,
 * so the check cannot pass vacuously.
 */
function assertNoBlobStorageUrls(value, message = "raw blob URL leaked") {
  const serialized = JSON.stringify(value);
  const hostnames = (serialized.match(/https?:\/\/[^\s"'<>\\]+/g) || []).map((u) => new URL(u).hostname);
  assert.ok(hostnames.length > 0, `expected at least one URL in: ${serialized}`);
  const blobHosts = hostnames.filter((h) => h === "blob.core.windows.net" || h.endsWith(".blob.core.windows.net"));
  assert.deepEqual(blobHosts, [], `${message}: ${serialized}`);
}

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

/** Every SQL statement issued by handlers, in order: { via, sql, params }. */
let sqlCalls = [];
let transactionCount = 0;
let state;
/** When true, app_user.user_id comes back as a string, as node-postgres returns BIGINT (int8). */
let stringUserIds = false;

function resetState() {
  stringUserIds = false;
  sqlCalls = [];
  transactionCount = 0;
  state = {
    nextInventoryId: 9000,
    nextNailImageId: 6200,
    // inventoryItemId (number) -> photo row; image_asset rows for nail photos by image id.
    nailPhotos: new Map([
      [
        OWNER_INVENTORY_ITEM_ID,
        {
          imageId: OWNER_NAIL_PHOTO_IMAGE_ID,
          contentType: "image/jpeg",
          width: 20,
          height: 40,
          sizeBytes: 1234,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    ]),
    nailAssets: new Map([[OWNER_NAIL_PHOTO_IMAGE_ID, { ownerId: OWNER, storageUrl: OWNER_NAIL_PHOTO_URL }]]),
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
          status: "destash",
          triedAt: OWNER_TRIED_AT,
          purchasePrice: OWNER_PURCHASE_PRICE,
          purchaseCurrency: "CHF",
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
    status: item ? item.status ?? "owned" : null,
    isUntried: item ? (item.status ?? "owned") === "owned" && !item.triedAt : false,
    triedAt: item ? item.triedAt ?? null : null,
    lastWornAt: null,
    wearCount: item ? 0 : null,
    purchasePrice: item ? item.purchasePrice ?? null : null,
    purchaseCurrency: item ? item.purchaseCurrency ?? null : null,
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

/** A `COLLECTION_EXPORT_SQL` row for a fake inventory item. */
function exportRow(item) {
  const base = polishRow(item.shadeId, item);
  return {
    inventoryItemId: item.inventoryItemId,
    shadeId: String(item.shadeId),
    brand: base.brand,
    name: base.name,
    color: null,
    legacyFinish: base.finish,
    finishes: [base.finish],
    collection: null,
    quantity: item.quantity,
    status: base.status,
    isUntried: base.isUntried,
    triedAt: base.triedAt,
    lastWornAt: null,
    wearCount: 0,
    purchasePrice: base.purchasePrice,
    purchaseCurrency: base.purchaseCurrency,
    purchaseDate: null,
    expirationDate: null,
    size: null,
    rating: item.rating ?? null,
    notes: item.notes ?? null,
    tags: item.tags ?? [],
    vendorHex: null,
    detectedHex: null,
    nameHex: null,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
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
    const found = USERS[Number(params[0])];
    const user = found && stringUserIds ? { ...found, user_id: String(found.user_id) } : found;
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }

  // Nail photos (#270). Ownership is decided only by the `ui.user_id = $n` predicate, so a
  // handler that forgot it would see (and could mutate) the owner's photo here.
  if (/inventory_nail_photo/i.test(text) || (/image_asset/i.test(text) && (kind === "DELETE" || /copyright_status/i.test(text)))) {
    return fakeNailPhotoQuery(text, params, kind);
  }

  if (/user_inventory_item/i.test(text)) {
    // Collection export (issue #264): keyset pages of the inventory rows the statement is
    // scoped to. An unscoped statement (no user_id predicate) sees every user's rows, so a
    // handler that dropped its predicate would leak them into the export.
    if (kind === "SELECT" && /LEFT JOIN sku k/i.test(text)) {
      const userId = boundUserId(text, params);
      const [, statusFilter, , , afterId, limit] = params;
      const rows = [...state.inventory.values()]
        .filter((item) => userId === undefined || item.userId === userId)
        .filter((item) => !statusFilter || statusFilter.includes(item.status ?? "owned"))
        .sort((a, b) => Number(a.inventoryItemId) - Number(b.inventoryItemId))
        .filter((item) => afterId === null || afterId === undefined || Number(item.inventoryItemId) > Number(afterId))
        .slice(0, Number(limit) || undefined)
        .map((item) => exportRow(item));
      return { rows, rowCount: rows.length };
    }

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
        status: null,
        triedAt: null,
        purchasePrice: null,
        purchaseCurrency: null,
      };
      const quantity = insertedValue(text, params, "quantity");
      const notes = insertedValue(text, params, "notes");
      const rating = insertedValue(text, params, "rating");
      const status = insertedValue(text, params, "status");
      const triedAt = insertedValue(text, params, "tried_at");
      const purchasePrice = insertedValue(text, params, "purchase_price");
      const purchaseCurrency = insertedValue(text, params, "purchase_currency");
      if (quantity !== undefined && quantity !== null) item.quantity = quantity;
      if (notes !== undefined && notes !== null) item.notes = notes;
      if (rating !== undefined && rating !== null) item.rating = rating;
      if (status !== undefined && status !== null) item.status = status;
      if (triedAt !== undefined && triedAt !== null) item.triedAt = triedAt;
      if (purchasePrice !== undefined && purchasePrice !== null) item.purchasePrice = purchasePrice;
      if (purchaseCurrency !== undefined && purchaseCurrency !== null) item.purchaseCurrency = purchaseCurrency;
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

/** Inventory items (all users) as an array. */
function allInventoryItems() {
  return [...state.inventory.values()];
}

function fakeNailPhotoQuery(text, params, kind) {
  const userId = boundUserId(text, params);
  const visible = (item) => userId === undefined || item.userId === userId;

  // Item + photo lookup (GET/PUT/DELETE nail-photo), optionally FOR UPDATE.
  if (kind === "SELECT" && /FROM\s+user_inventory_item\s+ui/i.test(text)) {
    const itemId = Number(boundParam(text, params, /ui\.inventory_item_id\s*=\s*\$(\d+)/i));
    const item = allInventoryItems().find((i) => Number(i.inventoryItemId) === itemId && visible(i));
    if (!item) return { rows: [], rowCount: 0 };
    const photo = state.nailPhotos.get(itemId);
    const asset = photo ? state.nailAssets.get(photo.imageId) : undefined;
    return {
      rows: [
        {
          inventoryItemId: String(itemId),
          shadeId: String(item.shadeId),
          imageId: photo ? String(photo.imageId) : null,
          storageUrl: asset ? asset.storageUrl : null,
          contentType: photo ? photo.contentType : null,
          width: photo ? photo.width : null,
          height: photo ? photo.height : null,
          sizeBytes: photo ? photo.sizeBytes : null,
          createdAt: photo ? photo.createdAt : null,
          updatedAt: photo ? photo.updatedAt : null,
        },
      ],
      rowCount: 1,
    };
  }

  // Photos for a shade (DELETE /polishes/{id} cleanup lookup).
  if (kind === "SELECT" && /FROM\s+inventory_nail_photo\s+p/i.test(text)) {
    const shadeId = Number(boundParam(text, params, /ui\.shade_id\s*=\s*\$(\d+)/i));
    const rows = allInventoryItems()
      .filter((i) => i.shadeId === shadeId && visible(i) && state.nailPhotos.has(Number(i.inventoryItemId)))
      .map((i) => ({ imageId: String(state.nailPhotos.get(Number(i.inventoryItemId)).imageId) }));
    return { rows, rowCount: rows.length };
  }

  // Cleanup delete for a shade: DELETE FROM image_asset ia USING inventory_nail_photo p, user_inventory_item ui ...
  if (kind === "DELETE" && /DELETE\s+FROM\s+image_asset\s+ia\s+USING/i.test(text)) {
    const shadeId = Number(boundParam(text, params, /ui\.shade_id\s*=\s*\$(\d+)/i));
    const imageIds = new Set((boundParam(text, params, /ANY\(\$(\d+)/i) || []).map(Number));
    const rows = [];
    for (const item of allInventoryItems()) {
      const itemId = Number(item.inventoryItemId);
      const photo = state.nailPhotos.get(itemId);
      if (!photo || item.shadeId !== shadeId || !visible(item) || !imageIds.has(photo.imageId)) continue;
      const asset = state.nailAssets.get(photo.imageId);
      state.nailPhotos.delete(itemId);
      state.nailAssets.delete(photo.imageId);
      rows.push({ storageUrl: asset ? asset.storageUrl : null });
    }
    return { rows, rowCount: rows.length };
  }

  if (kind === "INSERT" && /INSERT\s+INTO\s+image_asset/i.test(text)) {
    const imageId = state.nextNailImageId++;
    state.nailAssets.set(imageId, { ownerId: Number(params[0]), storageUrl: params[1] });
    return { rows: [{ imageId: String(imageId) }], rowCount: 1 };
  }

  if (kind === "INSERT" && /INSERT\s+INTO\s+inventory_nail_photo/i.test(text)) {
    const [itemId, imageId, contentType, width, height, sizeBytes] = params;
    const existing = state.nailPhotos.get(Number(itemId));
    const now = "2026-10-17T00:00:00.000Z";
    state.nailPhotos.set(Number(itemId), {
      imageId: Number(imageId),
      contentType,
      width,
      height,
      sizeBytes,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    });
    return { rows: [{ createdAt: existing ? existing.createdAt : now, updatedAt: now }], rowCount: 1 };
  }

  if (kind === "DELETE" && /DELETE\s+FROM\s+inventory_nail_photo/i.test(text)) {
    const itemId = Number(params[0]);
    const photo = state.nailPhotos.get(itemId);
    if (photo && photo.imageId === Number(params[1])) {
      state.nailPhotos.delete(itemId);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  if (kind === "DELETE" && /DELETE\s+FROM\s+image_asset/i.test(text)) {
    const imageId = Number(params[0]);
    const asset = state.nailAssets.get(imageId);
    if (!asset) return { rows: [], rowCount: 0 };
    state.nailAssets.delete(imageId);
    for (const [itemId, photo] of state.nailPhotos) {
      if (photo.imageId === imageId) state.nailPhotos.delete(itemId); // ON DELETE CASCADE
    }
    return { rows: [{ storageUrl: asset.storageUrl }], rowCount: 1 };
  }

  throw new Error(`fake DB: unhandled nail-photo statement: ${text}`);
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
  // functions/images treats jose errors as ordinary auth failures (instanceof check).
  errors: { JOSEError: class JOSEError extends Error {} },
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
  sideEffects = {
    blobReads: [],
    blobUploads: [],
    blobDeletes: [],
    ocrCalls: 0,
    labelParseCalls: 0,
    aiHexCalls: 0,
    stripCalls: 0,
    nailPhotoNormalizeCalls: 0,
  };
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
/** Container segment of a blob URL (virtual-host or path-style), same parsing as lib/blob-storage. */
function mockBlobContainer(storageUrl) {
  let parsed;
  try {
    parsed = new URL(storageUrl);
  } catch {
    return "";
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const virtualHost = /^[^.]+\.blob\./i.test(parsed.hostname);
  return (segments[virtualHost ? 0 : 1] ?? "").toLowerCase();
}
const MOCK_CATALOG_CONTAINER = "source-images";
const MOCK_USER_MEDIA_CONTAINER = "nail-photos";
registerMock("../lib/blob-storage", {
  BlobReadError,
  BlobAccessDeniedError,
  defaultReadableContainers: () => [MOCK_CATALOG_CONTAINER],
  userMediaContainer: () => MOCK_USER_MEDIA_CONTAINER,
  // Same logic as lib/blob-storage, against the mocked catalog container above.
  isCatalogStorageUrl: (storageUrl) => mockBlobContainer(storageUrl) === MOCK_CATALOG_CONTAINER,
  isUserMediaStorageUrl: (storageUrl) => mockBlobContainer(storageUrl) === MOCK_USER_MEDIA_CONTAINER,
  readBlobFromStorageUrl: async (storageUrl, options = {}) => {
    // Honour the per-scope container allowlist like the real reader: deny before any read.
    const allowed = options.allowedContainers ?? [MOCK_CATALOG_CONTAINER];
    if (!allowed.includes(mockBlobContainer(storageUrl))) {
      throw new BlobAccessDeniedError(`container not readable: ${mockBlobContainer(storageUrl)}`);
    }
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
  uploadBytesToBlob: async ({ containerName, blobName, contentType }) => {
    const url = `https://swatchwatchacct.blob.core.windows.net/${containerName}/${blobName}`;
    sideEffects.blobUploads.push({ url, containerName, contentType });
    return url;
  },
  deleteBlobFromStorageUrl: async (storageUrl, options) => {
    if (!options.allowedContainers.includes(mockBlobContainer(storageUrl))) {
      throw new BlobAccessDeniedError(`container not deletable: ${mockBlobContainer(storageUrl)}`);
    }
    sideEffects.blobDeletes.push(storageUrl);
    return true;
  },
});

// Nail-photo decoding/re-encoding is covered with real sharp in nail-photo-image.unit.test.cjs;
// here it only records whether a request got far enough to process image bytes.
class NailPhotoInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "NailPhotoInputError";
    this.status = status;
  }
}
registerMock("../lib/nail-photo-image", {
  NailPhotoInputError,
  parseNailPhotoDataUrl: (value) => {
    if (typeof value !== "string" || !value.startsWith("data:image/")) {
      throw new NailPhotoInputError("image must be a base64 data URL");
    }
    return { declaredType: "image/jpeg", bytes: Buffer.from(value.split(",")[1] || "", "base64") };
  },
  normalizeNailPhoto: async () => {
    sideEffects.nailPhotoNormalizeCalls += 1;
    return {
      bytes: Buffer.from("clean-jpeg"),
      contentType: "image/jpeg",
      width: 30,
      height: 60,
      checksumSha256: "c".repeat(64),
    };
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
  // Like a real client: a JSON body comes with its Content-Length (nail-photo uploads require one).
  if (body !== undefined && !headerMap.has("content-length")) {
    headerMap.set("content-length", String(Buffer.byteLength(JSON.stringify(body))));
  }
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
  assert.equal(item.status, "destash");
  assert.equal(item.triedAt, OWNER_TRIED_AT);
  assert.equal(item.purchasePrice, OWNER_PURCHASE_PRICE);
  assert.equal(item.purchaseCurrency, "CHF");
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
  assert.ok(!serialized.includes(String(OWNER_PURCHASE_PRICE)), `response leaked owner's purchasePrice: ${serialized}`);
  assert.ok(!serialized.includes(OWNER_TRIED_AT), `response leaked owner's triedAt: ${serialized}`);
  assert.ok(!serialized.includes('"destash"'), `response leaked owner's status: ${serialized}`);
}

// ---------------------------------------------------------------------------
// Load handler modules (they register routes via the mocked app.http)
// ---------------------------------------------------------------------------

require("../dist/functions/polishes");
require("../dist/functions/dupes");
require("../dist/functions/capture");
require("../dist/functions/ingestion");
require("../dist/functions/admin-users");
require("../dist/functions/admin-shade-review");
require("../dist/functions/admin-reference");
require("../dist/functions/voice");
require("../dist/functions/images");
require("../dist/functions/nail-photos");
require("../dist/functions/manicures");
const imageProxy = require("../dist/lib/image-proxy");

// lib/nail-photos (like lib/image-proxy) imports the REAL dist/lib/blob-storage via "./blob-storage";
// point only its blob delete at the recording mock so cleanup is observable without network.
require("../dist/lib/blob-storage").deleteBlobFromStorageUrl = mockModules["../lib/blob-storage"].deleteBlobFromStorageUrl;

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
  // Mani log (#269); cross-user isolation is covered in manicures.unit.test.cjs.
  { route: "manicures-list", method: "GET", url: "http://localhost:7071/api/manicures", params: {} },
  { route: "manicures-list", method: "GET", url: "http://localhost:7071/api/manicures/1", params: { id: "1" } },
  {
    route: "manicures-create",
    method: "POST",
    url: "http://localhost:7071/api/manicures",
    body: { polishes: [{ shadeId: OWNED_SHADE_ID }] },
  },
  {
    route: "manicures-mutate",
    method: "PATCH",
    url: "http://localhost:7071/api/manicures/1",
    params: { id: "1" },
    body: { notes: "x" },
  },
  { route: "manicures-mutate", method: "DELETE", url: "http://localhost:7071/api/manicures/1", params: { id: "1" } },
  {
    route: "polishes-dupes",
    method: "GET",
    url: `http://localhost:7071/api/polishes/${OWNED_SHADE_ID}/dupes`,
    params: { id: String(OWNED_SHADE_ID) },
  },
  {
    route: "polishes-dupes-batch",
    method: "POST",
    url: "http://localhost:7071/api/polishes/dupes",
    body: { shadeIds: [OWNED_SHADE_ID] },
  },
  {
    route: "polishes-list",
    method: "GET",
    url: "http://localhost:7071/api/polishes/export?format=csv",
    params: { id: "export" },
  },
  {
    route: "polishes-list",
    method: "GET",
    url: "http://localhost:7071/api/polishes/export?format=json",
    params: { id: "export" },
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
  {
    route: "inventory-nail-photo",
    method: "GET",
    url: `http://localhost:7071/api/inventory/${OWNER_INVENTORY_ITEM_ID}/nail-photo`,
    params: { inventoryItemId: String(OWNER_INVENTORY_ITEM_ID) },
  },
  {
    route: "inventory-nail-photo",
    method: "PUT",
    url: `http://localhost:7071/api/inventory/${OWNER_INVENTORY_ITEM_ID}/nail-photo`,
    params: { inventoryItemId: String(OWNER_INVENTORY_ITEM_ID) },
    body: { image: "data:image/jpeg;base64,YWJj" },
  },
  {
    route: "inventory-nail-photo",
    method: "DELETE",
    url: `http://localhost:7071/api/inventory/${OWNER_INVENTORY_ITEM_ID}/nail-photo`,
    params: { inventoryItemId: String(OWNER_INVENTORY_ITEM_ID) },
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
      "admin-shade-review-list",
      "admin-shade-review-candidates",
      "admin-shade-review-approve",
      "admin-shade-review-merge",
      "admin-shade-review-reject",
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

  it("GET dupes by another user is scoped to the caller and leaks no owner inventory (#265)", async () => {
    const res = await invoke("polishes-dupes", {
      method: "GET",
      userId: ATTACKER,
      url: `${detailUrl}/dupes`,
      params: { id: String(OWNED_SHADE_ID) },
    });
    assert.ok([200, 404].includes(res.status), `unexpected status ${res.status}: ${JSON.stringify(res.jsonBody)}`);
    assertNoOwnerDataInBody(res.jsonBody);
    assertScopedToCaller(ATTACKER);
    assertNoMutations();
    const inventoryQueries = handlerCalls().filter((c) => /user_inventory_item/i.test(c.sql));
    assert.ok(
      inventoryQueries.some((c) => /ui\.status\s*=\s*'owned'/i.test(c.sql)),
      "the candidate pool must be limited to owned rows"
    );
  });

  it("POST dupes batch by another user is scoped to the caller and leaks no owner inventory (#265)", async () => {
    const res = await invoke("polishes-dupes-batch", {
      method: "POST",
      userId: ATTACKER,
      url: "http://localhost:7071/api/polishes/dupes",
      body: { shadeIds: [OWNED_SHADE_ID], userId: OWNER, user_id: OWNER },
    });
    assert.equal(res.status, 200, `unexpected status ${res.status}: ${JSON.stringify(res.jsonBody)}`);
    assertNoOwnerDataInBody(res.jsonBody);
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

  function inventoryWriteCalls() {
    return handlerCalls().filter((c) => isMutation(c.sql) && /user_inventory_item/i.test(c.sql));
  }

  function assertInventoryWritesBindOnlyCaller(callerId) {
    const writes = inventoryWriteCalls();
    assert.ok(writes.length > 0, "expected at least one inventory write (guards against a vacuous pass)");
    for (const write of writes) {
      assert.equal(
        Number(insertedValue(write.sql, write.params, "user_id")),
        callerId,
        `inventory write must bind user_id to the caller: ${describeCall(write)}`
      );
      assert.ok(
        !write.params.some((p) => Number(p) === OWNER && callerId !== OWNER),
        `inventory write bound the owner's id: ${describeCall(write)}`
      );
    }
  }

  it("POST create ignores body userId/user_id spoofing (inventory insert binds the caller)", async () => {
    const res = await invoke("polishes-create", {
      method: "POST",
      userId: ATTACKER,
      url: "http://localhost:7071/api/polishes",
      body: { shadeId: String(OWNED_SHADE_ID), quantity: 4, userId: OWNER, user_id: OWNER },
    });
    assert.equal(res.status, 201, `unexpected status ${res.status}: ${JSON.stringify(res.jsonBody)}`);
    assertInventoryWritesBindOnlyCaller(ATTACKER);
    assertScopedToCaller(ATTACKER);
    assertOwnerInventoryUnchanged();
  });

  it("PUT ignores body userId/user_id spoofing (inventory upsert binds the caller)", async () => {
    const res = await invoke("polishes-mutate", {
      method: "PUT",
      userId: ATTACKER,
      url: detailUrl,
      params: { id: String(OWNED_SHADE_ID) },
      body: { quantity: 9, notes: "pwn", userId: OWNER, user_id: OWNER },
    });
    assert.equal(res.status, 200, `unexpected status ${res.status}: ${JSON.stringify(res.jsonBody)}`);
    assertInventoryWritesBindOnlyCaller(ATTACKER);
    assertScopedToCaller(ATTACKER);
    assertOwnerInventoryUnchanged();
    assertNoOwnerDataInBody(res.jsonBody);
  });

  it("GET list ignores ?userId=/?user_id= query spoofing (query scoped to caller, no owner fields)", async () => {
    const res = await invoke("polishes-list", {
      method: "GET",
      userId: ATTACKER,
      url: `http://localhost:7071/api/polishes?scope=collection&userId=${OWNER}&user_id=${OWNER}`,
      params: {},
    });
    assert.equal(res.status, 200);
    assertNoOwnerDataInBody(res.jsonBody);
    for (const polish of res.jsonBody.polishes) {
      assert.ok(polish.inventoryItemId == null, "attacker must not see the owner's inventory rows");
    }
    const scoped = handlerCalls().filter((c) => /user_inventory_item/i.test(c.sql));
    assert.ok(scoped.length > 0, "expected the list query to touch user_inventory_item");
    for (const call of scoped) {
      assert.ok(userIdPlaceholders(call.sql).length > 0, `missing user_id predicate: ${describeCall(call)}`);
      assert.ok(!call.params.some((p) => Number(p) === OWNER), `list params carried owner id: ${describeCall(call)}`);
    }
    assertScopedToCaller(ATTACKER);
    assertNoMutations();
  });

  // Inventory status model (issue #261): the new fields are part of the private overlay.
  it("owner sees their own status / triedAt / purchase fields", async () => {
    const res = await invoke("polishes-list", {
      method: "GET",
      userId: OWNER,
      url: detailUrl,
      params: { id: String(OWNED_SHADE_ID) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.status, "destash");
    assert.equal(res.jsonBody.purchasePrice, OWNER_PURCHASE_PRICE);
    assert.equal(res.jsonBody.triedAt, OWNER_TRIED_AT);
    assertScopedToCaller(OWNER);
  });

  it("GET detail by another user carries no status / purchase / tried fields", async () => {
    const res = await invoke("polishes-list", {
      method: "GET",
      userId: ATTACKER,
      url: detailUrl,
      params: { id: String(OWNED_SHADE_ID) },
    });
    assert.equal(res.status, 200);
    assertNoOwnerDataInBody(res.jsonBody);
    assert.equal(res.jsonBody.status, null);
    assert.equal(res.jsonBody.purchasePrice, null);
    assert.equal(res.jsonBody.triedAt, null);
    assert.equal(res.jsonBody.isUntried, false);
    assertScopedToCaller(ATTACKER);
    assertNoMutations();
  });

  for (const qs of ["status=destash", "status=owned,destash,wishlist,archived", "untried=true", "status=destash&untried=true"]) {
    it(`GET list ?${qs} by another user is scoped to the caller and leaks no owner fields`, async () => {
      const res = await invoke("polishes-list", {
        method: "GET",
        userId: ATTACKER,
        url: `http://localhost:7071/api/polishes?${qs}&userId=${OWNER}`,
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
  }

  it("PUT with status / triedAt / purchase fields by another user only writes the caller's row", async () => {
    const res = await invoke("polishes-mutate", {
      method: "PUT",
      userId: ATTACKER,
      url: detailUrl,
      params: { id: String(OWNED_SHADE_ID) },
      body: {
        status: "archived",
        triedAt: null,
        purchasePrice: 0,
        purchaseCurrency: "usd",
        userId: OWNER,
        user_id: OWNER,
      },
    });
    assert.equal(res.status, 200, `unexpected status ${res.status}: ${JSON.stringify(res.jsonBody)}`);
    assertInventoryWritesBindOnlyCaller(ATTACKER);
    assertScopedToCaller(ATTACKER);
    assertOwnerInventoryUnchanged();
    assertNoOwnerDataInBody(res.jsonBody);
    const attackerRow = state.inventory.get(`${ATTACKER}:${OWNED_SHADE_ID}`);
    assert.equal(attackerRow.status, "archived");
    assert.equal(attackerRow.purchaseCurrency, "USD");
  });

  it("POST create with status=wishlist binds the new row to the caller", async () => {
    const res = await invoke("polishes-create", {
      method: "POST",
      userId: ATTACKER,
      url: "http://localhost:7071/api/polishes",
      body: { shadeId: String(OWNED_SHADE_ID), status: "wishlist", purchasePrice: 7.25, user_id: OWNER },
    });
    assert.equal(res.status, 201, `unexpected status ${res.status}: ${JSON.stringify(res.jsonBody)}`);
    assertInventoryWritesBindOnlyCaller(ATTACKER);
    assertOwnerInventoryUnchanged();
    assert.equal(state.inventory.get(`${ATTACKER}:${OWNED_SHADE_ID}`).status, "wishlist");
  });

  it("invalid status input is rejected before any inventory write", async () => {
    const res = await invoke("polishes-mutate", {
      method: "PUT",
      userId: ATTACKER,
      url: detailUrl,
      params: { id: String(OWNED_SHADE_ID) },
      body: { status: "owned' OR user_id = 1 --" },
    });
    assert.equal(res.status, 400);
    assertNoMutations();
    assertOwnerInventoryUnchanged();
  });

  // Shades are a shared catalog: a user request writes color/finish data only when it creates
  // the shade (#224 decision 1b). Requests against an existing shared shade must not issue any
  // UPDATE on it, not even a NULL backfill.
  function assertNoSharedShadeWrites() {
    const shadeWrites = handlerCalls().filter((c) => /^\s*UPDATE\s+shade\b/i.test(c.sql));
    assert.deepEqual(shadeWrites.map(describeCall), [], "regular users must not write shared shade rows");
    const inventoryWrites = handlerCalls().filter((c) => /INSERT\s+INTO\s+user_inventory_item/i.test(c.sql));
    assert.ok(inventoryWrites.length > 0, "expected the caller's inventory write (guards against a vacuous pass)");
  }

  it("PUT with color and finish fields by a regular user never writes the shared shade", async () => {
    const res = await invoke("polishes-mutate", {
      method: "PUT",
      userId: ATTACKER,
      url: detailUrl,
      params: { id: String(OWNED_SHADE_ID) },
      body: { vendorHex: "#000000", detectedHex: "#000000", color: "Defaced", finishes: ["glitter"] },
    });
    assert.ok(res.status < 500);
    assertNoSharedShadeWrites();
  });

  it("POST adopting an existing shade with color and finish fields never writes the shared shade", async () => {
    const res = await invoke("polishes-create", {
      method: "POST",
      userId: ATTACKER,
      url: "http://localhost:7071/api/polishes",
      body: { shadeId: String(OWNED_SHADE_ID), quantity: 1, vendorHex: "#000000", color: "Defaced", finish: "glitter" },
    });
    assert.ok(res.status < 500);
    assertNoSharedShadeWrites();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Collection export (issue #264)
// ═══════════════════════════════════════════════════════════════════════════

describe("access control — collection export only contains the caller's rows", () => {
  const ATTACKER_NOTES = "attacker-own-notes";

  function addAttackerRow() {
    state.inventory.set(`${ATTACKER}:${OWNED_SHADE_ID}`, {
      inventoryItemId: "8001",
      userId: ATTACKER,
      shadeId: OWNED_SHADE_ID,
      quantity: 1,
      notes: ATTACKER_NOTES,
      rating: null,
      tags: [],
      status: "owned",
      triedAt: null,
      purchasePrice: null,
      purchaseCurrency: null,
    });
  }

  function exportRequest(qs) {
    return {
      method: "GET",
      url: `http://localhost:7071/api/polishes/export?${qs}`,
      params: { id: "export" },
    };
  }

  function bodyText(res) {
    return typeof res.body === "string" ? res.body : JSON.stringify(res.jsonBody ?? null);
  }

  it("owner export (CSV) contains the owner's row, with download headers", async () => {
    addAttackerRow();
    const res = await invoke("polishes-list", { userId: OWNER, ...exportRequest("format=csv") });
    assert.equal(res.status, 200);
    const headers = new Headers(res.headers);
    assert.equal(headers.get("Content-Type"), "text/csv; charset=utf-8");
    assert.match(
      headers.get("Content-Disposition"),
      /^attachment; filename="swatchwatch-collection-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    assert.equal(headers.get("Cache-Control"), "private, no-store");
    const text = bodyText(res);
    assert.ok(text.startsWith("\uFEFFBrand,Shade name,"), "CSV starts with BOM + header");
    assert.ok(text.includes(OWNER_SECRET_NOTES));
    assert.ok(text.includes("destash"));
    assert.ok(!text.includes(ATTACKER_NOTES), "owner export must not contain another user's row");
    assertScopedToCaller(OWNER);
    assertNoMutations();
  });

  for (const format of ["csv", "json"]) {
    it(`another user's ${format} export never includes the owner's rows`, async () => {
      addAttackerRow();
      const res = await invoke("polishes-list", {
        userId: ATTACKER,
        ...exportRequest(`format=${format}&userId=${OWNER}&user_id=${OWNER}`),
      });
      assert.equal(res.status, 200);
      const text = bodyText(res);
      assert.ok(text.includes(ATTACKER_NOTES), "caller's own row is exported (positive control)");
      assert.ok(!text.includes(OWNER_SECRET_NOTES), `export leaked owner's notes: ${text}`);
      assert.ok(!text.includes("owner-tag"), `export leaked owner's tags: ${text}`);
      assert.ok(!text.includes("7001"), `export leaked owner's inventory id: ${text}`);
      assert.ok(!text.includes(String(OWNER_PURCHASE_PRICE)), `export leaked owner's price: ${text}`);
      assert.ok(!text.includes("CHF"), `export leaked owner's currency: ${text}`);
      assertScopedToCaller(ATTACKER);
      assertNoMutations();
      for (const call of handlerCalls()) {
        assert.ok(!call.params.some((p) => Number(p) === OWNER), `export params carried owner id: ${describeCall(call)}`);
      }
    });
  }

  it("a user with no inventory gets an empty export, not someone else's", async () => {
    const res = await invoke("polishes-list", { userId: ATTACKER, ...exportRequest("format=json") });
    assert.equal(res.status, 200);
    const body = JSON.parse(bodyText(res));
    assert.equal(body.version, 1);
    assert.deepEqual(body.items, []);
    assert.equal(body.itemCount, 0);
    assertNoOwnerDataInBody(body);
    assertScopedToCaller(ATTACKER);
  });

  it("JSON export applies the status filter", async () => {
    const owned = await invoke("polishes-list", { userId: OWNER, ...exportRequest("format=json&status=owned") });
    assert.equal(owned.status, 200);
    assert.deepEqual(JSON.parse(bodyText(owned)).items, []);
    const destash = await invoke("polishes-list", { userId: OWNER, ...exportRequest("format=json&status=destash") });
    const body = JSON.parse(bodyText(destash));
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].inventoryItemId, "7001");
    assert.deepEqual(body.statusFilter, ["destash"]);
    assertScopedToCaller(OWNER);
  });

  for (const qs of ["format=xlsx", "status=bogus"]) {
    it(`rejects ?${qs} with 400 before any inventory query`, async () => {
      const res = await invoke("polishes-list", { userId: OWNER, ...exportRequest(qs) });
      assert.equal(res.status, 400);
      assert.equal(
        handlerCalls().filter((c) => /user_inventory_item/i.test(c.sql)).length,
        0,
        "no inventory query for an invalid request"
      );
    });
  }
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

  it("capture-start ignores body userId spoofing (session insert binds the caller)", async () => {
    const res = await invoke("capture-start", {
      method: "POST",
      userId: ATTACKER,
      url: "http://localhost:7071/api/capture/start",
      body: { userId: OWNER, user_id: OWNER },
    });
    assert.equal(res.status, 201);
    const inserts = handlerCalls().filter((c) => /INSERT\s+INTO\s+capture_session/i.test(c.sql));
    assert.equal(inserts.length, 1);
    assert.equal(Number(insertedValue(inserts[0].sql, inserts[0].params, "user_id")), ATTACKER);
    assert.ok(!inserts[0].params.some((p) => Number(p) === OWNER), "session insert must not bind the owner's id");
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
  // Server-minted ids are HMAC-signed and expiring (keyed by IMAGE_PROXY_SIGNING_KEY):
  //   - public catalog ids:   `v2.<b64url(storageUrl)>.<exp base36>.<b64url(hmac)>`
  //   - private owner-scoped: `v3.<b64url(storageUrl)>.<exp base36>.<owner base36>.<b64url(hmac)>` (#227)
  // Valid ids are minted via the library so these tests do not depend on the exact HMAC
  // construction, except where a test deliberately hand-signs one with the real key.
  const CATALOG_URL = "https://swatchwatchacct.blob.core.windows.net/source-images/holotaco/a.png";
  const PRIVATE_URL = "https://swatchwatchacct.blob.core.windows.net/nail-photos/user-1/private-photo.png";
  const OTHER_URL = "https://swatchwatchacct.blob.core.windows.net/nail-photos/user-2/other-photo.png";

  // lib/image-proxy (not mocked) decides catalog vs. private from SOURCE_IMAGE_CONTAINER at mint
  // time; the mocked blob-storage reader uses the same two containers for its allowlists.
  const ENV_KEYS = ["SOURCE_IMAGE_CONTAINER", "USER_MEDIA_CONTAINER"];
  let savedEnv;
  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.SOURCE_IMAGE_CONTAINER = MOCK_CATALOG_CONTAINER;
    process.env.USER_MEDIA_CONTAINER = MOCK_USER_MEDIA_CONTAINER;
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function b64url(input) {
    return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function mintId(sourceUrl, { ownerUserId, nowMs } = {}) {
    const options = {};
    if (ownerUserId !== undefined) options.ownerUserId = ownerUserId;
    if (nowMs !== undefined) options.nowMs = nowMs;
    const proxyUrl = imageProxy.toImageProxyUrl("http://localhost:7071/api/polishes", sourceUrl, options);
    const id = new URL(proxyUrl).pathname.split("/").pop();
    return decodeURIComponent(id);
  }

  async function getImage(id, { userId, headers } = {}) {
    return invoke("images", {
      method: "GET",
      userId,
      headers,
      url: `http://localhost:7071/api/images/${encodeURIComponent(id)}`,
      params: { id },
    });
  }

  function assertRejected(res) {
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    assert.deepEqual(sideEffects.blobReads, [], "blob storage must not be read for an unverified id");
  }

  it("server-minted catalog ids use the signed, expiring `v2.<payload>.<exp>.<signature>` format", () => {
    const id = mintId(CATALOG_URL);
    assert.match(id, /^v2\.[A-Za-z0-9_-]+\.[0-9a-z]+\.[A-Za-z0-9_-]+$/);
  });

  it("refuses to mint an id for private media without an owner (fail closed, #227)", () => {
    assert.throws(() => mintId(PRIVATE_URL), imageProxy.ImageProxyScopeError);
  });

  it("serves an image for a server-minted signed id (positive control)", async () => {
    const res = await getImage(mintId(CATALOG_URL));
    assert.equal(res.status, 200);
    assert.deepEqual(sideEffects.blobReads, [CATALOG_URL]);
    assert.deepEqual(sqlCalls, [], "public ids perform no caller lookup");
    assert.match(res.headers.get("Cache-Control"), /^public,/);
    assert.equal(res.headers.get("Vary"), null, "public responses do not vary on Authorization");
  });

  it("public catalog ids stay anonymous: served with another user's token, no SQL", async () => {
    const res = await getImage(mintId(CATALOG_URL), { userId: ATTACKER });
    assert.equal(res.status, 200);
    assert.deepEqual(sideEffects.blobReads, [CATALOG_URL]);
    assert.deepEqual(sqlCalls, [], "public ids perform no caller lookup");
  });

  it("rejects a forged unsigned id (plain base64url of a storage URL)", async () => {
    assertRejected(await getImage(b64url(CATALOG_URL)));
  });

  // Forgeries below keep the full minted `v2.<payload>.<exp>.<signature>` envelope and change only
  // the part under test, so they exercise signature / URL binding rather than format parsing.
  function envelope(id) {
    const [version, payload, exp, signature] = id.split(".");
    return { version, payload, exp, signature };
  }

  it("rejects an id with an empty signature", async () => {
    const { version, payload, exp } = envelope(mintId(CATALOG_URL));
    assertRejected(await getImage(`${version}.${payload}.${exp}.`));
  });

  it("rejects an id with a garbage signature", async () => {
    const { version, payload, exp } = envelope(mintId(CATALOG_URL));
    assertRejected(await getImage(`${version}.${payload}.${exp}.${b64url("not-a-real-mac")}`));
  });

  it("rejects an id signed with the wrong key", async () => {
    const { version, payload, exp } = envelope(mintId(CATALOG_URL));
    // Same message layout the server signs (expiry as decimal seconds; the id carries base36),
    // but the attacker's key.
    const expiresAt = Number.parseInt(exp, 36);
    const forgedMac = crypto
      .createHmac("sha256", "attacker-key")
      .update(`swatchwatch:image-proxy:v2:${expiresAt}:${CATALOG_URL}`)
      .digest();
    const forgedMacOverPayload = crypto.createHmac("sha256", "attacker-key").update(payload).digest();
    // Control: the identical construction with the real key is accepted, so the rejections
    // below are caused by the key alone, not by a malformed id.
    const realMac = crypto
      .createHmac("sha256", process.env.IMAGE_PROXY_SIGNING_KEY)
      .update(`swatchwatch:image-proxy:v2:${expiresAt}:${CATALOG_URL}`)
      .digest();
    assert.equal((await getImage(`${version}.${payload}.${exp}.${b64url(realMac)}`)).status, 200);
    sideEffects.blobReads.length = 0;
    assertRejected(await getImage(`${version}.${payload}.${exp}.${b64url(forgedMac)}`));
    assertRejected(await getImage(`${version}.${payload}.${exp}.${b64url(forgedMacOverPayload)}`));
  });

  it("rejects a valid signature transplanted onto a different URL", async () => {
    // Keep a catalog id's version, expiry and signature; swap in another catalog URL's payload only.
    const { version, exp, signature } = envelope(mintId(CATALOG_URL));
    const otherCatalogUrl = CATALOG_URL.replace("/a.png", "/b.png");
    assertRejected(await getImage(`${version}.${b64url(otherCatalogUrl)}.${exp}.${signature}`));
  });

  it("rejects a tampered signature (single character flipped)", async () => {
    // Flip the signature's FIRST character: its last base64url char carries unused bits, so a
    // change there can decode to the same MAC and make this test pass or fail by chance.
    const { version, payload, exp, signature } = envelope(mintId(CATALOG_URL));
    const tampered = `${version}.${payload}.${exp}.${(signature[0] === "A" ? "B" : "A") + signature.slice(1)}`;
    assertRejected(await getImage(tampered));
  });

  // Owner-scoped private ids (#227): a v3 id binds the owner's user id and a short expiry into
  // the HMAC. Serving one requires the owner's bearer token (401 without a valid token, 403 for
  // anyone else, admins included) and may only read USER_MEDIA_CONTAINER.
  describe("owner-scoped private ids (#227)", () => {
    function v3Envelope(id) {
      const [version, payload, exp, owner, signature] = id.split(".");
      assert.equal(version, "v3", `expected a v3 id, got ${id}`);
      return { version, payload, exp, owner, signature };
    }

    /** Hand-sign an id with the REAL key, bypassing the mint-time catalog/owner checks. */
    function realKeyMac(message) {
      return b64url(crypto.createHmac("sha256", process.env.IMAGE_PROXY_SIGNING_KEY).update(message).digest());
    }

    /** Only the dev-bypass user lookup from authenticateRequest may hit the DB. */
    function assertOnlyAuthLookup() {
      assert.deepEqual(handlerCalls().map(describeCall), [], "private ids perform no DB work beyond auth");
    }

    it("serves the owner's private image to the owner, uncacheable by shared caches", async () => {
      const id = mintId(PRIVATE_URL, { ownerUserId: OWNER });
      assert.match(id, /^v3\.[A-Za-z0-9_-]+\.[0-9a-z]+\.[0-9a-z]+\.[A-Za-z0-9_-]+$/);
      const res = await getImage(id, { userId: OWNER });
      assert.equal(res.status, 200);
      assert.deepEqual(sideEffects.blobReads, [PRIVATE_URL]);
      const cacheControl = res.headers.get("Cache-Control");
      assert.match(cacheControl, /^private,/);
      assert.doesNotMatch(cacheControl, /public/);
      assert.ok(
        (res.headers.get("Vary") || "").split(",").map((v) => v.trim().toLowerCase()).includes("authorization"),
        `Vary must include Authorization, got ${res.headers.get("Vary")}`
      );
      assertOnlyAuthLookup();
    });

    it("serves the owner when app_user.user_id comes back as a string (BIGINT via node-postgres)", async () => {
      stringUserIds = true;
      const res = await getImage(mintId(PRIVATE_URL, { ownerUserId: OWNER }), { userId: OWNER });
      assert.equal(res.status, 200);
      assert.deepEqual(sideEffects.blobReads, [PRIVATE_URL]);
      // ...and a string id still never matches another owner.
      sideEffects.blobReads.length = 0;
      const denied = await getImage(mintId(PRIVATE_URL, { ownerUserId: OWNER }), { userId: ATTACKER });
      assert.equal(denied.status, 403);
      assert.deepEqual(sideEffects.blobReads, []);
    });

    it("rejects an ADMIN token for another user's private id (no admin bypass, 403)", async () => {
      const res = await getImage(mintId(PRIVATE_URL, { ownerUserId: OWNER }), { userId: ADMIN });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(sideEffects.blobReads, []);
    });

    it("rejects a token for a user that no longer exists (401)", async () => {
      const res = await getImage(mintId(PRIVATE_URL, { ownerUserId: OWNER }), { userId: 424242 });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(sideEffects.blobReads, []);
    });

    it("rejects the owner's private id presented with the ATTACKER's token (403)", async () => {
      const res = await getImage(mintId(PRIVATE_URL, { ownerUserId: OWNER }), { userId: ATTACKER });
      assert.equal(res.status, 403);
      assert.deepEqual(res.jsonBody, { error: "Forbidden" });
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(sideEffects.blobReads, []);
      assertOnlyAuthLookup();
    });

    it("rejects the owner's private id with no Authorization header (401)", async () => {
      const res = await getImage(mintId(PRIVATE_URL, { ownerUserId: OWNER }));
      assert.equal(res.status, 401);
      assert.deepEqual(res.jsonBody, { error: "Unauthorized" });
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(sideEffects.blobReads, []);
      assert.deepEqual(sqlCalls, []);
    });

    it("rejects the owner's private id with a malformed Authorization header (401)", async () => {
      const res = await getImage(mintId(PRIVATE_URL, { ownerUserId: OWNER }), {
        headers: { authorization: "Bearer dev:1 OR 1=1" },
      });
      assert.equal(res.status, 401);
      assert.deepEqual(sideEffects.blobReads, []);
      assert.deepEqual(sqlCalls, []);
    });

    it("rejects an expired private id even with the owner's token (403)", async () => {
      const id = mintId(PRIVATE_URL, { ownerUserId: OWNER, nowMs: Date.now() - 2 * 60 * 60 * 1000 });
      const res = await getImage(id, { userId: OWNER });
      assert.equal(res.status, 403);
      assert.deepEqual(sideEffects.blobReads, []);
      assert.deepEqual(sqlCalls, [], "expiry is checked before any auth lookup");
    });

    it("rejects a private id's signature transplanted onto another URL (403)", async () => {
      // The attacker's own valid id for their own photo...
      const attackerId = mintId(OTHER_URL, { ownerUserId: ATTACKER });
      assert.equal((await getImage(attackerId, { userId: ATTACKER })).status, 200, "control");
      sideEffects.blobReads.length = 0;
      sqlCalls.length = 0;
      // ...with only the payload swapped to the owner's photo.
      const { version, exp, owner, signature } = v3Envelope(attackerId);
      const forged = `${version}.${b64url(PRIVATE_URL)}.${exp}.${owner}.${signature}`;
      const res = await getImage(forged, { userId: ATTACKER });
      assert.equal(res.status, 403);
      assert.deepEqual(sideEffects.blobReads, []);
      assert.deepEqual(sqlCalls, [], "signature is checked before any auth lookup");
    });

    it("rejects a private id whose owner was swapped to the ATTACKER, even with the attacker's token (403)", async () => {
      const { version, payload, exp, signature } = v3Envelope(mintId(PRIVATE_URL, { ownerUserId: OWNER }));
      const forged = `${version}.${payload}.${exp}.${ATTACKER.toString(36)}.${signature}`;
      const res = await getImage(forged, { userId: ATTACKER });
      assert.equal(res.status, 403);
      assert.deepEqual(sideEffects.blobReads, []);
      assert.deepEqual(sqlCalls, []);
    });

    it("refuses a hand-signed public v2 id for a private URL: not in the v2 container allowlist (403)", async () => {
      // A v2 id cannot be minted for a nail-photos URL; one built with the real key decodes
      // (valid signature) but the public scope may only read the catalog container.
      const { exp } = envelope(mintId(CATALOG_URL));
      const expiresAt = Number.parseInt(exp, 36);
      const forged = `v2.${b64url(PRIVATE_URL)}.${exp}.${realKeyMac(`swatchwatch:image-proxy:v2:${expiresAt}:${PRIVATE_URL}`)}`;
      const res = await getImage(forged, { userId: OWNER });
      assert.equal(res.status, 403);
      assert.deepEqual(sideEffects.blobReads, []);
      assert.deepEqual(sqlCalls, [], "public ids perform no caller lookup");
    });

    it("refuses a hand-signed private v3 id for a catalog URL: not in the v3 container allowlist (403)", async () => {
      // Catalog URLs always mint v2; a v3 id for one, built with the real key and bound to the
      // OWNER, authenticates but the private scope may only read USER_MEDIA_CONTAINER.
      const { exp } = v3Envelope(mintId(PRIVATE_URL, { ownerUserId: OWNER }));
      const expiresAt = Number.parseInt(exp, 36);
      const mac = realKeyMac(`swatchwatch:image-proxy:v3:${expiresAt}:${OWNER}:${CATALOG_URL}`);
      const forged = `v3.${b64url(CATALOG_URL)}.${exp}.${OWNER.toString(36)}.${mac}`;
      const res = await getImage(forged, { userId: OWNER });
      assert.equal(res.status, 403);
      assert.deepEqual(sideEffects.blobReads, []);
      assertOnlyAuthLookup();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Private nail photos (#270)
// ═══════════════════════════════════════════════════════════════════════════

describe("access control — private nail photos are scoped to the inventory owner (#270)", () => {
  const ENV_KEYS = ["SOURCE_IMAGE_CONTAINER", "USER_MEDIA_CONTAINER", "AZURE_STORAGE_CONNECTION"];
  let savedEnv;
  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.SOURCE_IMAGE_CONTAINER = MOCK_CATALOG_CONTAINER;
    process.env.USER_MEDIA_CONTAINER = MOCK_USER_MEDIA_CONTAINER;
    process.env.AZURE_STORAGE_CONNECTION =
      "DefaultEndpointsProtocol=https;AccountName=swatchwatchacct;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const ownerItemParams = { inventoryItemId: String(OWNER_INVENTORY_ITEM_ID) };
  const ownerItemUrl = `http://localhost:7071/api/inventory/${OWNER_INVENTORY_ITEM_ID}/nail-photo`;
  const UPLOAD = { image: "data:image/jpeg;base64,YWJj" };

  function nailPhoto(method, userId, extra = {}) {
    return invoke("inventory-nail-photo", { method, userId, url: ownerItemUrl, params: ownerItemParams, ...extra });
  }

  function assertOwnerPhotoUnchanged() {
    const photo = state.nailPhotos.get(OWNER_INVENTORY_ITEM_ID);
    assert.ok(photo, "owner's nail photo must still be linked");
    assert.equal(photo.imageId, OWNER_NAIL_PHOTO_IMAGE_ID);
    assert.deepEqual(state.nailAssets.get(OWNER_NAIL_PHOTO_IMAGE_ID), { ownerId: OWNER, storageUrl: OWNER_NAIL_PHOTO_URL });
  }

  function assertNoNailPhotoSideEffects() {
    assert.equal(sideEffects.nailPhotoNormalizeCalls, 0, "attacker bytes must never be processed");
    assert.deepEqual(sideEffects.blobUploads, [], "nothing may be uploaded");
    assert.deepEqual(sideEffects.blobDeletes, [], "no blob may be deleted");
  }

  /** Every statement touching the inventory table binds the caller's user id. */
  function assertItemLookupsScopedTo(callerId) {
    const lookups = handlerCalls().filter((c) => /user_inventory_item/i.test(c.sql));
    assert.ok(lookups.length > 0, "expected an inventory ownership lookup");
    for (const call of lookups) {
      const placeholders = userIdPlaceholders(call.sql);
      assert.ok(placeholders.length > 0, `missing user_id predicate: ${describeCall(call)}`);
      for (const n of placeholders) {
        assert.equal(Number(call.params[n - 1]), callerId, `must bind the caller: ${describeCall(call)}`);
      }
    }
  }

  it("owner sanity check: GET returns the photo as an owner-scoped v3 proxy URL only", async () => {
    const res = await nailPhoto("GET", OWNER);
    assert.equal(res.status, 200);
    const { photo } = res.jsonBody;
    assert.equal(photo.inventoryItemId, String(OWNER_INVENTORY_ITEM_ID));
    assert.match(photo.imageUrl, /^http:\/\/localhost:7071\/api\/images\/v3\./);
    const serialized = JSON.stringify(res.jsonBody);
    assertNoBlobStorageUrls(res.jsonBody);
    assert.ok(!/\/api\/images\/v2\./.test(serialized), "no public v2 id may be returned");
    assert.match(res.headers["Cache-Control"], /no-store/);
    assertItemLookupsScopedTo(OWNER);
    assertNoMutations();
  });

  it("GET of the owner's item by another user is 404 and reveals nothing", async () => {
    const res = await nailPhoto("GET", ATTACKER);
    assert.equal(res.status, 404);
    const serialized = JSON.stringify(res.jsonBody);
    assert.ok(!serialized.includes("images/v3"), `leaked an image id: ${serialized}`);
    assert.ok(!serialized.includes("nail-photos"), `leaked a storage URL: ${serialized}`);
    assertItemLookupsScopedTo(ATTACKER);
    assertNoMutations();
    assertNoNailPhotoSideEffects();
  });

  it("PUT on the owner's item by another user is 404 before the body is read or any image work", async () => {
    const res = await nailPhoto("PUT", ATTACKER, { body: UPLOAD });
    assert.equal(res.status, 404);
    assertItemLookupsScopedTo(ATTACKER);
    assertNoMutations();
    assertNoNailPhotoSideEffects();
    assertOwnerPhotoUnchanged();
  });

  it("PUT by another user who owns a different item still cannot target the owner's item id", async () => {
    state.inventory.set(`${ATTACKER}:${OWNED_SHADE_ID}`, {
      inventoryItemId: "8001",
      userId: ATTACKER,
      shadeId: OWNED_SHADE_ID,
      quantity: 1,
      notes: null,
      rating: null,
      tags: null,
    });
    const res = await nailPhoto("PUT", ATTACKER, { body: UPLOAD });
    assert.equal(res.status, 404);
    assertNoMutations();
    assertNoNailPhotoSideEffects();
    assertOwnerPhotoUnchanged();
  });

  it("DELETE of the owner's photo by another user is 404 and deletes nothing", async () => {
    const res = await nailPhoto("DELETE", ATTACKER);
    assert.equal(res.status, 404);
    assertItemLookupsScopedTo(ATTACKER);
    assertNoMutations();
    assertNoNailPhotoSideEffects();
    assertOwnerPhotoUnchanged();
  });

  it("an ADMIN gets no bypass: GET/PUT/DELETE on another user's item are 404", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      sqlCalls.length = 0;
      const res = await nailPhoto(method, ADMIN, method === "PUT" ? { body: UPLOAD } : {});
      assert.equal(res.status, 404, `${method} by admin`);
      assertNoMutations();
    }
    assertNoNailPhotoSideEffects();
    assertOwnerPhotoUnchanged();
  });

  it("the owner's photo URL cannot be read with another user's (or an admin's) bearer token", async () => {
    const { photo } = (await nailPhoto("GET", OWNER)).jsonBody;
    const id = decodeURIComponent(new URL(photo.imageUrl).pathname.split("/").pop());

    const asOwner = await invoke("images", { method: "GET", userId: OWNER, url: photo.imageUrl, params: { id } });
    assert.equal(asOwner.status, 200, "positive control: the owner can read it");
    assert.deepEqual(sideEffects.blobReads, [OWNER_NAIL_PHOTO_URL]);

    sideEffects.blobReads.length = 0;
    for (const userId of [ATTACKER, ADMIN]) {
      const res = await invoke("images", { method: "GET", userId, url: photo.imageUrl, params: { id } });
      assert.equal(res.status, 403, `user ${userId} must be refused`);
    }
    const anonymous = await invoke("images", { method: "GET", url: photo.imageUrl, params: { id } });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(sideEffects.blobReads, [], "no blob read for anyone but the owner");
  });

  it("owner PUT replaces the photo: new blob in nail-photos, image_asset owned by the caller, old blob deleted", async () => {
    const res = await nailPhoto("PUT", OWNER, { body: UPLOAD });
    assert.equal(res.status, 200);
    assert.equal(sideEffects.nailPhotoNormalizeCalls, 1);
    assert.equal(sideEffects.blobUploads.length, 1);
    const upload = sideEffects.blobUploads[0];
    assert.equal(upload.containerName, MOCK_USER_MEDIA_CONTAINER);
    assert.match(upload.url, new RegExp(`/nail-photos/${OWNER}/${OWNER_INVENTORY_ITEM_ID}/[0-9a-f-]{36}\\.jpg$`));

    const photo = state.nailPhotos.get(OWNER_INVENTORY_ITEM_ID);
    assert.notEqual(photo.imageId, OWNER_NAIL_PHOTO_IMAGE_ID);
    assert.deepEqual(state.nailAssets.get(photo.imageId), { ownerId: OWNER, storageUrl: upload.url });
    assert.equal(state.nailAssets.has(OWNER_NAIL_PHOTO_IMAGE_ID), false, "old asset removed");
    assert.deepEqual(sideEffects.blobDeletes, [OWNER_NAIL_PHOTO_URL], "old blob removed");

    assert.match(res.jsonBody.photo.imageUrl, /\/api\/images\/v3\./);
    assertNoBlobStorageUrls(res.jsonBody);
    assertItemLookupsScopedTo(OWNER);
  });

  it("owner DELETE removes the link, the asset and the blob", async () => {
    const res = await nailPhoto("DELETE", OWNER);
    assert.equal(res.status, 204);
    assert.equal(state.nailPhotos.has(OWNER_INVENTORY_ITEM_ID), false);
    assert.equal(state.nailAssets.has(OWNER_NAIL_PHOTO_IMAGE_ID), false);
    assert.deepEqual(sideEffects.blobDeletes, [OWNER_NAIL_PHOTO_URL]);
    assertItemLookupsScopedTo(OWNER);
  });

  it("deleting the polish (inventory row) also deletes its nail photo, for the owner only", async () => {
    const detailUrl = `http://localhost:7071/api/polishes/${OWNED_SHADE_ID}`;
    const params = { id: String(OWNED_SHADE_ID) };

    const denied = await invoke("polishes-mutate", { method: "DELETE", userId: ATTACKER, url: detailUrl, params });
    assert.ok([403, 404].includes(denied.status));
    assertOwnerPhotoUnchanged();
    assert.deepEqual(sideEffects.blobDeletes, []);

    const res = await invoke("polishes-mutate", { method: "DELETE", userId: OWNER, url: detailUrl, params });
    assert.equal(res.status, 200);
    assert.equal(state.nailPhotos.has(OWNER_INVENTORY_ITEM_ID), false);
    assert.equal(state.nailAssets.has(OWNER_NAIL_PHOTO_IMAGE_ID), false);
    assert.deepEqual(sideEffects.blobDeletes, [OWNER_NAIL_PHOTO_URL]);
  });
});
