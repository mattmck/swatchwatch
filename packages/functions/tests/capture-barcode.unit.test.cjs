/**
 * Barcode scans resolve end to end (#21, #325):
 * - the resolver matches a scanned code by its canonical key (UPC-A scanned, EAN-13 stored),
 *   then the caller's own learned barcodes (user_shade_barcode), then falls back to connector
 *   products' raw GTIN (external_product.gtin → shade_source_product → active shade);
 * - a barcode frame carrying the on-device decoded value skips OCR and returns the check
 *   verdict in the frame response (one round trip);
 * - a session whose GTIN matched nothing remembers the GTIN on the shade it ends up matching,
 *   privately for that user.
 *
 * Runs without a database (require interception + an in-memory fake, like capture-check).
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

const CAPTURE_UUID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = 777;
const SHADE_ID = 21;
const OTHER_SHADE_ID = 22;
const SKU_ID = 501;
const UPC_A = "036000291452"; // scanned as UPC-A
const CANONICAL = `0${UPC_A}`; // stored key
const UNKNOWN = "4006381333931";
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let sqlCalls;
let state;
let ocrCalls;

function resetState() {
  sqlCalls = [];
  ocrCalls = 0;
  state = {
    session: {
      id: SESSION_ID,
      userId: OWNER,
      captureId: CAPTURE_UUID,
      status: "processing",
      topConfidence: null,
      acceptedEntityType: null,
      acceptedEntityId: null,
      metadata: { gtin: UPC_A, barcodeFormat: "upc_a" },
    },
    frames: [{ frameType: "barcode", quality: { gtin: UPC_A, barcodeFormat: "upc_a" } }],
    /** Catalog barcode rows by canonical gtin. */
    barcodes: new Map(),
    /** user_shade_barcode rows. */
    userBarcodes: [],
    /** external_product rows joined to their shade(s). */
    externalProducts: [],
    shadeCandidates: [],
    inventory: [],
    nextFrameId: 1,
  };
}
resetState();

function statementKind(sql) {
  const match = String(sql).trim().match(/^(WITH|SELECT|INSERT|UPDATE|DELETE)\b/i);
  return match ? match[1].toUpperCase() : "OTHER";
}

