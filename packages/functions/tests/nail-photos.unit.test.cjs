/**
 * Handler tests for the private nail-photo routes (#270):
 *   GET/PUT/DELETE /api/inventory/{inventoryItemId}/nail-photo
 *
 * Runs without a database or storage account: the DB is an in-memory fake, blob uploads and
 * deletes are recorded, and image processing uses REAL sharp (lib/nail-photo-image), so these
 * tests also prove that what reaches storage carries no EXIF/GPS. Cross-user isolation lives in
 * access-control.unit.test.cjs.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const sharp = require("sharp");

process.env.IMAGE_PROXY_SIGNING_KEY = "nail-photos-unit-test-signing-key-0123456789";
delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const OWNER = 1;
const ITEM_ID = 7001;
const SHADE_ID = 500;
const OTHER_ITEM_ID = 8001; // belongs to user 2

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------
let db;
let failNextLinkInsert = false;
let failNextItemDelete = false;

function resetDb() {
  failNextLinkInsert = false;
  failNextItemDelete = false;
  db = {
    statements: [],
    transactions: 0,
    nextImageId: 100,
    items: new Map([
      [ITEM_ID, { userId: OWNER, shadeId: SHADE_ID }],
      [OTHER_ITEM_ID, { userId: 2, shadeId: SHADE_ID }],
    ]),
    photos: new Map(), // itemId -> { imageId, contentType, width, height, sizeBytes, createdAt, updatedAt }
    assets: new Map(), // imageId -> { ownerId, storageUrl }
  };
}
resetDb();

function bound(text, params, regex) {
  const match = String(text).match(regex);
  return match ? params[Number(match[1]) - 1] : undefined;
}

async function fakeQuery(sql, params = []) {
  const text = String(sql);
  db.statements.push({ sql: text, params });

  if (/FROM\s+app_user/i.test(text) && /WHERE\s+user_id\s*=\s*\$1/i.test(text)) {
    const userId = Number(params[0]);
    return { rows: userId > 0 && userId < 10 ? [{ user_id: userId, external_id: `ext-${userId}`, email: null, role: "user" }] : [] };
  }

  if (/^\s*SELECT/i.test(text) && /FROM\s+user_inventory_item\s+ui/i.test(text)) {
    const itemId = Number(bound(text, params, /ui\.inventory_item_id\s*=\s*\$(\d+)/i));
    const userId = Number(bound(text, params, /ui\.user_id\s*=\s*\$(\d+)/i));
    const item = db.items.get(itemId);
    if (!item || item.userId !== userId) return { rows: [] };
    const photo = db.photos.get(itemId);
    const asset = photo ? db.assets.get(photo.imageId) : undefined;
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
    };
  }

  // DELETE /api/polishes/{id}: row lock, nail-photo detach, item delete.
  if (/^\s*SELECT\s+inventory_item_id\s+FROM\s+user_inventory_item/i.test(text)) {
    const [shadeId, userId] = params.map(Number);
    const rows = [...db.items].filter(([, i]) => i.shadeId === shadeId && i.userId === userId);
    return { rows: rows.map(([id]) => ({ inventory_item_id: String(id) })) };
  }
  if (/FROM\s+inventory_nail_photo\s+p\s+JOIN/i.test(text)) {
    const [shadeId, userId] = params.map(Number);
    const rows = [...db.items]
      .filter(([id, i]) => i.shadeId === shadeId && i.userId === userId && db.photos.has(id))
      .map(([id]) => ({ imageId: String(db.photos.get(id).imageId) }));
    return { rows };
  }
  if (/DELETE\s+FROM\s+image_asset\s+ia\s+USING/i.test(text)) {
    const ids = new Set(params[0].map(Number));
    const [shadeId, userId] = [Number(params[1]), Number(params[2])];
    const rows = [];
    for (const [itemId, photo] of [...db.photos]) {
      const item = db.items.get(itemId);
      if (!item || item.shadeId !== shadeId || item.userId !== userId || !ids.has(photo.imageId)) continue;
      rows.push({ storageUrl: db.assets.get(photo.imageId).storageUrl });
      db.assets.delete(photo.imageId);
      db.photos.delete(itemId);
    }
    return { rows };
  }
  if (/DELETE\s+FROM\s+user_inventory_item/i.test(text)) {
    if (failNextItemDelete) {
      failNextItemDelete = false;
      throw new Error("simulated item delete failure");
    }
    const [shadeId, userId] = params.map(Number);
    const victims = [...db.items].filter(([, i]) => i.shadeId === shadeId && i.userId === userId);
    for (const [id] of victims) {
      db.items.delete(id);
      db.photos.delete(id);
    }
    return { rows: victims.map(([id]) => ({ id: String(id) })) };
  }

  if (/INSERT\s+INTO\s+image_asset/i.test(text)) {
    const imageId = db.nextImageId++;
    db.assets.set(imageId, { ownerId: Number(params[0]), storageUrl: params[1], checksum: params[2] });
    return { rows: [{ imageId: String(imageId) }] };
  }

  if (/INSERT\s+INTO\s+inventory_nail_photo/i.test(text)) {
    if (failNextLinkInsert) {
      failNextLinkInsert = false;
      throw new Error("simulated DB failure");
    }
    const [itemId, imageId, contentType, width, height, sizeBytes] = params;
    const existing = db.photos.get(Number(itemId));
    const createdAt = existing ? existing.createdAt : new Date("2026-10-17T01:00:00Z");
    const updatedAt = new Date("2026-10-17T02:00:00Z");
    db.photos.set(Number(itemId), { imageId: Number(imageId), contentType, width, height, sizeBytes, createdAt, updatedAt });
    return { rows: [{ createdAt, updatedAt }] };
  }

  if (/DELETE\s+FROM\s+inventory_nail_photo/i.test(text)) {
    const photo = db.photos.get(Number(params[0]));
    if (photo && photo.imageId === Number(params[1])) db.photos.delete(Number(params[0]));
    return { rows: [] };
  }

  if (/DELETE\s+FROM\s+image_asset/i.test(text)) {
    const imageId = Number(params[0]);
    const asset = db.assets.get(imageId);
    db.assets.delete(imageId);
    for (const [itemId, photo] of db.photos) if (photo.imageId === imageId) db.photos.delete(itemId);
    return { rows: asset ? [{ storageUrl: asset.storageUrl }] : [] };
  }

  throw new Error(`unexpected SQL in nail-photos test: ${text}`);
}

/** Snapshot-based rollback so a failing transaction leaves the fake untouched. */
async function fakeTransaction(callback) {
  db.transactions += 1;
  const snapshot = {
    items: new Map([...db.items].map(([k, v]) => [k, { ...v }])),
    photos: new Map([...db.photos].map(([k, v]) => [k, { ...v }])),
    assets: new Map([...db.assets].map(([k, v]) => [k, { ...v }])),
  };
  try {
    return await callback({ query: fakeQuery });
  } catch (error) {
    db.items = snapshot.items;
    db.photos = snapshot.photos;
    db.assets = snapshot.assets;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Module mocks
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
  app: { http: (name, opts) => (registeredRoutes[name] = opts), storageQueue: () => {}, timer: () => {} },
});
registerMock("jose", {
  errors: { JOSEError: class JOSEError extends Error {} },
  createRemoteJWKSet: () => {},
  jwtVerify: async () => {
    throw new Error("JWT validation is not exercised here");
  },
});
const dbMock = { query: fakeQuery, transaction: fakeTransaction, getPool: () => ({}), closePool: async () => {} };
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);

