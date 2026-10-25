/**
 * Collection stats (issue #271): `GET /api/stats/collection`.
 *
 * Runs without a database. `buildCollectionStats` / `monthWindow` are pure and tested directly.
 * The handler is loaded from dist/ with `../lib/db` swapped for an in-memory fake that answers
 * each of the five aggregate statements the way the SQL does (filter by `$1`, then aggregate),
 * so these tests check that every statement is bound to the caller and that another user's
 * rows never reach the response. The SQL itself was run against Postgres 16 with mixed
 * currencies, null purchase dates, SKU-only rows and a second user (see the PR description).
 *
 * Users: OWNER = 1, ATTACKER = 2, EMPTY = 3 (no inventory).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const OWNER = 1;
const ATTACKER = 2;
const EMPTY = 3;
const USERS = {
  [OWNER]: { user_id: OWNER, external_id: "ext-owner", email: null, role: "user" },
  [ATTACKER]: { user_id: ATTACKER, external_id: "ext-attacker", email: null, role: "user" },
  [EMPTY]: { user_id: EMPTY, external_id: "ext-empty", email: null, role: "user" },
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
const registeredRoutes = {};
const mockModules = {};
function registerMock(id, exports) {
  mockModules[id] = exports;
}
const originalResolve = Module._resolveFilename;
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
  output: { storageQueue: (opts) => ({ __type: "storageQueue", ...opts }) },
});
registerMock("jose", {
  errors: { JOSEError: class JOSEError extends Error {} },
  createRemoteJWKSet: () => {},
  jwtVerify: async () => ({ payload: {} }),
});

// In-memory cache standing in for Redis (`lib/cache`).
const cacheStore = new Map();
let cacheOps;
const cacheMock = {
  hashCacheKey: (input) => String(input).slice(0, 24),
  cacheGetJson: async (key) => {
    cacheOps.push(["get", key]);
    return cacheStore.has(key) ? JSON.parse(cacheStore.get(key)) : null;
  },
  cacheSetJson: async (key, value, ttl) => {
    cacheOps.push(["set", key, ttl]);
    cacheStore.set(key, JSON.stringify(value));
  },
  cacheDelete: async (key) => {
    cacheOps.push(["del", key]);
    cacheStore.delete(key);
  },
  cacheDeleteByPrefix: async (prefix) => {
    cacheOps.push(["delPrefix", prefix]);
    for (const key of [...cacheStore.keys()]) if (key.startsWith(prefix)) cacheStore.delete(key);
  },
};
registerMock(path.resolve(__dirname, "../dist/lib/cache.js"), cacheMock);
registerMock("../lib/cache", cacheMock);
registerMock("./cache", cacheMock);

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------
const BRANDS = { 1: "Brand A", 2: "Brand B", 3: "Brand C", 4: "Brand D", 5: "Brand E" };
const SHADES = {};
for (let id = 1; id <= 40; id += 1) {
  SHADES[id] = { brandId: ((id - 1) % 5) + 1, name: `Shade ${id}`, vendorHex: "#AA0000" };
}

/** Brand products (buy links) per shade id: list prices the wishlist value sums. */
const BUY_LINK = (price, currency, fetchedAt) => ({
  url: "https://brand.example/p",
  sourceEnabled: true,
  lastSeenAt: fetchedAt,
  fetchedAt,
  externalProductId: "1",
  price,
  currency,
});
const BUY_LINKS = {
  6: BUY_LINK("14.00", "USD", "2026-10-20T00:00:00Z"),
  8: BUY_LINK("18.50", "EUR", "2026-10-21T00:00:00Z"),
  30: BUY_LINK("1000.00", "USD", "2026-10-21T00:00:00Z"),
};

let inventory;
let calls;
let buyLinkCalls;
let nextId;

function item(userId, shadeId, fields = {}) {
  return {
    id: nextId++,
    userId,
    shadeId,
    status: "owned",
    price: null,
    currency: null,
    purchaseDate: null,
    createdAt: "2026-09-15T12:00:00Z",
    triedAt: null,
    wearCount: 0,
    lastWornAt: null,
    ...fields,
  };
}

