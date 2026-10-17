/**
 * Dupe finder (issue #265): grading thresholds, finish compatibility, exclusion of the shade
 * itself and of non-owned shades, the batch cap, and per-user scoping of
 * `GET /api/polishes/{id}/dupes` and `POST /api/polishes/dupes`.
 *
 * Runs without a database (same require-interception mocking as handlers.unit.test.cjs). The
 * fake DB below honours the SQL predicates the dupe queries rely on (`ui.user_id = $n`,
 * `ui.status = 'owned'`, the `user_submitted` visibility rule), so a handler that dropped one
 * of them would return another user's or a non-owned shade and fail these tests.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const {
  DUPE_LIMITS,
  HIGH_CONFIDENCE_MAX_DISTANCE,
  MEDIUM_CONFIDENCE_MAX_DISTANCE,
  colorDistance,
  finishCompatibility,
  finishFamily,
  findDupes,
  gradeDupe,
  oklabToHex,
  hexToOklab,
  prepareDupeCandidates,
  prepareDupeShade,
  summarizeDupes,
} = require("swatchwatch-shared");

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
  jwtVerify: async () => {
    throw new Error("JWT validation is not exercised in dupes tests");
  },
});

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

const OWNER = 1;
const OTHER = 2;
const USERS = {
  [OWNER]: { user_id: OWNER, external_id: "ext-owner", email: "owner@test.dev", role: "user" },
  [OTHER]: { user_id: OTHER, external_id: "ext-other", email: "other@test.dev", role: "user" },
};

/** Shift a hex by an OKLAB lightness delta (keeps hue), for distance-controlled fixtures. */
function shiftL(hex, dL) {
  const lab = hexToOklab(hex);
  return oklabToHex({ ...lab, L: lab.L + dL });
}

const BASE_RED = "#B0303A";

/** shade_id -> shade row. */
const SHADES = {
  100: { brand: "Target", name: "Wishlist Red", vendorHex: BASE_RED, finishes: ["creme"] },
  101: { brand: "A", name: "Owned Red Creme", vendorHex: shiftL(BASE_RED, 0.01), finishes: ["creme"] },
  102: { brand: "B", name: "Owned Red Holo", vendorHex: shiftL(BASE_RED, 0.01), finishes: ["holographic"] },
  103: { brand: "C", name: "Owned Red Jelly", vendorHex: shiftL(BASE_RED, 0.03), finishes: ["jelly"] },
  104: { brand: "D", name: "Owned Darker Red", vendorHex: shiftL(BASE_RED, -0.08), finishes: ["creme"] },
  105: { brand: "E", name: "Owned Blue", vendorHex: "#2040C0", finishes: ["creme"] },
  106: { brand: "F", name: "Owned No Hex", finishes: ["creme"] },
  107: { brand: "G", name: "Wishlisted Twin", vendorHex: BASE_RED, finishes: ["creme"] },
  108: { brand: "H", name: "Destashed Twin", vendorHex: BASE_RED, finishes: ["creme"] },
  109: { brand: "I", name: "Detected Only", detectedHex: shiftL(BASE_RED, 0.02), finishes: [] },
  // Another user's inventory: identical color, must never show up for OWNER.
  200: { brand: "Other", name: "Other User Twin", vendorHex: BASE_RED, finishes: ["creme"] },
  // Another user's private submission: invisible to OWNER as a target.
  300: {
    brand: "Private",
    name: "Private Submission",
    vendorHex: BASE_RED,
    finishes: ["creme"],
    status: "user_submitted",
    createdBy: OTHER,
  },
  // Visible catalog shade with no hex at all.
  400: { brand: "NoHex", name: "No Hex Target", finishes: ["creme"] },
};

/** user_inventory_item rows. */
const INVENTORY = [
  { userId: OWNER, shadeId: 100, status: "wishlist" },
  { userId: OWNER, shadeId: 101, status: "owned" },
  { userId: OWNER, shadeId: 102, status: "owned" },
  { userId: OWNER, shadeId: 103, status: "owned" },
  { userId: OWNER, shadeId: 104, status: "owned" },
  { userId: OWNER, shadeId: 105, status: "owned" },
  { userId: OWNER, shadeId: 106, status: "owned" },
  { userId: OWNER, shadeId: 107, status: "wishlist" },
  { userId: OWNER, shadeId: 108, status: "destash" },
  { userId: OWNER, shadeId: 109, status: "owned" },
  { userId: OTHER, shadeId: 200, status: "owned" },
  { userId: OTHER, shadeId: 300, status: "owned" },
];

