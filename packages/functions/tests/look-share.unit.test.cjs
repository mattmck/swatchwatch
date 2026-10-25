/**
 * Shareable looks unit tests (public link for one saved look, modeled on the shareable wishlist
 * #268). No database: handler modules load from dist/ with `@azure/functions`, `jose` and
 * `../lib/db` swapped via require interception (same approach as wishlist-share.unit.test.cjs).
 * The fake DB honours the SQL predicates the handlers send (`user_id = $n`, `revoked_at IS NULL`,
 * the public-shade `status = 'active'`/category/merge filters, the suspended-owner check), so a handler that
 * dropped one would visibly leak rows and fail here.
 *
 * Users: OWNER = 1, ATTACKER = 2 (dev-bypass tokens `Bearer dev:<id>`).
 */
const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const SIGNING_KEY = "look-share-unit-test-signing-key-0123456789abcdef";
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
  [OWNER]: { user_id: OWNER, external_id: "ext-owner-secret", email: "owner@test.dev", role: "user", suspended_at: null },
  [ATTACKER]: { user_id: ATTACKER, external_id: "ext-attacker", email: "attacker@test.dev", role: "user", suspended_at: null },
};

const CATALOG_IMAGE = "https://acct.blob.core.windows.net/source-images/catalog/holo.png";
const PRIVATE_IMAGE = "https://acct.blob.core.windows.net/nail-photos/1/private.png";

/** shade_id -> shade. Only 701 and 702 are public catalog shades. */
const SHADES = {
  701: { brand: "Holo Taco", name: "Scattered Holo", finish: "holo", finishes: ["holo", "glitter"], vendorHex: "#aa0000", detectedHex: "#AB0101", nameHex: null, status: "active", category: "color", mergedInto: null, imageUrl: CATALOG_IMAGE },
  702: { brand: "Essie", name: "Detected Only", finish: "matte", finishes: [], vendorHex: null, detectedHex: "#00AA00", nameHex: "#00FF00", status: "active", category: "color", mergedInto: null, imageUrl: PRIVATE_IMAGE },
  703: { brand: "My Brand", name: "My Private Submission", finish: "creme", finishes: ["creme"], vendorHex: "#ABCDEF", detectedHex: null, nameHex: null, status: "user_submitted", category: "color", mergedInto: null, imageUrl: CATALOG_IMAGE },
  704: { brand: "Excluded Co", name: "Excluded Shade", finish: "creme", finishes: ["creme"], vendorHex: "#222222", detectedHex: null, nameHex: null, status: "excluded", category: "color", mergedInto: null, imageUrl: null },
  705: { brand: "Merged Co", name: "Merged Away", finish: "creme", finishes: ["creme"], vendorHex: "#333333", detectedHex: null, nameHex: null, status: "active", category: "color", mergedInto: 701, imageUrl: null },
  706: { brand: "Tool Co", name: "Nail File", finish: null, finishes: [], vendorHex: "#444444", detectedHex: null, nameHex: null, status: "active", category: "accessory", mergedInto: null, imageUrl: null },
};

const SNAPSHOT_SECRETS = ["Snapshot Brand Secret", "Snapshot Name Secret", "My secret label"];