function resetState() {
  nextId = 100;
  calls = [];
  buyLinkCalls = [];
  cacheOps = [];
  cacheStore.clear();
  inventory = [
    // OWNER: USD and EUR purchases, a price with no currency, an unpriced row, a wishlist price.
    item(OWNER, 1, { price: "12.00", currency: "USD", purchaseDate: "2026-10-03", wearCount: 6, triedAt: "2026-01-01", lastWornAt: "2026-10-10T00:00:00Z" }),
    item(OWNER, 2, { price: "8.50", currency: "USD", purchaseDate: "2026-04-20", wearCount: 1, triedAt: "2026-05-01", lastWornAt: "2026-05-01T00:00:00Z" }),
    item(OWNER, 3, { price: "20.00", currency: "EUR", wearCount: 0 }), // no purchase date → created_at month
    item(OWNER, 4, { price: "5.00", currency: null, purchaseDate: "2026-09-02", wearCount: 2, lastWornAt: "2026-09-05T00:00:00Z" }),
    item(OWNER, 5, { wearCount: 0 }), // unpriced
    item(OWNER, 6, { status: "wishlist", price: "99.00", currency: "USD" }), // target price, not spend
    item(OWNER, 8, { status: "wishlist" }), // EUR list price
    item(OWNER, 9, { status: "wishlist" }), // no buy link: counted, unpriced
    item(OWNER, 7, { status: "destash", price: "7.25", currency: "USD", purchaseDate: "2025-01-15", wearCount: 9, lastWornAt: "2025-06-01T00:00:00Z" }),
    // ATTACKER: big numbers that must never show up in OWNER's stats.
    ...Array.from({ length: 12 }, (_, i) =>
      item(ATTACKER, 20 + i, { price: "1000.00", currency: "USD", purchaseDate: "2026-10-01", wearCount: 50, triedAt: "2026-01-01" })
    ),
    item(ATTACKER, 1, { price: "1000.00", currency: "EUR", purchaseDate: "2026-10-01", wearCount: 99 }),
    item(ATTACKER, 30, { status: "wishlist" }),
  ];
}
resetState();

const sqlOf = (sql) => String(sql).replace(/\s+/g, " ").trim();
const brandOf = (row) => BRANDS[SHADES[row.shadeId].brandId];
const cents = (value) => Math.round(Number(value) * 100);
const money = (c) => (c / 100).toFixed(2);

let lib;
function rowsFor(userId) {
  return inventory.filter((row) => row.userId === userId);
}
function shadeCols(row) {
  return {
    inventoryItemId: String(row.id),
    shadeId: String(row.shadeId),
    brand: brandOf(row),
    name: SHADES[row.shadeId].name,
    vendorHex: SHADES[row.shadeId].vendorHex,
    detectedHex: null,
    nameHex: null,
  };
}
function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