let storage;
function resetStorage() {
  storage = { uploads: [], deletes: [], failUpload: false };
}
resetStorage();

function containerOf(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[0] || "";
  } catch {
    return "";
  }
}
const realBlobStorage = require("../dist/lib/blob-storage");
registerMock("../lib/blob-storage", {
  ...realBlobStorage,
  uploadBytesToBlob: async ({ containerName, blobName, bytes, contentType }) => {
    if (storage.failUpload) throw new Error("storage down");
    const url = `https://swatchwatchacct.blob.core.windows.net/${containerName}/${blobName}`;
    storage.uploads.push({ url, containerName, blobName, bytes, contentType });
    return url;
  },
});
// lib/nail-photos imports the real module via "./blob-storage"; record its deletes instead of calling Azure.
realBlobStorage.deleteBlobFromStorageUrl = async (url, options) => {
  if (!options.allowedContainers.includes(containerOf(url))) {
    throw new realBlobStorage.BlobAccessDeniedError(`not deletable: ${url}`);
  }
  storage.deletes.push(url);
  return true;
};

for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

require("../dist/functions/nail-photos");
require("../dist/functions/polishes");
const { NAIL_PHOTO_MAX_UPLOAD_BYTES } = require("swatchwatch-shared");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * `body` is JSON-encoded (or sent verbatim when `rawBody` is given) as a ReadableStream, with a
 * matching Content-Length unless `chunked` is set or `headers` overrides it. `streamChunks` lets a
 * test stream more bytes than the Content-Length claims.
 */
