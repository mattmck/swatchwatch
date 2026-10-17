/**
 * Admin Hex Labeling routes (functions/hex-labels): request validation, queue SQL shape and
 * ordering, cursor handling, admin-only access, label upsert/undo, and the eval export of
 * manual labels (eval/hex/populate). No database: lib/db is replaced by a recording fake.
 */
const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

process.env.IMAGE_PROXY_SIGNING_KEY = "hex-labels-unit-test-signing-key-0123456789abcdef";
delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const ADMIN = 99;
const USER = 2;
const USERS = {
  [ADMIN]: { user_id: ADMIN, external_id: "ext-admin", email: null, role: "admin" },
  [USER]: { user_id: USER, external_id: "ext-user", email: null, role: "user" },
};

const CATALOG_URL = "https://swatchacct.blob.core.windows.net/source-images/holotaco/hero.png";
const GALLERY_URL = "https://swatchacct.blob.core.windows.net/source-images/holotaco/hand.png";
const USER_MEDIA_URL = "https://swatchacct.blob.core.windows.net/nail-photos/user-1/private.png";

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

let sqlCalls = [];
let transactionCount = 0;
/** Handler-specific responder: (sql, params) => result | undefined. */
let responder = () => undefined;

async function fakeQuery(via, sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ via, sql: text, params });
  if (/FROM\s+app_user/i.test(text) && /WHERE\s+user_id\s*=\s*\$1/i.test(text)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }
  const result = responder(text, params, via);
  return result ?? { rows: [], rowCount: 0 };
}

function handlerCalls() {
  return sqlCalls.filter((c) => !/FROM\s+app_user/i.test(c.sql));
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
  app: {
    http: (name, opts) => {
      registeredRoutes[name] = opts;
    },
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
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) delete require.cache[id];
});

const hexLabels = require("../dist/functions/hex-labels");
const populate = require("../dist/eval/hex/populate");

beforeEach(() => {
  sqlCalls = [];
  transactionCount = 0;
  responder = () => undefined;
  process.env.AUTH_DEV_BYPASS = "true";
});
afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
});

function fakeRequest({ method = "GET", url = "http://localhost:7071/api/hex-labels-admin/queue", userId, params = {}, body, rawBody } = {}) {
  const headers = new Map();
  if (userId !== undefined) headers.set("authorization", `Bearer dev:${userId}`);
  return {
    method,
    url,
    params,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    json: async () => {
      if (rawBody !== undefined) return JSON.parse(rawBody);
      return body;
    },
  };
}

function fakeContext() {
  return { log: () => {}, warn: () => {}, error: () => {}, invocationId: "test-invocation" };
}

function invoke(name, options) {
  const route = registeredRoutes[name];
  assert.ok(route, `route ${name} registered`);
  return route.handler(fakeRequest(options), fakeContext());
}

function queueRow(overrides = {}) {
  return {
    shadeKey: "10",
    shadeId: "10",
    brand: "Holo Taco",
    name: "Pier Pressure",
    finishes: ["creme"],
    legacyFinish: "creme",
    vendorHex: "#22BACC",
    detectedHex: "#4A90A0",
    nameHex: null,
    hexAgreement: 0.1234,
    detectedHexConfidence: 0.8,
    detectedHexMethod: "vision-direct",
    labelId: null,
    labelHex: null,
    labelStatus: null,
    labelImageId: null,
    labelNote: null,
    labelMeta: null,
    labelUserId: null,
    labelAt: null,
    labeledRank: 0,
    imageRank: 1,
    agreementRank: "0.1234",
    ...overrides,
  };
}

