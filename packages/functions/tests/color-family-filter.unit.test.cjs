/**
 * `?family=` filter (#103) on GET /api/polishes and GET /api/catalog/search.
 *
 * Runs without a database: the db module is replaced by a recorder so the tests can assert
 * on the SQL text and bound parameters. The filter must be a plain WHERE clause on
 * `shade.color_family` so pagination and the COUNT(*) OVER() total stay correct.
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
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
require("../dist/functions/catalog");
const { parseColorFamilyFilter } = require("../dist/lib/color-family-filter");

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

describe("parseColorFamilyFilter", () => {
  const parse = (qs) => parseColorFamilyFilter(new URLSearchParams(qs));

  it("returns no families when the parameter is absent or blank", () => {
    assert.deepEqual(parse(""), { ok: true, families: [] });
    assert.deepEqual(parse("family="), { ok: true, families: [] });
    assert.deepEqual(parse("family=%20,%20"), { ok: true, families: [] });
  });

  it("accepts comma-separated and repeated values, case-insensitive, deduped in canonical order", () => {
    assert.deepEqual(parse("family=Pink,red&family=RED&family=multichrome"), {
      ok: true,
      families: ["red", "pink", "multichrome"],
    });
  });

  it("accepts gray for grey", () => {
    assert.deepEqual(parse("family=gray"), { ok: true, families: ["grey"] });
  });

  it("rejects unknown families instead of ignoring them", () => {
    const result = parse("family=red,mauve,chartreuse");
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, ["mauve", "chartreuse"]);
    assert.match(result.error, /mauve, chartreuse/);
    assert.match(result.error, /Valid families: red, pink/);
  });
});

describe("GET /api/polishes?family=", () => {
  function recordListQueries(rows = []) {
    const calls = [];
    queryMock = async (text, params) => {
      if (text.includes("FROM app_user")) return { rows: [authUserRow] };
      calls.push({ text, params });
      if (text.includes("COUNT(*) AS total")) return { rows: [{ total: "7" }] };
      return { rows };
    };
    return calls;
  }

  it("filters on shade.color_family with a bound array and returns colorFamily", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const calls = recordListQueries([
      { id: "5", brand: "OPI", name: "Big Apple Red", color: "", finish: "creme", colorFamily: "red", swatchImageUrl: null, totalCount: "3" },
    ]);
    const res = await registeredRoutes["polishes-list"].handler(
      fakeRequest("http://localhost:7071/api/polishes?family=red,Pink&pageSize=1", AUTH),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.total, 3, "total comes from the filtered window count");
    assert.equal(res.jsonBody.polishes[0].colorFamily, "red");

    assert.equal(calls.length, 1);
    const { text, params } = calls[0];
    assert.match(text, /s\.color_family\s+AS "colorFamily"/);
    const placeholder = text.match(/s\.color_family = ANY\(\$(\d+)::text\[\]\)/);
    assert.ok(placeholder, "family filter should be in the WHERE clause");
    assert.deepEqual(params[Number(placeholder[1]) - 1], ["red", "pink"]);
    // The filter sits before ORDER BY / LIMIT, so COUNT(*) OVER() counts filtered rows only.
    assert.ok(text.indexOf("s.color_family = ANY") < text.lastIndexOf("ORDER BY"));
    // LIMIT/OFFSET placeholders still come after every filter parameter.
    const limit = text.match(/LIMIT \$(\d+) OFFSET \$(\d+)/);
    assert.equal(params[Number(limit[1]) - 1], 1);
    assert.equal(params[Number(limit[2]) - 1], 0);
  });

  it("applies the family filter to the fallback count for a page past the end", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const calls = recordListQueries([]);
    const res = await registeredRoutes["polishes-list"].handler(
      fakeRequest("http://localhost:7071/api/polishes?family=teal&page=9", AUTH),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.total, 7);
    const count = calls.find((c) => c.text.includes("COUNT(*) AS total"));
    assert.ok(count, "page past the end falls back to an explicit count");
    const placeholder = count.text.match(/s\.color_family = ANY\(\$(\d+)::text\[\]\)/);
    assert.ok(placeholder, "fallback count must carry the family filter");
    assert.deepEqual(count.params[Number(placeholder[1]) - 1], ["teal"]);
  });

  it("composes with other filters (finish, availability, search)", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const calls = [];
    queryMock = async (text, params) => {
      if (text.includes("FROM app_user")) return { rows: [authUserRow] };
      if (text.includes("FROM finish_type") || text.includes("FROM finish_normalization")) return { rows: [] };
      calls.push({ text, params });
      return { rows: [] };
    };
    const res = await registeredRoutes["polishes-list"].handler(
      fakeRequest("http://localhost:7071/api/polishes?search=apple&availability=owned&finishes=shimmer&family=multichrome", AUTH),
      fakeContext()
    );
    assert.equal(res.status, 200);
    const list = calls.find((c) => c.text.includes("COUNT(*) OVER()"));
    assert.ok(list);
    assert.match(list.text, /ILIKE/);
    assert.match(list.text, /COALESCE\(ui\.quantity, 0\) > 0/);
    const placeholder = list.text.match(/s\.color_family = ANY\(\$(\d+)::text\[\]\)/);
    assert.deepEqual(list.params[Number(placeholder[1]) - 1], ["multichrome"]);
  });

  it("does not touch the query when no family is requested", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const calls = recordListQueries([]);
    await registeredRoutes["polishes-list"].handler(
      fakeRequest("http://localhost:7071/api/polishes", AUTH),
      fakeContext()
    );
    assert.ok(calls.length >= 1);
    assert.doesNotMatch(calls[0].text, /color_family = ANY/);
  });

  it("answers 400 for an unknown family without querying the list", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const calls = recordListQueries([]);
    const res = await registeredRoutes["polishes-list"].handler(
      fakeRequest("http://localhost:7071/api/polishes?family=mauve", AUTH),
      fakeContext()
    );
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /Invalid color family: mauve/);
    assert.equal(calls.length, 0);
  });
});

describe("GET /api/catalog/search?family=", () => {
  it("binds null (no filter) when family is absent", async () => {
    const calls = [];
    queryMock = async (text, params) => {
      calls.push({ text, params });
      return { rows: [] };
    };
    const res = await registeredRoutes["catalog-search"].handler(
      fakeRequest("http://localhost:7071/api/catalog/search?q=red"),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.match(calls[0].text, /\(\$2::text\[\] IS NULL OR s\.color_family = ANY\(\$2::text\[\]\)\)/);
    assert.deepEqual(calls[0].params, ["red", null]);
  });

  it("filters by family and returns colorFamily on results", async () => {
    const calls = [];
    queryMock = async (text, params) => {
      calls.push({ text, params });
      return {
        rows: [
          { shadeId: "1", brand: "OPI", name: "Big Apple Red", finish: "creme", finishes: ["creme"], collection: null, colorFamily: "red", similarity: 0.5 },
        ],
      };
    };
    const res = await registeredRoutes["catalog-search"].handler(
      fakeRequest("http://localhost:7071/api/catalog/search?q=apple&family=red,coral"),
      fakeContext()
    );
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0].params, ["apple", ["red", "coral"]]);
    assert.match(calls[0].text, /s\.color_family\s+AS "colorFamily"/);
    assert.equal(res.jsonBody.results[0].colorFamily, "red");
    assert.equal(res.jsonBody.total, 1);
  });

  it("answers 400 for an unknown family", async () => {
    let called = false;
    queryMock = async () => {
      called = true;
      return { rows: [] };
    };
    const res = await registeredRoutes["catalog-search"].handler(
      fakeRequest("http://localhost:7071/api/catalog/search?q=apple&family=beige"),
      fakeContext()
    );
    assert.equal(res.status, 400);
    assert.match(res.jsonBody.error, /beige/);
    assert.equal(called, false);
  });
});
