const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Handler tests need db / jose / @azure/functions mocked before the dist modules load
// (same approach as admin-users.unit.test.cjs). The pure planners never touch the db.
const registeredRoutes = {};
let queryMock = async () => ({ rows: [] });
let transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });

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
  app: { http: (name, opts) => { registeredRoutes[name] = opts; } },
};
mockModules["jose"] = {
  createRemoteJWKSet: () => () => {},
  jwtVerify: async () => { throw new Error("invalid JWT"); },
};
mockModules["../lib/db"] = dbMock;
mockModules["./db"] = dbMock;
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const {
  BRAND_DUPLICATE_SQL,
  brandsAdminBrandsSql,
  buildBrandList,
  normalizeBrandName,
  parseBrandProfileRequest,
} = require("../dist/lib/brands-admin");
require("../dist/functions/brands-admin");

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) delete require.cache[id];
});

function brandRow(overrides = {}) {
  return {
    brandId: "1",
    name: "ILNP",
    aliases: [],
    colorShades: "0",
    otherShades: "0",
    latestIngestAt: null,
    hasProfile: false,
    websiteUrl: null,
    platform: null,
    blocker: null,
    notes: null,
    ownDataSourceId: null,
    profileUpdatedAt: null,
    ...overrides,
  };
}
const brandSource = (id, name, metadata = {}, enabled = false) => ({ dataSourceId: String(id), name, enabled, metadata });

describe("normalizeBrandName", () => {
  it("trims and collapses whitespace", () => {
    assert.equal(normalizeBrandName(" I  Scream   Nails "), "I Scream Nails");
  });
});

