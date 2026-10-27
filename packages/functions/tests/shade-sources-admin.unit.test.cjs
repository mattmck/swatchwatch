/**
 * GET /api/shades-admin/{id}/source-products: the connector products behind a shade (admin-only,
 * raw + normalized JSON). Handler tested with a fake db; `withAdmin` is covered by access-control.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

let shadeExists;
let products;
const calls = [];

const dbPath = path.resolve(__dirname, "../dist/lib/db.js");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT 1 FROM shade")) return { rows: shadeExists ? [{ "?column?": 1 }] : [] };
      return { rows: products };
    },
  },
};

const { getShadeSourceProducts } = require("../dist/functions/shade-sources-admin");
const context = { log() {}, error() {}, warn() {} };
const request = (id) => ({ params: { id } });

describe("GET /api/shades-admin/{id}/source-products", () => {
  beforeEach(() => {
    shadeExists = true;
    products = [];
    calls.length = 0;
  });

  it("rejects a bad id", async () => {
    assert.equal((await getShadeSourceProducts(request("abc"), context)).status, 400);
    assert.equal((await getShadeSourceProducts(request("0"), context)).status, 400);
    assert.equal(calls.length, 0);
  });

  it("404s an unknown shade", async () => {
    shadeExists = false;
    assert.equal((await getShadeSourceProducts(request("5"), context)).status, 404);
  });

  it("returns each linked product with its raw and normalized JSON", async () => {
    products = [
      {
        externalProductId: "9",
        source: "MakeupAPI",
        sourceEnabled: true,
        externalId: "740",
        gtin: null,
        productUrl: "https://well.ca/products/x.html",
        fetchedAt: new Date("2026-10-20T00:00:00Z"),
        firstSeenAt: new Date("2026-10-01T00:00:00Z"),
        lastSeenAt: new Date("2026-10-20T00:00:00Z"),
        rawJson: { id: 740 },
        normalizedJson: { name: "Junon" },
      },
    ];
    const response = await getShadeSourceProducts(request("3054"), context);
    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.shadeId, "3054");
    assert.equal(response.jsonBody.products[0].fetchedAt, "2026-10-20T00:00:00.000Z");
    assert.deepEqual(response.jsonBody.products[0].rawJson, { id: 740 });
    const list = calls.find((call) => call.sql.includes("FROM shade_source_product"));
    assert.deepEqual(list.params, [3054]);
  });
});