function initialLooks() {
  return [
    {
      userLookId: 11,
      userId: OWNER,
      lookKey: "glazed-donut:701,703,-",
      templateId: "glazed-donut",
      name: "Glazed Donut",
      vibe: { occasion: "date", mood: "soft", finish: "holo", ownedOnly: true },
      steps: [
        { role: "base", label: "My secret label", hex: "#111111", source: "owned", shadeId: "701", brand: "Snapshot Brand Secret", name: "Snapshot Name Secret" },
        { role: "accent", label: "Accent", hex: "#123456", source: "owned", shadeId: "703", brand: "My Brand", name: "My Private Submission" },
        { role: "topper", label: "Topper", hex: "#EEEEEE", source: "template" },
      ],
    },
    {
      userLookId: 12,
      userId: OWNER,
      lookKey: "office-neutral:702,704,705,706",
      templateId: "office-neutral",
      name: "Office Neutral",
      vibe: { occasion: "work", mood: "soft", finish: null, ownedOnly: false },
      steps: [
        { role: "base", label: "Base", hex: "#010101", source: "catalog", shadeId: "702", brand: "Essie", name: "Detected Only" },
        { role: "accent", label: "Accent", hex: "#020202", source: "catalog", shadeId: "704" },
        { role: "accent", label: "Accent", hex: "#030303", source: "catalog", shadeId: "705" },
        { role: "topper", label: "Topper", hex: "#040404", source: "catalog", shadeId: "706" },
      ],
    },
    {
      userLookId: 21,
      userId: ATTACKER,
      lookKey: "glazed-donut:701,-",
      templateId: "glazed-donut",
      name: "Glazed Donut",
      vibe: { occasion: "party", mood: "bold", finish: null, ownedOnly: false },
      steps: [{ role: "base", label: "Base", hex: "#555555", source: "catalog", shadeId: "701" }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

let sqlCalls = [];
let looks = [];
/** userLookId -> share row */
let shares = new Map();
let clock = 0;

function resetDb() {
  sqlCalls = [];
  looks = initialLooks();
  shares = new Map();
  clock = Date.parse("2026-10-22T00:00:00Z");
  USERS[OWNER].suspended_at = null;
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
  const look = looks.find((l) => l.userLookId === row.userLookId);
  return {
    userLookId: String(row.userLookId),
    lookKey: look?.lookKey,
    tokenSalt: row.tokenSalt,
    tokenHash: row.tokenHash,
    displayName: row.displayName,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

function lookShareQuery(text, params) {
  if (/INSERT\s+INTO\s+look_share/i.test(text)) {
    const [userId, userLookId, tokenHash, tokenSalt, displayName, setDisplayName] = params;
    const scopedTo = /ul\.user_id\s*=\s*\$1/i.test(text) ? Number(userId) : undefined;
    const look = looks.find((l) => l.userLookId === Number(userLookId) && (scopedTo === undefined || l.userId === scopedTo));
    if (!look) return { rows: [], rowCount: 0 };
    const existing = shares.get(look.userLookId);
    if (existing) {
      if (existing.userId !== Number(userId)) return { rows: [], rowCount: 0 };
      if (existing.revokedAt) {
        existing.tokenHash = tokenHash;
        existing.tokenSalt = tokenSalt;
        existing.createdAt = nowIso();
      }
      if (setDisplayName) existing.displayName = displayName;
      existing.revokedAt = null;
      return { rows: [shareRowOut(existing)], rowCount: 1 };
    }
    const row = { userLookId: look.userLookId, userId: look.userId, tokenHash, tokenSalt, displayName, createdAt: nowIso(), revokedAt: null };
    shares.set(row.userLookId, row);
    return { rows: [shareRowOut(row)], rowCount: 1 };
  }
  if (/^\s*UPDATE\s+look_share/i.test(text)) {
    const userId = boundUserId(text, params);
    const onlyLive = /revoked_at\s+IS\s+NULL/i.test(text);
    const targets = [...shares.values()].filter((row) => {
      const look = looks.find((l) => l.userLookId === row.userLookId);
      return look && look.lookKey === params[1] && (userId === undefined || row.userId === userId) && (!onlyLive || !row.revokedAt);
    });
    for (const row of targets) row.revokedAt = nowIso();
    return { rows: targets.map(shareRowOut), rowCount: targets.length };
  }
  if (/token_hash\s*=\s*\$1/i.test(text)) {
    const row = [...shares.values()].find((r) => r.tokenHash === params[0]);
    const look = row && looks.find((l) => l.userLookId === row.userLookId && l.userId === row.userId);
    const suspendedChecked = /suspended_at'\)\s+IS\s+NULL/i.test(text);
    if (!row || !look || (suspendedChecked && USERS[row.userId].suspended_at)) return { rows: [], rowCount: 0 };
    // Everything a careless SELECT could return; the mapper must drop extras.
    return {
      rows: [
        {
          ...look,
          userId: String(row.userId),
          email: USERS[row.userId].email,
          tokenSalt: row.tokenSalt,
          displayName: row.displayName,
          revoked: Boolean(row.revokedAt),
        },
      ],
      rowCount: 1,
    };
  }
  // Owner list.
  const userId = boundUserId(text, params);
  const onlyLive = /revoked_at\s+IS\s+NULL/i.test(text);
  const rows = [...shares.values()]
    .filter((r) => (userId === undefined || r.userId === userId) && (!onlyLive || !r.revokedAt))
    .map(shareRowOut);
  return { rows, rowCount: rows.length };
}

function shadeQuery(text, params) {
  const ids = (params[0] ?? []).map(Number);
  const rows = ids
    .filter((id) => SHADES[id])
    .filter((id) => !/s\.status\s*=\s*'active'/i.test(text) || SHADES[id].status === "active")
    .filter((id) => !/s\.product_category\s*<>\s*'accessory'/i.test(text) || SHADES[id].category !== "accessory")
    .filter((id) => !/s\.merged_into_shade_id\s+IS\s+NULL/i.test(text) || SHADES[id].mergedInto === null)
    .map((id) => ({ ...SHADES[id], shadeId: String(id), createdByUserId: "1" }));
  return { rows, rowCount: rows.length };
}

async function fakeQuery(sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ sql: text, params });

  if (/look_share/i.test(text)) return lookShareQuery(text, params);

  if (/FROM\s+user_look\b/i.test(text)) {
    const userId = boundUserId(text, params);
    const rows = looks
      .filter((l) => (userId === undefined || l.userId === userId) && l.lookKey === params[1])
      .map((l) => ({ userLookId: String(l.userLookId) }));
    return { rows, rowCount: rows.length };
  }

  if (/FROM\s+shade\s+s/i.test(text)) return shadeQuery(text, params);

  if (/FROM\s+app_user/i.test(text) && /WHERE\s+user_id\s*=\s*\$1/i.test(text)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }

  return { rows: [], rowCount: 0 };
}

/** What `ON DELETE CASCADE` does when the owner deletes a saved look. */
function deleteLook(userLookId) {
  looks = looks.filter((l) => l.userLookId !== userLookId);
  shares.delete(userLookId);
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

const handlers = require("../dist/functions/look-share.js");
const wishlistHandlers = require("../dist/functions/wishlist-share.js");
const lookLib = require("../dist/lib/look-share.js");
const wishlistLib = require("../dist/lib/wishlist-share.js");
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
  return new Headers(response.headers ?? {}).get(name);
}

const KEY_A = "glazed-donut:701,703,-";
const KEY_B = "office-neutral:702,704,705,706";
const ATTACKER_KEY = "glazed-donut:701,-";

function share(userId, lookKey, extra = {}) {
  return invoke("look-share", { method: "POST", userId, body: { lookKey, ...extra } });
}
function list(userId) {
  return invoke("look-share", { method: "GET", userId });
}
function revoke(userId, lookKey) {
  return invoke("look-share", {
    method: "DELETE",
    userId,
    url: `http://localhost:7071/api/look-share?key=${encodeURIComponent(lookKey)}`,
  });
}
function viewPublic(token, ip = freshIp()) {
  return invoke("look-public", {
    method: "GET",
    params: { token },
    headers: { "x-forwarded-for": ip },
    url: `http://localhost:7071/api/look/${token}`,
  });
}

beforeEach(() => {
  resetDb();
  process.env.SHAREABLE_LOOKS_ENABLED = "true";
  process.env.IMAGE_PROXY_SIGNING_KEY = SIGNING_KEY;
  handlers.publicLookIpLimiter.reset();
  handlers.publicLookTokenLimiter.reset();
  wishlistHandlers.publicWishlistIpLimiter.reset();
  wishlistHandlers.publicWishlistTokenLimiter.reset();
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

describe("look share tokens", () => {
  it("derives a deterministic 256-bit URL-safe token bound to user, look and salt", () => {
    const salt = wishlistLib.generateShareTokenSalt();
    const token = lookLib.deriveLookShareToken(OWNER, 11, salt);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, "base64url").length, 32);
    assert.equal(wishlistLib.parseShareToken(token), token, "parses as a canonical share token");
    assert.equal(lookLib.deriveLookShareToken(OWNER, 11, salt), token, "deterministic");
    assert.notEqual(lookLib.deriveLookShareToken(ATTACKER, 11, salt), token, "bound to the user");
    assert.notEqual(lookLib.deriveLookShareToken(OWNER, 12, salt), token, "bound to the look");
    assert.notEqual(lookLib.deriveLookShareToken(OWNER, 11, wishlistLib.generateShareTokenSalt()), token, "bound to the salt");
  });

  it("uses a different HMAC subkey from the wishlist, so the token spaces never collide", () => {
    // Same HMAC message for both: the wishlist hashes "<user>:<salt>", the look "<user>:<look>:<salt>".
    const salt = "collide-salt";
    const lookToken = lookLib.deriveLookShareToken(OWNER, 11, salt);
    assert.notEqual(wishlistLib.deriveShareToken(OWNER, `11:${salt}`), lookToken);
  });

  it("stores only the hash and re-derives the token until the server key changes", () => {
    const salt = "salt-key-change-0001";
    const token = lookLib.deriveLookShareToken(OWNER, 11, salt);
    const hash = lookLib.hashLookShareToken(token);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(lookLib.recoverLookShareToken(OWNER, 11, salt, hash), token);
    assert.equal(lookLib.recoverLookShareToken(OWNER, 12, salt, hash), null, "another look's id does not match");
    process.env.IMAGE_PROXY_SIGNING_KEY = "a-completely-different-signing-key-0123456789";
    assert.equal(lookLib.recoverLookShareToken(OWNER, 11, salt, hash), null);
    delete process.env.IMAGE_PROXY_SIGNING_KEY;
    process.env.AUTH_DEV_BYPASS = "false";
    resetImageProxySigningStateForTests();
    assert.equal(lookLib.recoverLookShareToken(OWNER, 11, salt, hash), null, "no key: fails closed");
    process.env.AUTH_DEV_BYPASS = "true";
    process.env.IMAGE_PROXY_SIGNING_KEY = SIGNING_KEY;
  });
});

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

describe("SHAREABLE_LOOKS_ENABLED flag", () => {
  it("is off unless explicitly 'true', independent of the wishlist flag", () => {
    for (const value of [undefined, "", "false", "0", "yes", "1", "on"]) {
      assert.equal(lookLib.isShareableLooksEnabled({ SHAREABLE_LOOKS_ENABLED: value }), false, String(value));
    }
    assert.equal(lookLib.isShareableLooksEnabled({ SHAREABLE_LOOKS_ENABLED: " TRUE " }), true);
    assert.equal(lookLib.isShareableLooksEnabled({ SHAREABLE_WISHLIST_ENABLED: "true" }), false);
  });

  it("answers 404 feature_disabled on every route while off, before auth and before any SQL", async () => {
    const token = (await share(OWNER, KEY_A)).jsonBody.token;
    sqlCalls = [];
    delete process.env.SHAREABLE_LOOKS_ENABLED;
    process.env.SHAREABLE_WISHLIST_ENABLED = "true";

    const calls = [
      list(OWNER),
      share(OWNER, KEY_A),
      revoke(OWNER, KEY_A),
      invoke("look-share", { method: "GET" }), // no auth: still 404, not 401
      viewPublic(token),
    ];
    for (const response of await Promise.all(calls)) {
      assert.equal(response.status, 404);
      assert.equal(response.jsonBody.code, "feature_disabled");
    }
    assert.equal(sqlCalls.length, 0, "no DB access while disabled");
    assert.equal(shares.get(11).revokedAt, null, "the disabled DELETE did not revoke anything");

    delete process.env.SHAREABLE_WISHLIST_ENABLED;
    process.env.SHAREABLE_LOOKS_ENABLED = "true";
    assert.equal((await viewPublic(token)).status, 200, "turning the flag on is all it takes");
  });
});

// ---------------------------------------------------------------------------
// Owner lifecycle
// ---------------------------------------------------------------------------

describe("owner share lifecycle", () => {
  it("registers the expected routes", () => {
    assert.deepEqual([...registeredRoutes["look-share"].methods].sort(), ["DELETE", "GET", "OPTIONS", "POST"]);
    assert.equal(registeredRoutes["look-share"].route, "look-share");
    assert.deepEqual([...registeredRoutes["look-public"].methods].sort(), ["GET", "OPTIONS"]);
    assert.equal(registeredRoutes["look-public"].route, "look/{token}");
  });

  it("requires auth on owner routes", async () => {
    assert.equal((await list(undefined)).status, 401);
    assert.equal((await share(undefined, KEY_A)).status, 401);
    assert.equal((await revoke(undefined, KEY_A)).status, 401);
  });

  it("shares a saved look idempotently, never stores the raw token, and lists it", async () => {
    assert.deepEqual((await list(OWNER)).jsonBody, { shares: [] });
    const first = await share(OWNER, KEY_A, { displayName: "Sam" });
    assert.equal(first.status, 200);
    assert.equal(headerOf(first, "Cache-Control"), "no-store");
    assert.equal(first.jsonBody.lookKey, KEY_A);
    assert.equal(first.jsonBody.enabled, true);
    assert.match(first.jsonBody.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(first.jsonBody.path, `/l/?token=${first.jsonBody.token}`);
    assert.equal(first.jsonBody.displayName, "Sam");
    assert.equal(first.jsonBody.revokedAt, null);
    const stored = shares.get(11);
    assert.equal(stored.tokenHash, lookLib.hashLookShareToken(first.jsonBody.token));
    assert.ok(!JSON.stringify(stored).includes(first.jsonBody.token), "raw token is not persisted");

    const again = await share(OWNER, KEY_A);
    assert.equal(again.jsonBody.token, first.jsonBody.token, "sharing again keeps the live link");
    assert.equal(again.jsonBody.displayName, "Sam", "omitted displayName is kept");
    const renamed = await share(OWNER, KEY_A, { displayName: null });
    assert.equal(renamed.jsonBody.displayName, null);
    assert.equal(renamed.jsonBody.token, first.jsonBody.token);

    const listed = await list(OWNER);
    assert.equal(listed.jsonBody.shares.length, 1);
    assert.equal(listed.jsonBody.shares[0].token, first.jsonBody.token, "list re-derives the same token");
    assert.equal(listed.jsonBody.shares[0].lookKey, KEY_A);
  });

  it("rejects bad bodies and unsaved looks", async () => {
    assert.equal((await share(OWNER, KEY_A, { displayName: "owner@test.dev" })).status, 400);
    assert.equal((await share(OWNER, KEY_A, { displayName: "x".repeat(61) })).status, 400);
    assert.equal((await invoke("look-share", { method: "POST", userId: OWNER, body: {} })).status, 400);
    assert.equal((await invoke("look-share", { method: "POST", userId: OWNER, body: { lookKey: 42 } })).status, 400);
    assert.equal((await invoke("look-share", { method: "POST", userId: OWNER, body: "{not json" })).status, 400);
    assert.equal((await share(OWNER, "x".repeat(161))).status, 400);
    assert.equal((await share(OWNER, "never-saved:1")).status, 404);
    assert.equal((await revoke(OWNER, "")).status, 400);
    assert.equal(shares.size, 0);
  });

  it("revoking answers 410 immediately; sharing again mints a new token and the old one 404s", async () => {
    const token = (await share(OWNER, KEY_A)).jsonBody.token;
    assert.equal((await viewPublic(token)).status, 200);

    const revoked = await revoke(OWNER, KEY_A);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.jsonBody.enabled, false);
    assert.equal(revoked.jsonBody.token, null);
    assert.ok(revoked.jsonBody.revokedAt);
    const gone = await viewPublic(token);
    assert.equal(gone.status, 410);
    assert.equal(gone.jsonBody.code, "share_revoked");
    assert.equal(headerOf(gone, "Cache-Control"), "no-store");
    assert.deepEqual(Object.keys(gone.jsonBody).sort(), ["code", "error"], "a revoked link shows nothing of the look");
    assert.deepEqual((await list(OWNER)).jsonBody.shares, [], "revoked links are not listed");

    const again = await revoke(OWNER, KEY_A);
    assert.equal(again.status, 200, "revoking twice is fine");
    assert.equal(again.jsonBody.enabled, false);

    const reshared = await share(OWNER, KEY_A);
    assert.notEqual(reshared.jsonBody.token, token, "re-sharing mints a new token");
    assert.equal((await viewPublic(token)).status, 404, "the old token is gone for good");
    assert.equal((await viewPublic(reshared.jsonBody.token)).status, 200);
  });

  it("deleting the saved look kills the link", async () => {
    const token = (await share(OWNER, KEY_A)).jsonBody.token;
    deleteLook(11);
    assert.equal((await viewPublic(token)).status, 404);
    assert.deepEqual((await list(OWNER)).jsonBody.shares, []);
  });
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe("access control", () => {
  it("another user cannot create, list or revoke the owner's share", async () => {
    const ownerToken = (await share(OWNER, KEY_A, { displayName: "Sam" })).jsonBody.token;

    const steal = await share(ATTACKER, KEY_A, { displayName: "Mallory" });
    assert.equal(steal.status, 404, "the owner's look key means nothing to another user");
    assert.equal(shares.get(11).displayName, "Sam");
    assert.equal(shares.size, 1);

    const peek = await list(ATTACKER);
    assert.deepEqual(peek.jsonBody.shares, []);

    const kill = await revoke(ATTACKER, KEY_A);
    assert.equal(kill.status, 200);
    assert.equal(kill.jsonBody.enabled, false);
    assert.equal(shares.get(11).revokedAt, null, "owner link not revoked");
    assert.equal((await viewPublic(ownerToken)).status, 200, "owner link survives the attacker's calls");

    const own = await share(ATTACKER, ATTACKER_KEY);
    assert.equal(own.status, 200);
    assert.notEqual(own.jsonBody.token, ownerToken);
    const ownView = await viewPublic(own.jsonBody.token);
    assert.equal(ownView.jsonBody.vibe.occasion, "party", "the attacker's token shows the attacker's look");
  });

  it("binds every owner statement on look_share / user_look to the caller's user id", async () => {
    await share(ATTACKER, ATTACKER_KEY);
    await share(ATTACKER, KEY_A);
    await list(ATTACKER);
    await revoke(ATTACKER, ATTACKER_KEY);
    await revoke(ATTACKER, KEY_A);
    const scoped = sqlCalls.filter((c) => /look_share|user_look/i.test(c.sql));
    assert.ok(scoped.length >= 6, String(scoped.length));
    for (const call of scoped) {
      assert.equal(boundUserId(call.sql, call.params), ATTACKER, call.sql);
    }
  });

  it("pins the share row to the look's owner in SQL", async () => {
    await share(OWNER, KEY_A);
    const insert = sqlCalls.find((c) => /INSERT\s+INTO\s+look_share/i.test(c.sql));
    assert.match(insert.sql, /ul\.user_look_id = \$2\s+AND ul\.user_id = \$1/);
    assert.match(insert.sql, /WHERE look_share\.user_id = \$1/);
  });
});

// ---------------------------------------------------------------------------
// Public payload
// ---------------------------------------------------------------------------

const ALLOWED_TOP_LEVEL_KEYS = ["displayName", "steps", "templateId", "vibe"];
const ALLOWED_VIBE_KEYS = ["finish", "mood", "occasion"];
const ALLOWED_STEP_KEYS = ["brand", "finishes", "hex", "imageUrl", "name", "role"];

describe("public look payload", () => {
  it("contains only allowlisted fields", async () => {
    for (const key of [KEY_A, KEY_B]) {
      const token = (await share(OWNER, key, { displayName: "Sam" })).jsonBody.token;
      const response = await viewPublic(token);
      assert.equal(response.status, 200);
      assert.deepEqual(Object.keys(response.jsonBody).sort(), ALLOWED_TOP_LEVEL_KEYS);
      assert.deepEqual(Object.keys(response.jsonBody.vibe).sort(), ALLOWED_VIBE_KEYS);
      for (const step of response.jsonBody.steps) {
        assert.deepEqual(Object.keys(step).sort(), ALLOWED_STEP_KEYS);
      }
    }
  });

  it("leaks no ids, PII, ownership, snapshot text or private media", async () => {
    const token = (await share(OWNER, KEY_A, { displayName: "Sam" })).jsonBody.token;
    const { jsonBody } = await viewPublic(token);
    const serialized = JSON.stringify(jsonBody);
    for (const secret of [
      USERS[OWNER].email,
      USERS[OWNER].external_id,
      ...SNAPSHOT_SECRETS,
      "My Private Submission",
      "My Brand",
      "ownedOnly",
      "\"owned\"",
      "\"template\"",
      "\"catalog\"",
      "701",
      "703",
      KEY_A,
      "nail-photos",
      "blob.core.windows.net",
      "/api/images/v3.",
      token,
      shares.get(11).tokenSalt,
    ]) {
      assert.ok(!serialized.includes(secret), `payload must not contain ${secret}`);
    }
  });

  it("names catalog steps from the catalog and shows private or template steps as color chips", async () => {
    const token = (await share(OWNER, KEY_A, { displayName: "Sam" })).jsonBody.token;
    const { jsonBody } = await viewPublic(token);
    assert.equal(jsonBody.displayName, "Sam");
    assert.equal(jsonBody.templateId, "glazed-donut");
    assert.deepEqual(jsonBody.vibe, { occasion: "date", mood: "soft", finish: "holo" });
    assert.deepEqual(jsonBody.steps, [
      {
        role: "base",
        brand: "Holo Taco",
        name: "Scattered Holo",
        finishes: ["holo", "glitter"],
        hex: "#AA0000",
        imageUrl: jsonBody.steps[0].imageUrl,
      },
      { role: "accent", brand: null, name: null, finishes: [], hex: "#123456", imageUrl: null },
      { role: "topper", brand: null, name: null, finishes: [], hex: "#EEEEEE", imageUrl: null },
    ]);
    assert.match(jsonBody.steps[0].imageUrl, /^http:\/\/localhost:7071\/api\/images\/v2\./);
  });

  it("drops excluded, merged and accessory shades to chips and never exposes private images", async () => {
    const token = (await share(OWNER, KEY_B)).jsonBody.token;
    const { jsonBody } = await viewPublic(token);
    assert.equal(jsonBody.displayName, null);
    assert.equal(jsonBody.vibe.finish, null);
    const [base, excluded, merged, accessory] = jsonBody.steps;
    assert.equal(base.name, "Detected Only");
    assert.equal(base.hex, "#00AA00", "detected beats name hex");
    assert.deepEqual(base.finishes, ["matte"], "falls back to the legacy finish");
    assert.equal(base.imageUrl, null, "private user media is never exposed");
    for (const [step, hex] of [[excluded, "#020202"], [merged, "#030303"], [accessory, "#040404"]]) {
      assert.deepEqual(step, { role: step.role, brand: null, name: null, finishes: [], hex, imageUrl: null });
    }
  });

  it("selects no private columns in SQL", async () => {
    const token = (await share(OWNER, KEY_A)).jsonBody.token;
    sqlCalls = [];
    await viewPublic(token);
    const shareSql = sqlCalls.find((c) => /token_hash\s*=\s*\$1/i.test(c.sql));
    assert.doesNotMatch(shareSql.sql, /\b(email|external_id|handle|token_salt|look_key)\b/i);
    const shadeSql = sqlCalls.find((c) => /FROM\s+shade\s+s/i.test(c.sql));
    assert.doesNotMatch(shadeSql.sql, /user_inventory_item|created_by_user_id/i);
  });

  it("does not serve a suspended owner's look (#45)", async () => {
    const token = (await share(OWNER, KEY_A)).jsonBody.token;
    USERS[OWNER].suspended_at = "2026-10-22T00:00:00Z";
    assert.equal((await viewPublic(token)).status, 404);
  });

  it("sets noindex, no-referrer and short private caching", async () => {
    const token = (await share(OWNER, KEY_A)).jsonBody.token;
    const response = await viewPublic(token);
    const cacheControl = headerOf(response, "Cache-Control");
    assert.ok(Number(/max-age=(\d+)/.exec(cacheControl)[1]) <= 60, cacheControl);
    assert.match(cacheControl, /\bprivate\b/);
    assert.match(headerOf(response, "X-Robots-Tag"), /noindex/);
    assert.equal(headerOf(response, "Referrer-Policy"), "no-referrer");
  });

  it("404s unknown and malformed tokens, and wishlist tokens, without a lookup for malformed ones", async () => {
    await share(OWNER, KEY_A);
    assert.equal((await viewPublic(lookLib.deriveLookShareToken(OWNER, 11, "never-stored-salt"))).status, 404);
    assert.equal((await viewPublic(wishlistLib.deriveShareToken(OWNER, "some-salt"))).status, 404);
    sqlCalls = [];
    for (const bad of ["", "abc", "x".repeat(42) + "!", "a".repeat(500)]) {
      assert.equal((await viewPublic(bad)).status, 404, bad);
    }
    assert.equal(sqlCalls.length, 0);
  });

  it("never carries a skin tone from the stored vibe into the public payload", () => {
    const vibe = { occasion: "work", mood: "soft", finish: null, ownedOnly: true, skinTone: { undertone: "warm", depth: "deep" } };
    const look = lookLib.toPublicLook({ templateId: "x", vibe, steps: [{ role: "base", hex: "#000000" }] }, null, new Map(), "http://h/api");
    assert.ok(look);
    assert.deepEqual(look.vibe, { occasion: "work", mood: "soft", finish: null });
    assert.ok(!/skin|undertone|depth|deep|warm/i.test(JSON.stringify(look)), JSON.stringify(look));
  });

  it("builds nothing from a stored look with an unusable vibe", () => {
    const shades = new Map();
    assert.equal(lookLib.toPublicLook({ templateId: "x", vibe: null, steps: [{ role: "base", hex: "#000000" }] }, null, shades, "http://h/api"), null);
    assert.equal(lookLib.toPublicLook({ templateId: "x", vibe: { occasion: "work", mood: "soft" }, steps: [] }, null, shades, "http://h/api"), null);
    assert.equal(lookLib.toPublicLook({ templateId: "Bad Id!", vibe: { occasion: "work", mood: "soft" }, steps: [{ role: "base", hex: "#000000" }] }, null, shades, "http://h/api"), null);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  it("returns 429 with Retry-After per client IP", async () => {
    const token = (await share(OWNER, KEY_A)).jsonBody.token;
    const ip = "198.51.100.42";
    let last;
    for (let i = 0; i < 31; i += 1) last = await viewPublic(token, ip);
    assert.equal(last.status, 429);
    assert.ok(Number(headerOf(last, "Retry-After")) >= 1);
    assert.equal(headerOf(last, "Cache-Control"), "no-store");
    assert.equal((await viewPublic(token, "198.51.100.43")).status, 200, "other IPs are unaffected");
  });

  it("returns 429 per token across many IPs", async () => {
    const token = (await share(OWNER, KEY_A)).jsonBody.token;
    const statuses = [];
    for (let i = 0; i < 61; i += 1) statuses.push((await viewPublic(token, `192.0.2.${i}`)).status);
    assert.deepEqual([...new Set(statuses.slice(0, 60))], [200]);
    assert.equal(statuses[60], 429);
    const other = (await share(OWNER, KEY_B)).jsonBody.token;
    assert.equal((await viewPublic(other, "192.0.2.200")).status, 200, "other tokens are unaffected");
  });

  it("rate-limits guessed tokens per IP before any lookup", async () => {
    const ip = "198.51.100.99";
    for (let i = 0; i < 30; i += 1) await viewPublic(lookLib.deriveLookShareToken(OWNER, 11, `guess-${i}`), ip);
    sqlCalls = [];
    const limited = await viewPublic(lookLib.deriveLookShareToken(OWNER, 11, "guess-final"), ip);
    assert.equal(limited.status, 429);
    assert.equal(sqlCalls.length, 0);
  });

  it("keeps its buckets separate from the public wishlist's", async () => {
    const token = (await share(OWNER, KEY_A)).jsonBody.token;
    const ip = "198.51.100.77";
    for (let i = 0; i < 40; i += 1) wishlistHandlers.publicWishlistIpLimiter.take(`ip:${ip}`);
    assert.equal(wishlistHandlers.publicWishlistIpLimiter.take(`ip:${ip}`).allowed, false);
    assert.equal((await viewPublic(token, ip)).status, 200);
  });
});