async function fakeQuery(via, sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ via, sql: text, params });
  const kind = statementKind(text);
  const norm = text.replace(/\s+/g, " ");

  if (/FROM app_user/i.test(norm) && /WHERE user_id = \$1/i.test(norm)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }
  if (/FROM capture_session/i.test(norm) && kind === "SELECT") {
    const s = state.session;
    if (params[0] === s.captureId && Number(params[1]) === s.userId) {
      const { userId: _owner, ...row } = s;
      return { rows: [{ ...row }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  if (/FROM capture_frame/i.test(norm)) {
    return { rows: state.frames, rowCount: state.frames.length };
  }
  if (/FROM capture_question/i.test(norm) && kind === "SELECT") {
    return { rows: [], rowCount: 0 };
  }
  if (/INSERT INTO image_asset/i.test(norm)) {
    return { rows: [{ imageId: "9001" }], rowCount: 1 };
  }
  if (/INSERT INTO capture_frame/i.test(norm)) {
    state.frames = [{ frameType: params[2], quality: params[3] }, ...state.frames];
    return { rows: [{ frameId: String(state.nextFrameId++) }], rowCount: 1 };
  }

  // Catalog barcode lookup: bc.gtin = ANY($1).
  if (/FROM barcode bc/i.test(norm)) {
    assert.ok(Array.isArray(params[0]), "catalog lookup takes an array of keys");
    for (const key of params[0]) {
      const row = state.barcodes.get(key);
      if (row) return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  // Learned barcodes: always scoped to the caller.
  if (/FROM user_shade_barcode/i.test(norm) && kind === "SELECT") {
    assert.match(norm, /ub\.user_id = \$2/);
    const row = state.userBarcodes.find((r) => r.userId === Number(params[1]) && params[0].includes(r.gtin));
    return row
      ? { rows: [{ shadeId: String(row.shadeId), brand: "Indie", shadeName: "Learned Shade" }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (/INSERT INTO user_shade_barcode/i.test(norm)) {
    const [userId, gtin, shadeId, barcodeType, sessionId] = params;
    state.userBarcodes = state.userBarcodes.filter((r) => !(r.userId === userId && r.gtin === gtin));
    state.userBarcodes.push({ userId, gtin, shadeId: Number(shadeId), barcodeType, sessionId });
    return { rows: [], rowCount: 1 };
  }
  // Fallback: connector product raw GTIN.
  if (/FROM external_product ep/i.test(norm)) {
    assert.match(norm, /regexp_replace\(ep\.gtin/);
    assert.match(norm, /sh\.status = 'active'/);
    const rows = state.externalProducts
      .filter((p) => params[0].includes(p.gtin.replace(/[\s-]/g, "")) && p.status === "active")
      .map((p) => ({ shadeId: String(p.shadeId), brand: p.brand, shadeName: p.shadeName }));
    return { rows, rowCount: rows.length };
  }

  if (/vendor_hex/i.test(norm) && /shade_id = ANY\(\$1::bigint\[\]\)/i.test(norm)) {
    const rows = params[0]
      .filter((id) => String(id) === String(SHADE_ID))
      .map((id) => ({ shadeId: String(id), vendorHex: null, detectedHex: "#C1121F", nameHex: "#FF0000" }));
    return { rows, rowCount: rows.length };
  }
  if (/similarity\(/i.test(norm) && /FROM shade s/i.test(norm)) {
    return { rows: state.shadeCandidates, rowCount: state.shadeCandidates.length };
  }
  if (/FROM sku s/i.test(norm) && /WHERE s\.sku_id = \$1/i.test(norm)) {
    return { rows: [{ shadeId: String(SHADE_ID), brand: "OPI", productName: "Big Apple Red", shadeName: "Big Apple Red" }], rowCount: 1 };
  }
  if (/FROM shade s LEFT JOIN brand b/i.test(norm) && /WHERE s\.shade_id = \$1/i.test(norm)) {
    return { rows: [{ brand: "Indie", shadeName: "Shade" }], rowCount: 1 };
  }
  if (/s\.created_by_user_id/i.test(norm)) {
    return { rows: [{ "?column?": 1 }], rowCount: 1 };
  }
  if (/SELECT shade_id AS "shadeId" FROM sku/i.test(norm)) {
    return { rows: [{ shadeId: SHADE_ID }], rowCount: 1 };
  }
  if (/user_inventory_item/i.test(norm)) {
    if (kind === "SELECT" && /ANY\(\$2::bigint\[\]\)/i.test(norm)) {
      return { rows: [], rowCount: 0 };
    }
    if (kind === "SELECT") return { rows: [], rowCount: 0 };
    if (kind === "INSERT") return { rows: [{ id: 4242 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE capture_session/i.test(norm)) {
    const status = norm.match(/SET status = '(\w+)'/i);
    if (status) state.session.status = status[1];
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

// ---------------------------------------------------------------------------
// Module mocking
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
  app: { http: (name, opts) => { registeredRoutes[name] = opts; }, storageQueue: () => {}, timer: () => {} },
  output: { storageQueue: (opts) => ({ __type: "storageQueue", ...opts }) },
});
registerMock("jose", {
  errors: { JOSEError: class JOSEError extends Error {} },
  createRemoteJWKSet: () => {},
  jwtVerify: async () => { throw new Error("unused"); },
});
const dbMock = {
  query: (sql, params) => fakeQuery("pool", sql, params),
  transaction: async (cb) => cb({ query: (sql, params) => fakeQuery("tx", sql, params) }),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
registerMock("./db", dbMock);
registerMock("../lib/ocr", {
  extractTextFromImage: async () => {
    ocrCalls += 1;
    return null;
  },
});
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

function fakeRequest({ url, userId, params, body }) {
  const headers = new Map([["authorization", `Bearer dev:${userId}`]]);
  return {
    method: "POST",
    url,
    headers: { get: (name) => headers.get(name.toLowerCase()) || null },
    params,
    query: new URL(url).searchParams,
    json: async () => body,
  };
}

async function invoke(routeName, { userId = OWNER, body = {} } = {}) {
  const route = registeredRoutes[routeName];
  assert.ok(route, `route ${routeName} should be registered`);
  const action = routeName.replace(/^capture-/, "");
  return route.handler(
    fakeRequest({
      url: `http://localhost:7071/api/capture/${CAPTURE_UUID}/${action}`,
      userId,
      params: { captureId: CAPTURE_UUID },
      body,
    }),
    { log: () => {}, error: () => {}, warn: () => {} }
  );
}

beforeEach(() => {
  resetState();
  process.env.AUTH_DEV_BYPASS = "true";
});
afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
});

// ═══════════════════════════════════════════════════════════════════════════

describe("capture resolver — barcode lookup", () => {
  it("matches a catalog barcode by its canonical key (UPC-A scanned, EAN-13 form stored)", async () => {
    state.barcodes.set(CANONICAL, {
      skuId: String(SKU_ID),
      shadeId: String(SHADE_ID),
      brand: "OPI",
      productName: "Big Apple Red",
      shadeName: "Big Apple Red",
    });
    const res = await invoke("capture-check");
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.outcome, "matched");
    assert.equal(res.jsonBody.match.entityType, "sku");
    assert.equal(res.jsonBody.match.entityId, String(SKU_ID));
    assert.equal(res.jsonBody.confidence, 1);
    const lookup = sqlCalls.find((c) => /FROM barcode bc/i.test(c.sql));
    assert.ok(lookup.params[0].includes(CANONICAL));
  });

  it("falls back to a connector product's raw GTIN linked to one active shade", async () => {
    state.externalProducts.push({ gtin: "0 36000 29145 2", shadeId: SHADE_ID, status: "active", brand: "Holo Taco", shadeName: "Blurple" });
    const res = await invoke("capture-check");
    assert.equal(res.jsonBody.outcome, "matched");
    assert.equal(res.jsonBody.match.entityType, "shade");
    assert.equal(res.jsonBody.match.entityId, String(SHADE_ID));
    assert.equal(res.jsonBody.match.display, "Holo Taco — Blurple");
    assert.equal(res.jsonBody.confidence, 1);
    const fallback = sqlCalls.find((c) => /FROM external_product ep/i.test(c.sql));
    assert.ok(fallback.params[0].includes(UPC_A), "12-digit spelling is searched");
    assert.ok(fallback.params[0].includes(CANONICAL), "13-digit spelling is searched");
  });

  it("does not auto-match when the GTIN's products map to more than one shade", async () => {
    state.externalProducts.push(
      { gtin: UPC_A, shadeId: SHADE_ID, status: "active", brand: "A", shadeName: "One" },
      { gtin: UPC_A, shadeId: OTHER_SHADE_ID, status: "active", brand: "A", shadeName: "Two" }
    );
    const res = await invoke("capture-check");
    assert.notEqual(res.jsonBody.outcome, "matched");
  });

  it("ignores connector products whose shade is not active", async () => {
    state.externalProducts.push({ gtin: UPC_A, shadeId: SHADE_ID, status: "user_submitted", brand: "A", shadeName: "One" });
    const res = await invoke("capture-check");
    assert.notEqual(res.jsonBody.outcome, "matched");
  });

  it("matches the caller's own learned barcode, never another user's", async () => {
    state.userBarcodes.push({ userId: OTHER, gtin: CANONICAL, shadeId: OTHER_SHADE_ID });
    let res = await invoke("capture-check");
    assert.notEqual(res.jsonBody.outcome, "matched", "another user's learned barcode is invisible");

    state.userBarcodes.push({ userId: OWNER, gtin: CANONICAL, shadeId: SHADE_ID });
    res = await invoke("capture-check");
    assert.equal(res.jsonBody.outcome, "matched");
    assert.equal(res.jsonBody.match.entityType, "shade");
    assert.equal(res.jsonBody.match.entityId, String(SHADE_ID));
    const lookup = sqlCalls.filter((c) => /FROM user_shade_barcode/i.test(c.sql)).pop();
    assert.equal(lookup.params[1], OWNER);
  });

  it("the catalog lookup is bound to the caller and skips shades they cannot see", async () => {
    await invoke("capture-check");
    const lookup = sqlCalls.find((c) => /FROM barcode bc/i.test(c.sql));
    assert.equal(lookup.params[1], OWNER, "visibility is checked against the caller");
    assert.match(lookup.sql.replace(/\s+/g, " "), /sh\.merged_into_shade_id IS NULL AND \(sh\.status <> 'user_submitted' OR sh\.created_by_user_id = \$2\)/);
  });

  it("still matches a legacy raw GTIN row (exact string) for codes with a bad check digit", async () => {
    const legacy = "1234567890123";
    state.session.metadata = { gtin: legacy };
    state.frames = [{ frameType: "barcode", quality: { gtin: legacy } }];
    state.barcodes.set(legacy, { skuId: String(SKU_ID), shadeId: String(SHADE_ID), brand: "OPI", productName: "X", shadeName: "X" });
    const res = await invoke("capture-check");
    assert.equal(res.jsonBody.outcome, "matched");
  });
});

describe("capture frame — decoded barcode evidence", () => {
  const decodedFrame = {
    frameType: "barcode",
    imageBlobUrl: PIXEL,
    quality: { source: "web-camera", gtin: UPC_A, barcodeFormat: "upc_a", barcodeDecoder: "native" },
  };

  it("skips OCR and returns the check verdict in the frame response", async () => {
    state.session.metadata = {};
    state.frames = [];
    state.barcodes.set(CANONICAL, { skuId: String(SKU_ID), shadeId: String(SHADE_ID), brand: "OPI", productName: "Big Apple Red", shadeName: "Big Apple Red" });
    const res = await invoke("capture-frame", { body: decodedFrame });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(ocrCalls, 0, "no OCR for an on-device decoded barcode");
    assert.equal(res.jsonBody.received, true);
    assert.ok(res.jsonBody.check, "frame response carries the verdict");
    assert.equal(res.jsonBody.check.outcome, "matched");
    assert.equal(res.jsonBody.check.match.entityId, String(SKU_ID));
    assert.deepEqual(res.jsonBody.check.match.ownership, { relationship: "notOwned" });
    assert.equal(res.jsonBody.check.match.hex, "#C1121F", "display hex (vendor > detected > name) for the swatch");
  });

  it("reports an unknown barcode as unmatched without OCR", async () => {
    state.session.metadata = {};
    state.frames = [];
    const res = await invoke("capture-frame", {
      body: { ...decodedFrame, quality: { gtin: UNKNOWN, barcodeFormat: "ean_13", barcodeDecoder: "zxing" } },
    });
    assert.equal(res.status, 201);
    assert.equal(ocrCalls, 0);
    assert.notEqual(res.jsonBody.check.outcome, "matched");
  });

  it("still runs OCR on a barcode frame without a decoded value", async () => {
    state.session.metadata = {};
    state.frames = [];
    const res = await invoke("capture-frame", { body: { frameType: "barcode", imageBlobUrl: PIXEL, quality: {} } });
    assert.equal(res.status, 201);
    assert.equal(ocrCalls, 1);
    assert.equal(res.jsonBody.check, undefined, "no verdict without decoded evidence");
  });

  it("does not trust a decoded value that is not a valid barcode", async () => {
    state.session.metadata = {};
    state.frames = [];
    const res = await invoke("capture-frame", {
      body: { ...decodedFrame, quality: { gtin: "hello", barcodeDecoder: "native" } },
    });
    assert.equal(res.status, 201);
    assert.equal(ocrCalls, 1);
    assert.equal(res.jsonBody.check, undefined);
  });
});

describe("capture — remembering an unknown barcode", () => {
  it("links the scanned GTIN to the shade the label flow matched, privately for the caller", async () => {
    state.session.metadata = { gtin: UNKNOWN, barcodeFormat: "ean_13", brand: "Indie", shadeName: "Label Shade" };
    state.frames = [
      { frameType: "label", quality: { extracted: { brand: "Indie", shadeName: "Label Shade" } } },
      { frameType: "barcode", quality: { gtin: UNKNOWN, barcodeFormat: "ean_13" } },
    ];
    state.shadeCandidates = [{ shadeId: String(SHADE_ID), brand: "Indie", shadeName: "Label Shade", score: 0.97 }];

    const res = await invoke("capture-finalize");
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.status, "matched");
    assert.deepEqual(state.userBarcodes, [
      { userId: OWNER, gtin: UNKNOWN, shadeId: SHADE_ID, barcodeType: "EAN_13", sessionId: SESSION_ID },
    ]);
    const insert = sqlCalls.find((c) => /INSERT INTO user_shade_barcode/i.test(c.sql));
    assert.equal(insert.via, "tx", "written in the finalize transaction");

    // Second scan of the same bottle: matched by the learned barcode.
    state.session.status = "processing";
    state.session.metadata = { gtin: UNKNOWN };
    state.frames = [{ frameType: "barcode", quality: { gtin: UNKNOWN } }];
    state.shadeCandidates = [];
    const second = await invoke("capture-check");
    assert.equal(second.jsonBody.outcome, "matched");
    assert.equal(second.jsonBody.match.entityId, String(SHADE_ID));
  });

  it("learns nothing when the catalog barcode matched", async () => {
    state.barcodes.set(CANONICAL, { skuId: String(SKU_ID), shadeId: String(SHADE_ID), brand: "OPI", productName: "X", shadeName: "X" });
    const res = await invoke("capture-finalize");
    assert.equal(res.jsonBody.status, "matched");
    assert.deepEqual(state.userBarcodes, []);
  });

  it("learns nothing without a valid scanned GTIN", async () => {
    state.session.metadata = { brand: "Indie", shadeName: "Label Shade" };
    state.frames = [{ frameType: "label", quality: { extracted: { brand: "Indie", shadeName: "Label Shade" } } }];
    state.shadeCandidates = [{ shadeId: String(SHADE_ID), brand: "Indie", shadeName: "Label Shade", score: 0.97 }];
    const res = await invoke("capture-finalize");
    assert.equal(res.jsonBody.status, "matched");
    assert.deepEqual(state.userBarcodes, []);
  });
});

describe("capture — question options are stored as JSON", () => {
  it("finalize binds options_json as a JSON string (node-pg would send a JS array as a Postgres array literal)", async () => {
    state.session.metadata = { gtin: UNKNOWN };
    state.frames = [{ frameType: "barcode", quality: { gtin: UNKNOWN } }];
    const res = await invoke("capture-finalize");
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.status, "needs_question");
    const insert = sqlCalls.find((c) => /INSERT INTO capture_question/i.test(c.sql));
    assert.ok(insert, "a question is opened");
    const options = insert.params[4];
    assert.equal(typeof options, "string", "options must be serialized JSON");
    assert.deepEqual(JSON.parse(options), ["brand + shade", "upload_label_photo", "skip"]);
  });
});

describe("capture — SQL parameters Postgres must be able to type", () => {
  // Postgres cannot infer the type of a bare parameter inside jsonb_build_object (42P18,
  // "could not determine data type of parameter"), which made every matched finalize/answer
  // fail against a real database while the in-memory fakes passed.
  it("every jsonb_build_object value parameter in capture.ts carries a cast", () => {
    const fs = require("node:fs");
    const source = fs.readFileSync(path.resolve(__dirname, "../src/functions/capture.ts"), "utf8");
    const bare = [...source.matchAll(/jsonb_build_object\([^()]*?,\s*(\$\d+)(?!::)\s*\)/g)].map((m) => m[0]);
    assert.deepEqual(bare, []);
  });

  it("a matched finalize records inventoryItemId with a typed parameter", async () => {
    state.barcodes.set(CANONICAL, { skuId: String(SKU_ID), shadeId: String(SHADE_ID), brand: "OPI", productName: "X", shadeName: "X" });
    const res = await invoke("capture-finalize");
    assert.equal(res.jsonBody.status, "matched");
    const update = sqlCalls.find((c) => /UPDATE capture_session/i.test(c.sql) && /inventoryItemId/.test(c.sql));
    assert.match(update.sql, /'inventoryItemId', \$\d+::bigint/);
  });
});
