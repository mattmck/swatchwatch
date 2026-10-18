/**
 * Unit tests for pre-generated catalog thumbnails ("image variants"):
 * - lib/image-variants: blob naming, storage URL derivation, transform → variant matching/snapping,
 *   and the product-framing crop (trim the flat background, square around the product)
 * - functions/images: square cover WebP requests are served from the variant blob, snapped to the
 *   ladder, and fall back to on-the-fly resizing when the variant is missing; private (v3) media
 *   and non-matching transforms never read variants; scope/Cache-Control rules are unchanged
 * - functions/image-variants-admin: the keyset-paginated, idempotent backfill
 */
const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const sharp = require("sharp");

const registeredRoutes = {};
const mockModules = {
  "@azure/functions": {
    app: {
      http: (name, opts) => {
        registeredRoutes[name] = opts;
      },
    },
  },
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (Object.prototype.hasOwnProperty.call(mockModules, request)) return request;
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

let imageAssetRows = [];
const dbCalls = [];
const DB_MODULE_PATH = path.resolve(__dirname, "../dist/lib/db.js");
require.cache[DB_MODULE_PATH] = {
  id: DB_MODULE_PATH,
  filename: DB_MODULE_PATH,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      dbCalls.push({ sql, params });
      if (/FROM\s+image_asset/i.test(sql)) {
        const [after, limit] = params;
        return { rows: imageAssetRows.filter((row) => row.image_id > after).slice(0, limit) };
      }
      if (/FROM\s+app_user/i.test(sql)) {
        const userId = Number(params[0]);
        return { rows: [{ user_id: userId, external_id: `ext-${userId}`, email: null, role: "user" }] };
      }
      return { rows: [] };
    },
    transaction: async () => {
      throw new Error("transactions are not expected in image variant tests");
    },
  },
};

const variants = require("../dist/lib/image-variants");
const imageProxy = require("../dist/lib/image-proxy");
const images = require("../dist/functions/images");
const variantsAdmin = require("../dist/functions/image-variants-admin");

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) delete require.cache[id];
  delete require.cache[DB_MODULE_PATH];
});

const KEY = "test-image-proxy-signing-key-0123456789abcdef";
const BLOB_URL = "https://swatchtest.blob.core.windows.net/source-images/holotaco/a-0123456789ab.png";
const PRIVATE_URL = "https://swatchtest.blob.core.windows.net/nail-photos/user-7/a.png";
const STORAGE_CONNECTION = `DefaultEndpointsProtocol=https;AccountName=swatchtest;AccountKey=${Buffer.from(
  "test-key"
).toString("base64")};EndpointSuffix=core.windows.net`;
const ENV_KEYS = [
  "IMAGE_PROXY_SIGNING_KEY",
  "AZURE_STORAGE_CONNECTION",
  "SOURCE_IMAGE_CONTAINER",
  "USER_MEDIA_CONTAINER",
  "AUTH_DEV_BYPASS",
];

let saved = {};
const originalFetch = global.fetch;
beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.IMAGE_PROXY_SIGNING_KEY = KEY;
  process.env.AZURE_STORAGE_CONNECTION = STORAGE_CONNECTION;
  imageProxy.resetImageProxySigningStateForTests();
  dbCalls.length = 0;
  imageAssetRows = [];
});
afterEach(() => {
  global.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

let originalPng;
async function fixturePng() {
  originalPng ??= await sharp({
    create: { width: 600, height: 400, channels: 3, background: { r: 200, g: 20, b: 120 } },
  })
    .png()
    .toBuffer();
  return originalPng;
}

/**
 * Fake blob storage: `blobs` maps blob URL → { body, contentType, etag }. Records every request.
 */
function mockStorage(blobs) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const key = String(url);
    calls.push({ method, url: key, body: init.body });
    const blob = blobs[key];
    if (method === "PUT") {
      blobs[key] = { body: Buffer.from(init.body), contentType: init.headers["Content-Type"], etag: '"new"' };
      return new Response(null, { status: 201 });
    }
    if (!blob) return new Response("missing", { status: 404, statusText: "Not Found" });
    if (method === "HEAD") return new Response(null, { status: 200 });
    return new Response(blob.body, {
      status: 200,
      headers: {
        "content-type": blob.contentType,
        etag: blob.etag ?? '"etag-1"',
        "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT",
      },
    });
  };
  return calls;
}