/** Answers each stats statement the way its SQL does (mirrors `src/lib/collection-stats.ts`). */
function handle(rawSql, params = []) {
  const sql = sqlOf(rawSql);
  if (/FROM app_user/i.test(sql)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [] };
  }
  if (sql === sqlOf(buyLink.BUY_LINK_CANDIDATES_SQL)) {
    buyLinkCalls.push(params[0]);
    return { rows: params[0].filter((id) => BUY_LINKS[id]).map((id) => ({ shadeId: id, ...BUY_LINKS[id] })) };
  }
  calls.push({ sql, params });
  const userId = Number(params[0]);
  const mine = rowsFor(userId);

  if (sql === sqlOf(lib.STATS_COUNTS_SQL)) {
    const groups = groupBy(mine, (r) => JSON.stringify([r.status, r.currency]));
    return {
      rows: [...groups.values()].map((rows) => ({
        status: rows[0].status,
        currency: rows[0].currency,
        items: rows.length,
        untried: rows.filter((r) => !r.triedAt).length,
        worn: rows.filter((r) => r.wearCount > 0).length,
        priced: rows.filter((r) => r.price !== null).length,
        pricedWorn: rows.filter((r) => r.price !== null && r.wearCount > 0).length,
        pricedUnworn: rows.filter((r) => r.price !== null && r.wearCount === 0).length,
      })),
    };
  }
  if (sql === sqlOf(lib.STATS_SPEND_BY_BRAND_SQL)) {
    const [, statuses, topN] = params;
    const spent = mine.filter((r) => statuses.includes(r.status) && r.price !== null);
    const out = [];
    for (const [, rows] of groupBy(spent, (r) => r.currency ?? "")) {
      const brands = [...groupBy(rows, brandOf).entries()]
        .map(([brand, list]) => ({ brand, cents: list.reduce((s, r) => s + cents(r.price), 0), items: list.length }))
        .sort((a, b) => b.cents - a.cents || a.brand.localeCompare(b.brand));
      brands.forEach((b, i) => {
        if (i < topN) {
          out.push({ currency: rows[0].currency, isOther: false, brand: b.brand, brandCount: 1, total: money(b.cents), itemCount: b.items, rank: i + 1 });
        }
      });
      const rest = brands.slice(topN);
      if (rest.length) {
        out.push({
          currency: rows[0].currency,
          isOther: true,
          brand: null,
          brandCount: rest.length,
          total: money(rest.reduce((s, b) => s + b.cents, 0)),
          itemCount: rest.reduce((s, b) => s + b.items, 0),
          rank: topN + 1,
        });
      }
    }
    return { rows: out };
  }
  if (sql === sqlOf(lib.STATS_SPEND_BY_MONTH_SQL)) {
    const [, statuses, start, end] = params;
    const bucket = (r) => r.purchaseDate ?? r.createdAt.slice(0, 10);
    const spent = mine.filter(
      (r) => statuses.includes(r.status) && r.price !== null && bucket(r) >= start && bucket(r) < end
    );
    return {
      rows: [...groupBy(spent, (r) => JSON.stringify([r.currency, bucket(r).slice(0, 7)])).values()].map((rows) => ({
        currency: rows[0].currency,
        month: bucket(rows[0]).slice(0, 7),
        total: money(rows.reduce((s, r) => s + cents(r.price), 0)),
        itemCount: rows.length,
        estimatedDateCount: rows.filter((r) => !r.purchaseDate).length,
      })),
    };
  }
  if (sql === sqlOf(lib.STATS_WISHLIST_SHADES_SQL)) {
    return { rows: mine.filter((r) => r.status === "wishlist").map((r) => ({ shadeId: String(r.shadeId) })) };
  }
  if (sql === sqlOf(lib.STATS_MOST_WORN_SQL)) {
    return {
      rows: mine
        .filter((r) => r.wearCount > 0)
        .sort((a, b) => b.wearCount - a.wearCount || String(b.lastWornAt).localeCompare(String(a.lastWornAt)) || a.id - b.id)
        .slice(0, params[1])
        .map((r) => ({ ...shadeCols(r), status: r.status, wearCount: r.wearCount, lastWornAt: r.lastWornAt ? new Date(r.lastWornAt) : null })),
    };
  }
  if (sql === sqlOf(lib.STATS_COST_PER_WEAR_SQL)) {
    const n = params[1];
    const worn = mine.filter((r) => r.status === "owned" && r.price !== null && r.wearCount > 0);
    const out = [];
    for (const [, rows] of groupBy(worn, (r) => r.currency ?? "")) {
      const ranked = rows
        .map((r) => ({ r, cpw: Number(r.price) / r.wearCount }))
        .sort((a, b) => a.cpw - b.cpw || b.r.wearCount - a.r.wearCount || a.r.id - b.r.id);
      ranked.forEach(({ r, cpw }, i) => {
        const bestRank = i + 1;
        if (bestRank <= n || bestRank > ranked.length - n) {
          out.push({
            ...shadeCols(r),
            currency: r.currency,
            price: r.price,
            wearCount: r.wearCount,
            costPerWear: cpw.toFixed(2),
            bestRank,
            currencyCount: ranked.length,
          });
        }
      });
    }
    return { rows: out };
  }
  throw new Error(`Unexpected SQL in fake DB: ${sql.slice(0, 160)}`);
}

