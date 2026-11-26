// Google product feed connector (brand sources plan, Task 14). The fixtures under
// tests/fixtures/product-feed-sample.{xml,tsv} are hand-written (2026-11-08), no store data.
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ProductFeedConnector,
  parseFeedPrice,
  parseFeedAvailability,
  parseProductFeed,
} = require("../dist/lib/connectors/product-feed");
const { readSourceSettings } = require("../dist/lib/source-settings");

const FIXTURES = path.join(__dirname, "fixtures");
const XML = fs.readFileSync(path.join(FIXTURES, "product-feed-sample.xml"), "utf8");
const TSV = fs.readFileSync(path.join(FIXTURES, "product-feed-sample.tsv"), "utf8");

const PULL = { searchTerm: "", page: 1, pageSize: 100, maxRecords: 100 };

function stubFetch(body, contentType, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
      text: async () => body,
    };
  };
}

function connector(body, contentType, metadata = {}, { url = "https://lacquer.example/feed", calls } = {}) {
  const settings = readSourceSettings(metadata, "ExampleLacquerFeed");
  return new ProductFeedConnector("ExampleLacquerFeed", url, settings, { fetchImpl: stubFetch(body, contentType, calls) });
}

function assertSampleRecords(result) {
  const ids = result.records.map((record) => record.externalId);
  // The "Duo" set and the stamping plate are dropped; the out-of-stock lacquer is kept.
  assert.deepEqual(ids, ["EX-001", "EX-002", "EX-003", "EX-004", "EX-005"]);
  const byId = Object.fromEntries(result.records.map((record) => [record.externalId, record]));

  // UPC-12 and EAN-13 normalize to their canonical barcode keys.
  assert.equal(byId["EX-001"].gtin, "0096200010000");
  assert.equal(byId["EX-002"].gtin, "5012345678900");
  // A wrong check digit is kept and reported.
  assert.equal(byId["EX-003"].gtin, "4006381333932");
  assert.deepEqual(result.metadata.invalidCheckDigits, [{ externalId: "EX-003", gtin: "4006381333932" }]);
  // id only: no barcode.
  assert.equal(byId["EX-004"].gtin, null);

  const first = byId["EX-001"].normalized;
  assert.equal(first.brand, "Example Lacquer");
  assert.equal(first.name, "Moonlit Garden");
  assert.equal(first.productType, "Nail Polish");
  assert.deepEqual(first.tags, []);
  assert.deepEqual(first.finishes, []);
  assert.deepEqual(first.collections, []);
  assert.deepEqual(first.descriptors, ["Blue", "Nail Polish", "EX-G1"]);
  assert.equal(first.descriptionText, "A deep blue holo polish.");
  assert.deepEqual(first.imageUrls, [
    "https://cdn.lacquer.example/moonlit-garden.jpg",
    "https://cdn.lacquer.example/moonlit-garden-2.jpg",
    "https://cdn.lacquer.example/moonlit-garden-3.jpg",
  ]);
  assert.equal(first.primaryImageUrl, "https://cdn.lacquer.example/moonlit-garden.jpg");
  assert.equal(first.productUrl, "https://lacquer.example/products/moonlit-garden");
  assert.equal(first.price, "12.50");
  assert.equal(Number(first.price), 12.5);
  assert.equal(first.currency, "USD");
  assert.equal(first.available, true);
  assert.equal(first.kind, "brand");
  assert.equal(first.productCategory, "color");

  assert.equal(byId["EX-005"].normalized.available, false);
  assert.equal(byId["EX-004"].normalized.primaryImageUrl, null);
  assert.deepEqual(byId["EX-004"].normalized.imageUrls, []);
  assert.equal(result.metadata.fetchedProductCount, 7);
  assert.equal(result.metadata.sourceCount, 5);
}