let sqlCalls = [];

function shadeRow(shadeId) {
  const shade = SHADES[shadeId];
  return {
    shadeId: String(shadeId),
    brand: shade.brand,
    name: shade.name,
    vendorHex: shade.vendorHex ?? null,
    detectedHex: shade.detectedHex ?? null,
    nameHex: shade.nameHex ?? null,
    hexAgreement: null,
    finish: shade.finishes[0] ?? "",
    finishes: shade.finishes,
  };
}

function boundUser(sql, params) {
  const placeholders = [...String(sql).matchAll(/\bui\.user_id\s*=\s*\$(\d+)/gi)].map((m) => Number(m[1]));
  const values = new Set(placeholders.map((n) => Number(params[n - 1])));
  return values.size === 1 ? [...values][0] : undefined;
}

async function fakeQuery(sql, params = []) {
  const text = String(sql);
  sqlCalls.push({ sql: text, params });

  if (/FROM\s+app_user/i.test(text) && /WHERE\s+user_id\s*=\s*\$1/i.test(text)) {
    const user = USERS[Number(params[0])];
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }

  // Targets: shades by id, filtered by the user_submitted visibility rule. Checked before the
  // candidate branch because its EXISTS subquery also mentions user_inventory_item.
  if (/FROM\s+shade\s+s/i.test(text) && /s\.shade_id\s*=\s*ANY\(\$2/i.test(text)) {
    const userId = Number(params[0]);
    const enforcesVisibility = /user_submitted/.test(text) && /ui\.user_id\s*=\s*\$1/.test(text);
    const rows = params[1]
      .map(Number)
      .filter((id) => SHADES[id])
      .filter((id) => {
        if (!enforcesVisibility) return true;
        const shade = SHADES[id];
        if (shade.status !== "user_submitted") return true;
        if (shade.createdBy === userId) return true;
        return INVENTORY.some((item) => item.shadeId === id && item.userId === userId);
      })
      .map(shadeRow);
    return { rows, rowCount: rows.length };
  }

  // Candidate pool: the caller's owned shades.
  if (/FROM\s+user_inventory_item\s+ui/i.test(text)) {
    const userId = boundUser(text, params);
    const ownedOnly = /ui\.status\s*=\s*'owned'/i.test(text);
    const rows = INVENTORY.filter(
      (item) => (userId === undefined || item.userId === userId) && (!ownedOnly || item.status === "owned")
    )
      .map((item) => shadeRow(item.shadeId))
      .filter((row) => row.vendorHex || row.detectedHex || row.nameHex);
    return { rows, rowCount: rows.length };
  }

  return { rows: [], rowCount: 0 };
}

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

const { parseDupesBatchRequest, parseDupesLimit, parseShadeId, DupesInputError } = require("../dist/lib/dupes");
require("../dist/functions/dupes");

beforeEach(() => {
  sqlCalls = [];
  process.env.AUTH_DEV_BYPASS = "true";
});
afterEach(() => {
  delete process.env.AUTH_DEV_BYPASS;
});

function fakeRequest({ method = "GET", url, params = {}, body, userId } = {}) {
  const headers = new Map();
  if (userId !== undefined) headers.set("authorization", `Bearer dev:${userId}`);
  return {
    method,
    url,
    headers: { get: (name) => headers.get(name.toLowerCase()) || null },
    params,
    query: new URL(url).searchParams,
    json: async () => {
      if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
      return body;
    },
  };
}

function fakeContext() {
  return { log: () => {}, error: () => {}, warn: () => {}, invocationId: "test-invocation" };
}

async function getDupes(shadeId, options = {}) {
  const { query = "" } = options;
  const userId = "userId" in options ? options.userId : OWNER;
  return registeredRoutes["polishes-dupes"].handler(
    fakeRequest({
      url: `http://localhost:7071/api/polishes/${shadeId}/dupes${query}`,
      params: { id: String(shadeId) },
      userId,
    }),
    fakeContext()
  );
}

async function batchDupes(body, options = {}) {
  const userId = "userId" in options ? options.userId : OWNER;
  return registeredRoutes["polishes-dupes-batch"].handler(
    fakeRequest({ method: "POST", url: "http://localhost:7071/api/polishes/dupes", body, userId }),
    fakeContext()
  );
}

/** Handler statements (excluding the auth user lookup). */
function handlerCalls() {
  return sqlCalls.filter((c) => !/FROM\s+app_user/i.test(c.sql));
}

/** Every statement touching user_inventory_item binds its user_id predicates to the caller. */
function assertScopedToCaller(callerId) {
  const touching = handlerCalls().filter((c) => /user_inventory_item/i.test(c.sql));
  assert.ok(touching.length > 0, "expected an inventory query");
  for (const call of touching) {
    const placeholders = [...call.sql.matchAll(/\buser_id\s*=\s*\$(\d+)/gi)].map((m) => Number(m[1]));
    assert.ok(placeholders.length > 0, `missing user_id predicate: ${call.sql}`);
    for (const n of placeholders) {
      assert.equal(Number(call.params[n - 1]), callerId, `user_id $${n} must be bound to the caller`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure grading rules (swatchwatch-shared color/dupes.ts)
// ═══════════════════════════════════════════════════════════════════════════

describe("dupe grading — reuses the match-image thresholds", () => {
  it("HIGH ≤ 0.05, MEDIUM ≤ 0.10, LOW is not a dupe", () => {
    assert.equal(HIGH_CONFIDENCE_MAX_DISTANCE, 0.05);
    assert.equal(MEDIUM_CONFIDENCE_MAX_DISTANCE, 0.1);
    assert.deepEqual(gradeDupe(0, "same"), { colorGrade: "high", grade: "high" });
    assert.deepEqual(gradeDupe(0.05, "same"), { colorGrade: "high", grade: "high" });
    assert.deepEqual(gradeDupe(0.0501, "same"), { colorGrade: "medium", grade: "medium" });
    assert.deepEqual(gradeDupe(0.1, "compatible"), { colorGrade: "medium", grade: "medium" });
    assert.deepEqual(gradeDupe(0.1001, "same"), { colorGrade: "low", grade: null });
  });

  it("unknown finishes keep the color grade", () => {
    assert.deepEqual(gradeDupe(0.02, "unknown"), { colorGrade: "high", grade: "high" });
    assert.deepEqual(gradeDupe(0.08, "unknown"), { colorGrade: "medium", grade: "medium" });
  });

  it("a clearly different finish drops one grade step", () => {
    assert.deepEqual(gradeDupe(0.01, "different"), { colorGrade: "high", grade: "medium" });
    assert.deepEqual(gradeDupe(0.07, "different"), { colorGrade: "medium", grade: null });
  });
});

describe("finishCompatibility", () => {
  it("same primary finish is `same`", () => {
    assert.equal(finishCompatibility(["creme"], ["creme"]), "same");
    assert.equal(finishCompatibility(["Creme"], ["cream"]), "same", "case and legacy alias");
    assert.equal(finishCompatibility(["shimmer", "holographic"], ["shimmer"]), "same");
  });

  it("same family or any shared finish is `compatible`", () => {
    assert.equal(finishCompatibility(["creme"], ["jelly"]), "compatible");
    assert.equal(finishCompatibility(["shimmer"], ["metallic"]), "compatible");
    assert.equal(finishCompatibility(["glitter"], ["flake"]), "compatible");
    assert.equal(finishCompatibility(["jelly", "glitter"], ["glitter"]), "compatible");
  });

  it("known finishes in different families are `different`", () => {
    assert.equal(finishCompatibility(["holographic"], ["creme"]), "different");
    assert.equal(finishCompatibility(["holo"], ["creme"]), "different");
    assert.equal(finishCompatibility(["glitter"], ["matte"]), "different");
    assert.equal(finishCompatibility(["shimmer"], ["creme"]), "different");
  });

  it("missing, `other` or admin-defined finishes are `unknown`", () => {
    assert.equal(finishCompatibility([], ["creme"]), "unknown");
    assert.equal(finishCompatibility(["creme"], []), "unknown");
    assert.equal(finishCompatibility(["other"], ["holographic"]), "unknown");
    assert.equal(finishCompatibility(["galaxy-bomb"], ["creme"]), "unknown");
    assert.equal(finishCompatibility(["galaxy-bomb"], ["galaxy-bomb"]), "same");
  });

  it("finishFamily knows the built-in families", () => {
    assert.equal(finishFamily("crelly"), "solid");
    assert.equal(finishFamily("multichrome"), "shimmer");
    assert.equal(finishFamily("holographic"), "holo");
    assert.equal(finishFamily("other"), undefined);
  });
});

describe("findDupes", () => {
  const ownedRows = INVENTORY.filter((i) => i.userId === OWNER && i.status === "owned").map((i) =>
    shadeRow(i.shadeId)
  );

  it("prepare uses the display hex (vendor > detected > name) and drops shades without one", () => {
    const prepared = prepareDupeCandidates(ownedRows);
    assert.ok(!prepared.some((c) => c.shadeId === "106"), "shade without a hex is skipped");
    const detectedOnly = prepared.find((c) => c.shadeId === "109");
    assert.equal(detectedOnly.displayHexSource, "detected");
    const vendorWins = prepareDupeShade({ shadeId: 1, vendorHex: "#aa0000", detectedHex: "#00AA00" });
    assert.equal(vendorWins.displayHex, "#AA0000");
    assert.equal(vendorWins.displayHexSource, "vendor");
    assert.equal(prepareDupeShade({ shadeId: 2, vendorHex: "not-a-hex" }), null);
  });

  it("ranks same-finish dupes first and grades holo vs creme one step lower", () => {
    const target = prepareDupeShade(shadeRow(100));
    const { dupes, candidateCount } = findDupes(target, prepareDupeCandidates(ownedRows));
    assert.equal(candidateCount, 6, "owned shades with a hex");
    const ids = dupes.map((d) => d.shadeId);
    // HIGH first (same < compatible < unknown), then MEDIUM (same-finish 104 before the holo 102).
    assert.deepEqual(ids, ["101", "103", "109", "104", "102"]);

    const creme = dupes[0];
    assert.equal(creme.grade, "high");
    assert.equal(creme.finishCompatibility, "same");
    assert.ok(Math.abs(creme.distance - 0.01) < 0.002);
    assert.equal(creme.displayHexSource, "vendor");

    const holo = dupes.find((d) => d.shadeId === "102");
    assert.equal(holo.colorGrade, "high");
    assert.equal(holo.grade, "medium", "different finish is downgraded");
    assert.equal(holo.finishCompatibility, "different");

    const jelly = dupes.find((d) => d.shadeId === "103");
    assert.equal(jelly.finishCompatibility, "compatible");
    assert.equal(jelly.grade, "high");

    const unknown = dupes.find((d) => d.shadeId === "109");
    assert.equal(unknown.finishCompatibility, "unknown");

    const darker = dupes.find((d) => d.shadeId === "104");
    assert.equal(darker.grade, "medium");
    assert.ok(!ids.includes("105"), "a different color is not a dupe");
  });

  it("always excludes the target's own shade", () => {
    const target = prepareDupeShade(shadeRow(101));
    const { dupes, candidateCount } = findDupes(target, prepareDupeCandidates(ownedRows));
    assert.ok(!dupes.some((d) => d.shadeId === "101"));
    assert.equal(candidateCount, 5);
  });

  it("summarizeDupes reports the best dupe and counts", () => {
    const target = prepareDupeShade(shadeRow(100));
    const { dupes } = findDupes(target, prepareDupeCandidates(ownedRows));
    const hint = summarizeDupes("100", dupes);
    assert.equal(hint.best.shadeId, "101");
    assert.equal(hint.dupeCount, 5);
    assert.equal(hint.highCount, 3);
    assert.deepEqual(summarizeDupes("1", []), { shadeId: "1", best: null, dupeCount: 0, highCount: 0 });
  });

  it("distance agrees with the shared colorDistance", () => {
    const target = prepareDupeShade(shadeRow(100));
    const { dupes } = findDupes(target, prepareDupeCandidates(ownedRows));
    for (const dupe of dupes) {
      assert.ok(Math.abs(dupe.distance - colorDistance(BASE_RED, dupe.displayHex)) < 1e-4);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Request parsing
// ═══════════════════════════════════════════════════════════════════════════

describe("dupes request parsing", () => {
  it("parseShadeId accepts positive integers and numeric strings only", () => {
    assert.equal(parseShadeId(12), 12);
    assert.equal(parseShadeId("12"), 12);
    for (const bad of [0, -1, 1.5, "1.5", "abc", "", null, undefined, {}, "1; DROP TABLE"]) {
      assert.equal(parseShadeId(bad), null, `rejects ${JSON.stringify(bad)}`);
    }
  });

  it("parseDupesLimit defaults and enforces 1..maxLimit", () => {
    assert.equal(parseDupesLimit(null), DUPE_LIMITS.defaultLimit);
    assert.equal(parseDupesLimit("3"), 3);
    assert.equal(parseDupesLimit(String(DUPE_LIMITS.maxLimit)), DUPE_LIMITS.maxLimit);
    assert.throws(() => parseDupesLimit("0"), DupesInputError);
    assert.throws(() => parseDupesLimit(String(DUPE_LIMITS.maxLimit + 1)), DupesInputError);
    assert.throws(() => parseDupesLimit("x"), DupesInputError);
  });

  it("parseDupesBatchRequest de-duplicates and enforces the cap", () => {
    assert.deepEqual(parseDupesBatchRequest({ shadeIds: [3, "3", 1] }), [3, 1]);
    assert.deepEqual(parseDupesBatchRequest({ shadeIds: [] }), []);
    const atCap = Array.from({ length: DUPE_LIMITS.batchMaxShadeIds }, (_, i) => i + 1);
    assert.equal(parseDupesBatchRequest({ shadeIds: atCap }).length, DUPE_LIMITS.batchMaxShadeIds);
    // Duplicates do not count toward the cap.
    assert.equal(parseDupesBatchRequest({ shadeIds: [...atCap, ...atCap] }).length, DUPE_LIMITS.batchMaxShadeIds);
    assert.throws(() => parseDupesBatchRequest({ shadeIds: [...atCap, atCap.length + 1] }), /at most 100/);
    assert.throws(() => parseDupesBatchRequest({ shadeIds: "1,2" }), DupesInputError);
    assert.throws(() => parseDupesBatchRequest({ shadeIds: [1, "x"] }), DupesInputError);
    assert.throws(() => parseDupesBatchRequest([1, 2]), DupesInputError);
    assert.throws(() => parseDupesBatchRequest(null), DupesInputError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/polishes/{id}/dupes
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/polishes/{id}/dupes", () => {
  it("is registered with auth on the expected route", () => {
    assert.equal(registeredRoutes["polishes-dupes"].route, "polishes/{id}/dupes");
    assert.deepEqual(registeredRoutes["polishes-dupes"].methods, ["GET", "OPTIONS"]);
    assert.equal(registeredRoutes["polishes-dupes-batch"].route, "polishes/dupes");
  });

  it("returns 401 without credentials and runs no handler SQL", async () => {
    const res = await getDupes(100, { userId: undefined });
    assert.equal(res.status, 401);
    assert.deepEqual(handlerCalls(), []);
  });

  it("returns graded owned dupes, excluding non-owned statuses, other users and the target", async () => {
    const res = await getDupes(100);
    assert.equal(res.status, 200);
    const body = res.jsonBody;
    assert.equal(body.target.shadeId, "100");
    assert.equal(body.target.displayHex, BASE_RED);
    assert.equal(body.target.displayHexSource, "vendor");
    assert.deepEqual(body.target.finishes, ["creme"]);
    assert.equal(body.candidateCount, 6);
    assert.equal(body.dupeCount, 5);
    assert.equal(body.highCount, 3);
    assert.equal(body.dupes.length, DUPE_LIMITS.defaultLimit);
    const ids = body.dupes.map((d) => d.shadeId);
    for (const excluded of ["100", "107", "108", "200", "300"]) {
      assert.ok(!ids.includes(excluded), `shade ${excluded} must not be a dupe`);
    }
    for (const dupe of body.dupes) {
      assert.ok(["high", "medium"].includes(dupe.grade));
      assert.match(dupe.displayHex, /^#[0-9A-F]{6}$/);
    }
    assertScopedToCaller(OWNER);
  });

  it("honours ?limit= and rejects bad input", async () => {
    const limited = await getDupes(100, { query: "?limit=2" });
    assert.equal(limited.status, 200);
    assert.equal(limited.jsonBody.dupes.length, 2);
    assert.equal(limited.jsonBody.dupeCount, 5, "dupeCount is not limited");

    assert.equal((await getDupes(100, { query: "?limit=0" })).status, 400);
    assert.equal((await getDupes(100, { query: "?limit=999" })).status, 400);
    assert.equal((await getDupes("abc")).status, 400);
  });

  it("an owned target never lists itself", async () => {
    const res = await getDupes(101);
    assert.equal(res.status, 200);
    assert.ok(!res.jsonBody.dupes.some((d) => d.shadeId === "101"));
    assert.equal(res.jsonBody.candidateCount, 5);
  });

  it("a target without a hex returns an empty result", async () => {
    const res = await getDupes(400);
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.target.displayHex, null);
    assert.equal(res.jsonBody.target.displayHexSource, "none");
    assert.deepEqual(res.jsonBody.dupes, []);
  });

  it("404 for a missing shade or another user's private submission", async () => {
    assert.equal((await getDupes(999)).status, 404);
    assert.equal((await getDupes(300)).status, 404);
  });

  it("another user only ever sees their own inventory as dupes", async () => {
    const res = await getDupes(100, { userId: OTHER });
    assert.equal(res.status, 200);
    const ids = res.jsonBody.dupes.map((d) => d.shadeId);
    assert.deepEqual(ids, ["200", "300"], "only OTHER's own owned shades");
    const serialized = JSON.stringify(res.jsonBody);
    for (const ownerShade of ["Owned Red Creme", "Owned Red Holo", "Owned Red Jelly", "Detected Only"]) {
      assert.ok(!serialized.includes(ownerShade), `leaked owner's shade ${ownerShade}`);
    }
    assertScopedToCaller(OTHER);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/polishes/dupes
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/polishes/dupes", () => {
  it("returns the best owned dupe per visible shade in one pass", async () => {
    const res = await batchDupes({ shadeIds: [100, "105", 400, 999, 300] });
    assert.equal(res.status, 200);
    const { results, candidateCount } = res.jsonBody;
    assert.equal(candidateCount, 6);
    assert.deepEqual(Object.keys(results).sort(), ["100", "105", "400"], "missing/private ids are omitted");
    assert.equal(results["100"].best.shadeId, "101");
    assert.equal(results["100"].dupeCount, 5);
    assert.equal(results["105"].best, null, "the owned blue has no other blue to dupe");
    assert.equal(results["400"].best, null);

    const queries = handlerCalls();
    assert.equal(queries.length, 2, "one target query + one owned query, no N+1");
    assertScopedToCaller(OWNER);
  });

  it("enforces the batch cap before touching the database", async () => {
    const shadeIds = Array.from({ length: DUPE_LIMITS.batchMaxShadeIds + 1 }, (_, i) => i + 1);
    const res = await batchDupes({ shadeIds });
    assert.equal(res.status, 400);
    assert.deepEqual(handlerCalls(), []);
  });

  it("rejects malformed bodies and short-circuits an empty list", async () => {
    assert.equal((await batchDupes(undefined)).status, 400);
    assert.equal((await batchDupes({ shadeIds: "100" })).status, 400);
    const empty = await batchDupes({ shadeIds: [] });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.jsonBody, { results: {}, candidateCount: 0 });
    assert.deepEqual(handlerCalls(), []);
  });

  it("returns 401 without credentials", async () => {
    const res = await batchDupes({ shadeIds: [100] }, { userId: undefined });
    assert.equal(res.status, 401);
    assert.deepEqual(handlerCalls(), []);
  });

  it("never returns another user's inventory", async () => {
    const res = await batchDupes({ shadeIds: [100, 101, 102] }, { userId: OTHER });
    assert.equal(res.status, 200);
    for (const hint of Object.values(res.jsonBody.results)) {
      if (hint.best) assert.ok(["200", "300"].includes(hint.best.shadeId), `leaked ${hint.best.shadeId}`);
    }
    assert.equal(res.jsonBody.candidateCount, 2);
    assertScopedToCaller(OTHER);
  });
});