function fakeRequest(id, query = "", headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: "GET",
    url: `http://localhost:7071/api/images/${id}${query}`,
    params: { id },
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
  };
}
const fakeContext = () => ({ log: () => {}, warn: () => {}, error: () => {} });

describe("lib/image-variants", () => {
  it("names variants by pixel size next to the original", () => {
    assert.equal(variants.IMAGE_VARIANT_CROP_VERSION, 1);
    assert.equal(variants.imageVariantBlobName("shop/a-123.jpg", 128), "shop/a-123.jpg.c1.w128.webp");
    assert.equal(variants.isImageVariantBlobName("shop/a-123.jpg.c1.w128.webp"), true);
    assert.equal(variants.isImageVariantBlobName("shop/a-123.jpg.w128.webp"), true);
    assert.equal(variants.isImageVariantBlobName("shop/a-123.jpg"), false);
  });

  it("derives the variant storage URL in the same container", () => {
    assert.equal(variants.imageVariantStorageUrl(BLOB_URL, 64), `${BLOB_URL}.c1.w64.webp`);
    // Path-style (Azurite) URLs keep their account segment.
    assert.equal(
      variants.imageVariantStorageUrl("http://127.0.0.1:10000/devstore/source-images/x.png", 256),
      "http://127.0.0.1:10000/devstore/source-images/x.png.c1.w256.webp"
    );
  });

  it("refuses URLs that cannot carry a variant", () => {
    assert.equal(variants.imageVariantStorageUrl("not a url", 64), null);
    assert.equal(variants.imageVariantStorageUrl(`${BLOB_URL}?comp=list`, 64), null);
    assert.equal(variants.imageVariantStorageUrl(`${BLOB_URL}.c1.w64.webp`, 64), null);
  });

  it("matches only square cover WebP requests at the variant quality, snapping up", () => {
    const base = { fit: "cover", format: "webp", quality: 72 };
    assert.equal(variants.matchImageVariantSize({ ...base, width: 96, height: 96 }), 128);
    assert.equal(variants.matchImageVariantSize({ ...base, width: 64, height: 64 }), 64);
    assert.equal(variants.matchImageVariantSize({ ...base, width: 16, height: 16 }), 64);
    assert.equal(variants.matchImageVariantSize({ ...base, width: 513, height: 513 }), null);
    assert.equal(variants.matchImageVariantSize({ ...base, width: 96, height: 64 }), null);
    assert.equal(variants.matchImageVariantSize({ ...base, width: 96 }), null);
    assert.equal(variants.matchImageVariantSize({ ...base, fit: "inside", width: 96, height: 96 }), null);
    assert.equal(variants.matchImageVariantSize({ ...base, format: "jpeg", width: 96, height: 96 }), null);
    assert.equal(variants.matchImageVariantSize({ ...base, format: undefined, width: 96, height: 96 }), null);
    assert.equal(variants.matchImageVariantSize({ ...base, quality: 90, width: 96, height: 96 }), null);
  });

  /** Mean RGB of an encoded image. */
  async function meanColor(buf) {
    const { channels } = await sharp(buf).removeAlpha().stats();
    return channels.slice(0, 3).map((c) => Math.round(c.mean));
  }
  /** A `w`×`h` red product at (`left`, `top`) on a white `size`×`size` studio background. */
  function studioShot({ size = 1000, left, top, w, h }) {
    return sharp({ create: { width: size, height: size, channels: 3, background: "#ffffff" } })
      .composite([
        {
          input: { create: { width: w, height: h, channels: 3, background: { r: 220, g: 20, b: 40 } } },
          left,
          top,
        },
      ])
      .png()
      .toBuffer();
  }

  it("frames an off-center product on a flat background instead of the empty center", async () => {
    // A small product in the top-right corner of a white square: the plain resize is ~97% white.
    const shot = await studioShot({ left: 760, top: 60, w: 160, h: 160 });
    const plan = await variants.planImageVariantCrop(shot);
    assert.ok(plan, "a flat-background studio shot gets a product crop");
    assert.ok(plan.left > 600 && plan.top < 100, `crop is around the product: ${JSON.stringify(plan)}`);
    assert.equal(plan.width, plan.height);

    const [r, g] = await meanColor(await variants.renderImageVariant(shot, 128));
    assert.ok(r > 180 && g < 120, `variant is mostly product, got r=${r} g=${g}`);
    const centered = await sharp(shot).resize({ width: 128, height: 128, fit: "cover" }).png().toBuffer();
    assert.ok((await meanColor(centered))[1] > 240, "the plain center crop is mostly background");
  });

  it("keeps a tall bottle's body: the square is at least 65% of its height", async () => {
    const shot = await studioShot({ left: 450, top: 100, w: 100, h: 800 });
    const plan = await variants.planImageVariantCrop(shot);
    assert.ok(plan);
    assert.ok(plan.width >= 0.65 * 800 && plan.width <= 0.65 * 800 * 1.1, `side ${plan.width}`);
    // Centered on the bottle (center y = 500).
    assert.ok(Math.abs(plan.top + plan.height / 2 - 500) < 12);
  });

  it("pads with the background when the square would leave the image", async () => {
    // Tall 400×1000 image filled top to bottom by a narrow product: the square (≈ 700px) is wider
    // than the image, so the crop is clamped and the variant padded with the white background.
    const shot = await sharp({ create: { width: 400, height: 1000, channels: 3, background: "#ffffff" } })
      .composite([{ input: { create: { width: 80, height: 990, channels: 3, background: "#dc1428" } }, left: 160, top: 5 }])
      .png()
      .toBuffer();
    const plan = await variants.planImageVariantCrop(shot);
    assert.ok(plan);
    assert.equal(plan.width, 400);
    const variant = await variants.renderImageVariant(shot, 128, plan);
    const meta = await sharp(variant).metadata();
    assert.equal(meta.width, 128);
    assert.equal(meta.height, 128);
    const { data } = await sharp(variant).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data.subarray(0, 3)].map((v) => v > 240), [true, true, true], "corner is background white");
  });

  it("center-crops photos without a flat background", async () => {
    const { randomBytes } = require("node:crypto");
    const noise = await sharp(randomBytes(300 * 200 * 3), { raw: { width: 300, height: 200, channels: 3 } }).png().toBuffer();
    assert.equal(await variants.planImageVariantCrop(noise), null);
    const expected = await sharp(noise)
      .rotate()
      .resize({ width: 128, height: 128, fit: "cover", withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
    assert.deepEqual(await variants.renderImageVariant(noise, 128), expected);
  });

  it("center-crops uniform and undecodable images without throwing", async () => {
    const flat = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#336699" } }).png().toBuffer();
    assert.equal(await variants.planImageVariantCrop(flat), null);
    assert.equal(await variants.planImageVariantCrop(Buffer.from("not-an-image")), null);
  });

  it("keeps the shared ladder in the documented order", () => {
    assert.deepEqual([...variants.IMAGE_VARIANT_SIZES], [64, 128, 256, 512]);
    assert.equal(variants.IMAGE_VARIANT_QUALITY, 72);
  });
});