const dbMock = {
  query: async (sql, params) => handle(sql, params),
  transaction: async () => {
    throw new Error("stats must not open a transaction");
  },
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

lib = require("../dist/lib/collection-stats");
const buyLink = require("../dist/lib/buy-link");
const polishCache = require("../dist/lib/polish-cache");
require("../dist/functions/stats");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fakeRequest(userId) {
  return {
    method: "GET",
    url: "http://localhost:7071/api/stats/collection",
    headers: {
      get: (name) => (name.toLowerCase() === "authorization" && userId ? `Bearer dev:${userId}` : null),
    },
    params: {},
  };
}
const fakeContext = () => ({ log() {}, error() {}, warn() {}, invocationId: "test-invocation" });
const getStats = (userId = OWNER) => registeredRoutes["stats-collection"].handler(fakeRequest(userId), fakeContext());

beforeEach(() => {
  resetState();
  process.env.AUTH_DEV_BYPASS = "true";
});
afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
});

// ---------------------------------------------------------------------------
// Pure assembly
// ---------------------------------------------------------------------------
const EMPTY_ROWS = { counts: [], spendByBrand: [], spendByMonth: [], mostWorn: [], costPerWear: [], wishlistPrices: [] };
const NOW = new Date("2026-10-17T12:00:00Z");

describe("monthWindow", () => {
  it("covers the current UTC month and the 11 before it", () => {
    const window = lib.monthWindow(NOW);
    assert.equal(window.months.length, 12);
    assert.equal(window.months[0], "2025-11");
    assert.equal(window.months[11], "2026-10");
    assert.equal(window.start, "2025-11-01");
    assert.equal(window.end, "2026-11-01");
  });

  it("crosses year boundaries", () => {
    const window = lib.monthWindow(new Date("2027-01-31T23:59:59Z"));
    assert.deepEqual(window.months.slice(-2), ["2026-12", "2027-01"]);
    assert.equal(window.start, "2026-02-01");
    assert.equal(window.end, "2027-02-01");
  });
});