describe("ProductFeedConnector: fixtures", () => {
  it("parses the RSS 2.0 XML fixture", async () => {
    const result = await connector(XML, "application/xml; charset=utf-8").pullProducts(PULL);
    assert.equal(result.metadata.feedFormat, "xml");
    assertSampleRecords(result);
  });

  it("parses the TSV fixture", async () => {
    const result = await connector(TSV, "text/tab-separated-values").pullProducts(PULL);
    assert.equal(result.metadata.feedFormat, "delimited");
    assertSampleRecords(result);
  });

  it("detects the format from the extension when the content type says nothing", async () => {
    const xml = await connector(XML, "application/octet-stream", {}, { url: "https://lacquer.example/feed.xml" }).pullProducts(PULL);
    assert.equal(xml.metadata.feedFormat, "xml");
    const tsv = await connector(TSV, null, {}, { url: "https://lacquer.example/feed.tsv?token=x" }).pullProducts(PULL);
    assert.equal(tsv.metadata.feedFormat, "delimited");
    assert.equal(tsv.records.length, 5);
  });

  it("windows the feed by page and caps at maxRecords", async () => {
    const page2 = await connector(XML, "application/xml").pullProducts({ ...PULL, page: 2, pageSize: 2 });
    assert.deepEqual(page2.records.map((record) => record.externalId), ["EX-003", "EX-004"]);
    assert.equal(page2.metadata.sourcePageCount, 3);
    const capped = await connector(XML, "application/xml").pullProducts({ ...PULL, maxRecords: 1 });
    assert.deepEqual(capped.records.map((record) => record.externalId), ["EX-001"]);
  });

  it("filters by a search term", async () => {
    const result = await connector(XML, "application/xml").pullProducts({ ...PULL, searchTerm: "copper" });
    assert.deepEqual(result.records.map((record) => record.externalId), ["EX-002"]);
  });

  it("reports every item id as a complete catalog when it downloaded the feed", async () => {
    const result = await connector(XML, "application/xml").pullProducts({ ...PULL, pageSize: 2 });
    // Every item, before the gate and the window (the set and the stamping plate included).
    assert.deepEqual(result.catalog, {
      externalIds: ["EX-001", "EX-002", "EX-003", "EX-004", "EX-005", "EX-006", "EX-007"],
      complete: true,
    });
  });

  it("reports no catalog when the feed came from the job's cache", async () => {
    const cache = { load: async () => parseProductFeed(XML, "application/xml", "https://lacquer.example/feed").items, save: async () => {} };
    const calls = [];
    const result = await connector(XML, "application/xml", {}, { calls }).pullProducts({ ...PULL, catalogCache: cache });
    assert.equal(calls.length, 0);
    assert.equal(result.catalog, undefined);
    assert.equal(result.records.length, 5);
  });

  it("downloads once per job through the catalog cache", async () => {
    let saved = null;
    const cache = { load: async () => saved, save: async (items) => { saved = items; } };
    const calls = [];
    const feed = connector(XML, "application/xml", {}, { calls });
    await feed.pullProducts({ ...PULL, pageSize: 2, catalogCache: cache });
    const page2 = await feed.pullProducts({ ...PULL, page: 2, pageSize: 2, catalogCache: cache });
    assert.equal(calls.length, 1);
    assert.deepEqual(page2.records.map((record) => record.externalId), ["EX-003", "EX-004"]);
  });
});