function fakeRequest({
  method,
  itemId = ITEM_ID,
  userId = OWNER,
  body,
  rawBody,
  chunked = false,
  streamChunks,
  headers = {},
  url,
  params,
}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (userId !== null) headerMap.set("authorization", `Bearer dev:${userId}`);
  const text = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
  const bytes = text !== undefined ? Buffer.from(text) : null;
  if (bytes && !chunked && !headerMap.has("content-length")) headerMap.set("content-length", String(bytes.length));
  const chunks = streamChunks || (bytes ? [bytes] : []);
  let streamed = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (streamed < chunks.length) controller.enqueue(new Uint8Array(chunks[streamed++]));
      else controller.close();
    },
  });
  return {
    method,
    url: url || `http://localhost:7071/api/inventory/${itemId}/nail-photo`,
    headers: { get: (name) => headerMap.get(name.toLowerCase()) ?? null },
    params: params || { inventoryItemId: String(itemId) },
    query: new URLSearchParams(),
    get body() {
      return bytes || streamChunks ? stream : null;
    },
    get streamedChunks() {
      return streamed;
    },
    arrayBuffer: async () => (bytes ? bytes : Buffer.alloc(0)),
  };
}

function fakeContext() {
  return { log() {}, warn() {}, error() {}, invocationId: "test-invocation" };
}

function call(method, options = {}) {
  return registeredRoutes["inventory-nail-photo"].handler(fakeRequest({ method, ...options }), fakeContext());
}

async function taggedJpegDataUrl() {
  const jpeg = await sharp({ create: { width: 60, height: 30, channels: 3, background: "#c81e5a" } })
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: "LeakyPhone", Model: "Model X" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" },
    })
    .jpeg()
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

const ENV_KEYS = ["AUTH_DEV_BYPASS", "AZURE_STORAGE_CONNECTION", "SOURCE_IMAGE_CONTAINER", "USER_MEDIA_CONTAINER"];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.AUTH_DEV_BYPASS = "true";
  process.env.AZURE_STORAGE_CONNECTION =
    "DefaultEndpointsProtocol=https;AccountName=swatchwatchacct;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
  delete process.env.SOURCE_IMAGE_CONTAINER;
  delete process.env.USER_MEDIA_CONTAINER;
  resetDb();
  resetStorage();
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("functions/nail-photos — registration", () => {
  it("registers GET/PUT/DELETE (+OPTIONS) on inventory/{inventoryItemId}/nail-photo", () => {
    const route = registeredRoutes["inventory-nail-photo"];
    assert.ok(route);
    assert.equal(route.route, "inventory/{inventoryItemId}/nail-photo");
    assert.deepEqual([...route.methods].sort(), ["DELETE", "GET", "OPTIONS", "PUT"]);
    assert.equal(route.authLevel, "anonymous");
  });

  it("requires authentication", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await call(method, { userId: null });
      assert.equal(res.status, 401, method);
    }
    assert.equal(db.statements.length, 0);
  });

  it("rejects non-numeric, zero and partially numeric ids with 400 before any SQL", async () => {
    for (const itemId of ["abc", "0", "12abc", "-1", "1.5", "99999999999999999999"]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const res = await call(method, { itemId, body: { image: "data:image/jpeg;base64,YWJj" } });
        assert.equal(res.status, 400, `${method} ${itemId}`);
      }
    }
    assert.ok(db.statements.every((s) => /FROM\s+app_user/i.test(s.sql)), "only the auth lookup may run");
  });
});