function imageRow(overrides = {}) {
  return {
    shadeId: "10",
    imageId: "500",
    dataSourceId: "3",
    storageUrl: CATALOG_URL,
    swatchType: "source_product",
    sourceUrl: "https://cdn.shopify.com/hero.png",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("hex-labels — route registration", () => {
  it("registers admin routes with OPTIONS and stable paths", () => {
    assert.deepEqual(registeredRoutes["admin-hex-labels-queue"].methods, ["GET", "OPTIONS"]);
    assert.equal(registeredRoutes["admin-hex-labels-queue"].route, "hex-labels-admin/queue");
    assert.deepEqual(registeredRoutes["admin-hex-labels-save"].methods, ["POST", "OPTIONS"]);
    assert.equal(registeredRoutes["admin-hex-labels-save"].route, "hex-labels-admin/labels");
    assert.deepEqual(registeredRoutes["admin-hex-labels-item"].methods, ["DELETE", "OPTIONS"]);
    assert.equal(registeredRoutes["admin-hex-labels-item"].route, "hex-labels-admin/labels/{id}");
  });
});

describe("hex-labels — admin-only access", () => {
  const cases = [
    ["admin-hex-labels-queue", { method: "GET" }],
    ["admin-hex-labels-save", { method: "POST", body: { shadeId: "10", hex: "#112233" } }],
    ["admin-hex-labels-item", { method: "DELETE", params: { id: "1" } }],
  ];
  for (const [name, options] of cases) {
    it(`${name}: 403 for a regular user, no handler SQL`, async () => {
      const res = await invoke(name, { ...options, userId: USER });
      assert.equal(res.status, 403);
      assert.deepEqual(handlerCalls(), []);
      assert.equal(transactionCount, 0);
    });
    it(`${name}: 401 without credentials`, async () => {
      const res = await invoke(name, options);
      assert.equal(res.status, 401);
      assert.deepEqual(sqlCalls, []);
    });
  }
});

describe("hex-labels — parseHexLabelRequest", () => {
  const ok = (body) => {
    const parsed = hexLabels.parseHexLabelRequest(body);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    return parsed.value;
  };
  const err = (body, pattern) => {
    const parsed = hexLabels.parseHexLabelRequest(body);
    assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(body)}`);
    assert.match(parsed.error, pattern);
  };

  it("accepts a canvas sample and uppercases the hex", () => {
    const value = ok({
      shadeId: "10",
      hex: "#22bacc",
      imageId: 500,
      note: "  bottle shot  ",
      method: "canvas",
      samplePoint: { x: 0.5, y: 0.25, size: 5, imageWidth: 1024, imageHeight: 768 },
    });
    assert.deepEqual(value, {
      shadeId: 10,
      hex: "#22BACC",
      imageId: 500,
      unreliable: false,
      note: "bottle shot",
      method: "canvas",
      samplePoint: { x: 0.5, y: 0.25, size: 5, imageWidth: 1024, imageHeight: 768 },
    });
  });

  it("allows a missing hex only when the images are flagged unreliable", () => {
    assert.equal(ok({ shadeId: 10, unreliable: true }).hex, null);
    err({ shadeId: 10 }, /hex is required/);
    err({ shadeId: 10, hex: "" }, /hex is required/);
  });

  it("rejects malformed hexes strictly (#RRGGBB only)", () => {
    for (const hex of ["22BACC", "#22BAC", "#22BACCC", "#GGGGGG", "#fff", "rgb(1,2,3)", 123]) {
      err({ shadeId: 10, hex }, /hex must be a #RRGGBB/);
    }
  });

  it("rejects bad ids (digits only, positive, safe integers)", () => {
    for (const shadeId of [undefined, null, "", "0", "-1", "12abc", "1.5", "99999999999999999999", {}, []]) {
      err({ shadeId, hex: "#112233" }, /shadeId/);
    }
    err({ shadeId: 1, hex: "#112233", imageId: "x1" }, /imageId/);
  });

  it("validates note, method, unreliable and samplePoint", () => {
    err({ shadeId: 1, hex: "#112233", note: 5 }, /note must be a string/);
    err({ shadeId: 1, hex: "#112233", note: "x".repeat(1001) }, /at most 1000/);
    err({ shadeId: 1, hex: "#112233", method: "magic" }, /method/);
    err({ shadeId: 1, hex: "#112233", unreliable: "yes" }, /unreliable/);
    const point = { x: 0.5, y: 0.5, size: 5, imageWidth: 10, imageHeight: 10 };
    err({ shadeId: 1, hex: "#112233", samplePoint: point }, /samplePoint requires imageId/);
    for (const bad of [
      { ...point, x: 1.5 },
      { ...point, y: -0.1 },
      { ...point, size: 4 },
      { ...point, imageWidth: 0 },
      { ...point, imageHeight: 1.5 },
      [],
    ]) {
      err({ shadeId: 1, hex: "#112233", imageId: 1, samplePoint: bad }, /samplePoint must be/);
    }
    err(null, /JSON object/);
    err([], /JSON object/);
  });
});

describe("hex-labels — queue cursor", () => {
  it("round-trips and rejects tampered cursors", () => {
    const cursor = { l: 0, i: 1, a: "0.1234", s: "42" };
    assert.deepEqual(hexLabels.decodeQueueCursor(hexLabels.encodeQueueCursor(cursor)), cursor);
    assert.deepEqual(hexLabels.decodeQueueCursor(hexLabels.encodeQueueCursor({ ...cursor, a: "-1" })).a, "-1");
    const bad = [
      "",
      "not-base64-json",
      Buffer.from(JSON.stringify({ ...cursor, l: 2 })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...cursor, a: "1; DROP TABLE shade" })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...cursor, s: "0" })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...cursor, s: 42 })).toString("base64url"),
      "x".repeat(600),
    ];
    for (const value of bad) assert.equal(hexLabels.decodeQueueCursor(value), null, value);
  });
});

describe("hex-labels — queue SQL shape", () => {
  const base = { brand: null, disagreeOnly: false, showLabeled: false, includeWithoutImages: false, cursor: null, limit: 21 };

  it("orders unlabeled, then with-images, then worst agreement, then shade id", () => {
    const { page } = hexLabels.buildQueueQueries(base);
    assert.match(
      page.sql,
      /ORDER BY q\."labeledRank" ASC, q\."imageRank" DESC, q\."agreementRank" DESC, q\."shadeKey" ASC\s+LIMIT \$1/
    );
    assert.deepEqual(page.params, [21]);
    assert.match(page.sql, /lbl\.training_sample_id IS NULL/, "labeled shades skipped by default");
    assert.match(page.sql, /'user_submitted' AND img\.image_count > 0/, "shades without images skipped by default");
    assert.match(page.sql, /s\.status <> 'user_submitted'/, "private user shades never queued");
    assert.match(page.sql, /ia\.owner_type = 'source'/, "only catalog images count");
    assert.match(page.sql, /lbl\.source_type = 'manual'/);
  });

  it("binds brand and disagreement filters as parameters (never interpolated)", () => {
    const brand = "Holo'; DROP TABLE shade; --";
    const { count, page } = hexLabels.buildQueueQueries({ ...base, brand, disagreeOnly: true });
    for (const stmt of [count, page]) {
      assert.ok(!stmt.sql.includes("DROP TABLE"), "brand text must not appear in SQL");
      assert.match(stmt.sql, /b\.name_canonical ILIKE \$1/);
      assert.match(stmt.sql, /s\.hex_agreement > \$2/);
      assert.equal(stmt.params[0], `%${brand}%`);
      assert.equal(stmt.params[1], 0.1);
    }
    assert.equal(count.params.length, 2);
  });

  it("showLabeled / includeWithoutImages drop the corresponding filters; count ignores showLabeled", () => {
    const { count, page } = hexLabels.buildQueueQueries({ ...base, showLabeled: true, includeWithoutImages: true });
    assert.doesNotMatch(page.sql, /lbl\.training_sample_id IS NULL/);
    assert.doesNotMatch(page.sql, /AND img\.image_count > 0/);
    assert.match(count.sql, /count\(lbl\.training_sample_id\)::int AS labeled/);
    const defaults = hexLabels.buildQueueQueries(base);
    assert.doesNotMatch(defaults.count.sql, /lbl\.training_sample_id IS NULL/, "progress counts labeled shades too");
  });

  it("adds a keyset predicate for the cursor with bound values", () => {
    const { page } = hexLabels.buildQueueQueries({ ...base, cursor: { l: 0, i: 1, a: "0.2500", s: "77" } });
    assert.match(page.sql, /q\."labeledRank" > \$1/);
    assert.match(page.sql, /q\."imageRank" < \$2/);
    assert.match(page.sql, /q\."agreementRank" < \$3::numeric/);
    assert.match(page.sql, /q\."shadeKey" > \$4::bigint/);
    assert.deepEqual(page.params, [0, 1, "0.2500", "77", 21]);
  });
});

describe("hex-labels — GET queue", () => {
  it("returns items with proxied catalog images, label, progress and a next cursor", async () => {
    responder = (sql, params) => {
      if (/count\(\*\)::int AS total/.test(sql)) return { rows: [{ total: 40, labeled: 3 }] };
      if (/FROM \(/.test(sql)) {
        assert.equal(params[params.length - 1], 3, "pageSize + 1 rows requested");
        return {
          rows: [
            queueRow(),
            queueRow({
              shadeKey: "11",
              shadeId: "11",
              finishes: [],
              legacyFinish: "holo",
              hexAgreement: null,
              agreementRank: "-1",
              labelId: "900",
              labelHex: "#ABCDEF",
              labelStatus: "approved",
              labelImageId: "501",
              labelMeta: { method: "canvas", samplePoint: { x: 0.1, y: 0.2, size: 5, imageWidth: 100, imageHeight: 50 } },
              labelUserId: String(ADMIN),
              labelAt: new Date("2026-10-17T00:00:00Z"),
              labeledRank: 1,
            }),
            queueRow({ shadeKey: "12", shadeId: "12" }),
          ],
        };
      }
      if (/FROM swatch sw/.test(sql) && /ANY\(\$1::bigint\[\]\)/.test(sql)) {
        assert.deepEqual(params, [["10", "11"]]);
        return {
          rows: [
            imageRow(),
            imageRow({ imageId: "500" }), // duplicate swatch link to the same image
            imageRow({ imageId: "501", storageUrl: GALLERY_URL, swatchType: "source_gallery", sourceUrl: null }),
            imageRow({ imageId: "502", storageUrl: USER_MEDIA_URL, swatchType: "source_gallery" }),
            imageRow({ shadeId: "11", imageId: "600", storageUrl: "https://cdn.example.com/raw.png", swatchType: "source_product" }),
          ],
        };
      }
      return undefined;
    };
    const res = await invoke("admin-hex-labels-queue", {
      userId: ADMIN,
      url: "http://localhost:7071/api/hex-labels-admin/queue?pageSize=2&brand=holo&disagreeOnly=true",
    });
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    const body = res.jsonBody;
    assert.equal(body.total, 40);
    assert.equal(body.labeled, 3);
    assert.equal(body.pageSize, 2);
    assert.equal(body.items.length, 2);
    assert.ok(body.nextCursor);
    assert.deepEqual(hexLabels.decodeQueueCursor(body.nextCursor), { l: 1, i: 1, a: "-1", s: "11" });

    const [first, second] = body.items;
    assert.equal(first.flagged, true);
    assert.deepEqual(first.finishes, ["creme"]);
    assert.equal(first.label, null);
    assert.deepEqual(first.images.map((img) => img.imageId), ["500", "501"], "deduped; private user media omitted");
    assert.match(first.images[0].url, /^http:\/\/localhost:7071\/api\/images\/v2\./);
    assert.equal(first.images[0].isPrimary, true);
    assert.equal(first.images[0].sourceUrl, "https://cdn.shopify.com/hero.png");
    assert.equal(first.images[1].isPrimary, false);
    assert.ok(!JSON.stringify(body).includes("blob.core.windows.net"), "raw storage URLs never leak");

    assert.deepEqual(second.finishes, ["holo"], "falls back to the legacy single finish");
    assert.equal(second.flagged, false);
    assert.equal(second.images[0].url, "https://cdn.example.com/raw.png", "non-blob URLs pass through");
    assert.deepEqual(second.label, {
      trainingSampleId: "900",
      shadeId: "11",
      hex: "#ABCDEF",
      unreliable: false,
      imageId: "501",
      note: null,
      method: "canvas",
      samplePoint: { x: 0.1, y: 0.2, size: 5, imageWidth: 100, imageHeight: 50 },
      labeledByUserId: String(ADMIN),
      labeledAt: "2026-10-17T00:00:00.000Z",
    });
  });

  it("returns no cursor at the end of the queue and skips the image query when empty", async () => {
    responder = (sql) => (/AS total/.test(sql) ? { rows: [{ total: 0, labeled: 0 }] } : { rows: [] });
    const res = await invoke("admin-hex-labels-queue", { userId: ADMIN });
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody.items, []);
    assert.equal(res.jsonBody.nextCursor, null);
    assert.ok(!handlerCalls().some((c) => /FROM swatch sw\s+JOIN/.test(c.sql) && /ANY/.test(c.sql)));
  });

  it("validates query parameters (400)", async () => {
    for (const qs of ["cursor=garbage", "pageSize=0", "pageSize=abc", "showLabeled=maybe", "disagreeOnly=yes"]) {
      const res = await invoke("admin-hex-labels-queue", {
        userId: ADMIN,
        url: `http://localhost:7071/api/hex-labels-admin/queue?${qs}`,
      });
      assert.equal(res.status, 400, qs);
    }
    assert.deepEqual(handlerCalls(), []);
  });

  it("caps pageSize at 100", async () => {
    responder = (sql) => (/AS total/.test(sql) ? { rows: [{ total: 0, labeled: 0 }] } : { rows: [] });
    const res = await invoke("admin-hex-labels-queue", {
      userId: ADMIN,
      url: "http://localhost:7071/api/hex-labels-admin/queue?pageSize=5000",
    });
    assert.equal(res.jsonBody.pageSize, 100);
    const page = handlerCalls().find((c) => /FROM \(/.test(c.sql));
    assert.equal(page.params[page.params.length - 1], 101);
  });
});

