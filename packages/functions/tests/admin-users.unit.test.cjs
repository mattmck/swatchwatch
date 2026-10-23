/**
 * Admin user management (issue #45): list query parsing + SQL building, PATCH validation and
 * planning, the self-suspension guard, suspension enforcement in withAuth / withAdmin /
 * authenticateRequestReadOnly, and the users-admin handlers (audit row written in the same
 * transaction as the change). Runs without a database: lib/db and jose are swapped out via
 * require interception (same approach as handlers.unit.test.cjs).
 */
const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const registeredRoutes = {};
let queryMock = async () => ({ rows: [] });
let transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });
let jwtPayload = null;

const mockModules = {};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) return key;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

const dbMock = {
  query: (...args) => queryMock(...args),
  transaction: (...args) => transactionMock(...args),
  getPool: () => ({}),
  closePool: async () => {},
};
mockModules["@azure/functions"] = {
  app: {
    http: (name, opts) => {
      registeredRoutes[name] = opts;
    },
  },
};
mockModules["jose"] = {
  createRemoteJWKSet: () => () => {},
  jwtVerify: async () => {
    if (!jwtPayload) throw new Error("invalid JWT");
    return { payload: jwtPayload };
  },
};
mockModules["../lib/db"] = dbMock;
mockModules["./db"] = dbMock;
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const lib = require("../dist/lib/admin-users");
const auth = require("../dist/lib/auth");
require("../dist/functions/admin-users");

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) delete require.cache[id];
});

const ADMIN = 2;
const OTHER = 10;

