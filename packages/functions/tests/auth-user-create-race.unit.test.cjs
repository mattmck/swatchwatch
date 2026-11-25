/**
 * First sign-in must not fail when several requests race to create the same user (#525).
 *
 * A brand-new user's first dashboard load fires several API calls at once; each runs
 * `getOrCreateUser` in its own transaction. Without a verified email there is no advisory
 * lock, so every transaction can miss the user on lookup and try to insert it. The losers
 * must read the winner's row instead of failing with a unique violation (23505), which
 * `withAuth` used to turn into a 401 "Authentication failed".
 *
 * Runs without a database: `./db` and `./telemetry` are replaced via require interception.
 * The fake client yields between statements so parallel calls interleave like concurrent
 * transactions, and its INSERT honours `ON CONFLICT (external_id) DO NOTHING`.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

let db;
let telemetryEvents = [];
/** "on-conflict": the insert returns no row; "unique-violation": it throws 23505 (e.g. on `handle`). */
let conflictMode = "on-conflict";

function resetDb() {
  db = { nextUserId: 100, users: [], identities: [], statements: [] };
  telemetryEvents = [];
  conflictMode = "on-conflict";
}
resetDb();

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function clientQuery(sql, params = []) {
  const text = String(sql);
  db.statements.push({ sql: text, params });
  // Yield so concurrent callers interleave: every lookup runs before any insert.
  await tick();

  if (/^\s*(SAVEPOINT|RELEASE\s+SAVEPOINT|ROLLBACK\s+TO\s+SAVEPOINT)\b/i.test(text)) return { rows: [] };
  if (/FROM\s+user_external_identities\s+uei/i.test(text)) {
    const identity = db.identities.find((i) => i.external_id === params[0]);
    return { rows: identity ? [{ userId: identity.user_id }] : [] };
  }
  if (/FROM\s+app_user\s+WHERE\s+external_id\s*=\s*\$1/i.test(text)) {
    const user = db.users.find((u) => u.external_id === params[0]);
    return { rows: user ? [{ userId: user.user_id }] : [] };
  }
  if (/INSERT\s+INTO\s+app_user/i.test(text)) {
    if (db.users.some((u) => u.external_id === params[0])) {
      if (conflictMode === "unique-violation") {
        const error = new Error('duplicate key value violates unique constraint "app_user_handle_key"');
        error.code = "23505";
        throw error;
      }
      assert.match(text, /ON\s+CONFLICT\s*\(external_id\)\s*DO\s+NOTHING/i);
      return { rows: [] };
    }
    const user = { user_id: db.nextUserId++, external_id: params[0], email: params[1], role: params[3] || "user" };
    db.users.push(user);
    return { rows: [{ userId: user.user_id, role: user.role }] };
  }
  if (/UPDATE\s+app_user/i.test(text)) {
    const user = db.users.find((u) => u.user_id === params[0]);
    if (user && params[1]) user.email = params[1];
    if (user && params[2]) user.role = params[2];
    return { rows: user ? [{ role: user.role, suspended: user.suspended === true }] : [] };
  }
  if (/INSERT\s+INTO\s+user_external_identities/i.test(text)) {
    const existing = db.identities.find((i) => i.external_id === params[1]);
    if (existing) existing.user_id = params[0];
    else db.identities.push({ user_id: params[0], external_id: params[1], email: params[2] });
    return { rows: [] };
  }
  throw new Error(`unexpected SQL in user-create race test: ${text}`);
}

const originalResolve = Module._resolveFilename;
const mocks = {
  jose: { createRemoteJWKSet: () => ({}), jwtVerify: async () => ({ payload: {} }) },
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

const { getOrCreateUser } = require("../dist/lib/auth");

beforeEach(resetDb);

describe("getOrCreateUser under concurrent first sign-in (#525)", () => {
  it("creates one user when 5 requests for a new external id run in parallel (ON CONFLICT DO NOTHING)", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => getOrCreateUser("ext-new")));

    assert.equal(db.users.length, 1, "exactly one app_user row");
    const userId = db.users[0].user_id;
    for (const result of results) {
      assert.equal(result.userId, userId);
      assert.equal(result.role, "user");
      assert.equal(result.suspended === true, false);
    }
    assert.equal(db.identities.length, 1);
    assert.equal(db.identities[0].user_id, userId);
    assert.equal(telemetryEvents.filter((e) => e.name === "auth.user_create_race").length, 4);
  });

  it("recovers from a 23505 on another unique index by rolling back to the savepoint", async () => {
    conflictMode = "unique-violation";
    const results = await Promise.all(Array.from({ length: 5 }, () => getOrCreateUser("ext-new")));

    assert.equal(db.users.length, 1);
    for (const result of results) assert.equal(result.userId, db.users[0].user_id);
    assert.equal(
      db.statements.filter((s) => /ROLLBACK\s+TO\s+SAVEPOINT\s+app_user_insert/i.test(s.sql)).length,
      4,
      "each loser rolls back only its savepoint, not the transaction"
    );
  });

  it("keeps the suspended flag for a user re-read after losing the race", async () => {
    // Another request created (and an admin suspended) the user between this call's lookup and insert.
    const originalPush = db.statements.push.bind(db.statements);
    db.statements.push = (entry) => {
      if (/INSERT\s+INTO\s+app_user/i.test(entry.sql) && db.users.length === 0) {
        db.users.push({ user_id: 7, external_id: "ext-new", email: null, role: "user", suspended: true });
      }
      return originalPush(entry);
    };

    const result = await getOrCreateUser("ext-new");
    assert.equal(result.userId, 7);
    assert.equal(result.suspended, true);
    assert.equal(db.users.length, 1);
  });

  it("still creates a normal user when there is no race", async () => {
    const result = await getOrCreateUser("ext-solo");
    assert.equal(result.userId, 100);
    assert.equal(db.users.length, 1);
    assert.equal(telemetryEvents.some((e) => e.name === "auth.user_create_race"), false);
    assert.ok(db.statements.some((s) => /RELEASE\s+SAVEPOINT\s+app_user_insert/i.test(s.sql)));
  });
});
