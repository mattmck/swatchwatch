/**
 * `?nearHex=` color-distance sort on GET /api/polishes (`lib/near-hex.ts`) and the stored
 * display-hex OKLAB columns it ranks on (migration 20261023001520034_shade-display-oklab).
 *
 * Runs without a database: the db module is replaced by a recorder so the tests can assert on
 * the SQL text and bound parameters. The TS ↔ SQL OKLAB sync is checked by evaluating the
 * coefficients parsed out of hex_to_oklab() (docs/schema.sql) against the shared hexToOklab()
 * on a fixed set of hexes; when NEAR_HEX_SQL_TEST_DATABASE_URL (or
 * COLOR_FAMILY_SQL_TEST_DATABASE_URL) points at a migrated database (read-only) the real
 * function is compared too.
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const registeredRoutes = {};
let queryMock = async () => ({ rows: [] });

function preload(resolvedPath, exports) {
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
}

preload(require.resolve("@azure/functions"), {
  app: {
    http: (name, opts) => {
      registeredRoutes[name] = opts;
    },
    storageQueue: () => {},
    timer: () => {},
  },
  output: { storageQueue: (opts) => opts },
});
preload(path.resolve(__dirname, "../dist/lib/db.js"), {
  query: (...args) => queryMock(...args),
  transaction: async (cb) => cb({ query: async () => ({ rows: [] }) }),
  getPool: () => ({}),
  closePool: async () => {},
});

require("../dist/functions/polishes");
const { parseNearHexFilter, buildNearHexDistanceSql, NEAR_HEX_MAX_TARGETS } = require("../dist/lib/near-hex");
const { hexToOklab, colorDistance } = require("swatchwatch-shared");

const MIGRATION_PATH = path.resolve(__dirname, "../migrations/20261023001520034_shade-display-oklab.sql");
const SCHEMA_PATH = path.resolve(__dirname, "../../../docs/schema.sql");
const SQL_DATABASE_URL = process.env.NEAR_HEX_SQL_TEST_DATABASE_URL || process.env.COLOR_FAMILY_SQL_TEST_DATABASE_URL;

// Fixed hexes: primaries, greys, polish-ish colors and the channel edges of the sRGB transfer curve.
const FIXED_HEXES = [
  "#000000", "#FFFFFF", "#808080", "#0A0A0A", "#0B0B0B", "#FF0000", "#00FF00", "#0000FF",
  "#FFFF00", "#00FFFF", "#FF00FF", "#E0457B", "#B11226", "#F4C2C2", "#2E1A47", "#1B4D3E",
  "#C0C0C0", "#D2B48C", "#7B3F00", "#FFD1DC", "#123456", "#ABCDEF", "#FEDCBA", "#010203",
];

function fakeRequest(url, headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: "GET",
    url,
    headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
    params: {},
    json: async () => undefined,
  };
}

function fakeContext() {
  return { log: () => {}, error: () => {}, warn: () => {} };
}

const AUTH = { authorization: "Bearer dev:1" };
const authUserRow = { user_id: 1, external_id: "ext-1", email: null, role: "user" };

afterEach(() => {
  queryMock = async () => ({ rows: [] });
  delete process.env.AUTH_DEV_BYPASS;
});

describe("parseNearHexFilter", () => {
  const parse = (qs) => parseNearHexFilter(new URLSearchParams(qs));

  it("returns no targets when the parameter is absent or blank", () => {
    assert.deepEqual(parse(""), { ok: true, targets: [] });
    assert.deepEqual(parse("nearHex="), { ok: true, targets: [] });
    assert.deepEqual(parse("nearHex=%20,%20"), { ok: true, targets: [] });
  });

  it("accepts hexes with or without #, comma-separated and repeated, deduped and sorted", () => {
    assert.deepEqual(parse("nearHex=e0457b,%23B11226&nearHex=E0457B"), {
      ok: true,
      targets: ["#B11226", "#E0457B"],
    });
  });

  it("rejects anything that is not a 6-digit hex", () => {
    for (const bad of ["FFF", "#FFFFFFF", "GGGGGG", "red", "##FFFFFF", "12345"]) {
      const result = parse(`nearHex=${encodeURIComponent(bad)}`);
      assert.equal(result.ok, false, bad);
      assert.deepEqual(result.invalid, [bad]);
    }
  });

  it(`accepts at most ${NEAR_HEX_MAX_TARGETS} distinct targets`, () => {
    const hexes = Array.from({ length: NEAR_HEX_MAX_TARGETS + 1 }, (_, i) => i.toString(16).padStart(6, "0"));
    assert.equal(parse(`nearHex=${hexes.slice(0, -1).join(",")}`).ok, true);
    const tooMany = parse(`nearHex=${hexes.join(",")}`);
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.error, /at most 24/);
  });
});

describe("buildNearHexDistanceSql", () => {
  it("binds the shared hexToOklab coordinates, three placeholders per target", () => {
    const one = buildNearHexDistanceSql(["#E0457B"], 4);
    const lab = hexToOklab("#E0457B");
    assert.deepEqual(one.params, [lab.L, lab.a, lab.b]);
    assert.equal(
      one.sql,
      "sqrt(power(s.oklab_l - $4::float8, 2) + power(s.oklab_a - $5::float8, 2) + power(s.oklab_b - $6::float8, 2))"
    );
    const two = buildNearHexDistanceSql(["#000000", "#FFFFFF"], 2);
    assert.equal(two.params.length, 6);
    assert.match(two.sql, /^LEAST\(sqrt\(.*\$2::float8.*\), sqrt\(.*\$7::float8, 2\)\)\)$/);
  });
});

describe("GET /api/polishes?nearHex=", () => {
  function recordListQueries(rows = []) {
    const calls = [];
    queryMock = async (text, params) => {
      if (text.includes("FROM app_user")) return { rows: [authUserRow] };
      if (text.includes("shade_source_product")) return { rows: [] };
      calls.push({ text, params });
      if (text.includes("COUNT(*) AS total")) return { rows: [{ total: "4" }] };
      return { rows };
    };
    return calls;
  }

  it("orders by distance (nulls last, shade id tiebreak) after every filter and returns colorDistance", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const calls = recordListQueries([
      { id: "5", brand: "OPI", name: "Pink", color: "", finish: "", colorDistance: 0.0123, swatchImageUrl: null, totalCount: "2" },
    ]);
    const res = await registeredRoutes["polishes-list"].handler(
      fakeRequest(
        "http://localhost:7071/api/polishes?nearHex=E0457B&family=pink&category=color&status=owned&sortBy=name&pageSize=10&page=2",
        AUTH
      ),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.polishes[0].colorDistance, 0.0123);
    assert.equal(res.jsonBody.total, 2);

    assert.equal(calls.length, 1);
    const { text, params } = calls[0];
    assert.match(text, /ORDER BY "colorDistance" ASC NULLS LAST, s\.shade_id ASC/);
    assert.doesNotMatch(text, /ORDER BY s\.shade_name_canonical/, "nearHex replaces sortBy");
    // Visibility and every filter stay in the WHERE clause: nearHex only changes the order.
    assert.match(text, /s\.merged_into_shade_id IS NULL AND \(s\.status <> 'user_submitted'/);
    assert.match(text, /s\.color_family = ANY/);
    assert.match(text, /s\.product_category = ANY/);
    assert.match(text, /ui\.status = ANY/);
    // Distance placeholders sit between the filter params and LIMIT/OFFSET.
    const distance = text.match(/sqrt\(power\(s\.oklab_l - \$(\d+)::float8, 2\)/);
    assert.ok(distance);
    const lab = hexToOklab("#E0457B");
    const first = Number(distance[1]) - 1;
    assert.deepEqual(params.slice(first, first + 3), [lab.L, lab.a, lab.b]);
    const limit = text.match(/LIMIT \$(\d+) OFFSET \$(\d+)/);
    assert.equal(Number(limit[1]), first + 4);
    assert.equal(params[Number(limit[1]) - 1], 10);
    assert.equal(params[Number(limit[2]) - 1], 10);
  });

  it("keeps the fallback count free of the distance parameters", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const calls = recordListQueries([]);
    const res = await registeredRoutes["polishes-list"].handler(
      fakeRequest("http://localhost:7071/api/polishes?nearHex=%23E0457B,000000&family=red&page=9", AUTH),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.total, 4);
    const count = calls.find((c) => c.text.includes("COUNT(*) AS total"));
    assert.ok(count);
    assert.doesNotMatch(count.text, /oklab/);
    const highest = Math.max(...[...count.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    assert.equal(count.params.length, highest, "every bound parameter is referenced");
  });

  it("leaves the default sort alone without nearHex", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const calls = recordListQueries([]);
    await registeredRoutes["polishes-list"].handler(fakeRequest("http://localhost:7071/api/polishes", AUTH), fakeContext());
    assert.doesNotMatch(calls[0].text, /colorDistance|oklab/);
  });

  it("answers 400 for a bad nearHex", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const calls = recordListQueries([]);
    const res = await registeredRoutes["polishes-list"].handler(
      fakeRequest("http://localhost:7071/api/polishes?nearHex=pinkish", AUTH),
      fakeContext()
    );
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /Invalid nearHex: pinkish/);
    assert.equal(calls.length, 0);
  });
});

/** The current `hex_to_oklab()` body from a SQL file. */
function hexToOklabFunction(sql) {
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION hex_to_oklab(");
  assert.ok(start >= 0, "hex_to_oklab() not found");
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end);
}