describe("buildCollectionStats", () => {
  it("returns zeros, null percent and empty lists for an empty collection", () => {
    const stats = lib.buildCollectionStats(EMPTY_ROWS, NOW);
    assert.deepEqual(stats.totals, { byStatus: { owned: 0, wishlist: 0, destash: 0, archived: 0 }, total: 0 });
    assert.deepEqual(stats.untried, { owned: 0, untried: 0, percent: null });
    assert.deepEqual(stats.wornVsWaiting, { worn: 0, waiting: 0 });
    assert.deepEqual(stats.spend.currencies, []);
    assert.equal(stats.spend.months.length, 12);
    assert.equal(stats.spend.pricedCount, 0);
    assert.equal(stats.spend.unpricedCount, 0);
    assert.deepEqual(stats.mostWorn, []);
    assert.deepEqual(stats.costPerWear, { currencies: [], pricedUnwornCount: 0 });
    assert.equal(stats.generatedAt, NOW.toISOString());
  });

  it("keeps every currency separate and never sums across them", () => {
    const stats = lib.buildCollectionStats(
      {
        ...EMPTY_ROWS,
        spendByBrand: [
          { currency: "USD", isOther: false, brand: "A", brandCount: 1, total: "10.10", itemCount: 1, rank: 1 },
          { currency: "EUR", isOther: false, brand: "A", brandCount: 1, total: "5.05", itemCount: 2, rank: 1 },
          { currency: "USD", isOther: false, brand: "B", brandCount: 1, total: "0.20", itemCount: 1, rank: 2 },
          { currency: null, isOther: false, brand: "C", brandCount: 1, total: "3.00", itemCount: 1, rank: 1 },
        ],
        spendByMonth: [
          { currency: "USD", month: "2026-10", total: "10.10", itemCount: 1, estimatedDateCount: 0 },
          { currency: "EUR", month: "2026-10", total: "5.05", itemCount: 2, estimatedDateCount: 2 },
          { currency: "USD", month: "1999-01", total: "1.00", itemCount: 1, estimatedDateCount: 0 }, // outside window
        ],
      },
      NOW
    );
    const byCode = Object.fromEntries(stats.spend.currencies.map((c) => [String(c.currency), c]));
    assert.deepEqual(Object.keys(byCode).sort(), ["EUR", "USD", "null"]);
    assert.equal(byCode.USD.total, 10.3); // exact cents: 10.10 + 0.20
    assert.equal(byCode.EUR.total, 5.05);
    assert.equal(byCode.null.total, 3);
    assert.equal(byCode.USD.byMonth.at(-1).total, 10.1);
    assert.equal(byCode.EUR.byMonth.at(-1).total, 5.05);
    assert.equal(byCode.EUR.byMonth.at(-1).estimatedDateCount, 2);
    assert.ok(byCode.USD.byMonth.every((m) => m.month >= "2025-11"));
    // Ordered by item count (EUR and USD tie at 2, code order), null currency last.
    assert.deepEqual(stats.spend.currencies.map((c) => c.currency), ["EUR", "USD", null]);
  });

  it("puts the 'other' entry after the named brands", () => {
    const stats = lib.buildCollectionStats(
      {
        ...EMPTY_ROWS,
        spendByBrand: [
          { currency: "USD", isOther: true, brand: null, brandCount: 3, total: "50.00", itemCount: 4, rank: 9 },
          { currency: "USD", isOther: false, brand: "Top", brandCount: 1, total: "40.00", itemCount: 2, rank: 1 },
        ],
      },
      NOW
    );
    const usd = stats.spend.currencies[0];
    assert.deepEqual(usd.byBrand.map((b) => [b.brand, b.isOther, b.brandCount]), [["Top", false, 0], ["Other", true, 3]]);
    assert.equal(usd.total, 90);
    assert.equal(usd.itemCount, 6);
  });

  it("splits cost per wear into best and worst lists without repeating an item", () => {
    const cpwRows = Array.from({ length: 7 }, (_, i) => ({
      inventoryItemId: String(i + 1),
      shadeId: String(i + 1),
      brand: "B",
      name: `S${i + 1}`,
      vendorHex: null,
      detectedHex: null,
      nameHex: null,
      currency: "USD",
      price: String(i + 1),
      wearCount: 1,
      costPerWear: String(i + 1),
      bestRank: i + 1,
      currencyCount: 7,
    }));
    const stats = lib.buildCollectionStats(
      {
        ...EMPTY_ROWS,
        counts: [{ status: "owned", currency: "USD", items: 9, untried: 0, worn: 7, priced: 9, pricedWorn: 7, pricedUnworn: 2 }],
        costPerWear: cpwRows,
      },
      NOW
    );
    const usd = stats.costPerWear.currencies[0];
    assert.deepEqual(usd.best.map((e) => e.costPerWear), [1, 2, 3, 4, 5]);
    assert.deepEqual(usd.worst.map((e) => e.costPerWear), [7, 6]);
    assert.equal(usd.wornCount, 7);
    assert.equal(usd.pricedUnwornCount, 2);
    assert.equal(stats.costPerWear.pricedUnwornCount, 2);
  });

  it("derives untried % and worn vs waiting from owned rows only", () => {
    const stats = lib.buildCollectionStats(
      {
        ...EMPTY_ROWS,
        counts: [
          { status: "owned", currency: "USD", items: 2, untried: 1, worn: 1, priced: 2, pricedWorn: 1, pricedUnworn: 1 },
          { status: "owned", currency: null, items: 1, untried: 1, worn: 0, priced: 0, pricedWorn: 0, pricedUnworn: 0 },
          { status: "archived", currency: "USD", items: 4, untried: 4, worn: 4, priced: 4, pricedWorn: 4, pricedUnworn: 0 },
          { status: "wishlist", currency: "USD", items: 5, untried: 5, worn: 0, priced: 5, pricedWorn: 0, pricedUnworn: 5 },
        ],
      },
      NOW
    );
    assert.deepEqual(stats.totals.byStatus, { owned: 3, wishlist: 5, destash: 0, archived: 4 });
    assert.equal(stats.totals.total, 12);
    assert.deepEqual(stats.untried, { owned: 3, untried: 2, percent: 66.7 });
    assert.deepEqual(stats.wornVsWaiting, { worn: 1, waiting: 2 });
    // Spend coverage counts bought statuses only (owned + archived here), never wishlist.
    assert.equal(stats.spend.pricedCount, 6);
    assert.equal(stats.spend.unpricedCount, 1);
  });
});