describe("hex-labels — POST label", () => {
  function saveResponder({ shade = true, images = [imageRow(), imageRow({ imageId: "501", storageUrl: GALLERY_URL, swatchType: "source_gallery", sourceUrl: null })], previous = null } = {}) {
    return (sql, params) => {
      if (/FROM shade s\s+JOIN brand b/.test(sql) && /WHERE s\.shade_id = \$1/.test(sql)) {
        return { rows: shade ? [{ shadeId: String(params[0]), brand: "Holo Taco", name: "Pier Pressure" }] : [] };
      }
      if (/FROM swatch sw/.test(sql)) return { rows: images };
      if (/FOR UPDATE/.test(sql)) return { rows: previous ? [previous] : [] };
      if (/INSERT INTO color_training_sample/.test(sql)) {
        return {
          rows: [
            {
              labelId: "900",
              labelHex: params[4],
              labelStatus: params[7],
              labelImageId: params[2] === null ? null : String(params[2]),
              labelNote: params[8],
              labelMeta: JSON.parse(params[10]),
              labelUserId: String(params[9]),
              labelAt: "2026-10-17T01:02:03.000Z",
            },
          ],
        };
      }
      return undefined;
    };
  }

  const body = {
    shadeId: "10",
    hex: "#22bacc",
    imageId: "501",
    note: "nail swatch photo",
    method: "canvas",
    samplePoint: { x: 0.4, y: 0.6, size: 5, imageWidth: 800, imageHeight: 600 },
  };

  it("creates a manual label (201) from the picked image without touching shade hexes", async () => {
    responder = saveResponder();
    const res = await invoke("admin-hex-labels-save", { method: "POST", userId: ADMIN, body });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.previous, null);
    assert.equal(res.jsonBody.label.hex, "#22BACC");
    assert.equal(res.jsonBody.label.unreliable, false);
    assert.equal(res.jsonBody.label.method, "canvas");

    const upsert = handlerCalls().find((c) => /INSERT INTO color_training_sample/.test(c.sql));
    assert.equal(upsert.via, "tx");
    assert.match(upsert.sql, /VALUES \(\$1, \$2, \$3, \$4::jsonb, \$5, \$6, \$7, 'manual', \$8, \$9, \$10, \$11::jsonb\)/);
    assert.match(upsert.sql, /ON CONFLICT \(shade_id\) WHERE source_type = 'manual' AND shade_id IS NOT NULL/);
    const [shadeId, dataSourceId, imageId, imageUrls, hex, colorName, brandName, status, note, labeledBy, meta] = upsert.params;
    assert.equal(shadeId, 10);
    assert.equal(dataSourceId, 3);
    assert.equal(imageId, 501);
    assert.equal(hex, "#22BACC");
    assert.equal(colorName, "Pier Pressure");
    assert.equal(brandName, "Holo Taco");
    assert.equal(status, "approved");
    assert.equal(note, "nail swatch photo");
    assert.equal(labeledBy, ADMIN);
    assert.deepEqual(JSON.parse(meta), { method: "canvas", samplePoint: body.samplePoint });
    assert.deepEqual(JSON.parse(imageUrls), [
      { url: null, storage_path: GALLERY_URL, image_id: "501", swatch_type: "source_gallery", is_primary: true },
      { url: "https://cdn.shopify.com/hero.png", storage_path: CATALOG_URL, image_id: "500", swatch_type: "source_product", is_primary: false },
    ]);
    assert.ok(!handlerCalls().some((c) => /UPDATE\s+shade\b/i.test(c.sql)), "shade hexes are never written");
    assert.equal(transactionCount, 1);
  });

  it("returns the replaced label as previous (200) so the client can undo", async () => {
    responder = saveResponder({
      previous: {
        labelId: "900",
        labelHex: "#000000",
        labelStatus: "approved",
        labelImageId: "500",
        labelNote: null,
        labelMeta: { method: "eyedropper", samplePoint: null },
        labelUserId: "5",
        labelAt: "2026-10-16T00:00:00.000Z",
      },
    });
    const res = await invoke("admin-hex-labels-save", { method: "POST", userId: ADMIN, body });
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.previous.hex, "#000000");
    assert.equal(res.jsonBody.previous.method, "eyedropper");
    const lock = handlerCalls().find((c) => /FOR UPDATE/.test(c.sql));
    assert.match(lock.sql, /source_type = 'manual'/);
  });

  it("stores an unreliable flag as rejected with no hex", async () => {
    responder = saveResponder();
    const res = await invoke("admin-hex-labels-save", { method: "POST", userId: ADMIN, body: { shadeId: "10", unreliable: true } });
    assert.equal(res.status, 201);
    assert.equal(res.jsonBody.label.unreliable, true);
    assert.equal(res.jsonBody.label.hex, null);
    const upsert = handlerCalls().find((c) => /INSERT INTO color_training_sample/.test(c.sql));
    assert.equal(upsert.params[4], null);
    assert.equal(upsert.params[7], "rejected");
    // No picked image: the shade's primary product image is the one the eval would score.
    assert.equal(JSON.parse(upsert.params[3])[0].image_id, "500");
    assert.equal(JSON.parse(upsert.params[3])[0].is_primary, true);
  });

  it("400 for invalid input, before any SQL", async () => {
    for (const bad of [{ shadeId: "10", hex: "22BACC" }, { shadeId: "abc", hex: "#22BACC" }, {}]) {
      const res = await invoke("admin-hex-labels-save", { method: "POST", userId: ADMIN, body: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    const res = await invoke("admin-hex-labels-save", { method: "POST", userId: ADMIN, rawBody: "{not json" });
    assert.equal(res.status, 400);
    assert.deepEqual(handlerCalls(), []);
  });

  it("404 when the shade does not exist", async () => {
    responder = saveResponder({ shade: false });
    const res = await invoke("admin-hex-labels-save", { method: "POST", userId: ADMIN, body });
    assert.equal(res.status, 404);
    assert.equal(transactionCount, 0);
  });

  it("400 when the image is not one of the shade's catalog images", async () => {
    responder = saveResponder();
    const res = await invoke("admin-hex-labels-save", { method: "POST", userId: ADMIN, body: { ...body, imageId: "777" } });
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /not one of this shade's catalog images/);
    assert.equal(transactionCount, 0);
    const imageQuery = handlerCalls().find((c) => /FROM swatch sw/.test(c.sql));
    assert.match(imageQuery.sql, /ia\.owner_type = 'source'/, "user media can never be a label image");
    assert.deepEqual(imageQuery.params, [["10"]]);
  });
});

describe("hex-labels — DELETE label (undo)", () => {
  it("deletes only manual labels", async () => {
    responder = (sql) => (/DELETE FROM color_training_sample/.test(sql) ? { rows: [{ id: "900" }] } : undefined);
    const res = await invoke("admin-hex-labels-item", { method: "DELETE", userId: ADMIN, params: { id: "900" } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody, { deleted: "900" });
    const del = handlerCalls().find((c) => /DELETE/.test(c.sql));
    assert.match(del.sql, /training_sample_id = \$1\s+AND source_type = 'manual'/);
    assert.deepEqual(del.params, [900]);
  });

  it("404 when nothing matched, 400 for a bad id", async () => {
    const missing = await invoke("admin-hex-labels-item", { method: "DELETE", userId: ADMIN, params: { id: "901" } });
    assert.equal(missing.status, 404);
    for (const id of ["abc", "0", "1e3", ""]) {
      const res = await invoke("admin-hex-labels-item", { method: "DELETE", userId: ADMIN, params: { id } });
      assert.equal(res.status, 400, id);
    }
  });
});

describe("hex-labels — image helpers", () => {
  it("readableCatalogImageUrl: v2 proxy for catalog blobs, passthrough for CDN URLs, null otherwise", () => {
    const req = "http://localhost:7071/api/hex-labels-admin/queue";
    assert.match(hexLabels.readableCatalogImageUrl(CATALOG_URL, req), /^http:\/\/localhost:7071\/api\/images\/v2\./);
    assert.equal(hexLabels.readableCatalogImageUrl(USER_MEDIA_URL, req), null);
    assert.equal(hexLabels.readableCatalogImageUrl("http://127.0.0.1:10000/devstoreaccount1/other/x.png", req), null);
    assert.equal(hexLabels.readableCatalogImageUrl("https://cdn.example.com/a.png", req), "https://cdn.example.com/a.png");
    assert.equal(hexLabels.readableCatalogImageUrl("javascript:alert(1)", req), null);
    assert.equal(hexLabels.readableCatalogImageUrl("  ", req), null);
  });

  it("buildManualLabelImageUrls puts the picked image first and only http(s) vendor URLs in url", () => {
    const rows = [imageRow(), imageRow({ imageId: "501", storageUrl: GALLERY_URL, sourceUrl: "ftp://nope" })];
    const entries = hexLabels.buildManualLabelImageUrls(rows, 501);
    assert.deepEqual(entries.map((e) => [e.image_id, e.is_primary, e.url]), [
      ["501", true, null],
      ["500", false, "https://cdn.shopify.com/hero.png"],
    ]);
    assert.deepEqual(hexLabels.buildManualLabelImageUrls([], null), []);
  });
});

describe("eval export of manual labels (populate)", () => {
  const manualRow = (overrides = {}) => ({
    trainingSampleId: 77,
    hex: "#22BACC",
    colorName: "Pier Pressure",
    brandName: "Holo Taco",
    productName: null,
    productHandle: null,
    imageUrls: [
      { url: "https://cdn.shopify.com/hand.png", storage_path: GALLERY_URL, image_id: "501", is_primary: true },
      { url: "https://cdn.shopify.com/hero.png", storage_path: CATALOG_URL, image_id: "500", is_primary: false },
    ],
    sourceType: "manual",
    trainingStatus: "approved",
    notes: "nail swatch photo",
    sourceName: "HoloTacoShopify",
    externalId: null,
    tags: null,
    finishes: ["creme"],
    bodyHtml: null,
    labelMeta: { method: "canvas", samplePoint: { x: 0.4, y: 0.6, size: 5, imageWidth: 800, imageHeight: 600 } },
    imageId: "501",
    ...overrides,
  });

  it("exports a manual label as a `manual` case scored on the sampled image", () => {
    const c = populate.trainingSampleToEvalCase(manualRow());
    assert.equal(c.groundTruthSource, "manual");
    assert.equal(c.groundTruthHex, "#22BACC");
    assert.equal(c.imageUrl, "https://cdn.shopify.com/hand.png");
    assert.deepEqual(c.finishes, ["creme"]);
    assert.match(c.notes, /manual label \(canvas\) 5x5 px at \(0\.400, 0\.600\) of image_asset 501/);
    assert.match(c.notes, /nail swatch photo/);
  });

  it("skips a manual label whose sampled image has no public URL (never scores another image)", () => {
    const row = manualRow({
      imageUrls: [
        { url: null, storage_path: GALLERY_URL, image_id: "501", is_primary: true },
        { url: "https://cdn.shopify.com/hero.png", storage_path: CATALOG_URL, image_id: "500", is_primary: false },
      ],
    });
    assert.equal(populate.trainingSampleToEvalCase(row), null);
  });

  it("export SQL filters source types and never exports a NULL hex", () => {
    assert.match(populate.READ_SAMPLES_FOR_EXPORT_SQL, /cts\.hex IS NOT NULL/);
    assert.match(populate.READ_SAMPLES_FOR_EXPORT_SQL, /\$3::text\[\] IS NULL OR cts\.source_type = ANY\(\$3::text\[\]\)/);
    assert.match(populate.READ_SAMPLES_FOR_EXPORT_SQL, /LEFT JOIN shade s ON s\.shade_id = cts\.shade_id/);
  });

  it("parses --source-type", () => {
    assert.deepEqual(populate.parsePopulateArgs(["--source-type", "manual, vendor_option"]).sourceTypes, ["manual", "vendor_option"]);
    assert.equal(populate.parsePopulateArgs([]).sourceTypes, null);
    assert.throws(() => populate.parsePopulateArgs(["--source-type"]), /requires a value/);
  });

  it("describeManualLabel tolerates missing metadata", () => {
    assert.equal(populate.describeManualLabel(null, null), null);
    assert.equal(populate.describeManualLabel(null, "5"), "manual label from image_asset 5");
    assert.equal(populate.describeManualLabel({ method: "eyedropper", samplePoint: null }, null), "manual label (eyedropper)");
  });
});
