/**
 * authenticateRequestReadOnly (#270, follow-up from the #283 review): the private image proxy
 * resolves the caller without provisioning or updating anything, so a page of N private photos
 * costs N reads instead of N `getOrCreateUser` write transactions.
 *
 * Runs without a database or network: `jose` and `./db` are replaced via require interception.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

let jwtPayload = {};
let jwtError = null;
let statements = [];
let transactions = 0;
let identities;
let users;
let identitiesTableMissing = false;

function resetDb() {
  statements = [];
  transactions = 0;
  identitiesTableMissing = false;
  users = [
    { user_id: 1, external_id: "ext-original", email: "owner@example.com", role: "user" },
    { user_id: 7, external_id: "ext-legacy", email: null, role: "user" },
  ];
  identities = [
    { user_id: 1, external_id: "ext-original" },
    { user_id: 1, external_id: "ext-second-idp" },
  ];
}
resetDb();

async function query(sql, params = []) {
  const text = String(sql);
  statements.push({ sql: text, params });
  if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(text)) {
    throw new Error(`read-only auth issued a write: ${text}`);
  }
  if (/FROM\s+user_external_identities/i.test(text)) {
    if (identitiesTableMissing) {
      const error = new Error('relation "user_external_identities" does not exist');
      error.code = "42P01";
      throw error;
    }
    const identity = identities.find((i) => i.external_id === params[0]);
    const legacy = users.find((u) => u.external_id === params[0]);
    return { rows: [{ userId: identity ? identity.user_id : legacy ? legacy.user_id : null }] };
  }
  if (/FROM\s+app_user\s+WHERE\s+external_id\s*=\s*\$1/i.test(text)) {
    const user = users.find((u) => u.external_id === params[0]);
    return { rows: user ? [{ userId: user.user_id }] : [] };
  }
  if (/FROM\s+app_user\s+WHERE\s+user_id\s*=\s*\$1/i.test(text)) {
    const user = users.find((u) => u.user_id === Number(params[0]));
    return { rows: user ? [user] : [] };
  }
  throw new Error(`unexpected SQL in read-only auth test: ${text}`);
}

const originalResolve = Module._resolveFilename;
const mocks = {
  jose: {
    createRemoteJWKSet: () => ({}),
    jwtVerify: async () => {
      if (jwtError) throw jwtError;
      return { payload: jwtPayload };
    },
  },
  "./db": {
    query,
    transaction: async (cb) => {
      transactions += 1;
      return cb({ query });
    },
  },
  "./telemetry": { trackEvent: () => {}, trackException: () => {} },
};
Module._resolveFilename = function (request, parent, ...rest) {
  if (Object.prototype.hasOwnProperty.call(mocks, request) && parent && /dist[\\/]lib[\\/]auth\.js$/.test(parent.filename || "")) {
    return `mock-ro:${request}`;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [id, exports] of Object.entries(mocks)) {
  const key = `mock-ro:${id}`;
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
}

const { authenticateRequestReadOnly, AuthError } = require("../dist/lib/auth");

const ctx = { log() {}, error() {}, warn() {} };
function request(authorization) {
  return { headers: { get: (n) => (n.toLowerCase() === "authorization" ? authorization : null) } };
}
function authenticateJwt(payload) {
  jwtPayload = payload;
  return authenticateRequestReadOnly(request("Bearer header.payload.sig"), ctx);
}

const originalFetch = global.fetch;
beforeEach(() => {
  resetDb();
  jwtPayload = {};
  jwtError = null;
  process.env.AZURE_AD_B2C_TENANT = "testtenant";
  process.env.AZURE_AD_B2C_CLIENT_ID = "test-client";
  delete process.env.AUTH_DEV_BYPASS;
  // OIDC discovery falls back to the legacy b2clogin metadata when this fails.
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
});
afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.AZURE_AD_B2C_TENANT;
  delete process.env.AZURE_AD_B2C_CLIENT_ID;
  delete process.env.AUTH_DEV_BYPASS;
});

function assertNoWrites() {
  assert.equal(transactions, 0, "read-only auth must not open a transaction");
  for (const { sql } of statements) {
    assert.doesNotMatch(sql, /^\s*(INSERT|UPDATE|DELETE)\b/i);
  }
}

describe("lib/auth — authenticateRequestReadOnly (JWT mode)", () => {
  it("resolves a linked identity with a single read and no transaction", async () => {
    const auth = await authenticateJwt({ oid: "ext-second-idp", email: "someone@example.com", email_verified: true });
    assert.deepEqual(auth, { userId: 1 });
    assert.equal(statements.length, 1);
    assertNoWrites();
  });

  it("resolves a legacy app_user.external_id", async () => {
    const auth = await authenticateJwt({ sub: "ext-legacy" });
    assert.deepEqual(auth, { userId: 7 });
    assertNoWrites();
  });

  it("falls back to app_user when the identities table does not exist yet (42P01)", async () => {
    identitiesTableMissing = true;
    assert.deepEqual(await authenticateJwt({ oid: "ext-legacy" }), { userId: 7 });
    assertNoWrites();
  });

  it("rejects a valid token for an identity that was never provisioned, without creating a user", async () => {
    await assert.rejects(authenticateJwt({ oid: "ext-unknown", email: "owner@example.com", email_verified: true }), AuthError);
    assert.equal(users.length, 2);
    assertNoWrites();
  });

  it("never links by email, even a verified one", async () => {
    await assert.rejects(
      authenticateJwt({ oid: "ext-new-idp", email: "owner@example.com", email_verified: true }),
      AuthError
    );
    assertNoWrites();
  });

  it("coerces a BIGINT user id returned as a string", async () => {
    identities[0].user_id = "1";
    const auth = await authenticateJwt({ oid: "ext-original" });
    assert.equal(auth.userId, 1);
    assert.equal(typeof auth.userId, "number");
  });

  it("propagates token verification failures and does not touch the DB", async () => {
    jwtError = Object.assign(new Error("signature verification failed"), { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" });
    await assert.rejects(authenticateJwt({ oid: "ext-original" }), /signature verification failed/);
    assert.equal(statements.length, 0);
  });

  it("rejects a token without oid/sub", async () => {
    await assert.rejects(authenticateJwt({ email: "owner@example.com" }), AuthError);
    assert.equal(statements.length, 0);
  });

  it("rejects missing, malformed and empty Authorization headers without any lookup", async () => {
    for (const header of [null, "Basic abc", "Bearer "]) {
      await assert.rejects(authenticateRequestReadOnly(request(header), ctx), AuthError);
    }
    assert.equal(statements.length, 0);
  });

  it("rejects when B2C is not configured", async () => {
    delete process.env.AZURE_AD_B2C_TENANT;
    await assert.rejects(authenticateJwt({ oid: "ext-original" }), AuthError);
  });
});

describe("lib/auth — authenticateRequestReadOnly (dev bypass)", () => {
  beforeEach(() => {
    process.env.AUTH_DEV_BYPASS = "true";
  });

  it("resolves dev:<id> tokens with one read", async () => {
    const auth = await authenticateRequestReadOnly(request("Bearer dev:7"), ctx);
    assert.deepEqual(auth, { userId: 7 });
    assertNoWrites();
  });

  it("rejects unknown dev users and malformed dev tokens", async () => {
    await assert.rejects(authenticateRequestReadOnly(request("Bearer dev:999"), ctx), AuthError);
    await assert.rejects(authenticateRequestReadOnly(request("Bearer dev:1 OR 1=1"), ctx), AuthError);
  });
});
