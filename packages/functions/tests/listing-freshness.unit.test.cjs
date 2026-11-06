const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { markExternalProductsMissing } = require("../dist/lib/listing-freshness");
const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");

function fakeClient(rowCounts = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [], rowCount: rowCounts.shift() ?? 0 };
    },
  };
}

describe("lib/listing-freshness — markExternalProductsMissing", () => {
  it("skips an incomplete catalog and issues no UPDATE", async () => {
    const client = fakeClient();
    const result = await markExternalProductsMissing(client, 7, { externalIds: ["1", "2"], complete: false });
    assert.deepEqual(result, { marked: 0, cleared: 0, skipped: true });
    assert.equal(client.calls.length, 0);
  });

  it("skips an empty id list even when complete", async () => {
    const client = fakeClient();
    const result = await markExternalProductsMissing(client, 7, { externalIds: [], complete: true });
    assert.deepEqual(result, { marked: 0, cleared: 0, skipped: true });
    assert.equal(client.calls.length, 0);
  });

  it("marks absent ids and clears present ids, both scoped to the data source", async () => {
    const client = fakeClient([3, 2]);
    const result = await markExternalProductsMissing(client, 7, { externalIds: ["1", "2"], complete: true });
    assert.deepEqual(result, { marked: 3, cleared: 2, skipped: false });
    assert.equal(client.calls.length, 2);
    const [mark, clear] = client.calls;
    assert.match(mark.sql, /COALESCE\(missing_since, now\(\)\)/);
    assert.match(mark.sql, /data_source_id = \$1/);
    assert.match(mark.sql, /external_id IS NOT NULL/);
    assert.match(mark.sql, /NOT IN \(SELECT unnest\(\$2/);
    assert.deepEqual(mark.params, [7, ["1", "2"]]);
    assert.match(clear.sql, /missing_since = NULL/);
    assert.match(clear.sql, /data_source_id = \$1/);
    assert.match(clear.sql, /= ANY\(\$2/);
    assert.match(clear.sql, /missing_since IS NOT NULL/);
    assert.deepEqual(clear.params, [7, ["1", "2"]]);
  });
});

describe("ShopifyGenericConnector — catalog completeness", () => {
  const product = (id, title) => ({
    id,
    title,
    handle: `p-${id}`,
    vendor: "Mooncat",
    product_type: "Nail Polishes",
    tags: ["finish:glitter"],
    published_at: "2026-10-01T00:00:00Z",
    variants: [{ id: id * 10, title: "Default Title" }],
    images: [],
  });
  let originalFetch;
  let originalEndpoint;
  let pages;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    globalThis.fetch = async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        text: async () => JSON.stringify({ products: pages(page) }),
      };
    };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEndpoint !== undefined) process.env.AZURE_OPENAI_ENDPOINT = originalEndpoint;
  });

  const pull = (options = {}) =>
    new ShopifyGenericConnector("MooncatShopify", "https://mooncat.com").pullProducts({
      searchTerm: "",
      page: 1,
      pageSize: 50,
      maxRecords: 50,
      ...options,
    });

  it("is not complete when 30 full pages were fetched", async () => {
    pages = (page) => Array.from({ length: 250 }, (_, i) => product(page * 1000 + i, `Shade ${page}-${i}`));
    const result = await pull();
    assert.equal(result.catalog.complete, false);
    assert.equal(result.catalog.externalIds.length, 30 * 250);
  });

  it("is complete when the last page is short and lists ids even when filters drop records", async () => {
    pages = (page) =>
      page === 1
        ? Array.from({ length: 250 }, (_, i) => product(i + 1, `Shade ${i + 1}`))
        : [product(9001, "Zebra"), product(9002, "Yak")];
    const result = await pull({ searchTerm: "zebra", recentDays: 3650 });
    assert.equal(result.catalog.complete, true);
    assert.equal(result.catalog.externalIds.length, 252);
    assert.ok(result.catalog.externalIds.includes("1"));
    assert.ok(result.catalog.externalIds.includes("9002"));
    assert.equal(result.records.length, 1);
  });

  it("is not complete for an empty catalog", async () => {
    pages = () => [];
    const result = await pull();
    assert.equal(result.catalog.complete, false);
    assert.deepEqual(result.catalog.externalIds, []);
  });

  it("omits catalog when the catalog came from the cache", async () => {
    pages = () => [product(1, "Only")];
    const cache = { load: async () => [product(1, "Only")], save: async () => {} };
    const result = await pull({ catalogCache: cache });
    assert.equal(result.catalog, undefined);
  });
});