describe("collection stats SQL", () => {
  const statements = [
    lib.STATS_COUNTS_SQL,
    lib.STATS_SPEND_BY_BRAND_SQL,
    lib.STATS_SPEND_BY_MONTH_SQL,
    lib.STATS_MOST_WORN_SQL,
    lib.STATS_COST_PER_WEAR_SQL,
  ];

  it("binds every statement to the caller and reads only their inventory", () => {
    for (const sql of statements) {
      const text = sqlOf(sql);
      assert.match(text, /WHERE ui\.user_id = \$1/);
      assert.equal((text.match(/user_inventory_item/g) || []).length, 1, "one inventory scan, scoped by $1");
      assert.doesNotMatch(text, /manicure|app_user|image_asset/);
    }
  });

  it("starts with SELECT so lib/db can retry it on connection timeouts", () => {
    for (const sql of statements) assert.match(sql.trim(), /^SELECT\b/);
  });

  it("applies the product-category rules (#349): spend skips accessories, wear stats are color + topper", () => {
    for (const sql of [lib.STATS_SPEND_BY_BRAND_SQL, lib.STATS_SPEND_BY_MONTH_SQL]) {
      assert.match(sqlOf(sql), /COALESCE\(s\.product_category, 'color'\) <> 'accessory'/);
    }
    for (const sql of [lib.STATS_COUNTS_SQL, lib.STATS_MOST_WORN_SQL, lib.STATS_COST_PER_WEAR_SQL]) {
      assert.match(sqlOf(sql), /COALESCE\(s\.product_category, 'color'\) IN \('color', 'topper'\)/);
    }
  });

  it("buckets null purchase dates by the UTC created_at date", () => {
    assert.match(sqlOf(lib.STATS_SPEND_BY_MONTH_SQL), /COALESCE\(ui\.purchase_date, \(ui\.created_at AT TIME ZONE 'UTC'\)::date\)/);
  });
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
describe("GET /api/stats/collection", () => {
  it("requires authentication", async () => {
    const res = await getStats(null);
    assert.equal(res.status, 401);
    assert.deepEqual(calls, []);
  });

  it("returns the caller's stats with currencies kept apart", async () => {
    const res = await getStats(OWNER);
    assert.equal(res.status, 200);
    assert.equal(res.headers["Cache-Control"], "private, no-cache");
    const stats = res.jsonBody;

    assert.deepEqual(stats.totals.byStatus, { owned: 5, wishlist: 3, destash: 1, archived: 0 });
    assert.deepEqual(stats.untried, { owned: 5, untried: 3, percent: 60 });
    assert.deepEqual(stats.wornVsWaiting, { worn: 3, waiting: 2 });

    const byCode = Object.fromEntries(stats.spend.currencies.map((c) => [String(c.currency), c]));
    assert.equal(byCode.USD.total, 27.75); // 12.00 + 8.50 + destash 7.25; wishlist 99.00 excluded
    assert.equal(byCode.EUR.total, 20);
    assert.equal(byCode.null.total, 5);
    assert.equal(stats.spend.pricedCount, 5); // 4 owned + 1 destash
    assert.equal(stats.spend.unpricedCount, 1);

    // Null purchase date → created_at month (2026-09) and flagged as estimated.
    const eurSept = byCode.EUR.byMonth.find((m) => m.month === "2026-09");
    assert.deepEqual(eurSept, { month: "2026-09", total: 20, itemCount: 1, estimatedDateCount: 1 });
    // The 2025-01 destash purchase is in the all-time total but outside the 12-month window.
    assert.equal(byCode.USD.byMonth.reduce((sum, m) => sum + m.total, 0), 20.5);

    assert.deepEqual(stats.mostWorn.map((m) => [m.name, m.wearCount, m.status]), [
      ["Shade 7", 9, "destash"],
      ["Shade 1", 6, "owned"],
      ["Shade 4", 2, "owned"],
      ["Shade 2", 1, "owned"],
    ]);

    const cpw = Object.fromEntries(stats.costPerWear.currencies.map((c) => [String(c.currency), c]));
    assert.deepEqual(cpw.USD.best.map((e) => [e.name, e.costPerWear]), [["Shade 1", 2], ["Shade 2", 8.5]]);
    assert.deepEqual(cpw.USD.worst, []);
    assert.equal(cpw.EUR.wornCount, 0);
    assert.equal(cpw.EUR.pricedUnwornCount, 1);
    assert.equal(stats.costPerWear.pricedUnwornCount, 1);

    // Wishlist value: brand list prices of the buy links, per currency; the row's own target
    // price (99.00) is never used, and a shade without a buy link is counted as unpriced.
    assert.deepEqual(stats.wishlist, {
      count: 3,
      listPrices: {
        byCurrency: [
          { currency: "EUR", total: 18.5, count: 1 },
          { currency: "USD", total: 14, count: 1 },
        ],
        unpricedCount: 1,
        latestSeenAt: "2026-10-21T00:00:00.000Z",
      },
    });
    assert.deepEqual(buyLinkCalls, [["6", "8", "9"]], "buy links are looked up for the caller's wishlist shades only");
  });

  it("never includes another user's rows", async () => {
    const res = await getStats(OWNER);
    const body = JSON.stringify(res.jsonBody);
    assert.ok(!body.includes("1000"), "attacker prices must not leak");
    assert.ok(!res.jsonBody.mostWorn.some((m) => m.wearCount >= 50), "attacker wear counts must not leak");
    const ownerItemIds = new Set(rowsFor(OWNER).map((r) => String(r.id)));
    for (const entry of [
      ...res.jsonBody.mostWorn,
      ...res.jsonBody.costPerWear.currencies.flatMap((c) => [...c.best, ...c.worst]),
    ]) {
      assert.ok(ownerItemIds.has(entry.inventoryItemId), `item ${entry.inventoryItemId} is not the caller's`);
    }
    assert.equal(calls.length, 6);
    for (const call of calls) assert.equal(call.params[0], OWNER, "every statement binds the caller as $1");
  });

  it("answers an empty collection without errors", async () => {
    const res = await getStats(EMPTY);
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.totals.total, 0);
    assert.equal(res.jsonBody.untried.percent, null);
    assert.deepEqual(res.jsonBody.spend.currencies, []);
    assert.deepEqual(res.jsonBody.mostWorn, []);
    assert.deepEqual(res.jsonBody.wishlist, { count: 0, listPrices: { byCurrency: [], unpricedCount: 0, latestSeenAt: null } });
    assert.deepEqual(buyLinkCalls, [], "no wishlist, no buy-link lookup");
  });

  it("caches per user for 60s and serves the cached copy without queries", async () => {
    await getStats(OWNER);
    assert.deepEqual(cacheOps.find((op) => op[0] === "set"), ["set", "stats:collection:u:1", 60]);
    calls = [];
    const again = await getStats(OWNER);
    assert.equal(again.status, 200);
    assert.deepEqual(calls, [], "cached response must not hit the database");

    // Another user's request never reads OWNER's cache entry.
    await getStats(ATTACKER);
    assert.ok(calls.length === 6 && calls.every((c) => c.params[0] === ATTACKER));
  });

  it("is invalidated by the per-user polish cache hook", async () => {
    await getStats(OWNER);
    await getStats(ATTACKER);
    await polishCache.invalidatePolishCachesForUser(OWNER, [1]);
    assert.ok(!cacheStore.has("stats:collection:u:1"));
    assert.ok(cacheStore.has("stats:collection:u:2"), "other users' entries survive");
    await polishCache.invalidateAllCollectionStats();
    assert.ok(!cacheStore.has("stats:collection:u:2"));
  });
});