describe("ProductFeedConnector: Atom", () => {
  it("reads Atom entries with g: elements", async () => {
    const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:g="http://base.google.com/ns/1.0">
  <title>Example</title>
  <entry>
    <g:id>A-1</g:id>
    <title>Atom Shade</title>
    <link href="https://lacquer.example/products/atom-shade"/>
    <g:price>10 EUR</g:price>
    <g:availability>in_stock</g:availability>
    <g:brand>Example Lacquer</g:brand>
    <g:product_type>Nail Polish</g:product_type>
  </entry>
</feed>`;
    const result = await connector(atom, "application/atom+xml").pullProducts(PULL);
    assert.equal(result.records.length, 1);
    const [record] = result.records;
    assert.equal(record.externalId, "A-1");
    assert.equal(record.normalized.name, "Atom Shade");
    assert.equal(record.normalized.productUrl, "https://lacquer.example/products/atom-shade");
    assert.equal(record.normalized.price, "10.00");
    assert.equal(record.normalized.currency, "EUR");
    assert.equal(record.normalized.available, true);
  });
});

function feedItem({ id, title, brand }) {
  return `<item><g:id>${id}</g:id><g:title>${title}</g:title>${brand ? `<g:brand>${brand}</g:brand>` : ""}
    <g:link>https://reseller.example/p/${id}</g:link><g:price>11.00 USD</g:price>
    <g:availability>in stock</g:availability><g:product_type>Nail Polish</g:product_type></item>`;
}

function rss(items) {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>${items.join("")}</channel></rss>`;
}

describe("ProductFeedConnector: feed-kind pull", () => {
  it("uses settings.brand for an item without g:brand and keeps an item's own brand", async () => {
    const body = rss([
      feedItem({ id: "F-1", title: "Example Lacquer - Night Swim - #EX12" }),
      feedItem({ id: "F-2", title: "Other Brand Nail Lacquer - Sunburst", brand: "Other Brand" }),
    ]);
    const result = await connector(body, "application/xml", { kind: "feed", brand: "Example Lacquer" }).pullProducts(PULL);
    const byId = Object.fromEntries(result.records.map((record) => [record.externalId, record.normalized]));
    assert.equal(byId["F-1"].brand, "Example Lacquer");
    // Feed listings are parsed like retailer titles and carry the listing fields.
    assert.equal(byId["F-1"].name, "Night Swim");
    assert.equal(byId["F-1"].vendorCode, "EX12");
    assert.equal(byId["F-1"].listingTitle, "Example Lacquer - Night Swim - #EX12");
    assert.equal(byId["F-1"].kind, "feed");
    assert.equal(byId["F-2"].brand, "Other Brand");
    assert.equal(byId["F-2"].name, "Sunburst");
    assert.equal(byId["F-2"].productLine, "Nail Lacquer");
    assert.equal(result.metadata.vendorlessSkipped, 0);
  });

  it("skips an item without g:brand when the source has no brand, and counts it", async () => {
    const body = rss([
      feedItem({ id: "F-1", title: "Night Swim" }),
      feedItem({ id: "F-2", title: "Sunburst", brand: "Other Brand" }),
    ]);
    const result = await connector(body, "application/xml", { kind: "feed" }).pullProducts(PULL);
    assert.deepEqual(result.records.map((record) => record.externalId), ["F-2"]);
    assert.equal(result.metadata.vendorlessSkipped, 1);
  });

  it("drops a set listing parsed from a retailer-style title", async () => {
    const body = rss([feedItem({ id: "F-9", title: "Example Lacquer - Sonnet Fall Collection", brand: "Example Lacquer" })]);
    const result = await connector(body, "application/xml", { kind: "retailer" }).pullProducts(PULL);
    assert.equal(result.records.length, 0);
  });

  it("keeps a brand-kind shade whose name ends in a set word (the generic gate decides)", async () => {
    const body = rss([feedItem({ id: "B-2", title: "Jet Set", brand: "Example Lacquer" })]);
    const brand = await connector(body, "application/xml", { kind: "brand" }).pullProducts(PULL);
    assert.deepEqual(brand.records.map((record) => record.externalId), ["B-2"]);
    assert.equal(brand.records[0].normalized.name, "Jet Set");
    // A feed or retailer source still drops a title ending in a set word.
    const feed = await connector(body, "application/xml", { kind: "feed" }).pullProducts(PULL);
    assert.equal(feed.records.length, 0);
  });

  it("parses a brand-kind title like the other connectors, keeping rawTitle", async () => {
    const body = rss([feedItem({ id: "B-1", title: "Zoya Nail Polish - Aurora", brand: "Zoya" })]);
    const result = await connector(body, "application/xml", { kind: "brand" }).pullProducts(PULL);
    const [record] = result.records;
    assert.equal(record.normalized.name, "Aurora");
    assert.equal(record.normalized.rawTitle, "Zoya Nail Polish - Aurora");
    assert.equal(record.normalized.listingTitle, undefined, "brand mode");
  });

  it("keeps a brand-kind title whole when its first segment is not the brand or a line word", async () => {
    const body = rss([
      feedItem({ id: "B-1", title: "Night Swim - Holo", brand: "Example Lacquer" }),
      feedItem({ id: "B-2", title: "Picture Polish – Atomic", brand: "Picture Polish" }),
    ]);
    const result = await connector(body, "application/xml", { kind: "brand" }).pullProducts(PULL);
    const names = Object.fromEntries(result.records.map((record) => [record.externalId, record.normalized.name]));
    assert.deepEqual(names, { "B-1": "Night Swim - Holo", "B-2": "Atomic" });
    // A feed source still reads the first segment as the brand.
    const feed = await connector(body, "application/xml", { kind: "feed" }).pullProducts(PULL);
    assert.equal(feed.records.find((record) => record.externalId === "B-1").normalized.name, "Holo");
  });

  it("maps g:brand through metadata.vendorAliases, in feed and brand mode", async () => {
    const body = rss([feedItem({ id: "A-1", title: "Atomic", brand: "piCture pOlish" })]);
    for (const kind of ["feed", "brand"]) {
      const result = await connector(body, "application/xml", {
        kind,
        vendorAliases: { "piCture pOlish": "Picture Polish" },
      }).pullProducts(PULL);
      assert.equal(result.records[0].normalized.brand, "Picture Polish", kind);
    }
  });

  it("skips a feed item whose g:brand is a placeholder when the source has no brand", async () => {
    const body = rss([feedItem({ id: "P-1", title: "Atomic", brand: "Vendor Unknown" })]);
    const result = await connector(body, "application/xml", { kind: "feed" }).pullProducts(PULL);
    assert.equal(result.records.length, 0);
    assert.equal(result.metadata.vendorlessSkipped, 1);
  });
});

describe("ProductFeedConnector: fetch", () => {
  const ENV = "PRODUCT_FEED_AUTH_EXAMPLELACQUERFEED";
  afterEach(() => {
    delete process.env[ENV];
  });

  it("sends the connector User-Agent and basic auth from the env var metadata.feedAuthEnv names", async () => {
    process.env[ENV] = "feeduser:s3cret";
    const calls = [];
    await connector(XML, "application/xml", { feedAuthEnv: ENV }, { calls }).pullProducts(PULL);
    assert.equal(calls.length, 1);
    const headers = calls[0].init.headers;
    assert.match(headers["User-Agent"], /^SwatchWatch\/connector-ingestion/);
    assert.equal(headers.Authorization, `Basic ${Buffer.from("feeduser:s3cret").toString("base64")}`);
  });

  it("refuses a feedAuthEnv outside PRODUCT_FEED_AUTH_* before any request", async () => {
    process.env.AZURE_STORAGE_CONNECTION_TEST_ONLY = "secret";
    try {
      for (const name of ["AZURE_STORAGE_CONNECTION_TEST_ONLY", "PRODUCT_FEED_AUTH_", "product_feed_auth_x", "PRODUCT_FEED_AUTH_X-Y"]) {
        const calls = [];
        await assert.rejects(
          connector(XML, "application/xml", { feedAuthEnv: name }, { calls }).pullProducts(PULL),
          /feedAuthEnv must match \^PRODUCT_FEED_AUTH_\[A-Z0-9_\]\+\$/
        );
        assert.equal(calls.length, 0, name);
      }
    } finally {
      delete process.env.AZURE_STORAGE_CONNECTION_TEST_ONLY;
    }
  });

  it("sends no Authorization header without feedAuthEnv", async () => {
    process.env[ENV] = "feeduser:s3cret";
    const calls = [];
    await connector(XML, "application/xml", {}, { calls }).pullProducts(PULL);
    assert.equal(calls[0].init.headers.Authorization, undefined);
  });

  it("never puts the credentials or the query string in the metadata", async () => {
    process.env[ENV] = "feeduser:s3cret";
    const result = await connector(XML, "application/xml", { feedAuthEnv: ENV }, { url: "https://lacquer.example/feed.xml?key=abc" }).pullProducts(PULL);
    assert.equal(result.metadata.requestUrl, "https://lacquer.example"); // origin only: a path or query token is never logged
    assert.doesNotMatch(JSON.stringify(result), /s3cret|key=abc/);
  });

  it("fails on an HTTP error without retrying a 404", async () => {
    let count = 0;
    const settings = readSourceSettings({}, "ExampleLacquerFeed");
    const feed = new ProductFeedConnector("ExampleLacquerFeed", "https://lacquer.example/feed", settings, {
      fetchImpl: async () => {
        count += 1;
        return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "" };
      },
    });
    await assert.rejects(feed.pullProducts(PULL), /404/);
    assert.equal(count, 1);
  });
});

describe("ProductFeedConnector: feed URL never leaks through an error", () => {
  const FEED = "https://feed.example/x?token=SECRET";
  const feedWith = (fetchImpl) =>
    new ProductFeedConnector("ExampleLacquerFeed", FEED, readSourceSettings({}, "ExampleLacquerFeed"), { fetchImpl });

  it("redacts the full URL from a rethrown error's message and stack, keeping its class", async () => {
    class ConnectError extends Error {}
    let count = 0;
    const feed = feedWith(async () => {
      count += 1;
      throw new ConnectError(`connect failed for ${FEED}`);
    });
    await assert.rejects(feed.pullProducts(PULL), (error) => {
      assert.ok(error instanceof ConnectError);
      assert.equal(error.message, "connect failed for https://feed.example");
      assert.doesNotMatch(String(error.stack), /SECRET/);
      return true;
    });
    assert.equal(count, 1);
  });

  it("redacts the URL-encoded form and the cause from retry warnings and the final error", async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    let count = 0;
    try {
      const feed = feedWith(async () => {
        count += 1;
        if (count === 1) throw new Error(`fetch failed (${encodeURIComponent(FEED)})`, { cause: new Error(`ECONNRESET ${FEED}`) });
        throw new Error(`socket closed while reading ${FEED}`, { cause: new Error(`at ${FEED}`) });
      });
      await assert.rejects(feed.pullProducts(PULL), (error) => {
        assert.doesNotMatch(`${error.message} ${error.stack} ${error.cause?.message} ${error.cause?.stack}`, /SECRET/);
        assert.match(error.message, /https:\/\/feed\.example$/);
        return true;
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(count, 2, "the retryable first error is still retried");
    assert.ok(warnings.length >= 1);
    assert.doesNotMatch(warnings.join("\n"), /SECRET/);
  });
});

describe("product feed helpers", () => {
  it("parseFeedPrice reads amount + ISO code in either order", () => {
    assert.deepEqual(parseFeedPrice("12.50 USD"), { price: "12.50", currency: "USD" });
    assert.deepEqual(parseFeedPrice("USD 8"), { price: "8.00", currency: "USD" });
    assert.deepEqual(parseFeedPrice("12,50 EUR"), { price: "12.50", currency: "EUR" });
    assert.deepEqual(parseFeedPrice("12.50"), { price: null, currency: null });
    assert.deepEqual(parseFeedPrice("free"), { price: null, currency: null });
    assert.deepEqual(parseFeedPrice(null), { price: null, currency: null });
  });

  it("parseFeedAvailability: in stock and preorder are buyable, backorder and out of stock not, anything else null", () => {
    assert.equal(parseFeedAvailability("in stock"), true);
    assert.equal(parseFeedAvailability("IN_STOCK"), true);
    assert.equal(parseFeedAvailability("preorder"), true);
    assert.equal(parseFeedAvailability("pre_order"), true);
    assert.equal(parseFeedAvailability("out of stock"), false);
    assert.equal(parseFeedAvailability("out_of_stock"), false);
    assert.equal(parseFeedAvailability("backorder"), false);
    assert.equal(parseFeedAvailability("discontinued"), null);
    assert.equal(parseFeedAvailability(""), null);
    assert.equal(parseFeedAvailability(undefined), null);
  });

  it("parseProductFeed reads quoted CSV", () => {
    const csv = 'id,title,price,brand,product_type\n"C-1","Shade, with comma","9.00 USD",Example Lacquer,Nail Polish\n';
    const { format, items } = parseProductFeed(csv, "text/csv", "https://x.example/feed.csv");
    assert.equal(format, "delimited");
    assert.deepEqual(items, [{ id: "C-1", title: "Shade, with comma", price: "9.00 USD", brand: "Example Lacquer", product_type: "Nail Polish" }]);
  });
});

describe("ProductFeedConnector: authed feeds use https (PR #506 review)", () => {
  const ENV = "PRODUCT_FEED_AUTH_EXAMPLELACQUERFEED";

  it("the constructor refuses a non-https feed URL when metadata.feedAuthEnv is set", () => {
    const settings = readSourceSettings({ feedAuthEnv: ENV }, "ExampleLacquerFeed");
    for (const url of ["http://lacquer.example/feed", "ftp://lacquer.example/feed", "lacquer.example/feed"]) {
      assert.throws(
        () => new ProductFeedConnector("ExampleLacquerFeed", url, settings, { fetchImpl: stubFetch(XML, "application/xml") }),
        /^Error: ExampleLacquerFeed: the feed URL must use https when metadata\.feedAuthEnv is set$/,
        url
      );
    }
    // https in any case is fine; so is http without credentials.
    assert.ok(new ProductFeedConnector("ExampleLacquerFeed", "HTTPS://lacquer.example/feed", settings));
    assert.ok(new ProductFeedConnector("ExampleLacquerFeed", "http://lacquer.example/feed", readSourceSettings({}, "ExampleLacquerFeed")));
  });

  it("the ProductFeed factory refuses it too, before any request", () => {
    const { createConnectorForProtocol } = require("../dist/functions/ingestion");
    const authed = readSourceSettings({ feedAuthEnv: ENV }, "ExampleLacquerFeed");
    assert.throws(
      () => createConnectorForProtocol("ProductFeed", "ExampleLacquerFeed", "http://lacquer.example/feed", authed),
      /the feed URL must use https when metadata\.feedAuthEnv is set/
    );
    const viaFeedUrl = readSourceSettings({ feedAuthEnv: ENV, feedUrl: "http://lacquer.example/other" }, "ExampleLacquerFeed");
    assert.throws(
      () => createConnectorForProtocol("ProductFeed", "ExampleLacquerFeed", "https://lacquer.example/feed", viaFeedUrl),
      /the feed URL must use https/
    );
    assert.ok(createConnectorForProtocol("ProductFeed", "ExampleLacquerFeed", "https://lacquer.example/feed", authed) instanceof ProductFeedConnector);
  });
});
