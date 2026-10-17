/**
 * Email-based account linking requires a verified email (issue #47, finding F3).
 *
 * A new external identity may be linked to an existing app_user by email ONLY when
 * the token proves the email is verified (`email_verified` or Entra's `xms_edov`).
 * Runs without a database or network: `jose` and `./db` are replaced via require
 * interception and the transaction client is a tiny in-memory fake of app_user /
 * user_external_identities.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

let jwtPayload = {};
let telemetryEvents = [];
let db;

function resetDb() {
  db = {
    nextUserId: 100,
    users: [{ user_id: 1, external_id: "ext-original", email: "victim@example.com", role: "user" }],
    identities: [{ user_id: 1, external_id: "ext-original", email: "victim@example.com" }],
    statements: [],
  };
}
resetDb();

async function clientQuery(sql, params = []) {
  const text = String(sql);
  db.statements.push({ sql: text, params });

  if (/FROM\s+user_external_identities\s+uei/i.test(text)) {
    const identity = db.identities.find((i) => i.external_id === params[0]);
    return { rows: identity ? [{ userId: identity.user_id }] : [] };
  }
  if (/FROM\s+app_user\s+WHERE\s+external_id\s*=\s*\$1/i.test(text)) {
    const user = db.users.find((u) => u.external_id === params[0]);
    return { rows: user ? [{ userId: user.user_id }] : [] };
  }
  if (/pg_advisory_xact_lock/i.test(text)) return { rows: [] };
  if (/lower\(email\)\s*=\s*lower\(\$1\)/i.test(text)) {
    const user = db.users.find((u) => u.email && u.email.toLowerCase() === String(params[0]).toLowerCase());
    return { rows: user ? [{ userId: user.user_id }] : [] };
  }
  if (/INSERT\s+INTO\s+app_user/i.test(text)) {
    const user = { user_id: db.nextUserId++, external_id: params[0], email: params[1], role: params[3] || "user" };
    db.users.push(user);
    return { rows: [{ userId: user.user_id, role: user.role }] };
  }
  if (/UPDATE\s+app_user/i.test(text)) {
    const user = db.users.find((u) => u.user_id === params[0]);
    if (user && params[1]) user.email = params[1];
    return { rows: [{ role: user ? user.role : "user" }] };
  }
  if (/INSERT\s+INTO\s+user_external_identities/i.test(text)) {
    const existing = db.identities.find((i) => i.external_id === params[1]);
    if (existing) {
      existing.user_id = params[0];
    } else {
      db.identities.push({ user_id: params[0], external_id: params[1], email: params[2] });
    }
    return { rows: [] };
  }
  throw new Error(`unexpected SQL in auth test: ${text}`);
}

const originalResolve = Module._resolveFilename;
const mocks = {
  jose: {
    createRemoteJWKSet: () => ({}),
    jwtVerify: async () => ({ payload: jwtPayload }),
  },
  "./db": {
    query: clientQuery,
    transaction: async (cb) => cb({ query: clientQuery }),
  },
  "./telemetry": {
    trackEvent: (name, props) => telemetryEvents.push({ name, props }),
    trackException: () => {},
  },
};
Module._resolveFilename = function (request, parent, ...rest) {
  if (Object.prototype.hasOwnProperty.call(mocks, request) && parent && /dist[\\/]lib[\\/]auth\.js$/.test(parent.filename || "")) {
    return `mock:${request}`;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [id, exports] of Object.entries(mocks)) {
  const key = `mock:${id}`;
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
}

const { authenticateRequest, isEmailVerifiedClaim } = require("../dist/lib/auth");

process.env.AZURE_AD_B2C_TENANT = "testtenant";
process.env.AZURE_AD_B2C_CLIENT_ID = "test-client";
delete process.env.AUTH_DEV_BYPASS;
// OIDC discovery falls back to the legacy b2clogin metadata when this fails.
global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

function authenticate(payload) {
  jwtPayload = payload;
  return authenticateRequest(
    { headers: { get: (n) => (n.toLowerCase() === "authorization" ? "Bearer header.payload.sig" : null) } },
    { log() {}, error() {}, warn() {} }
  );
}

beforeEach(() => {
  resetDb();
  telemetryEvents = [];
  jwtPayload = {};
});

describe("isEmailVerifiedClaim", () => {
  it("accepts email_verified true (boolean or string) and xms_edov true", () => {
    assert.equal(isEmailVerifiedClaim({ email_verified: true }), true);
    assert.equal(isEmailVerifiedClaim({ email_verified: "true" }), true);
    assert.equal(isEmailVerifiedClaim({ xms_edov: true }), true);
    assert.equal(isEmailVerifiedClaim({ xms_edov: "True" }), true);
  });

  it("rejects missing, false and non-boolean-ish values", () => {
    assert.equal(isEmailVerifiedClaim({}), false);
    assert.equal(isEmailVerifiedClaim({ email_verified: false }), false);
    assert.equal(isEmailVerifiedClaim({ email_verified: "false" }), false);
    assert.equal(isEmailVerifiedClaim({ email_verified: 1 }), false);
    assert.equal(isEmailVerifiedClaim({ xms_edov: "yes" }), false);
    assert.equal(isEmailVerifiedClaim({ xms_edov: false, email_verified: null }), false);
  });
});

describe("account linking by email", () => {
  it("does NOT link an unverified email to an existing account", async () => {
    const auth = await authenticate({ oid: "ext-attacker", email: "victim@example.com" });
    assert.notEqual(auth.userId, 1, "must not take over the victim's account");
    assert.equal(db.users.length, 2);
    const created = db.users.find((u) => u.user_id === auth.userId);
    assert.equal(created.external_id, "ext-attacker");
    assert.equal(created.email, null, "unverified email must not be stored (it would squat the address)");
    assert.equal(db.identities.find((i) => i.external_id === "ext-attacker").user_id, auth.userId);
    assert.ok(
      telemetryEvents.some((e) => e.name === "auth.email_link_skipped" && e.props.reason === "email_unverified")
    );
  });

  it("does NOT link when email_verified is explicitly false", async () => {
    const auth = await authenticate({ oid: "ext-attacker", email: "victim@example.com", email_verified: false });
    assert.notEqual(auth.userId, 1);
  });

  it("links a verified email (email_verified: true) to the existing account", async () => {
    const auth = await authenticate({ oid: "ext-second-idp", email: "Victim@Example.com", email_verified: true });
    assert.equal(auth.userId, 1);
    assert.equal(db.users.length, 1);
    assert.equal(db.identities.find((i) => i.external_id === "ext-second-idp").user_id, 1);
    assert.ok(!telemetryEvents.some((e) => e.name === "auth.email_link_skipped"));
  });

  it("links a verified email supplied via the B2C `emails` claim with email_verified: 'true'", async () => {
    const auth = await authenticate({ oid: "ext-second-idp", emails: ["victim@example.com"], email_verified: "true" });
    assert.equal(auth.userId, 1);
  });

  it("links when Entra's xms_edov is true", async () => {
    const auth = await authenticate({ oid: "ext-entra", email: "victim@example.com", xms_edov: true });
    assert.equal(auth.userId, 1);
  });

  it("creates a new user and stores the email when it is verified and unknown", async () => {
    const auth = await authenticate({ oid: "ext-new", email: "new@example.com", email_verified: true });
    assert.notEqual(auth.userId, 1);
    assert.equal(db.users.find((u) => u.user_id === auth.userId).email, "new@example.com");
  });

  it("an already-linked external id keeps resolving without any email trust", async () => {
    const auth = await authenticate({ oid: "ext-original", email: "someone-else@example.com" });
    assert.equal(auth.userId, 1);
    assert.equal(db.users.length, 1);
    assert.equal(db.users[0].email, "victim@example.com", "unverified email must not overwrite the stored one");
  });

  it("a legacy app_user.external_id keeps resolving", async () => {
    db.users.push({ user_id: 7, external_id: "ext-legacy", email: null, role: "user" });
    const auth = await authenticate({ oid: "ext-legacy" });
    assert.equal(auth.userId, 7);
  });

  it("coerces a BIGINT user_id returned as a string (node-postgres int8) to a number (#227)", async () => {
    // pg returns int8 columns as strings; AuthResult.userId must still be a real number so
    // strict comparisons (e.g. image proxy owner checks) work.
    db.identities[0].user_id = "1";
    const auth = await authenticate({ oid: "ext-original" });
    assert.equal(auth.userId, 1);
    assert.equal(typeof auth.userId, "number");
  });

  it("rejects a resolved user id that is not a positive integer", async () => {
    db.identities[0].user_id = "1e3";
    await assert.rejects(() => authenticate({ oid: "ext-original" }), (err) => err.name === "AuthError");
    db.identities[0].user_id = 0;
    await assert.rejects(() => authenticate({ oid: "ext-original" }), (err) => err.name === "AuthError");
  });
});