describe("functions/images — pre-generated variants", () => {
  const VARIANT_QUERY = "?w=96&h=96&fit=cover&fm=webp&q=72";

  it("serves a stored variant without reading the original", async () => {
    const variantBody = Buffer.from("variant-128-bytes");
    const calls = mockStorage({
      [`${BLOB_URL}.c1.w128.webp`]: { body: variantBody, contentType: "image/webp", etag: '"variant-etag"' },
      [BLOB_URL]: { body: await fixturePng(), contentType: "image/png" },
    });
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    const res = await images.imagesHandler(fakeRequest(id, VARIANT_QUERY), fakeContext());

    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(res.body), variantBody);
    assert.deepEqual(calls.map((call) => call.url), [`${BLOB_URL}.c1.w128.webp`]);
    assert.equal(res.headers.get("Content-Type"), "image/webp");
    assert.equal(res.headers.get("ETag"), '"variant-etag"');
    assert.match(res.headers.get("Cache-Control"), /^public, max-age=86400, stale-while-revalidate=\d+$/);
    assert.match(res.headers.get("Vary"), /Origin/);
  });

  it("falls back to resizing the original, at the snapped size, when the variant is missing", async () => {
    const calls = mockStorage({ [BLOB_URL]: { body: await fixturePng(), contentType: "image/png" } });
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    const res = await images.imagesHandler(fakeRequest(id, VARIANT_QUERY), fakeContext());

    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((call) => call.url), [`${BLOB_URL}.c1.w128.webp`, BLOB_URL]);
    const meta = await sharp(Buffer.from(res.body)).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, 128);
    assert.equal(meta.height, 128);
    assert.match(res.headers.get("Cache-Control"), /^public, max-age=86400/);
    assert.equal(calls.filter((call) => call.method === "PUT").length, 0, "the proxy never writes blobs");
  });

  it("renders the same pixels on a miss as the ingest-time variant", async () => {
    const png = await fixturePng();
    mockStorage({ [BLOB_URL]: { body: png, contentType: "image/png" } });
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    const res = await images.imagesHandler(fakeRequest(id, "?w=128&h=128&fit=cover&fm=webp"), fakeContext());
    const stored = await variants.renderImageVariant(png, 128);
    assert.deepEqual(Buffer.from(res.body), stored);
  });

  it("falls back when the variant read fails with a server error", async () => {
    const png = await fixturePng();
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith(".c1.w128.webp")) return new Response("busy", { status: 503 });
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    };
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    const res = await images.imagesHandler(fakeRequest(id, VARIANT_QUERY), fakeContext());
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
  });

  it("keeps non-variant transforms on the exact requested size", async () => {
    const calls = mockStorage({ [BLOB_URL]: { body: await fixturePng(), contentType: "image/png" } });
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    const res = await images.imagesHandler(fakeRequest(id, "?w=96&h=96&fit=inside&fm=webp"), fakeContext());
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((call) => call.url), [BLOB_URL]);
    const meta = await sharp(Buffer.from(res.body)).metadata();
    assert.equal(meta.width, 96);
  });

  it("serves untransformed requests from the original", async () => {
    const png = await fixturePng();
    const calls = mockStorage({ [BLOB_URL]: { body: png, contentType: "image/png" } });
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    const res = await images.imagesHandler(fakeRequest(id), fakeContext());
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((call) => call.url), [BLOB_URL]);
    assert.deepEqual(Buffer.from(res.body), png);
  });

  it("never reads variants for owner-scoped (v3) private media", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const calls = mockStorage({ [PRIVATE_URL]: { body: await fixturePng(), contentType: "image/png" } });
    const id = imageProxy.encodeImageProxyId(PRIVATE_URL, { ownerUserId: 7 });
    const res = await images.imagesHandler(
      fakeRequest(id, VARIANT_QUERY, { authorization: "Bearer dev:7" }),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((call) => call.url), [PRIVATE_URL]);
    const meta = await sharp(Buffer.from(res.body)).metadata();
    assert.equal(meta.width, 96, "private transforms are not snapped");
    assert.equal(res.headers.get("Cache-Control"), "private, max-age=300");
  });

  it("still refuses forged ids before touching storage", async () => {
    const calls = mockStorage({});
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    const forged = `${id.slice(0, -2)}${id.endsWith("AA") ? "BB" : "AA"}`;
    const res = await images.imagesHandler(fakeRequest(forged, VARIANT_QUERY), fakeContext());
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it("returns 404 when neither the variant nor the original exists", async () => {
    mockStorage({});
    const id = imageProxy.encodeImageProxyId(BLOB_URL);
    const res = await images.imagesHandler(fakeRequest(id, VARIANT_QUERY), fakeContext());
    assert.equal(res.status, 404);
  });
});