describe("buildBrandList", () => {
  it("a brand with no shades and an explicit pending store is own", () => {
    const [item] = buildBrandList({
      brands: [brandRow({ hasProfile: true, ownDataSourceId: "5", profileUpdatedAt: "2026-11-11" })],
      sources: [brandSource(5, "IlnpWooCommerce", { pendingApproval: true })],
      links: [],
    });
    assert.equal(item.supply, "own");
    assert.equal(item.colorShades, 0);
    assert.equal(item.otherShades, 0);
    assert.equal(item.ownStores.length, 1);
    assert.equal(item.ownStores[0].link, "explicit");
    assert.equal(item.ownStores[0].displayName, "Ilnp");
    assert.equal(item.profile.ownDataSourceId, 5);
  });

  it("explicit plus listings link dedupes to one explicit entry", () => {
    const [item] = buildBrandList({
      brands: [brandRow({ hasProfile: true, ownDataSourceId: 5 })],
      sources: [brandSource(5, "IlnpWooCommerce")],
      links: [{ brandId: 1, dataSourceId: 5 }],
    });
    assert.equal(item.ownStores.length, 1);
    assert.equal(item.ownStores[0].link, "explicit");
    assert.equal(item.retailers.length, 0);
  });

  it("matches metadata.brand case-insensitively, also by alias", () => {
    const sources = [brandSource(5, "IlnpWooCommerce", { brand: "  ilnp " }), brandSource(6, "PaintedPolishBigCartel", { brand: "I L N P" })];
    const [byName] = buildBrandList({ brands: [brandRow({ name: "ILNP" })], sources: [sources[0], brandSource(9, "HypnoticPolishShopify", { brand: "Zed" })], links: [] });
    assert.deepEqual(byName.ownStores.map((s) => [s.dataSourceId, s.link]), [[5, "metadata"]]);
    const [byAlias] = buildBrandList({ brands: [brandRow({ aliases: ["i  l n p"] })], sources, links: [] });
    assert.deepEqual(byAlias.ownStores.map((s) => s.dataSourceId).sort(), [5, 6]);
  });

  it("links a brand-kind source by its display name, ignoring punctuation and case", () => {
    const [item] = buildBrandList({
      brands: [brandRow({ name: "Bee's Knees Lacquer" })],
      sources: [brandSource(5, "BeesKneesLacquerShopify")],
      links: [],
    });
    assert.deepEqual(item.ownStores.map((s) => [s.dataSourceId, s.link, s.displayName]), [[5, "name", "Bees Knees Lacquer"]]);
    const [byAlias] = buildBrandList({
      brands: [brandRow({ name: "Bee's Knees", aliases: ["Bees Knees Lacquer"] })],
      sources: [brandSource(5, "BeesKneesLacquerShopify")],
      links: [],
    });
    assert.equal(byAlias.ownStores[0].link, "name");
  });

  it("metadata.brand names the source and beats the name link; explicit beats both", () => {
    const [item] = buildBrandList({
      brands: [brandRow({ hasProfile: true, ownDataSourceId: 6 })],
      sources: [brandSource(5, "MooncatShopify", { brand: "ILNP" }), brandSource(6, "IlnpWooCommerce"), brandSource(7, "HypnoticPolishShopify", { brand: "Zed" })],
      links: [],
    });
    assert.deepEqual(item.ownStores.map((s) => [s.dataSourceId, s.link]), [[6, "explicit"], [5, "metadata"]]);
    assert.equal(item.ownStores[1].displayName, "ILNP");
  });

  it("a brand-kind source with listings on the brand's shades is not an own store without a name link", () => {
    const [item] = buildBrandList({
      brands: [brandRow()],
      sources: [brandSource(5, "MooncatShopify"), brandSource(6, "HypnoticPolishShopify")],
      links: [{ brandId: 1, dataSourceId: 5 }, { brandId: 1, dataSourceId: 6 }],
    });
    assert.equal(item.ownStores.length, 0);
    assert.equal(item.retailers.length, 0);
    assert.equal(item.supply, "none");
  });

  it("open-data sources are neither own stores nor retailers", () => {
    const [item] = buildBrandList({
      brands: [brandRow({ name: "Makeup Api" })],
      sources: [brandSource(5, "MakeupAPI"), brandSource(6, "OpenBeautyFacts", { kind: "retailer" })],
      links: [{ brandId: 1, dataSourceId: 5 }, { brandId: 1, dataSourceId: 6 }],
    });
    assert.equal(item.ownStores.length, 0);
    assert.equal(item.retailers.length, 0);
  });

  it("an open-data explicit store derives not_needed", () => {
    const [item] = buildBrandList({
      brands: [brandRow({ hasProfile: true, ownDataSourceId: 5 })],
      sources: [brandSource(5, "MakeupAPI")],
      links: [],
    });
    assert.equal(item.ownStores[0].permissionStatus, "not_needed");
  });

  it("retailer-only brand is retailer; feeds count; nothing is none", () => {
    const sources = [brandSource(7, "HarlowAndCoShopify", { kind: "retailer" }), brandSource(8, "BeyondPolishShopify", { kind: "feed" })];
    const [retail] = buildBrandList({
      brands: [brandRow()],
      sources,
      links: [{ brandId: 1, dataSourceId: 7 }, { brandId: 1, dataSourceId: 8 }],
    });
    assert.equal(retail.supply, "retailer");
    assert.equal(retail.ownStores.length, 0);
    assert.equal(retail.retailers.length, 2);
    const [none] = buildBrandList({ brands: [brandRow()], sources, links: [] });
    assert.equal(none.supply, "none");
  });

  it("both when an own store and a retailer exist; explicit retailer-kind source counts as own", () => {
    const sources = [brandSource(5, "MooncatShopify", { brand: "ILNP" }), brandSource(7, "HarlowAndCoShopify", { kind: "retailer" })];
    const [both] = buildBrandList({ brands: [brandRow()], sources, links: [{ brandId: 1, dataSourceId: 7 }] });
    assert.equal(both.supply, "both");
    const [explicit] = buildBrandList({
      brands: [brandRow({ hasProfile: true, ownDataSourceId: 7 })],
      sources,
      links: [{ brandId: 1, dataSourceId: 7 }],
    });
    assert.equal(explicit.ownStores[0].kind, "retailer");
    assert.equal(explicit.retailers.length, 0);
  });

  it("maps counts and profile", () => {
    const [item] = buildBrandList({
      brands: [brandRow({ colorShades: "12", otherShades: "3", latestIngestAt: "2026-11-10", hasProfile: true, platform: "custom", websiteUrl: "https://x.example" })],
      sources: [],
      links: [],
    });
    assert.equal(item.colorShades, 12);
    assert.equal(item.otherShades, 3);
    assert.equal(item.latestIngestAt, "2026-11-10");
    assert.equal(item.profile.platform, "custom");
  });
});

