/**
 * Shareable wishlist (issue #268) unit tests. No database: handler modules load from dist/ with
 * `@azure/functions`, `jose` and `../lib/db` swapped via require interception (same approach as
 * access-control.unit.test.cjs). The fake DB honours the SQL predicates the handlers send
 * (`user_id = $n`, `ui.status = 'wishlist'`, `s.status <> 'user_submitted'`), so a handler that
 * dropped one would visibly leak rows and fail here.
 *
 * Users: OWNER = 1, ATTACKER = 2 (dev-bypass tokens `Bearer dev:<id>`).
 */
const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const SIGNING_KEY = "wishlist-share-unit-test-signing-key-0123456789";
process.env.IMAGE_PROXY_SIGNING_KEY = SIGNING_KEY;
process.env.AUTH_DEV_BYPASS = "true";
delete process.env.WEBSITE_INSTANCE_ID;
delete process.env.WEBSITE_HOSTNAME;
delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;
delete process.env.SOURCE_IMAGE_CONTAINER;
delete process.env.USER_MEDIA_CONTAINER;

const OWNER = 1;
const ATTACKER = 2;
const USERS = {
  [OWNER]: { user_id: OWNER, external_id: "ext-owner-secret", email: "owner@test.dev", role: "user" },
  [ATTACKER]: { user_id: ATTACKER, external_id: "ext-attacker", email: "attacker@test.dev", role: "user" },
};

const CATALOG_IMAGE = "https://acct.blob.core.windows.net/source-images/catalog/holo.png";
const PRIVATE_IMAGE = "https://acct.blob.core.windows.net/nail-photos/1/private.png";
const OWNER_SECRET_NOTES = "owner-secret-notes";

/** shade_id -> shade (shared catalog). */
const SHADES = {
  501: { brand: "Holo Taco", name: "Scattered Holo", finish: "holo", finishes: ["holo", "glitter"], vendorHex: "#AA0000", detectedHex: "#AB0101", nameHex: null, status: "active", imageUrl: CATALOG_IMAGE },
  502: { brand: "OPI", name: "Owned Red", finish: "creme", finishes: ["creme"], vendorHex: "#FF0000", detectedHex: null, nameHex: null, status: "active", imageUrl: null },
  503: { brand: "OPI", name: "Destash Blue", finish: "creme", finishes: ["creme"], vendorHex: "#0000FF", detectedHex: null, nameHex: null, status: "active", imageUrl: null },
  504: { brand: "My Brand", name: "My Private Submission", finish: "creme", finishes: [], vendorHex: null, detectedHex: null, nameHex: "#123456", status: "user_submitted", imageUrl: null },
  505: { brand: "Essie", name: "Detected Only", finish: "creme", finishes: [], vendorHex: null, detectedHex: "#00AA00", nameHex: "#00FF00", status: "active", imageUrl: PRIVATE_IMAGE },
  601: { brand: "Zoya", name: "Attacker Wish", finish: "creme", finishes: ["creme"], vendorHex: "#ABCDEF", detectedHex: null, nameHex: null, status: "active", imageUrl: null },
};

/** Inventory rows; the extra fields are what a careless SELECT/mapper would leak. */
const INVENTORY = [
  { userId: OWNER, shadeId: 501, status: "wishlist", quantity: 0, notes: OWNER_SECRET_NOTES, purchasePrice: 12.5, purchaseCurrency: "CHF", rating: 5 },
  { userId: OWNER, shadeId: 502, status: "owned", quantity: 2, notes: OWNER_SECRET_NOTES, purchasePrice: 9, purchaseCurrency: "USD", rating: 4 },
  { userId: OWNER, shadeId: 503, status: "destash", quantity: 1, notes: null, purchasePrice: null, purchaseCurrency: null, rating: null },
  { userId: OWNER, shadeId: 504, status: "wishlist", quantity: 0, notes: OWNER_SECRET_NOTES, purchasePrice: null, purchaseCurrency: null, rating: null },
  { userId: OWNER, shadeId: 505, status: "wishlist", quantity: 0, notes: null, purchasePrice: 3.25, purchaseCurrency: "EUR", rating: 2 },
  { userId: ATTACKER, shadeId: 601, status: "wishlist", quantity: 0, notes: "attacker-notes", purchasePrice: null, purchaseCurrency: null, rating: null },
];

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