/**
 * Evaluate hex_to_oklab() in JS from the constants written in its SQL body: the sRGB transfer
 * curve, the linear RGB → LMS matrix (`l_ := cbrt(...)` lines) and the LMS → OKLAB matrix (the
 * RETURN ARRAY rows). A typo in any coefficient changes the result.
 */
function sqlHexToOklab(fnBody, hex) {
  const curve = fnBody.match(
    /r := CASE WHEN r <= ([\d.]+) THEN r \/ ([\d.]+) ELSE power\(\(r \+ ([\d.]+)\) \/ ([\d.]+), ([\d.]+)\) END;/
  );
  assert.ok(curve, "sRGB transfer curve for r");
  for (const ch of ["g", "b"]) {
    assert.ok(fnBody.includes(curve[0].replaceAll("r", ch).replace("powe" + ch, "power")), `same curve for ${ch}`);
  }
  const [threshold, slope, offset, scale, gamma] = curve.slice(1).map(Number);
  const linear = (c) => (c <= threshold ? c / slope : Math.pow((c + offset) / scale, gamma));

  const terms = (expr, vars) => {
    const out = [];
    for (const v of vars) {
      const m = expr.match(new RegExp(`(-|\\+)?\\s*([\\d.]+) \\* ${v.replace("_", "\\_")}\\b`));
      assert.ok(m, `coefficient for ${v} in ${expr}`);
      out.push((m[1] === "-" ? -1 : 1) * Number(m[2]));
    }
    return out;
  };
  const lms = ["l_", "m_", "s_"].map((name) => {
    const line = fnBody.match(new RegExp(`${name} := cbrt\\(([^;]+)\\);`));
    assert.ok(line, `${name} line`);
    return terms(line[1], ["r", "g", "b"]);
  });
  const ret = fnBody.match(/RETURN ARRAY\[([\s\S]+?)\];/);
  assert.ok(ret, "RETURN ARRAY");
  const rows = ret[1].split(",").map((row) => terms(row, ["l_", "m_", "s_"]));
  assert.equal(rows.length, 3);

  const clean = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => linear(parseInt(clean.slice(i, i + 2), 16) / 255));
  const lmsValues = lms.map((row) => Math.cbrt(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]));
  const [L, a, b] = rows.map((row) => row[0] * lmsValues[0] + row[1] * lmsValues[1] + row[2] * lmsValues[2]);
  return { L, a, b };
}