describe("functions/image-variants-admin — backfill", () => {
  const SIZES = [64, 128, 256, 512];
  const blobUrl = (name) => `https://swatchtest.blob.core.windows.net/source-images/shop/${name}`;
  const backfill = (body) =>
    variantsAdmin.backfillImageVariants(
      { text: async () => (body === undefined ? "" : JSON.stringify(body)) },
      fakeContext()
    );

  it("registers an admin POST route", () => {
    const route = registeredRoutes["image-variants-admin-backfill"];
    assert.ok(route);
    assert.equal(route.route, "images-admin/variants/backfill");
    assert.deepEqual(route.methods, ["POST", "OPTIONS"]);
  });

  it("writes missing variants, skips complete and non-catalog rows, and pages by image_id", async () => {
    const png = await fixturePng();
    const blobs = {
      [blobUrl("a.png")]: { body: png, contentType: "image/png" },
      [blobUrl("b.png")]: { body: png, contentType: "image/png" },
    };
    for (const size of SIZES) {
      blobs[`${blobUrl("b.png")}.c1.w${size}.webp`] = { body: Buffer.from("x"), contentType: "image/webp" };
    }
    const calls = mockStorage(blobs);
    imageAssetRows = [
      { image_id: 1, storage_url: blobUrl("a.png") },
      { image_id: 2, storage_url: blobUrl("b.png") },
      { image_id: 3, storage_url: "https://cdn.shop.example/c.png" },
    ];

    const res = await backfill({ limit: 3 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.jsonBody, {
      scanned: 3,
      checked: 2,
      complete: 1,
      variantsWritten: 4,
      skipped: 1,
      failures: [],
      nextAfterImageId: 3,
    });
    for (const size of SIZES) {
      assert.ok(blobs[`${blobUrl("a.png")}.c1.w${size}.webp`], `${size}px variant written`);
    }
    assert.equal(
      calls.filter((call) => call.method === "GET" && call.url === blobUrl("b.png")).length,
      0,
      "a complete image's original is never read"
    );
    assert.match(dbCalls[0].sql, /owner_type = 'source'/);
    assert.deepEqual(dbCalls[0].params, [0, 3]);

    const next = await backfill({ afterImageId: 3, limit: 3 });
    assert.equal(next.jsonBody.scanned, 0);
    assert.equal(next.jsonBody.nextAfterImageId, null);
  });

  it("is idempotent: a second run writes nothing", async () => {
    const blobs = { [blobUrl("a.png")]: { body: await fixturePng(), contentType: "image/png" } };
    mockStorage(blobs);
    imageAssetRows = [{ image_id: 5, storage_url: blobUrl("a.png") }];
    assert.equal((await backfill()).jsonBody.variantsWritten, 4);
    const second = await backfill();
    assert.equal(second.jsonBody.variantsWritten, 0);
    assert.equal(second.jsonBody.complete, 1);
    assert.equal(second.jsonBody.nextAfterImageId, null);
  });

  it("reports an image whose original cannot be read", async () => {
    mockStorage({});
    imageAssetRows = [{ image_id: 9, storage_url: blobUrl("gone.png") }];
    const res = await backfill();
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.failures.length, 1);
    assert.equal(res.jsonBody.failures[0].imageId, 9);
  });

  it("validates the body", async () => {
    assert.equal((await backfill({ limit: 0 })).status, 400);
    assert.equal((await backfill({ limit: 101 })).status, 400);
    assert.equal((await backfill({ afterImageId: -1 })).status, 400);
    assert.equal((await backfill({ afterImageId: "1" })).status, 400);
    const bad = await variantsAdmin.backfillImageVariants({ text: async () => "{" }, fakeContext());
    assert.equal(bad.status, 400);
  });

  it("returns 503 without a storage account", async () => {
    delete process.env.AZURE_STORAGE_CONNECTION;
    assert.equal((await backfill()).status, 503);
  });
});