describe("brands admin SQL", () => {
  it("duplicate lookup ranks a canonical-name match before an alias match, then brand id", () => {
    assert.match(BRAND_DUPLICATE_SQL, /ORDER BY m\.rank, m\."brandId"/);
    assert.match(BRAND_DUPLICATE_SQL, /UNION ALL/);
  });

  it("timestamps are ISO-8601 UTC text", () => {
    const sql = brandsAdminBrandsSql(false);
    assert.match(sql, /to_char\(max\(ssp\.last_seen_at\) AT TIME ZONE 'UTC'/);
    assert.match(sql, /to_char\(bip\.updated_at AT TIME ZONE 'UTC'/);
  });
});

describe("parseBrandProfileRequest", () => {
  it("accepts valid values, null clears, missing keys stay missing", () => {
    const ok = parseBrandProfileRequest({ websiteUrl: "https://x.example/a", platform: "shopify", notes: " hi ", ownDataSourceId: 4, blocker: null });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value, { websiteUrl: "https://x.example/a", platform: "shopify", notes: "hi", ownDataSourceId: 4, blocker: null });
    assert.deepEqual(parseBrandProfileRequest({}).value, {});
  });
  it("rejects bad values", () => {
    for (const bad of [
      { platform: "squarespace" },
      { websiteUrl: "javascript:x" },
      { websiteUrl: "https://u:p@x.example" },
      { websiteUrl: "/relative" },
      { websiteUrl: "https://x.example/" + "a".repeat(500) },
      { notes: "x".repeat(1001) },
      { blocker: 5 },
      { ownDataSourceId: 0 },
      { ownDataSourceId: 1.5 },
      { ownDataSourceId: "3" },
    ]) {
      assert.equal(parseBrandProfileRequest(bad).ok, false, JSON.stringify(bad));
    }
    assert.equal(parseBrandProfileRequest(null).ok, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════════════════

const ADMIN = 2;
const OTHER = 10;
const savedEnv = {};
beforeEach(() => {
  for (const key of ["AUTH_DEV_BYPASS", "WEBSITE_INSTANCE_ID", "WEBSITE_HOSTNAME"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AUTH_DEV_BYPASS = "true";
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
function fakeRequest({ method = "GET", url = "http://localhost/api/sources-admin", headers = {}, params = {}, body }) {
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
function authedQuery(handler) {
  return async (sql, params) => {
    if (/SELECT user_id, external_id, email/.test(sql)) {
      const id = params[0];
      return {
        rows: [{ user_id: id, external_id: `ext-${id}`, email: `u${id}@test.dev`, role: id === ADMIN ? "admin" : "user", suspended: false }],
      };
    }
    return handler(sql, params);
  };
}
function call(route, { as = ADMIN, ...rest } = {}) {
  return registeredRoutes[route].handler(
    fakeRequest({ ...rest, headers: { authorization: `Bearer dev:${as}` } }),
    fakeContext()
  );
}


function txRecorder(handler) {
  const statements = [];
  transactionMock = async (cb) =>
    cb({
      query: async (sql, params) => {
        statements.push({ sql, params });
        return handler(sql, params) ?? { rows: [], rowCount: 1 };
      },
    });
  return statements;
}

const listQueries = (brandRows = [brandRow()]) =>
  authedQuery(async (sql) => {
    if (/FROM brand b/.test(sql)) return { rows: brandRows };
    if (/FROM data_source/.test(sql)) return { rows: [] };
    return { rows: [] };
  });

describe("functions/brands-admin", () => {
  it("no two registered routes share a route string", () => {
    const routes = Object.values(registeredRoutes).map((r) => r.route);
    assert.equal(new Set(routes).size, routes.length);
    assert.equal(registeredRoutes["brands-admin-create"], undefined);
    assert.deepEqual(registeredRoutes["brands-admin-list"].methods, ["GET", "POST", "OPTIONS"]);
  });

  for (const [route, method, params] of [
    ["brands-admin-list", "GET", {}],
    ["brands-admin-list", "POST", {}],
    ["brands-admin-profile", "PUT", { id: "1" }],
  ]) {
    it(`${route}: a regular user gets 403 and nothing runs`, async () => {
      const seen = [];
      queryMock = authedQuery(async (sql) => { seen.push(sql); return { rows: [] }; });
      const statements = txRecorder(() => null);
      const res = await call(route, { as: OTHER, method, params, body: { name: "x" } });
      assert.equal(res.status, 403);
      assert.deepEqual(seen, []);
      assert.deepEqual(statements, []);
    });
  }

  it("GET list builds items from the three queries", async () => {
    queryMock = listQueries([brandRow({ colorShades: "4" })]);
    const res = await call("brands-admin-list");
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.brands[0].colorShades, 4);
    assert.equal(res.jsonBody.brands[0].supply, "none");
  });

  it("POST with a name that matches an existing brand or alias is 409 and inserts nothing", async () => {
    queryMock = listQueries();
    const statements = txRecorder((sql) => (/lower\(/.test(sql) ? { rows: [{ brandId: "7" }] } : null));
    const res = await call("brands-admin-list", { method: "POST", body: { name: " i  LNP " } });
    assert.equal(res.status, 409);
    assert.deepEqual(res.jsonBody, { code: "brand_exists", brandId: 7 });
    assert.equal(statements.length, 1);
    assert.match(statements[0].sql, /lower\(b\.name_canonical\) = lower\(\$1\)/);
    assert.match(statements[0].sql, /lower\(ba\.alias\) = lower\(\$1\)/);
    assert.equal(statements[0].params[0], "i LNP");
    assert.equal(statements.some((s) => /INSERT/.test(s.sql)), false);
  });

  it("POST a new brand with a profile: one transaction, insert brand, insert profile, audit, 201", async () => {
    queryMock = listQueries([brandRow({ brandId: "9", name: "New Brand" })]);
    const statements = txRecorder((sql) => {
      if (/lower\(/.test(sql)) return { rows: [] };
      if (/INSERT INTO brand \(/.test(sql)) return { rows: [{ brandId: "9" }] };
      return null;
    });
    const res = await call("brands-admin-list", {
      method: "POST",
      body: { name: "New  Brand", profile: { websiteUrl: "https://nb.example", platform: "custom" } },
    });
    assert.equal(res.status, 201);
    assert.equal(res.jsonBody.brand.brandId, 9);
    const sqls = statements.map((s) => s.sql);
    assert.match(sqls[1], /INSERT INTO brand \(name_canonical\)/);
    assert.equal(statements[1].params[0], "New Brand");
    assert.match(sqls[2], /INSERT INTO brand_ingest_profile/);
    assert.match(sqls[2], /ON CONFLICT \(brand_id\) DO UPDATE/);
    assert.equal(statements[2].params[0], 9);
    assert.equal(statements[2].params[1], "https://nb.example");
    assert.equal(statements[2].params[6], ADMIN);
    assert.match(sqls[3], /INSERT INTO admin_audit_event/);
    assert.equal(statements[3].params[2], "brand.create");
    const changes = JSON.parse(statements[3].params[3]);
    assert.equal(changes.brandId, 9);
    assert.deepEqual(changes.platform, { from: null, to: "custom" });
  });

  it("POST without a profile writes no profile row; bad body is 400", async () => {
    queryMock = listQueries([brandRow({ brandId: "9" })]);
    const statements = txRecorder((sql) => {
      if (/lower\(/.test(sql)) return { rows: [] };
      if (/INSERT INTO brand \(/.test(sql)) return { rows: [{ brandId: "9" }] };
      return null;
    });
    assert.equal((await call("brands-admin-list", { method: "POST", body: { name: "Plain" } })).status, 201);
    assert.equal(statements.some((s) => /brand_ingest_profile/.test(s.sql)), false);
    assert.equal((await call("brands-admin-list", { method: "POST", body: { name: "   " } })).status, 400);
    assert.equal((await call("brands-admin-list", { method: "POST", body: {} })).status, 400);
    assert.equal(
      (await call("brands-admin-list", { method: "POST", body: { name: "x", profile: { platform: "nope" } } })).status,
      400
    );
  });

  it("PUT profile rejects a bad platform or url with 400 before any write", async () => {
    queryMock = listQueries();
    const statements = txRecorder(() => null);
    for (const body of [{ platform: "squarespace" }, { websiteUrl: "javascript:x" }]) {
      const res = await call("brands-admin-profile", { method: "PUT", params: { id: "1" }, body });
      assert.equal(res.status, 400);
    }
    assert.equal((await call("brands-admin-profile", { method: "PUT", params: { id: "x" }, body: {} })).status, 400);
    assert.deepEqual(statements, []);
  });

  it("PUT profile upserts and audits only the changed fields", async () => {
    queryMock = listQueries([brandRow({ hasProfile: true, platform: "custom" })]);
    const statements = txRecorder((sql) => {
      if (/SELECT brand_id FROM brand/.test(sql)) return { rows: [{ brand_id: 1 }] };
      if (/FROM brand_ingest_profile/.test(sql)) {
        return { rows: [{ websiteUrl: "https://old.example", platform: "shopify", blocker: null, notes: "keep", ownDataSourceId: null }] };
      }
      return null;
    });
    const res = await call("brands-admin-profile", {
      method: "PUT",
      params: { id: "1" },
      body: { platform: "custom", websiteUrl: "https://old.example", blocker: "Cloudflare blocks automated access" },
    });
    assert.equal(res.status, 200);
    const upsert = statements.find((s) => /INSERT INTO brand_ingest_profile/.test(s.sql));
    assert.match(upsert.sql, /ON CONFLICT \(brand_id\) DO UPDATE/);
    assert.deepEqual(upsert.params, [1, "https://old.example", "custom", "Cloudflare blocks automated access", "keep", null, ADMIN]);
    const audit = statements.find((s) => /INSERT INTO admin_audit_event/.test(s.sql));
    assert.equal(audit.params[1], null);
    assert.equal(audit.params[2], "brand.profile_update");
    assert.deepEqual(JSON.parse(audit.params[3]), {
      brandId: 1,
      platform: { from: "shopify", to: "custom" },
      blocker: { from: null, to: "Cloudflare blocks automated access" },
    });
  });

  it("PUT profile with nothing changed is 200 with no write and no audit row", async () => {
    queryMock = listQueries();
    const statements = txRecorder((sql) => {
      if (/SELECT brand_id FROM brand/.test(sql)) return { rows: [{ brand_id: 1 }] };
      if (/FROM data_source/.test(sql)) return { rows: [{ data_source_id: 4 }] };
      if (/FROM brand_ingest_profile/.test(sql)) {
        return { rows: [{ websiteUrl: null, platform: "custom", blocker: null, notes: null, ownDataSourceId: "4" }] };
      }
      return null;
    });
    const res = await call("brands-admin-profile", {
      method: "PUT",
      params: { id: "1" },
      body: { platform: "custom", ownDataSourceId: 4 },
    });
    assert.equal(res.status, 200);
    assert.equal(statements.some((s) => /INSERT/.test(s.sql)), false);
  });

  it("PUT profile null clears a stored value", async () => {
    queryMock = listQueries();
    const statements = txRecorder((sql) => {
      if (/SELECT brand_id FROM brand/.test(sql)) return { rows: [{ brand_id: 1 }] };
      if (/FROM brand_ingest_profile/.test(sql)) {
        return { rows: [{ websiteUrl: null, platform: null, blocker: null, notes: "old", ownDataSourceId: null }] };
      }
      return null;
    });
    await call("brands-admin-profile", { method: "PUT", params: { id: "1" }, body: { notes: null } });
    const audit = statements.find((s) => /INSERT INTO admin_audit_event/.test(s.sql));
    assert.deepEqual(JSON.parse(audit.params[3]), { brandId: 1, notes: { from: "old", to: null } });
  });

  it("PUT profile: unknown brand is 404; an unknown ownDataSourceId is 400", async () => {
    queryMock = listQueries();
    txRecorder(() => ({ rows: [] }));
    assert.equal((await call("brands-admin-profile", { method: "PUT", params: { id: "1" }, body: { notes: "x" } })).status, 404);
    const statements = txRecorder((sql) => (/SELECT brand_id FROM brand/.test(sql) ? { rows: [{ brand_id: 1 }] } : { rows: [] }));
    const res = await call("brands-admin-profile", { method: "PUT", params: { id: "1" }, body: { ownDataSourceId: 99 } });
    assert.equal(res.status, 400);
    assert.equal(statements.some((s) => /INSERT/.test(s.sql)), false);
  });
});