describe("display-hex OKLAB — SQL ↔ TS", () => {
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  const migration = fs.readFileSync(MIGRATION_PATH, "utf8");
  const [up, down] = migration.split("-- Down Migration");

  it("hex_to_oklab() in docs/schema.sql and in its migration equals the shared hexToOklab() on fixed hexes", () => {
    const original = fs.readFileSync(
      path.resolve(__dirname, "../migrations/20261017024958000_shade-detected-hex-provenance.sql"),
      "utf8"
    );
    for (const [name, sql] of [["docs/schema.sql", schema], ["migration", original.split("-- Down Migration")[0]]]) {
      const fn = hexToOklabFunction(sql);
      for (const hex of FIXED_HEXES) {
        const fromSql = sqlHexToOklab(fn, hex);
        const ts = hexToOklab(hex);
        for (const key of ["L", "a", "b"]) {
          assert.ok(
            Math.abs(fromSql[key] - ts[key]) < 1e-12,
            `${name} ${hex} ${key}: SQL ${fromSql[key]} vs TS ${ts[key]}`
          );
        }
      }
    }
  });

  it("the stored columns use the display hex (vendor > detected > name) trimmed like color_family", () => {
    const expr = (i) =>
      `(hex_to_oklab(shade_color_family_trim(COALESCE(NULLIF(vendor_hex, ''), NULLIF(detected_hex, ''), NULLIF(name_hex, '')))))[${i}]`;
    for (const [i, column] of [[1, "oklab_l"], [2, "oklab_a"], [3, "oklab_b"]]) {
      for (const [name, sql] of [["migration", up], ["docs/schema.sql", schema]]) {
        assert.ok(
          sql.includes(`${column} DOUBLE PRECISION GENERATED ALWAYS AS (\n    ${expr(i)}\n  ) STORED`),
          `${name}: ${column}`
        );
      }
      assert.match(down, new RegExp(`DROP COLUMN IF EXISTS ${column}\\b`));
    }
  });

  it(
    "matches Postgres hex_to_oklab() and the distance math (needs NEAR_HEX_SQL_TEST_DATABASE_URL)",
    { skip: !SQL_DATABASE_URL && "NEAR_HEX_SQL_TEST_DATABASE_URL not set" },
    async () => {
      const { Client } = require("pg");
      const client = new Client({ connectionString: SQL_DATABASE_URL });
      await client.connect();
      try {
        const { rows } = await client.query(
          "SELECT h, hex_to_oklab(h) AS lab FROM unnest($1::text[]) AS h",
          [FIXED_HEXES]
        );
        for (const row of rows) {
          const ts = hexToOklab(row.h);
          assert.ok(Math.abs(row.lab[0] - ts.L) < 1e-12, `${row.h} L`);
          assert.ok(Math.abs(row.lab[1] - ts.a) < 1e-12, `${row.h} a`);
          assert.ok(Math.abs(row.lab[2] - ts.b) < 1e-12, `${row.h} b`);
        }
        // The list query's distance expression, evaluated on a stand-in for shade `s`.
        const target = "#E0457B";
        const { sql, params } = buildNearHexDistanceSql([target], 2);
        const { rows: dist } = await client.query(
          `SELECT h, ${sql} AS d
           FROM unnest($1::text[]) AS h,
           LATERAL (SELECT (hex_to_oklab(h))[1] AS oklab_l, (hex_to_oklab(h))[2] AS oklab_a, (hex_to_oklab(h))[3] AS oklab_b) AS s`,
          [FIXED_HEXES, ...params]
        );
        for (const row of dist) {
          assert.ok(Math.abs(row.d - colorDistance(row.h, target)) < 1e-12, `${row.h} distance`);
        }
      } finally {
        await client.end();
      }
    }
  );
});