describe("functions/nail-photos — GET", () => {
  it("returns { photo: null } for an owned item without a photo", async () => {
    const res = await call("GET");
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody, { photo: null });
    assert.equal(res.headers["Cache-Control"], "private, no-store");
  });

  it("404s for an item that does not exist or belongs to someone else", async () => {
    assert.equal((await call("GET", { itemId: 424242 })).status, 404);
    assert.equal((await call("GET", { itemId: OTHER_ITEM_ID })).status, 404);
  });
});

describe("functions/nail-photos — PUT", () => {
  it("stores a metadata-free, upright JPEG in the user-media container and returns a v3 URL (201)", async () => {
    const res = await call("PUT", { body: { image: await taggedJpegDataUrl() } });
    assert.equal(res.status, 201);

    assert.equal(storage.uploads.length, 1);
    const upload = storage.uploads[0];
    assert.equal(upload.containerName, "nail-photos");
    assert.equal(upload.contentType, "image/jpeg");
    assert.match(upload.blobName, /^1\/7001\/[0-9a-f-]{36}\.jpg$/);
    const meta = await sharp(upload.bytes).metadata();
    assert.equal(meta.exif, undefined, "EXIF (incl. GPS) must be stripped");
    assert.equal(meta.orientation, undefined);
    assert.equal(meta.width, 30, "orientation 6 applied to the pixels");
    assert.equal(meta.height, 60);
    assert.ok(!upload.bytes.includes(Buffer.from("LeakyPhone")));

    const photo = res.jsonBody.photo;
    assert.equal(photo.inventoryItemId, String(ITEM_ID));
    assert.equal(photo.shadeId, String(SHADE_ID));
    assert.equal(photo.contentType, "image/jpeg");
    assert.equal(photo.width, 30);
    assert.equal(photo.height, 60);
    assert.equal(photo.sizeBytes, upload.bytes.length);
    assert.match(photo.imageUrl, /^http:\/\/localhost:7071\/api\/images\/v3\.[^/]+$/);
    assert.ok(!JSON.stringify(res.jsonBody).includes("blob.core.windows.net"), "no raw blob URL");
    assert.equal(photo.createdAt, "2026-10-17T01:00:00.000Z");
    assert.equal(res.headers["Cache-Control"], "private, no-store");

    // The v3 id is bound to the owner and the stored blob.
    const { decodeImageProxyIdWithExpiry } = require("../dist/lib/image-proxy");
    const decoded = decodeImageProxyIdWithExpiry(decodeURIComponent(photo.imageUrl.split("/").pop()));
    assert.equal(decoded.scope, "private");
    assert.equal(decoded.ownerUserId, OWNER);
    assert.equal(decoded.url, upload.url);

    const [asset] = [...db.assets.values()];
    assert.equal(asset.ownerId, OWNER);
    assert.equal(asset.storageUrl, upload.url);
    assert.equal(db.photos.get(ITEM_ID).sizeBytes, upload.bytes.length);
    assert.deepEqual(storage.deletes, []);
  });

  it("replaces an existing photo (200): new blob linked, old asset and blob deleted", async () => {
    const image = await taggedJpegDataUrl();
    await call("PUT", { body: { image } });
    const firstUrl = storage.uploads[0].url;
    const firstImageId = db.photos.get(ITEM_ID).imageId;

    const res = await call("PUT", { body: { image } });
    assert.equal(res.status, 200);
    assert.equal(storage.uploads.length, 2);
    assert.notEqual(storage.uploads[1].url, firstUrl, "each upload gets a fresh blob name");
    assert.notEqual(db.photos.get(ITEM_ID).imageId, firstImageId);
    assert.equal(db.assets.has(firstImageId), false);
    assert.deepEqual(storage.deletes, [firstUrl]);
    assert.equal(db.photos.get(ITEM_ID).createdAt.toISOString(), "2026-10-17T01:00:00.000Z");
  });

  it("404s for someone else's item without uploading or decoding anything", async () => {
    const res = await call("PUT", { itemId: OTHER_ITEM_ID, body: { image: await taggedJpegDataUrl() } });
    assert.equal(res.status, 404);
    assert.deepEqual(storage.uploads, []);
    assert.equal(db.assets.size, 0);
  });

  it("rejects bad bodies: invalid JSON / missing image (400), unsupported type (415), non-image bytes (415)", async () => {
    assert.equal((await call("PUT", { rawBody: "{not json" })).status, 400);
    assert.equal((await call("PUT", { body: [] })).status, 400);
    assert.equal((await call("PUT", { body: {} })).status, 400);
    assert.equal((await call("PUT", { body: { image: "https://example.com/a.jpg" } })).status, 400);
    assert.equal((await call("PUT", { body: { image: "data:image/gif;base64,R0lGODlh" } })).status, 415);
    const notImage = `data:image/jpeg;base64,${Buffer.from("not really a jpeg").toString("base64")}`;
    const res = await call("PUT", { body: { image: notImage } });
    assert.equal(res.status, 415);
    assert.match(res.jsonBody.error, /not a supported image/);
    assert.deepEqual(storage.uploads, []);
    assert.equal(db.assets.size, 0);
  });

  it("rejects oversize uploads with 413 (declared Content-Length or payload)", async () => {
    const byHeader = await call("PUT", {
      body: { image: "data:image/jpeg;base64,YWJj" },
      headers: { "content-length": String(NAIL_PHOTO_MAX_UPLOAD_BYTES * 2) },
    });
    assert.equal(byHeader.status, 413);
    const huge = "A".repeat(Math.ceil(NAIL_PHOTO_MAX_UPLOAD_BYTES / 3) * 4 + 4);
    const byPayload = await call("PUT", { body: { image: `data:image/jpeg;base64,${huge}` } });
    assert.equal(byPayload.status, 413);
    assert.deepEqual(storage.uploads, []);
  });

  it("requires a Content-Length (411 for chunked uploads) and rejects a malformed one (400)", async () => {
    const image = await taggedJpegDataUrl();
    const chunked = await call("PUT", { body: { image }, chunked: true });
    assert.equal(chunked.status, 411);
    const malformed = await call("PUT", { body: { image }, headers: { "content-length": "12abc" } });
    assert.equal(malformed.status, 400);
    assert.deepEqual(storage.uploads, []);
  });

  it("stops reading at the size cap even when the body is larger than its Content-Length (413)", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x41);
    const chunks = Array.from({ length: 64 }, () => chunk); // 64 MB on the wire
    const req = fakeRequest({ method: "PUT", streamChunks: chunks, headers: { "content-length": "100" } });
    const res = await registeredRoutes["inventory-nail-photo"].handler(req, fakeContext());
    assert.equal(res.status, 413);
    assert.ok(req.streamedChunks < 20, `read ${req.streamedChunks} MB before stopping`);
    assert.deepEqual(storage.uploads, []);
  });

  it("answers 503 when no storage account is configured (nothing stored)", async () => {
    delete process.env.AZURE_STORAGE_CONNECTION;
    const res = await call("PUT", { body: { image: await taggedJpegDataUrl() } });
    assert.equal(res.status, 503);
    assert.equal(db.assets.size, 0);
  });

  it("deletes the just-uploaded blob when the DB write fails (no orphaned private media)", async () => {
    failNextLinkInsert = true;
    const res = await call("PUT", { body: { image: await taggedJpegDataUrl() } });
    assert.equal(res.status, 500);
    assert.ok(!JSON.stringify(res.jsonBody).includes("simulated"), "internal error text is not leaked");
    assert.equal(storage.uploads.length, 1);
    assert.deepEqual(storage.deletes, [storage.uploads[0].url]);
    assert.equal(db.assets.size, 0, "transaction rolled back");
    assert.equal(db.photos.size, 0);
  });

  it("answers 500 without storing anything when the upload itself fails", async () => {
    storage.failUpload = true;
    const res = await call("PUT", { body: { image: await taggedJpegDataUrl() } });
    assert.equal(res.status, 500);
    assert.equal(db.assets.size, 0);
    assert.deepEqual(storage.deletes, []);
  });
});