let sqlCalls = [];
/** userId -> share row */
let shares = new Map();
let clock = 0;

function resetDb() {
  sqlCalls = [];
  shares = new Map();
  clock = Date.parse("2026-10-17T00:00:00Z");
}

function nowIso() {
  clock += 1000;
  return new Date(clock).toISOString();
}

function userIdPlaceholders(sql) {
  return [...String(sql).matchAll(/\buser_id\s*=\s*\$(\d+)/gi)].map((m) => Number(m[1]));
}

/** The single user id a statement is scoped to, or undefined (unscoped = sees everyone). */
function boundUserId(sql, params) {
  const values = new Set(userIdPlaceholders(sql).map((n) => Number(params[n - 1])));
  return values.size === 1 ? [...values][0] : undefined;
}

function shareRowOut(row) {
  return {
    tokenSalt: row.tokenSalt,
    tokenHash: row.tokenHash,
    displayName: row.displayName,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
  };
}

function inventoryFor(sql, userId, { ignoreCatalogPredicate = false } = {}) {
  const text = String(sql);
  const wishlistOnly = /ui\.status\s*=\s*'wishlist'/i.test(text);
  const catalogOnly = !ignoreCatalogPredicate && /s\.status\s*<>\s*'user_submitted'/i.test(text);
  return INVENTORY.filter(
    (item) =>
      (userId === undefined || item.userId === userId) &&
      (!wishlistOnly || item.status === "wishlist") &&
      (!catalogOnly || SHADES[item.shadeId].status !== "user_submitted")
  );
}