const savedEnv = {};
beforeEach(() => {
  for (const key of ["AUTH_DEV_BYPASS", "AZURE_AD_B2C_TENANT", "AZURE_AD_B2C_CLIENT_ID", "WEBSITE_INSTANCE_ID", "WEBSITE_HOSTNAME"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AUTH_DEV_BYPASS = "true";
  jwtPayload = null;
  queryMock = async () => ({ rows: [] });
  transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fakeContext() {
  return { log() {}, warn() {}, error() {}, invocationId: "test-invocation" };
}

function fakeRequest({ method = "GET", url, headers = {}, params = {}, body }) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    url,
    params,
    headers: { get: (name) => h.get(name.toLowerCase()) ?? null },
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

/** Dev-bypass auth lookup row for `userId` (the first query withAuth/withAdmin issues). */
function authRow(userId, { role = "user", suspended = false } = {}) {
  return { user_id: userId, external_id: `ext-${userId}`, email: `u${userId}@test.dev`, role, suspended };
}

function isAuthLookup(sql) {
  return /SELECT user_id, external_id, email/.test(sql);
}

// ═══════════════════════════════════════════════════════════════════════════
// List query parsing + SQL
// ═══════════════════════════════════════════════════════════════════════════

describe("admin-users — parseListQuery", () => {
  it("applies defaults", () => {
    const parsed = lib.parseListQuery(new URLSearchParams(""));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, {
      q: undefined,
      role: undefined,
      state: undefined,
      sort: "created",
      dir: "desc",
      limit: 100,
      offset: 0,
    });
  });

  it("clamps limit and offset", () => {
    const parsed = lib.parseListQuery(new URLSearchParams("limit=9999&offset=-4"));
    assert.equal(parsed.value.limit, 500);
    assert.equal(parsed.value.offset, 0);
    assert.equal(lib.parseListQuery(new URLSearchParams("limit=0")).value.limit, 1);
    assert.equal(lib.parseListQuery(new URLSearchParams("limit=abc")).value.limit, 100);
  });

  for (const [qs, pattern] of [
    ["role=owner", /role/],
    ["state=banned", /state/],
    ["sort=password", /sort/],
    ["dir=sideways", /dir/],
    [`q=${"x".repeat(201)}`, /q must be/],
  ]) {
    it(`rejects ${qs.slice(0, 20)}`, () => {
      const parsed = lib.parseListQuery(new URLSearchParams(qs));
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, pattern);
    });
  }
});

describe("admin-users — buildListFilter / buildListOrder", () => {
  it("binds the search text as an escaped ILIKE parameter, never into the SQL", () => {
    const evil = "50%_off'; DROP TABLE app_user; --";
    const { whereSql, params } = lib.buildListFilter({ q: evil });
    assert.ok(!whereSql.includes("DROP TABLE"), "search text must not reach the SQL");
    assert.deepEqual(params, ["%50\\%\\_off'; DROP TABLE app\\_user; --%"]);
    assert.match(whereSql, /u\.email ILIKE \$1/);
    assert.match(whereSql, /user_external_identities/);
  });

  it("matches a numeric query against the user id too", () => {
    const { whereSql, params } = lib.buildListFilter({ q: "42" });
    assert.deepEqual(params, ["%42%", 42]);
    assert.match(whereSql, /u\.user_id = \$2/);
  });

  it("filters role and state", () => {
    const suspended = lib.buildListFilter({ role: "admin", state: "suspended" });
    assert.deepEqual(suspended.params, ["admin"]);
    assert.match(suspended.whereSql, /COALESCE\(u\.role, 'user'\) = \$1/);
    assert.match(suspended.whereSql, /u\.suspended_at IS NOT NULL/);
    assert.match(lib.buildListFilter({ state: "active" }).whereSql, /u\.suspended_at IS NULL/);
    assert.equal(lib.buildListFilter({}).whereSql, "");
  });

  it("orders by a fixed column per sort key with a user-id tie-break", () => {
    assert.equal(lib.buildListOrder({ sort: "lastSeen", dir: "asc" }), 'ORDER BY "lastSeenAtTs" ASC NULLS LAST, "userId" ASC');
    assert.match(lib.buildListOrder({ sort: "email", dir: "desc" }), /^ORDER BY lower\(COALESCE\("email", "handle", ''\)\) DESC/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PATCH validation + planning
// ═══════════════════════════════════════════════════════════════════════════

describe("admin-users — parseUserUpdate", () => {
  it("refuses role edits: role is assigned in Entra", () => {
    const parsed = lib.parseUserUpdate({ role: "admin" }, ADMIN, OTHER);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, "role_managed_in_entra");
  });

  it("refuses unknown fields and empty updates", () => {
    assert.match(lib.parseUserUpdate({ email: "x@y.z" }, ADMIN, OTHER).error, /Unknown field/);
    assert.match(lib.parseUserUpdate({}, ADMIN, OTHER).error, /Nothing to update/);
    assert.match(lib.parseUserUpdate({ note: "just a note" }, ADMIN, OTHER).error, /Nothing to update/);
    assert.match(lib.parseUserUpdate([], ADMIN, OTHER).error, /JSON object/);
  });

  it("validates handle", () => {
    assert.match(lib.parseUserUpdate({ handle: "   " }, ADMIN, OTHER).error, /handle must be/);
    assert.match(lib.parseUserUpdate({ handle: "x".repeat(65) }, ADMIN, OTHER).error, /handle must be/);
    assert.match(lib.parseUserUpdate({ handle: "bad\u0000name" }, ADMIN, OTHER).error, /control/);
    assert.match(lib.parseUserUpdate({ handle: 7 }, ADMIN, OTHER).error, /string/);
    assert.deepEqual(lib.parseUserUpdate({ handle: "  Polish Fan " }, ADMIN, OTHER).value, { handle: "Polish Fan" });
  });

  it("validates suspension fields", () => {
    assert.match(lib.parseUserUpdate({ suspended: "yes" }, ADMIN, OTHER).error, /boolean/);
    assert.match(lib.parseUserUpdate({ suspended: false, suspendedReason: "x" }, ADMIN, OTHER).error, /reactivating/);
    assert.match(lib.parseUserUpdate({ suspended: true, suspendedReason: "x".repeat(501) }, ADMIN, OTHER).error, /500/);
    assert.deepEqual(lib.parseUserUpdate({ suspended: true, suspendedReason: " spam ", note: " ticket 9 " }, ADMIN, OTHER).value, {
      suspended: true,
      suspendedReason: "spam",
      note: "ticket 9",
    });
  });

  it("refuses self-suspension with 409 cannot_modify_self", () => {
    const parsed = lib.parseUserUpdate({ suspended: true }, ADMIN, ADMIN);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, 409);
    assert.equal(parsed.code, "cannot_modify_self");
    // Editing one's own handle is fine.
    assert.equal(lib.parseUserUpdate({ handle: "me" }, ADMIN, ADMIN).ok, true);
  });
});

describe("admin-users — planUserUpdate", () => {
  const active = { handle: "old", suspendedAt: null, suspendedReason: null };
  const suspended = { handle: "old", suspendedAt: "2026-10-01 00:00:00+00", suspendedReason: "spam" };

  it("suspends with reason and actor ($2)", () => {
    const plan = lib.planUserUpdate(active, { suspended: true, suspendedReason: "abuse" }, ADMIN).value;
    assert.equal(plan.action, "user.suspend");
    assert.deepEqual(plan.setSql, ["suspended_at = now()", "suspended_reason = $2", "suspended_by_user_id = $3"]);
    assert.deepEqual(plan.params, ["abuse", ADMIN]);
    assert.deepEqual(plan.changes.suspended, { from: false, to: true });
  });

  it("reactivates and clears the suspension columns", () => {
    const plan = lib.planUserUpdate(suspended, { suspended: false }, ADMIN).value;
    assert.equal(plan.action, "user.unsuspend");
    assert.deepEqual(plan.setSql, ["suspended_at = NULL", "suspended_reason = NULL", "suspended_by_user_id = NULL"]);
    assert.deepEqual(plan.changes.suspendedReason, { from: "spam", to: null });
  });

  it("records a handle change with before/after", () => {
    const plan = lib.planUserUpdate(active, { handle: "new" }, ADMIN).value;
    assert.equal(plan.action, "user.update");
    // Only referenced values are bound: Postgres cannot type an unused parameter.
    assert.deepEqual(plan.setSql, ["handle = $2"]);
    assert.deepEqual(plan.params, ["new"]);
    assert.deepEqual(plan.changes, { handle: { from: "old", to: "new" } });
  });

  it("returns null for a no-op", () => {
    assert.equal(lib.planUserUpdate(active, { handle: "old", suspended: false }, ADMIN).value, null);
    assert.equal(lib.planUserUpdate(suspended, { suspended: true }, ADMIN).value, null);
  });

  it("refuses a reason on an active account", () => {
    const planned = lib.planUserUpdate(active, { suspendedReason: "x" }, ADMIN);
    assert.equal(planned.ok, false);
    assert.match(planned.error, /suspended account/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suspension in the auth wrappers
// ═══════════════════════════════════════════════════════════════════════════

describe("auth — suspended accounts are rejected", () => {
  function devAuthAs(row) {
    queryMock = async (sql) => {
      if (isAuthLookup(sql)) return { rows: [row] };
      return { rows: [] };
    };
  }

  it("dev bypass lookup reads suspension without depending on the column existing", async () => {
    const seen = [];
    queryMock = async (sql) => {
      seen.push(sql);
      return { rows: [authRow(OTHER)] };
    };
    await auth.authenticateRequest(fakeRequest({ url: "http://x", headers: { authorization: `Bearer dev:${OTHER}` } }), fakeContext());
    assert.match(seen[0], /to_jsonb\(app_user\.\*\) ->> 'suspended_at'/);
  });

  it("withAuth answers 403 account_suspended and never runs the handler", async () => {
    devAuthAs(authRow(OTHER, { suspended: true }));
    let ran = false;
    const wrapped = auth.withAuth(async () => {
      ran = true;
      return { status: 200 };
    });
    const res = await wrapped(fakeRequest({ url: "http://x", headers: { authorization: `Bearer dev:${OTHER}` } }), fakeContext());
    assert.equal(res.status, 403);
    assert.equal(res.jsonBody.code, "account_suspended");
    assert.equal(ran, false);
  });

  it("withAdmin answers 403 account_suspended for a suspended admin", async () => {
    devAuthAs(authRow(ADMIN, { role: "admin", suspended: true }));
    let ran = false;
    const wrapped = auth.withAdmin(async () => {
      ran = true;
      return { status: 200 };
    });
    const res = await wrapped(fakeRequest({ url: "http://x", headers: { authorization: `Bearer dev:${ADMIN}` } }), fakeContext());
    assert.equal(res.status, 403);
    assert.equal(res.jsonBody.code, "account_suspended");
    assert.equal(ran, false);
  });

  it("an active account passes through", async () => {
    devAuthAs(authRow(OTHER));
    const wrapped = auth.withAuth(async (_req, _ctx, userId) => ({ status: 200, jsonBody: { userId } }));
    const res = await wrapped(fakeRequest({ url: "http://x", headers: { authorization: `Bearer dev:${OTHER}` } }), fakeContext());
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.userId, OTHER);
  });

  it("authenticateRequestReadOnly rejects a suspended account", async () => {
    devAuthAs(authRow(OTHER, { suspended: true }));
    await assert.rejects(
      auth.authenticateRequestReadOnly(fakeRequest({ url: "http://x", headers: { authorization: `Bearer dev:${OTHER}` } }), fakeContext()),
      (error) => error instanceof auth.AccountSuspendedError
    );
  });

  it("JWT sign-in: the login upsert's RETURNING carries suspension and the request is refused", async () => {
    delete process.env.AUTH_DEV_BYPASS;
    process.env.AZURE_AD_B2C_TENANT = "tenant";
    process.env.AZURE_AD_B2C_CLIENT_ID = "client";
    jwtPayload = { oid: "oid-suspended", email: "s@test.dev", email_verified: true };
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ issuer: "https://issuer", jwks_uri: "https://issuer/keys" }) });
    const txSql = [];
    transactionMock = async (cb) =>
      cb({
        query: async (sql) => {
          txSql.push(sql);
          if (/FROM user_external_identities uei/.test(sql)) return { rows: [{ userId: OTHER }] };
          if (/UPDATE app_user/.test(sql)) return { rows: [{ role: "user", suspended: true }] };
          return { rows: [] };
        },
      });
    try {
      const wrapped = auth.withAuth(async () => ({ status: 200 }));
      const res = await wrapped(fakeRequest({ url: "http://x", headers: { authorization: "Bearer jwt" } }), fakeContext());
      assert.equal(res.status, 403);
      assert.equal(res.jsonBody.code, "account_suspended");
      assert.ok(txSql.some((sql) => /RETURNING role, \(to_jsonb\(app_user\.\*\) ->> 'suspended_at'\) IS NOT NULL/.test(sql)));
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════════════════

describe("functions/admin-users — routes", () => {
  it("registers list, item (GET + PATCH on one route) and merge", () => {
    assert.deepEqual(registeredRoutes["admin-users-list"].methods, ["GET", "OPTIONS"]);
    // The Functions host rejects two functions on one route template, so GET and PATCH share one.
    assert.equal(registeredRoutes["admin-users-item"].route, "users-admin/{id}");
    assert.deepEqual(registeredRoutes["admin-users-item"].methods, ["GET", "PATCH", "OPTIONS"]);
    assert.equal(registeredRoutes["admin-users-merge"].route, "users-admin/merge");
    const routes = Object.values(registeredRoutes).map((r) => r.route);
    assert.equal(new Set(routes).size, routes.length, "no two functions share a route");
  });
});

function adminQueryMock(handler) {
  return async (sql, params) => {
    if (isAuthLookup(sql)) {
      const id = params[0];
      return { rows: [authRow(id, { role: id === ADMIN ? "admin" : "user" })] };
    }
    return handler(sql, params);
  };
}

function detailRows(sql, params) {
  if (/FROM app_user u/.test(sql) && /WHERE u\.user_id = \$1/.test(sql)) {
    return {
      rows: [
        {
          userId: String(params[0]),
          role: "user",
          email: "target@test.dev",
          externalId: "oid-target",
          handle: "target",
          createdAt: "2026-01-01 00:00:00+00",
          suspendedAt: null,
          suspendedReason: null,
          suspendedByUserId: null,
          lastSeenAt: "2026-10-01 00:00:00+00",
          inventoryCount: "3",
          submissionCount: "0",
          captureSessionCount: "1",
          linkedExternalIds: ["oid-target"],
        },
      ],
    };
  }
  return { rows: [] };
}

describe("functions/admin-users — GET list", () => {
  it("returns 403 for a regular user without querying users", async () => {
    const seen = [];
    queryMock = adminQueryMock(async (sql) => {
      seen.push(sql);
      return { rows: [] };
    });
    const res = await registeredRoutes["admin-users-list"].handler(
      fakeRequest({ url: "http://localhost/api/users-admin", headers: { authorization: `Bearer dev:${OTHER}` } }),
      fakeContext()
    );
    assert.equal(res.status, 403);
    assert.deepEqual(seen, []);
  });

  it("400 on a bad filter", async () => {
    queryMock = adminQueryMock(async () => ({ rows: [] }));
    const res = await registeredRoutes["admin-users-list"].handler(
      fakeRequest({ url: "http://localhost/api/users-admin?state=gone", headers: { authorization: `Bearer dev:${ADMIN}` } }),
      fakeContext()
    );
    assert.equal(res.status, 400);
  });

  it("binds filters and pagination and maps rows", async () => {
    const calls = [];
    queryMock = adminQueryMock(async (sql, params) => {
      calls.push({ sql, params });
      if (/COUNT\(\*\)::text AS total/.test(sql)) return { rows: [{ total: "7" }] };
      return detailRows("FROM app_user u WHERE u.user_id = $1", [OTHER]);
    });
    const res = await registeredRoutes["admin-users-list"].handler(
      fakeRequest({
        url: "http://localhost/api/users-admin?q=target&role=user&state=active&sort=inventory&dir=asc&limit=2&offset=4",
        headers: { authorization: `Bearer dev:${ADMIN}` },
      }),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.total, 7);
    assert.equal(res.jsonBody.limit, 2);
    assert.equal(res.jsonBody.offset, 4);
    assert.equal(res.jsonBody.users[0].userId, OTHER);
    assert.equal(res.jsonBody.users[0].state, "active");
    assert.equal(res.jsonBody.users[0].inventoryCount, 3);
    const page = calls.find((c) => /LIMIT \$3 OFFSET \$4/.test(c.sql));
    assert.ok(page, "page query binds limit/offset after the filter params");
    assert.deepEqual(page.params, ["%target%", "user", 2, 4]);
    assert.match(page.sql, /ORDER BY "inventoryCountNum" ASC/);
  });
});

describe("functions/admin-users — GET detail", () => {
  it("400 on a non-numeric id, 404 when missing", async () => {
    queryMock = adminQueryMock(async () => ({ rows: [] }));
    const handler = registeredRoutes["admin-users-item"].handler;
    const headers = { authorization: `Bearer dev:${ADMIN}` };
    assert.equal((await handler(fakeRequest({ url: "http://x", headers, params: { id: "12abc" } }), fakeContext())).status, 400);
    assert.equal((await handler(fakeRequest({ url: "http://x", headers, params: { id: "55" } }), fakeContext())).status, 404);
  });

  it("returns the user, identities and audit events", async () => {
    queryMock = adminQueryMock(async (sql, params) => {
      if (/FROM user_external_identities\s+WHERE user_id = \$1/.test(sql)) {
        return { rows: [{ externalId: "oid-target", email: "target@test.dev", createdAt: "c", lastSeenAt: "l" }] };
      }
      if (/FROM admin_audit_event e/.test(sql)) {
        assert.deepEqual(params, [OTHER, 20]);
        return {
          rows: [
            {
              auditEventId: "5",
              actorUserId: String(ADMIN),
              actorLabel: "admin@test.dev",
              targetUserId: String(OTHER),
              action: "user.update",
              changes: { handle: { from: "a", to: "b" } },
              note: null,
              createdAt: "t",
            },
          ],
        };
      }
      return detailRows(sql, params);
    });
    const res = await registeredRoutes["admin-users-item"].handler(
      fakeRequest({ url: "http://x", headers: { authorization: `Bearer dev:${ADMIN}` }, params: { id: String(OTHER) } }),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.user.userId, OTHER);
    assert.equal(res.jsonBody.identities.length, 1);
    assert.equal(res.jsonBody.auditEvents[0].auditEventId, 5);
    assert.equal(res.jsonBody.auditEvents[0].actorUserId, ADMIN);
  });
});

describe("functions/admin-users — PATCH", () => {
  function patch(body, { as = ADMIN, id = OTHER } = {}) {
    return registeredRoutes["admin-users-item"].handler(
      fakeRequest({
        method: "PATCH",
        url: `http://localhost/api/users-admin/${id}`,
        headers: { authorization: `Bearer dev:${as}` },
        params: { id: String(id) },
        body,
      }),
      fakeContext()
    );
  }

  function txRecorder(current, { failUpdateWith } = {}) {
    const statements = [];
    let transactions = 0;
    transactionMock = async (cb) => {
      transactions++;
      return cb({
        query: async (sql, params) => {
          statements.push({ sql, params });
          if (/FOR UPDATE/.test(sql)) return { rows: current ? [current] : [] };
          if (/^\s*UPDATE app_user/.test(sql) && failUpdateWith) {
            throw Object.assign(new Error("dup"), { code: failUpdateWith });
          }
          return { rows: [], rowCount: 1 };
        },
      });
    };
    return { statements, count: () => transactions };
  }

  it("a regular user gets 403 and nothing runs", async () => {
    queryMock = adminQueryMock(async () => ({ rows: [] }));
    const tx = txRecorder({ handle: "x", suspendedAt: null, suspendedReason: null });
    const res = await patch({ suspended: true }, { as: OTHER, id: 77 });
    assert.equal(res.status, 403);
    assert.equal(tx.count(), 0);
  });

  it("an admin cannot suspend themselves (409) and no transaction runs", async () => {
    queryMock = adminQueryMock(async () => ({ rows: [] }));
    const tx = txRecorder({ handle: "x", suspendedAt: null, suspendedReason: null });
    const res = await patch({ suspended: true }, { id: ADMIN });
    assert.equal(res.status, 409);
    assert.equal(res.jsonBody.code, "cannot_modify_self");
    assert.equal(tx.count(), 0);
  });

  it("role edits are refused with 400", async () => {
    queryMock = adminQueryMock(async () => ({ rows: [] }));
    const res = await patch({ role: "admin" });
    assert.equal(res.status, 400);
    assert.equal(res.jsonBody.code, "role_managed_in_entra");
  });

  it("suspends: locks the row, updates it and writes the audit event in the same transaction", async () => {
    queryMock = adminQueryMock(async (sql, params) => detailRows(sql, params));
    const tx = txRecorder({ handle: "target", suspendedAt: null, suspendedReason: null });
    const res = await patch({ suspended: true, suspendedReason: "spam", note: "ticket 12" });
    assert.equal(res.status, 200);
    assert.equal(tx.count(), 1);
    const [lock, update, audit] = tx.statements;
    assert.match(lock.sql, /FOR UPDATE/);
    assert.deepEqual(lock.params, [OTHER]);
    assert.match(update.sql, /SET suspended_at = now\(\), suspended_reason = \$2, suspended_by_user_id = \$3/);
    assert.deepEqual(update.params, [OTHER, "spam", ADMIN]);
    assert.match(audit.sql, /INSERT INTO admin_audit_event/);
    assert.equal(audit.params[0], ADMIN);
    assert.equal(audit.params[1], OTHER);
    assert.equal(audit.params[2], "user.suspend");
    assert.deepEqual(JSON.parse(audit.params[3]).suspended, { from: false, to: true });
    assert.equal(audit.params[4], "ticket 12");
  });

  it("a no-op writes neither the row nor an audit event", async () => {
    queryMock = adminQueryMock(async (sql, params) => detailRows(sql, params));
    const tx = txRecorder({ handle: "target", suspendedAt: null, suspendedReason: null });
    const res = await patch({ handle: "target" });
    assert.equal(res.status, 200);
    assert.equal(tx.statements.length, 1, "only the lock query runs");
  });

  it("404 for a missing user, 409 for a taken handle", async () => {
    queryMock = adminQueryMock(async () => ({ rows: [] }));
    txRecorder(null);
    assert.equal((await patch({ handle: "x" })).status, 404);

    const tx = txRecorder({ handle: "target", suspendedAt: null, suspendedReason: null }, { failUpdateWith: "23505" });
    const res = await patch({ handle: "taken" });
    assert.equal(res.status, 409);
    assert.equal(res.jsonBody.code, "handle_taken");
    assert.ok(!tx.statements.some((s) => /admin_audit_event/.test(s.sql)), "no audit row for a failed change");
  });

  it("400 for invalid JSON", async () => {
    queryMock = adminQueryMock(async () => ({ rows: [] }));
    const res = await registeredRoutes["admin-users-item"].handler(
      fakeRequest({ method: "PATCH", url: "http://x", headers: { authorization: `Bearer dev:${ADMIN}` }, params: { id: "3" } }),
      fakeContext()
    );
    assert.equal(res.status, 400);
  });
});

describe("functions/admin-users — merge guards", () => {
  function mergeTx(sourceSuspended) {
    const statements = [];
    transactionMock = async (cb) =>
      cb({
        query: async (sql, params) => {
          statements.push({ sql, params });
          if (/WHERE user_id = ANY/.test(sql)) {
            return {
              rows: [
                {
                  userId: "10",
                  role: "user",
                  email: "source@test.dev",
                  externalId: "oid-source",
                  suspendedAt: sourceSuspended ? "2026-10-01T00:00:00.000Z" : null,
                  suspendedReason: sourceSuspended ? "spam" : null,
                  suspendedByUserId: sourceSuspended ? "2" : null,
                },
                { userId: "20", role: "user", email: "t@test.dev", externalId: "oid-t", suspendedAt: null, suspendedReason: null, suspendedByUserId: null },
              ],
            };
          }
          return { rows: [], rowCount: 1 };
        },
      });
    return statements;
  }

  function merge(body) {
    return registeredRoutes["admin-users-merge"].handler(
      fakeRequest({ method: "POST", url: "http://x", headers: { authorization: `Bearer dev:${ADMIN}` }, body }),
      fakeContext()
    );
  }

  it("refuses merging away the caller's own account (409) before any transaction", async () => {
    queryMock = adminQueryMock(async () => ({ rows: [] }));
    const statements = mergeTx(false);
    const res = await merge({ sourceUserId: ADMIN, targetUserId: 20 });
    assert.equal(res.status, 409);
    assert.equal(res.jsonBody.code, "cannot_modify_self");
    assert.equal(statements.length, 0);
  });

  it("carries a source suspension onto the target and audits it", async () => {
    queryMock = adminQueryMock(async () => ({ rows: [] }));
    const statements = mergeTx(true);
    const res = await merge({ sourceUserId: 10, targetUserId: 20 });
    assert.equal(res.status, 200);
    const carry = statements.find((s) => /SET suspended_at = \$2, suspended_reason = \$3, suspended_by_user_id = \$4/.test(s.sql));
    assert.ok(carry, "target inherits the suspension");
    assert.deepEqual(carry.params, [20, "2026-10-01T00:00:00.000Z", "spam", "2"]);
    const audit = statements.find((s) => /INSERT INTO admin_audit_event/.test(s.sql));
    assert.deepEqual(JSON.parse(audit.params[3]).suspended, { from: false, to: true });
  });

  it("leaves the target's state alone when the source is active", async () => {
    queryMock = adminQueryMock(async () => ({ rows: [] }));
    const statements = mergeTx(false);
    assert.equal((await merge({ sourceUserId: 10, targetUserId: 20 })).status, 200);
    assert.ok(!statements.some((s) => /SET suspended_at = \$2/.test(s.sql)));
  });
});

describe("functions/admin-users — merge is audited", () => {
  it("writes a user.merge audit row inside the merge transaction", async () => {
    queryMock = adminQueryMock(async () => ({ rows: [] }));
    const statements = [];
    transactionMock = async (cb) =>
      cb({
        query: async (sql, params) => {
          statements.push({ sql, params });
          if (/WHERE user_id = ANY/.test(sql)) {
            return {
              rows: [
                // BIGINT ids arrive as strings from node-postgres.
                { userId: "10", role: "user", email: "source@test.dev", externalId: "oid-source" },
                { userId: "20", role: "admin", email: "target@test.dev", externalId: "oid-target" },
              ],
            };
          }
          return { rows: [], rowCount: 1 };
        },
      });
    const res = await registeredRoutes["admin-users-merge"].handler(
      fakeRequest({
        method: "POST",
        url: "http://x",
        headers: { authorization: `Bearer dev:${ADMIN}` },
        body: { sourceUserId: 10, targetUserId: 20 },
      }),
      fakeContext()
    );
    assert.equal(res.status, 200);
    const audit = statements.find((s) => /INSERT INTO admin_audit_event/.test(s.sql));
    assert.ok(audit, "merge writes an audit row");
    assert.deepEqual(audit.params.slice(0, 3), [ADMIN, 20, "user.merge"]);
    assert.equal(JSON.parse(audit.params[3]).sourceUserId, 10);
    assert.equal(res.jsonBody.targetRole, "admin");
    const deleteIndex = statements.findIndex((s) => /DELETE FROM app_user/.test(s.sql));
    assert.ok(statements.indexOf(audit) > deleteIndex, "audit row is written after the merge statements");
  });

  it("moves the source's bottle eval samples to the target before deleting the source", async () => {
    queryMock = adminQueryMock(async () => ({ rows: [] }));
    const statements = [];
    transactionMock = async (cb) =>
      cb({
        query: async (sql, params) => {
          statements.push({ sql, params });
          if (/WHERE user_id = ANY/.test(sql)) {
            return {
              rows: [
                { userId: "10", role: "admin", email: "source@test.dev", externalId: "oid-source" },
                { userId: "20", role: "admin", email: "target@test.dev", externalId: "oid-target" },
              ],
            };
          }
          if (/UPDATE bottle_eval_sample/.test(sql)) return { rows: [], rowCount: 4 };
          return { rows: [], rowCount: 1 };
        },
      });
    const res = await registeredRoutes["admin-users-merge"].handler(
      fakeRequest({
        method: "POST",
        url: "http://x",
        headers: { authorization: `Bearer dev:${ADMIN}` },
        body: { sourceUserId: 10, targetUserId: 20 },
      }),
      fakeContext()
    );
    assert.equal(res.status, 200);
    const moveIndex = statements.findIndex((s) => /UPDATE bottle_eval_sample\s+SET created_by_user_id = \$1\s+WHERE created_by_user_id = \$2/.test(s.sql));
    assert.ok(moveIndex >= 0, "eval samples are re-owned inside the merge transaction");
    assert.deepEqual(statements[moveIndex].params, [20, 10]);
    const deleteIndex = statements.findIndex((s) => /DELETE FROM app_user/.test(s.sql));
    assert.ok(moveIndex < deleteIndex, "samples move before the source user is deleted");
    const audit = statements.find((s) => /INSERT INTO admin_audit_event/.test(s.sql));
    assert.equal(JSON.parse(audit.params[3]).bottleEvalSamplesMoved, 4);
  });
});