describe("functions/nail-photos — DELETE", () => {
  it("removes the photo (204) and its blob, and is idempotent", async () => {
    await call("PUT", { body: { image: await taggedJpegDataUrl() } });
    const url = storage.uploads[0].url;

    const res = await call("DELETE");
    assert.equal(res.status, 204);
    assert.equal(db.photos.size, 0);
    assert.equal(db.assets.size, 0);
    assert.deepEqual(storage.deletes, [url]);

    const again = await call("DELETE");
    assert.equal(again.status, 204);
    assert.deepEqual(storage.deletes, [url]);
    assert.deepEqual((await call("GET")).jsonBody, { photo: null });
  });

  it("404s for someone else's item", async () => {
    assert.equal((await call("DELETE", { itemId: OTHER_ITEM_ID })).status, 404);
    assert.deepEqual(storage.deletes, []);
  });
});

describe("functions/polishes — DELETE removes the nail photo atomically (#270)", () => {
  function deletePolish() {
    const req = fakeRequest({
      method: "DELETE",
      url: `http://localhost:7071/api/polishes/${SHADE_ID}`,
      params: { id: String(SHADE_ID) },
    });
    return registeredRoutes["polishes-mutate"].handler(req, fakeContext());
  }

  it("locks the item, detaches the photo and deletes the item in one transaction, then the blob", async () => {
    await call("PUT", { body: { image: await taggedJpegDataUrl() } });
    const url = storage.uploads[0].url;
    db.statements.length = 0;
    const transactionsBefore = db.transactions;

    const res = await deletePolish();
    assert.equal(res.status, 200);
    assert.equal(db.transactions, transactionsBefore + 1);
    const sql = db.statements.map((s) => s.sql).filter((t) => !/FROM\s+app_user/i.test(t));
    assert.match(sql[0], /FOR UPDATE/, "the inventory row is locked first");
    assert.ok(sql.some((t) => /DELETE\s+FROM\s+image_asset\s+ia\s+USING/i.test(t)));
    assert.match(sql[sql.length - 1], /DELETE\s+FROM\s+user_inventory_item/i);
    assert.equal(db.items.has(ITEM_ID), false);
    assert.equal(db.photos.size, 0);
    assert.equal(db.assets.size, 0);
    assert.deepEqual(storage.deletes, [url], "blob deleted after commit");
  });

  it("leaves the photo row, asset and blob untouched when the item delete fails", async () => {
    await call("PUT", { body: { image: await taggedJpegDataUrl() } });
    const photoBefore = { ...db.photos.get(ITEM_ID) };
    const assetsBefore = db.assets.size;

    failNextItemDelete = true;
    const res = await deletePolish();
    assert.equal(res.status, 500);
    assert.ok(db.items.has(ITEM_ID), "item still there");
    assert.deepEqual(db.photos.get(ITEM_ID), photoBefore, "photo link rolled back");
    assert.equal(db.assets.size, assetsBefore, "image_asset rolled back");
    assert.deepEqual(storage.deletes, [], "no blob deleted when the transaction fails");
    assert.equal((await call("GET")).jsonBody.photo.width, photoBefore.width, "photo still served");
  });

  it("deletes nothing for another user's polish (404) and keeps the owner's photo", async () => {
    await call("PUT", { body: { image: await taggedJpegDataUrl() } });
    db.items.delete(OTHER_ITEM_ID);
    const req = fakeRequest({
      method: "DELETE",
      userId: 2,
      url: `http://localhost:7071/api/polishes/${SHADE_ID}`,
      params: { id: String(SHADE_ID) },
    });
    const res = await registeredRoutes["polishes-mutate"].handler(req, fakeContext());
    assert.equal(res.status, 404);
    assert.equal(db.photos.size, 1);
    assert.deepEqual(storage.deletes, []);
  });
});