async function fakeQuery(sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ sql: text, params });

  if (/FROM\s+app_user/i.test(text) && /WHERE\s+user_id\s*=\s*\$1/i.test(text)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }

  if (/wishlist_share/i.test(text)) {
    if (/^\s*INSERT/i.test(text)) {
      const [userId, tokenHash, tokenSalt, displayName, setDisplayName] = params;
      const existing = shares.get(Number(userId));
      if (existing) {
        if (setDisplayName) existing.displayName = displayName;
        return { rows: [shareRowOut(existing)], rowCount: 1 };
      }
      const at = nowIso();
      const row = { userId: Number(userId), tokenHash, tokenSalt, displayName, createdAt: at, rotatedAt: at };
      shares.set(row.userId, row);
      return { rows: [shareRowOut(row)], rowCount: 1 };
    }
    if (/^\s*UPDATE/i.test(text)) {
      const userId = boundUserId(text, params);
      const targets = [...shares.values()].filter((row) => userId === undefined || row.userId === userId);
      for (const row of targets) {
        row.tokenSalt = params[1];
        row.tokenHash = params[2];
        row.rotatedAt = nowIso();
      }
      return { rows: targets.map(shareRowOut), rowCount: targets.length };
    }
    if (/^\s*DELETE/i.test(text)) {
      const userId = boundUserId(text, params);
      const targets = [...shares.values()].filter((row) => userId === undefined || row.userId === userId);
      for (const row of targets) shares.delete(row.userId);
      return { rows: [], rowCount: targets.length };
    }
    // SELECT by token hash (public) or by owner.
    if (/token_hash\s*=\s*\$1/i.test(text)) {
      const row = [...shares.values()].find((r) => r.tokenHash === params[0]);
      return row
        ? { rows: [{ userId: String(row.userId), displayName: row.displayName }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    const userId = boundUserId(text, params);
    const rows = [...shares.values()].filter((r) => userId === undefined || r.userId === userId).map(shareRowOut);
    return { rows, rowCount: rows.length };
  }

  if (/user_inventory_item/i.test(text) && /COUNT\(\*\)/i.test(text)) {
    // The count query splits by catalog status with FILTER clauses instead of a WHERE predicate.
    const items = inventoryFor(text, boundUserId(text, params), { ignoreCatalogPredicate: true });
    const visible = items.filter((i) => SHADES[i.shadeId].status !== "user_submitted").length;
    return { rows: [{ visible, hidden: items.length - visible }], rowCount: 1 };
  }

  if (/user_inventory_item/i.test(text)) {
    const items = inventoryFor(text, boundUserId(text, params));
    // Return every column a careless query could have selected; the mapper must drop extras.
    const rows = items.map((item) => ({
      ...SHADES[item.shadeId],
      shadeId: String(item.shadeId),
      userId: String(item.userId),
      email: USERS[item.userId].email,
      notes: item.notes,
      quantity: item.quantity,
      purchasePrice: item.purchasePrice,
      purchaseCurrency: item.purchaseCurrency,
      rating: item.rating,
      status: item.status,
    }));
    return { rows, rowCount: rows.length };
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
  app: {
    http: (name, opts) => {
      registeredRoutes[name] = opts;
    },
    storageQueue: () => {},
    timer: () => {},
  },
});
registerMock("jose", {
  errors: { JOSEError: class JOSEError extends Error {} },
  createRemoteJWKSet: () => {},
  jwtVerify: async () => {
    throw new Error("JWT validation is not exercised here");
  },
});
const dbMock = {
  query: (sql, params) => fakeQuery(sql, params),
  transaction: async (cb) => cb({ query: (sql, params) => fakeQuery(sql, params) }),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);

for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const handlers = require("../dist/functions/wishlist-share.js");
const shareLib = require("../dist/lib/wishlist-share.js");
const { TokenBucketLimiter, clientIpFromHeaders } = require("../dist/lib/rate-limit.js");
const { resetImageProxySigningStateForTests } = require("../dist/lib/image-proxy.js");

after(() => {
  Module._resolveFilename = originalResolve;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRequest({ method = "GET", url = "http://localhost:7071/api/test", headers = {}, params = {}, body } = {}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) headerMap.set(k.toLowerCase(), v);
  return {
    method,
    url,
    headers: { get: (name) => headerMap.get(name.toLowerCase()) ?? null },
    params,
    query: new URL(url).searchParams,
    text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function fakeContext() {
  return { log: () => {}, error: () => {}, warn: () => {}, invocationId: "test-invocation" };
}

let ipCounter = 0;
/** A fresh client IP per call so the per-IP bucket never interferes unless a test wants it. */
function freshIp() {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

async function invoke(routeName, { method, userId, headers = {}, params = {}, body, url } = {}) {
  const route = registeredRoutes[routeName];
  assert.ok(route, `route ${routeName} should be registered`);
  const req = fakeRequest({
    method: method || route.methods.find((m) => m !== "OPTIONS"),
    url: url || `http://localhost:7071/api/${route.route}`,
    headers: { ...(userId !== undefined ? { authorization: `Bearer dev:${userId}` } : {}), ...headers },
    params,
    body,
  });
  return route.handler(req, fakeContext());
}

function headerOf(response, name) {
  const headers = new Headers(response.headers ?? {});
  return headers.get(name);
}

const owner = {
  status: () => invoke("wishlist-share", { method: "GET", userId: OWNER }),
  enable: (body = {}) => invoke("wishlist-share", { method: "POST", userId: OWNER, body }),
  rotate: () => invoke("wishlist-share-rotate", { method: "POST", userId: OWNER }),
  revoke: () => invoke("wishlist-share", { method: "DELETE", userId: OWNER }),
};

function viewPublic(token, ip = freshIp()) {
  return invoke("wishlist-public", {
    method: "GET",
    params: { token },
    headers: { "x-forwarded-for": ip },
    url: `http://localhost:7071/api/wishlist/${token}`,
  });
}

function enableFlag() {
  process.env.SHAREABLE_WISHLIST_ENABLED = "true";
}

beforeEach(() => {
  resetDb();
  enableFlag();
  process.env.IMAGE_PROXY_SIGNING_KEY = SIGNING_KEY;
  handlers.publicWishlistIpLimiter.reset();
  handlers.publicWishlistTokenLimiter.reset();
});

// ---------------------------------------------------------------------------
// Token hashing and verification
// ---------------------------------------------------------------------------

describe("wishlist share tokens", () => {
  it("derives a deterministic 256-bit URL-safe token per (user, salt)", () => {
    const salt = shareLib.generateShareTokenSalt();
    const token = shareLib.deriveShareToken(OWNER, salt);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, "base64url").length, 32, "at least 128 bits of entropy");
    assert.equal(shareLib.deriveShareToken(OWNER, salt), token, "deterministic");
    assert.notEqual(shareLib.deriveShareToken(ATTACKER, salt), token, "bound to the user");
    assert.notEqual(shareLib.deriveShareToken(OWNER, shareLib.generateShareTokenSalt()), token, "bound to the salt");
  });

  it("generates distinct random salts", () => {
    const salts = new Set(Array.from({ length: 50 }, () => shareLib.generateShareTokenSalt()));
    assert.equal(salts.size, 50);
    for (const salt of salts) assert.equal(Buffer.from(salt, "base64url").length, 16);
  });

  it("stores only a SHA-256 hex hash and verifies in constant time", () => {
    const token = shareLib.deriveShareToken(OWNER, "salt-a");
    const hash = shareLib.hashShareToken(token);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(!hash.includes(token));
    assert.equal(shareLib.shareTokenMatchesHash(token, hash), true);
    assert.equal(shareLib.shareTokenMatchesHash(shareLib.deriveShareToken(OWNER, "salt-b"), hash), false);
    assert.equal(shareLib.shareTokenMatchesHash(token, "not-a-hash"), false);
  });

  it("parses only canonical 43-char base64url tokens", () => {
    const token = shareLib.deriveShareToken(OWNER, "salt-a");
    assert.equal(shareLib.parseShareToken(token), token);
    for (const bad of [undefined, null, 42, "", "short", `${token}A`, token.slice(0, 42) + "!", token.replace(/.$/, "=")]) {
      assert.equal(shareLib.parseShareToken(bad), null, `rejects ${String(bad)}`);
    }
    // Same bytes, different trailing bits: not canonical.
    const last = token[42];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const idx = alphabet.indexOf(last);
    const sibling = token.slice(0, 42) + alphabet[(idx & ~3) | ((idx & 3) ^ 1)];
    assert.equal(Buffer.from(sibling, "base64url").equals(Buffer.from(token, "base64url")), true);
    assert.equal(shareLib.parseShareToken(sibling), null);
  });

  it("cannot be re-derived after the server key changes (owner must rotate)", () => {
    const salt = "salt-key-change";
    const token = shareLib.deriveShareToken(OWNER, salt);
    const hash = shareLib.hashShareToken(token);
    assert.equal(shareLib.recoverShareToken(OWNER, salt, hash), token);
    process.env.IMAGE_PROXY_SIGNING_KEY = "a-completely-different-signing-key-0123456789";
    assert.equal(shareLib.recoverShareToken(OWNER, salt, hash), null);
    delete process.env.IMAGE_PROXY_SIGNING_KEY;
    process.env.AUTH_DEV_BYPASS = "false";
    resetImageProxySigningStateForTests();
    assert.equal(shareLib.recoverShareToken(OWNER, salt, hash), null, "no key: fails closed");
    process.env.AUTH_DEV_BYPASS = "true";
    process.env.IMAGE_PROXY_SIGNING_KEY = SIGNING_KEY;
  });

  it("validates the public display name", () => {
    assert.deepEqual(shareLib.normalizeShareDisplayName(undefined), { ok: true, value: null });
    assert.deepEqual(shareLib.normalizeShareDisplayName("   "), { ok: true, value: null });
    assert.deepEqual(shareLib.normalizeShareDisplayName("  Sam \n  P. "), { ok: true, value: "Sam P." });
    assert.equal(shareLib.normalizeShareDisplayName("x".repeat(61)).ok, false);
    assert.equal(shareLib.normalizeShareDisplayName("me@example.com").ok, false);
    assert.equal(shareLib.normalizeShareDisplayName(42).ok, false);
  });
});

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

describe("SHAREABLE_WISHLIST_ENABLED flag", () => {
  it("is off unless explicitly 'true'", () => {
    for (const value of [undefined, "", "false", "0", "yes", "1", "on"]) {
      assert.equal(shareLib.isShareableWishlistEnabled({ SHAREABLE_WISHLIST_ENABLED: value }), false, String(value));
    }
    assert.equal(shareLib.isShareableWishlistEnabled({ SHAREABLE_WISHLIST_ENABLED: "true" }), true);
    assert.equal(shareLib.isShareableWishlistEnabled({ SHAREABLE_WISHLIST_ENABLED: " TRUE " }), true);
  });

  it("answers 404 feature_disabled on every route while off, before auth and before any SQL", async () => {
    // Enable first so there is a live token that must stop working once the flag flips off.
    const { jsonBody } = await owner.enable();
    const token = jsonBody.token;
    sqlCalls = [];
    delete process.env.SHAREABLE_WISHLIST_ENABLED;

    const calls = [
      invoke("wishlist-share", { method: "GET", userId: OWNER }),
      invoke("wishlist-share", { method: "POST", userId: OWNER, body: {} }),
      invoke("wishlist-share", { method: "DELETE", userId: OWNER }),
      invoke("wishlist-share", { method: "GET" }), // no auth: still 404, not 401
      invoke("wishlist-share-rotate", { method: "POST", userId: OWNER }),
      viewPublic(token),
    ];
    for (const response of await Promise.all(calls)) {
      assert.equal(response.status, 404);
      assert.equal(response.jsonBody.code, "feature_disabled");
    }
    assert.equal(sqlCalls.length, 0, "no DB access while disabled");
    assert.equal(shares.size, 1, "the disabled DELETE did not revoke anything");

    enableFlag();
    assert.equal((await viewPublic(token)).status, 200, "turning the flag on is all it takes");
  });
});

// ---------------------------------------------------------------------------
// Owner lifecycle: enable, rotate, revoke
// ---------------------------------------------------------------------------

describe("owner share lifecycle", () => {
  it("registers the expected methods", () => {
    assert.deepEqual(registeredRoutes["wishlist-share"].methods.sort(), ["DELETE", "GET", "OPTIONS", "POST"]);
    assert.deepEqual(registeredRoutes["wishlist-share-rotate"].methods.sort(), ["OPTIONS", "POST"]);
    assert.deepEqual(registeredRoutes["wishlist-public"].methods.sort(), ["GET", "OPTIONS"]);
    assert.equal(registeredRoutes["wishlist-public"].route, "wishlist/{token}");
  });

  it("requires auth on owner routes", async () => {
    assert.equal((await invoke("wishlist-share", { method: "GET" })).status, 401);
    assert.equal((await invoke("wishlist-share", { method: "POST", body: {} })).status, 401);
    assert.equal((await invoke("wishlist-share", { method: "DELETE" })).status, 401);
    assert.equal((await invoke("wishlist-share-rotate", { method: "POST" })).status, 401);
  });

  it("reports no link before enabling, with wishlist counts", async () => {
    const response = await owner.status();
    assert.equal(response.status, 200);
    assert.deepEqual(response.jsonBody, {
      enabled: false,
      token: null,
      path: null,
      displayName: null,
      wishlistCount: 2,
      hiddenCount: 1,
      createdAt: null,
      rotatedAt: null,
    });
  });

  it("enables idempotently, never stores the raw token, and re-derives it for copy-link", async () => {
    const first = await owner.enable({ displayName: "Sam" });
    assert.equal(first.status, 200);
    assert.equal(first.jsonBody.enabled, true);
    assert.match(first.jsonBody.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(first.jsonBody.path, `/w/?token=${first.jsonBody.token}`);
    assert.equal(first.jsonBody.displayName, "Sam");
    assert.equal(headerOf(first, "Cache-Control"), "no-store");

    const stored = shares.get(OWNER);
    assert.equal(stored.tokenHash, shareLib.hashShareToken(first.jsonBody.token));
    assert.ok(!JSON.stringify(stored).includes(first.jsonBody.token), "raw token is not persisted");

    const again = await owner.enable({});
    assert.equal(again.jsonBody.token, first.jsonBody.token, "enable keeps the existing link");
    assert.equal(again.jsonBody.displayName, "Sam", "omitted displayName is kept");

    const status = await owner.status();
    assert.equal(status.jsonBody.token, first.jsonBody.token, "status re-derives the same token");

    const renamed = await owner.enable({ displayName: null });
    assert.equal(renamed.jsonBody.displayName, null);
    assert.equal(renamed.jsonBody.token, first.jsonBody.token);
  });

  it("rejects bad enable bodies", async () => {
    assert.equal((await owner.enable({ displayName: "owner@test.dev" })).status, 400);
    assert.equal((await owner.enable({ displayName: "x".repeat(61) })).status, 400);
    assert.equal((await invoke("wishlist-share", { method: "POST", userId: OWNER, body: "{not json" })).status, 400);
    assert.equal((await invoke("wishlist-share", { method: "POST", userId: OWNER, body: "[1]" })).status, 400);
    assert.equal(shares.size, 0);
  });

  it("rotation invalidates the old token immediately", async () => {
    const oldToken = (await owner.enable()).jsonBody.token;
    assert.equal((await viewPublic(oldToken)).status, 200);

    const rotated = await owner.rotate();
    assert.equal(rotated.status, 200);
    const newToken = rotated.jsonBody.token;
    assert.notEqual(newToken, oldToken);

    const stale = await viewPublic(oldToken);
    assert.equal(stale.status, 404);
    assert.equal(headerOf(stale, "Cache-Control"), "no-store");
    assert.equal((await viewPublic(newToken)).status, 200);
  });

  it("revocation makes the link 404 immediately and is idempotent", async () => {
    const token = (await owner.enable()).jsonBody.token;
    assert.equal((await viewPublic(token)).status, 200);

    const revoked = await owner.revoke();
    assert.equal(revoked.status, 200);
    assert.equal(revoked.jsonBody.enabled, false);
    assert.equal(revoked.jsonBody.token, null);
    assert.equal((await viewPublic(token)).status, 404);
    assert.equal((await owner.revoke()).status, 200, "revoking twice is fine");
    assert.equal((await owner.rotate()).status, 404, "nothing to rotate after revoke");

    const reenabled = await owner.enable();
    assert.notEqual(reenabled.jsonBody.token, token, "re-enabling mints a new token");
    assert.equal((await viewPublic(token)).status, 404);
  });
});

// ---------------------------------------------------------------------------
// Access control: owner endpoints are keyed on the caller
// ---------------------------------------------------------------------------

describe("access control", () => {
  it("another user cannot read, rotate or revoke the owner's share", async () => {
    const ownerToken = (await owner.enable({ displayName: "Sam" })).jsonBody.token;

    const peek = await invoke("wishlist-share", { method: "GET", userId: ATTACKER });
    assert.equal(peek.status, 200);
    assert.equal(peek.jsonBody.enabled, false);
    assert.equal(peek.jsonBody.token, null);
    assert.equal(peek.jsonBody.wishlistCount, 1, "attacker sees only their own count");

    assert.equal((await invoke("wishlist-share-rotate", { method: "POST", userId: ATTACKER })).status, 404);
    assert.equal((await invoke("wishlist-share", { method: "DELETE", userId: ATTACKER })).status, 200);

    assert.equal(shares.get(OWNER).displayName, "Sam");
    assert.equal((await viewPublic(ownerToken)).status, 200, "owner link survives the attacker's calls");

    // Attacker enabling their own share creates a separate row and a different token.
    const attackerShare = await invoke("wishlist-share", { method: "POST", userId: ATTACKER, body: { displayName: "Mallory" } });
    assert.notEqual(attackerShare.jsonBody.token, ownerToken);
    assert.equal(shares.get(OWNER).displayName, "Sam");
    const attackerView = await viewPublic(attackerShare.jsonBody.token);
    assert.deepEqual(attackerView.jsonBody.items.map((i) => i.name), ["Attacker Wish"]);
  });

  it("binds every owner statement on wishlist_share / inventory to the caller's user id", async () => {
    await invoke("wishlist-share", { method: "POST", userId: ATTACKER, body: {} });
    await invoke("wishlist-share", { method: "GET", userId: ATTACKER });
    await invoke("wishlist-share-rotate", { method: "POST", userId: ATTACKER });
    await invoke("wishlist-share", { method: "DELETE", userId: ATTACKER });
    const scoped = sqlCalls.filter((c) => /wishlist_share|user_inventory_item/i.test(c.sql));
    assert.ok(scoped.length >= 6);
    for (const call of scoped) {
      assert.equal(boundUserId(call.sql, call.params), ATTACKER, call.sql);
    }
  });
});

// ---------------------------------------------------------------------------
// Public payload
// ---------------------------------------------------------------------------

const ALLOWED_TOP_LEVEL_KEYS = ["displayName", "items"];
const ALLOWED_ITEM_KEYS = ["brand", "finishes", "hex", "imageUrl", "name"];

describe("public wishlist payload", () => {
  it("contains only allowlisted fields and no PII or private inventory data", async () => {
    const token = (await owner.enable({ displayName: "Sam" })).jsonBody.token;
    const response = await viewPublic(token);
    assert.equal(response.status, 200);

    assert.deepEqual(Object.keys(response.jsonBody).sort(), ALLOWED_TOP_LEVEL_KEYS);
    assert.equal(response.jsonBody.displayName, "Sam");
    for (const item of response.jsonBody.items) {
      assert.deepEqual(Object.keys(item).sort(), ALLOWED_ITEM_KEYS);
    }

    const serialized = JSON.stringify(response.jsonBody);
    for (const secret of [
      USERS[OWNER].email,
      USERS[OWNER].external_id,
      OWNER_SECRET_NOTES,
      "CHF",
      "EUR",
      "12.5",
      "3.25",
      "nail-photos",
      "blob.core.windows.net",
      "/api/images/v3.",
      token,
    ]) {
      assert.ok(!serialized.includes(secret), `payload must not contain ${secret}`);
    }
  });

  it("selects no private columns in SQL", async () => {
    const token = (await owner.enable()).jsonBody.token;
    sqlCalls = [];
    await viewPublic(token);
    const itemsSql = sqlCalls.find((c) => /user_inventory_item/i.test(c.sql));
    assert.ok(itemsSql);
    assert.doesNotMatch(itemsSql.sql, /\b(notes|purchase_price|purchase_currency|quantity|rating|email|external_id|handle|tags)\b/i);
    const shareSql = sqlCalls.find((c) => /wishlist_share/i.test(c.sql));
    assert.doesNotMatch(shareSql.sql, /\b(email|external_id|handle|token_salt)\b/i);
  });

  it("does not serve the page of a suspended owner (#45)", async () => {
    const token = (await owner.enable()).jsonBody.token;
    sqlCalls = [];
    await viewPublic(token);
    const shareSql = sqlCalls.find((c) => /token_hash\s*=\s*\$1/i.test(c.sql));
    assert.match(shareSql.sql, /JOIN app_user u ON u\.user_id = ws\.user_id/);
    assert.match(shareSql.sql, /\(to_jsonb\(u\.\*\) ->> 'suspended_at'\) IS NULL/);
  });

  it("returns only wishlist-status, shared-catalog items of the share owner", async () => {
    const token = (await owner.enable()).jsonBody.token;
    const { jsonBody } = await viewPublic(token);
    assert.deepEqual(
      jsonBody.items.map((i) => i.name),
      ["Scattered Holo", "Detected Only"],
      "no owned/destash items, no private user_submitted shade, no other user's items"
    );
  });

  it("maps finishes, display hex and only public catalog images", async () => {
    const token = (await owner.enable()).jsonBody.token;
    const { jsonBody } = await viewPublic(token);
    const holo = jsonBody.items.find((i) => i.name === "Scattered Holo");
    assert.equal(holo.brand, "Holo Taco");
    assert.deepEqual(holo.finishes, ["holo", "glitter"]);
    assert.equal(holo.hex, "#AA0000", "vendor hex wins");
    assert.match(holo.imageUrl, /^http:\/\/localhost:7071\/api\/images\/v2\./);

    const detected = jsonBody.items.find((i) => i.name === "Detected Only");
    assert.deepEqual(detected.finishes, ["creme"], "falls back to the legacy finish");
    assert.equal(detected.hex, "#00AA00", "detected beats name hex");
    assert.equal(detected.imageUrl, null, "private user media is never exposed");
  });

  it("sets noindex and short private caching", async () => {
    const token = (await owner.enable()).jsonBody.token;
    const response = await viewPublic(token);
    const cacheControl = headerOf(response, "Cache-Control");
    const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)[1]);
    assert.ok(maxAge <= 60, cacheControl);
    assert.match(cacheControl, /\bprivate\b/);
    assert.match(headerOf(response, "X-Robots-Tag"), /noindex/);
  });

  it("404s unknown and malformed tokens without touching the share table for malformed ones", async () => {
    await owner.enable();
    const unknown = shareLib.deriveShareToken(OWNER, "never-stored-salt");
    assert.equal((await viewPublic(unknown)).status, 404);

    sqlCalls = [];
    for (const bad of ["", "abc", "x".repeat(43).replace(/x$/, "!"), "a".repeat(500)]) {
      assert.equal((await viewPublic(bad)).status, 404, bad);
    }
    assert.equal(sqlCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  it("token bucket allows a burst, then refills over time", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 1, now: () => now });
    assert.equal(limiter.take("k").allowed, true);
    assert.equal(limiter.take("k").allowed, true);
    assert.equal(limiter.take("k").allowed, true);
    const denied = limiter.take("k");
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterSeconds, 1);
    assert.equal(limiter.take("other").allowed, true, "keys are independent");
    now += 1000;
    assert.equal(limiter.take("k").allowed, true, "one token refilled after 1s");
    assert.equal(limiter.take("k").allowed, false);
    now += 60_000;
    for (let i = 0; i < 3; i += 1) assert.equal(limiter.take("k").allowed, true, "refill caps at capacity");
    assert.equal(limiter.take("k").allowed, false);
  });

  it("reports Retry-After for slow refill rates", () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.1, now: () => 0 });
    limiter.take("k");
    assert.equal(limiter.take("k").retryAfterSeconds, 10);
  });

  it("bounds memory by evicting idle buckets", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1, maxKeys: 5, now: () => now });
    for (let i = 0; i < 50; i += 1) {
      limiter.take(`k${i}`);
      now += 10;
    }
    assert.ok(limiter.size <= 5, `size ${limiter.size}`);
  });

  it("extracts the client IP from the proxy-appended X-Forwarded-For entry", () => {
    const h = (headers) => ({ get: (n) => headers[n.toLowerCase()] ?? null });
    assert.equal(clientIpFromHeaders(h({ "x-forwarded-for": "198.51.100.7:51234" })), "198.51.100.7");
    assert.equal(clientIpFromHeaders(h({ "x-forwarded-for": "1.1.1.1, 198.51.100.7" })), "198.51.100.7");
    assert.equal(clientIpFromHeaders(h({ "x-forwarded-for": "[2001:DB8::1]:443" })), "2001:db8::1");
    assert.equal(clientIpFromHeaders(h({})), "unknown");
  });

  it("returns 429 with Retry-After per client IP", async () => {
    const token = (await owner.enable()).jsonBody.token;
    const ip = "198.51.100.42";
    let last;
    for (let i = 0; i < 31; i += 1) last = await viewPublic(token, ip);
    assert.equal(last.status, 429);
    assert.ok(Number(headerOf(last, "Retry-After")) >= 1);
    assert.equal(headerOf(last, "Cache-Control"), "no-store");
    assert.equal((await viewPublic(token, "198.51.100.43")).status, 200, "other IPs are unaffected");
  });

  it("returns 429 per token across many IPs", async () => {
    const token = (await owner.enable()).jsonBody.token;
    const statuses = [];
    for (let i = 0; i < 61; i += 1) statuses.push((await viewPublic(token, `192.0.2.${i}`)).status);
    assert.deepEqual([...new Set(statuses.slice(0, 60))], [200]);
    assert.equal(statuses[60], 429);
    const other = (await invoke("wishlist-share", { method: "POST", userId: ATTACKER, body: {} })).jsonBody.token;
    assert.equal((await viewPublic(other, "192.0.2.200")).status, 200, "other tokens are unaffected");
  });

  it("rate-limits guessed tokens per IP before any lookup", async () => {
    const ip = "198.51.100.99";
    for (let i = 0; i < 30; i += 1) {
      await viewPublic(shareLib.deriveShareToken(OWNER, `guess-${i}`), ip);
    }
    sqlCalls = [];
    const limited = await viewPublic(shareLib.deriveShareToken(OWNER, "guess-final"), ip);
    assert.equal(limited.status, 429);
    assert.equal(sqlCalls.length, 0);
  });
});
