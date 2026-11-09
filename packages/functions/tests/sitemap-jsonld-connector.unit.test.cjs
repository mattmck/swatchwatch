// Sitemap + JSON-LD connector (brand sources plan, Task 15). Fixtures trimmed from the opi.com
// probe of 2026-11-08: tests/fixtures/opi-sitemap-sample.xml (10 of the sitemap's 1,898 URLs, 3
// matching the two product prefixes, real <lastmod> values) and opi-product-sample.html (the
// "Pink on Canvas" page reduced to its <head> JSON-LD script). Other pages are synthetic.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  SitemapJsonLdConnector,
  buildCrawledRecord,
  extractJsonLdProduct,
  gateCrawledPage,
  jsonLdImageUrls,
  parseJsonLdAvailability,
  parseSitemapXml,
} = require("../dist/lib/connectors/sitemap-jsonld");
const { ConnectorCheckpointSupersededError } = require("../dist/lib/connectors/types");
const { readSourceSettings } = require("../dist/lib/source-settings");

const FIXTURES = path.join(__dirname, "fixtures");
const SITEMAP = fs.readFileSync(path.join(FIXTURES, "opi-sitemap-sample.xml"), "utf8");
const PINK = fs.readFileSync(path.join(FIXTURES, "opi-product-sample.html"), "utf8");

const SITEMAP_URL = "https://www.opi.com/sitemap.xml";
const PREFIXES = ["https://www.opi.com/products/nail-lacquer-", "https://www.opi.com/products/infinite-shine-"];
const SETTINGS = readSourceSettings(
  { brand: "OPI", sitemapUrl: SITEMAP_URL, productUrlPrefixes: PREFIXES, currency: "USD" },
  "OpiSitemap"
);
const MARGIN = 20000;
const PULL = { searchTerm: "", page: 1, pageSize: 500, maxRecords: 500 };

const ldPage = (ld) => `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;

/** A fake clock: `sleep` and every fetch advance it, nothing waits for real. */
function fakeClock(start = 1_000_000) {
  const clock = { t: start, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
  return clock;
}

/** An in-memory durable cache with ETags, like lib/ingestion-catalog-cache. */
function memoryCache({ durable = true } = {}) {
  let stored = null;
  let counter = 0;
  const cache = {
    durable,
    saves: 0,
    load: async () => null,
    save: async () => {},
    loadCheckpoint: async () => (stored ? { value: JSON.parse(stored.json), etag: stored.etag } : null),
    saveCheckpoint: async (value, etag) => {
      if ((stored ? stored.etag : null) !== etag) throw new ConnectorCheckpointSupersededError();
      stored = { json: JSON.stringify(value), etag: `"${++counter}"` };
      cache.saves += 1;
    },
    /** Another invocation saved meanwhile. */
    moveEtag: () => {
      stored = { ...stored, etag: `"${++counter}"` };
    },
    peek: () => (stored ? JSON.parse(stored.json) : null),
  };
  return cache;
}

/**
 * Fetch stub: `routes` maps a URL to a body, or to `(attempt) => ({ status, body, latencyMs, headers })`.
 * Every request advances the clock by `latencyMs` (default `latency`) and is logged with its start.
 * robots.txt requests (one per crawling pull) go to `robotsLog` instead of `log`; without a route
 * they answer 404 (allow) at once, so the sitemap and page logs and timings stay readable.
 */
function stubFetch(clock, routes, { latency = 0, log = [], robotsLog = [] } = {}) {
  const attempts = new Map();
  const fetchImpl = async (url, init) => {
    const attempt = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, attempt);
    const robots = url.endsWith("/robots.txt");
    (robots ? robotsLog : log).push({ url, at: clock.t, headers: init.headers });
    const route = routes[url];
    const answer =
      typeof route === "function"
        ? route(attempt)
        : route === undefined
          ? { status: 404, body: "", latencyMs: robots ? 0 : undefined }
          : { status: 200, body: route };
    clock.t += answer.latencyMs ?? latency;
    const headers = answer.headers ?? {};
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      statusText: "",
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => answer.body,
    };
  };
  return { fetchImpl, log, robotsLog };
}

function connector(clock, fetchImpl, options = {}) {
  return new SitemapJsonLdConnector("OpiSitemap", "https://www.opi.com", options.settings ?? SETTINGS, {
    sitemapUrl: SITEMAP_URL,
    productUrlPrefixes: PREFIXES,
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    saveMarginMs: MARGIN,
    ...options,
  });
}

const FLAME_URL = "https://www.opi.com/products/nail-lacquer-15-minutes-of-flame";
const SNOW_URL = "https://www.opi.com/products/infinite-shine-alpine-snow";
const PINK_URL = "https://www.opi.com/products/nail-lacquer-pink-on-canvas";

function fixtureRoutes() {
  return {
    [SITEMAP_URL]: SITEMAP,
    [PINK_URL]: PINK,
    // An @graph page whose Product title carries brand and line, with ImageObject images.
    [FLAME_URL]: ldPage({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "BreadcrumbList", itemListElement: [] },
        {
          "@type": "Product",
          name: "OPI Nail Lacquer - 15 Minutes of Flame",
          sku: "99350098460",
          gtin13: 4064665004243,
          brand: { "@type": "Brand", name: "OPI" },
          image: [
            { "@type": "ImageObject", url: "https://cdn.example/flame-1.jpg" },
            { "@type": "ImageObject", contentUrl: "https://cdn.example/flame-2.jpg" },
          ],
          offers: { "@type": "Offer", price: "11.99", priceCurrency: "USD", availability: "https://schema.org/OutOfStock" },
        },
      ],
    }),
    [SNOW_URL]: ldPage([
      { "@type": "Organization", name: "OPI" },
      {
        "@type": ["Product", "IndividualProduct"],
        name: "Alpine Snow",
        sku: "99350023478",
        brand: "OPI",
        image: { "@type": "ImageObject", url: "https://cdn.example/snow.jpg" },
        offers: [{ "@type": "Offer", price: 14.5, priceCurrency: "USD", availability: "PreOrder" }],
      },
    ]),
  };
}

describe("SitemapJsonLdConnector: fixtures", () => {
  it("crawls the prefix URLs only, paced 1 s apart, and builds the records", async () => {
    const clock = fakeClock();
    const { fetchImpl, log } = stubFetch(clock, fixtureRoutes(), { latency: 200 });
    const cache = memoryCache();
    const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 120000 });

    // The sitemap, then the three matching pages in sitemap order; nothing else.
    assert.deepEqual(log.map((entry) => entry.url), [SITEMAP_URL, PINK_URL, FLAME_URL, SNOW_URL]);
    for (let i = 1; i < log.length; i += 1) assert.ok(log[i].at - log[i - 1].at >= 1000, `request ${i} paced`);
    assert.match(log[0].headers["User-Agent"], /^SwatchWatch\/connector-ingestion/);

    assert.equal(result.metadata.catalogComplete, true);
    assert.equal(result.records.length, 3);
    // Newest lastmod first: Alpine Snow (10-23), 15 Minutes of Flame (09-19), Pink on Canvas (09-12).
    assert.deepEqual(result.records.map((record) => record.externalId), [
      "/products/infinite-shine-alpine-snow",
      "/products/nail-lacquer-15-minutes-of-flame",
      "/products/nail-lacquer-pink-on-canvas",
    ]);
    const byId = Object.fromEntries(result.records.map((record) => [record.externalId, record]));

    const pink = byId["/products/nail-lacquer-pink-on-canvas"];
    assert.equal(pink.gtin, "4064665004236");
    // The numeric SKU is the store's stock code, not a shade code: kept as sku, never vendorCode.
    assert.equal(pink.normalized.vendorCode, null);
    assert.equal(pink.normalized.sku, "99350098453");
    assert.equal(pink.normalized.brand, "OPI");
    assert.equal(pink.normalized.name, "(P)Ink on Canvas");
    assert.doesNotMatch(pink.normalized.name, /OPI Nail Lacquer -/);
    // The line comes from the matching URL prefix when the title has none.
    assert.equal(pink.normalized.productLine, "Nail Lacquer");
    assert.equal(pink.normalized.productType, "Nail Lacquer");
    // The saved page lists five images (the brief assumed one): all kept, the first is primary.
    assert.equal(pink.normalized.imageUrls.length, 5);
    assert.ok(pink.normalized.imageUrls.every((url) => typeof url === "string" && url.startsWith("https://cdn.shopify.com/")));
    assert.equal(pink.normalized.primaryImageUrl, pink.normalized.imageUrls[0]);
    assert.equal(pink.normalized.productUrl, PINK_URL);
    assert.equal(pink.normalized.price, "11.99");
    assert.equal(pink.normalized.currency, "USD");
    assert.equal(pink.normalized.available, true);
    assert.equal(pink.normalized.descriptionText, "A pastel crème blush nail polish for your own interpretation.");
    assert.equal(pink.normalized.kind, "brand");
    assert.deepEqual(pink.normalized.tags, []);
    assert.equal(pink.normalized.productCategory, "color");

    const flame = byId["/products/nail-lacquer-15-minutes-of-flame"];
    // Enterprise title: brand and line stripped, the line kept.
    assert.equal(flame.normalized.name, "15 Minutes of Flame");
    assert.equal(flame.normalized.productLine, "Nail Lacquer");
    assert.equal(flame.gtin, "4064665004243");
    assert.deepEqual(flame.normalized.imageUrls, ["https://cdn.example/flame-1.jpg", "https://cdn.example/flame-2.jpg"]);
    assert.equal(flame.normalized.primaryImageUrl, "https://cdn.example/flame-1.jpg");
    assert.equal(flame.normalized.available, false);

    const snow = byId["/products/infinite-shine-alpine-snow"];
    assert.equal(snow.normalized.productLine, "Infinite Shine");
    assert.deepEqual(snow.normalized.imageUrls, ["https://cdn.example/snow.jpg"]);
    assert.equal(snow.normalized.price, "14.50");
    assert.equal(snow.normalized.available, true);
    assert.equal(snow.gtin, null);

    // The complete catalog for listing freshness: every matching URL path.
    assert.deepEqual(result.catalog, {
      externalIds: [
        "/products/nail-lacquer-pink-on-canvas",
        "/products/nail-lacquer-15-minutes-of-flame",
        "/products/infinite-shine-alpine-snow",
      ],
      complete: true,
    });
    assert.equal(cache.peek().complete, true);
  });

  it("serves later pages from a complete checkpoint without any request or save", async () => {
    const clock = fakeClock();
    const cache = memoryCache();
    const first = stubFetch(clock, fixtureRoutes());
    await connector(clock, first.fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 120000 });
    const saves = cache.saves;

    const second = stubFetch(clock, fixtureRoutes());
    const page2 = await connector(clock, second.fetchImpl).pullProducts({ ...PULL, page: 2, pageSize: 2, catalogCache: cache });
    assert.equal(second.log.length, 0);
    assert.equal(cache.saves, saves);
    assert.deepEqual(page2.records.map((record) => record.externalId), ["/products/nail-lacquer-pink-on-canvas"]);
    assert.equal(page2.metadata.sourcePageCount, 2);
  });
});

function syntheticSitemap(count, prefix = PREFIXES[0]) {
  const urls = Array.from({ length: count }, (_, i) => `${prefix}shade-${i}`);
  const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((url, i) => `<url><loc>${url}</loc><lastmod>2026-10-${String((i % 28) + 1).padStart(2, "0")}</lastmod></url>`)
    .join("")}<url><loc>https://www.opi.com/products/files-x</loc></url></urlset>`;
  const routes = { [SITEMAP_URL]: xml };
  urls.forEach((url, i) => {
    routes[url] = ldPage({ "@type": "Product", name: `Shade ${i}`, brand: { name: "OPI" }, image: `https://cdn.example/${i}.jpg` });
  });
  return { urls, routes };
}

describe("SitemapJsonLdConnector: checkpointed crawl", () => {
  it("takes three calls for 400 URLs at 150 pages per call, fetching no URL twice", async () => {
    const clock = fakeClock();
    const { routes } = syntheticSitemap(400);
    const { fetchImpl, log } = stubFetch(clock, routes);
    const cache = memoryCache();
    const crawler = connector(clock, fetchImpl, { maxPagesPerRun: 150 });
    const results = [];
    for (let call = 0; call < 3; call += 1) {
      results.push(await crawler.pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000 }));
    }

    assert.deepEqual(results.map((result) => result.records.length), [0, 0, 400]);
    assert.deepEqual(results.map((result) => result.metadata.catalogComplete), [false, false, true]);
    assert.deepEqual(results.map((result) => result.metadata.crawledPages), [150, 300, 400]);
    assert.equal(results[0].metadata.totalPages, 400);
    assert.equal(results[0].catalog, undefined);
    assert.equal(results[1].catalog, undefined);
    assert.equal(results[2].catalog.externalIds.length, 400);
    assert.deepEqual(results.map((result) => result.metadata.checkpointGeneration), [1, 2, 3]);
    const urls = log.map((entry) => entry.url);
    assert.equal(new Set(urls).size, urls.length, "no URL fetched twice");
    assert.equal(urls.length, 401);
  });

  it("refuses to crawl without a durable cache, before any request", async () => {
    const clock = fakeClock();
    const { fetchImpl, log } = stubFetch(clock, fixtureRoutes());
    const crawler = connector(clock, fetchImpl);
    await assert.rejects(
      crawler.pullProducts({ ...PULL, catalogCache: memoryCache({ durable: false }), deadlineMs: clock.t + 120000 }),
      /SitemapJsonLd needs a durable catalog cache \(CONNECTOR_RAW_CONTAINER\)/
    );
    await assert.rejects(
      crawler.pullProducts({ ...PULL, deadlineMs: clock.t + 120000 }),
      /SitemapJsonLd needs a durable catalog cache/
    );
    // A Shopify-style cache without the checkpoint pair is not enough either.
    await assert.rejects(
      crawler.pullProducts({ ...PULL, catalogCache: { load: async () => null, save: async () => {} }, deadlineMs: clock.t + 120000 }),
      /durable catalog cache/
    );
    assert.equal(log.length, 0);
  });

  it("throws before any request when the deadline leaves less than 5 s before the margin", async () => {
    const clock = fakeClock();
    const { fetchImpl, log } = stubFetch(clock, fixtureRoutes());
    await assert.rejects(
      connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: memoryCache(), deadlineMs: clock.t + 3000 }),
      /SitemapJsonLd: worker budget too small to fetch a page/
    );
    assert.equal(log.length, 0);
  });

  it("makes progress on a 30 s budget with 400 ms requests, then stops and saves", async () => {
    const clock = fakeClock();
    const { routes } = syntheticSitemap(50);
    const { fetchImpl, log } = stubFetch(clock, routes, { latency: 400 });
    const cache = memoryCache();
    const deadlineMs = clock.t + 30000;
    const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs });

    assert.equal(result.metadata.catalogComplete, false);
    assert.ok(result.metadata.crawledPages >= 1, "at least one page");
    assert.ok(clock.t <= deadlineMs - MARGIN, "stopped before the save margin");
    assert.equal(cache.peek().urls.length, 50);
    assert.equal(Object.keys(cache.peek().pages).length, result.metadata.crawledPages);
    assert.equal(log.length, 1 + result.metadata.crawledPages);
  });

  /** A saved checkpoint with discovery done and these URLs still to fetch. */
  async function seededCache(urls) {
    const cache = memoryCache();
    await cache.saveCheckpoint(
      {
        discovery: { rootRead: true, children: [], done: [] },
        urls: urls.map((url) => ({ url, lastmod: null })),
        pages: {},
        complete: false,
        generation: 1,
      },
      null
    );
    return cache;
  }

  it("does not retry a page whose first attempt fails 3 s before the margin; it stays unfetched", async () => {
    const clock = fakeClock();
    const url = `${PREFIXES[0]}flaky`;
    const { fetchImpl, log } = stubFetch(clock, { [url]: () => ({ status: 503, body: "", latencyMs: 5000 }) });
    const cache = await seededCache([url]);
    const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + MARGIN + 8000 });

    assert.equal(log.length, 1);
    assert.equal(result.metadata.catalogComplete, false);
    assert.equal(result.metadata.crawledPages, 0);
    assert.deepEqual(cache.peek().pages, {});
    assert.equal(cache.peek().generation, 2);
  });

  it("fetches exactly one page when a 3 s request leaves too little time for a second", async () => {
    const clock = fakeClock();
    const urls = [`${PREFIXES[0]}one`, `${PREFIXES[0]}two`];
    const routes = Object.fromEntries(urls.map((url) => [url, ldPage({ "@type": "Product", name: "X", brand: "OPI" })]));
    const { fetchImpl, log } = stubFetch(clock, routes, { latency: 3000 });
    const cache = await seededCache(urls);
    const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 27000 });

    assert.deepEqual(log.map((entry) => entry.url), [urls[0]]);
    assert.equal(result.metadata.crawledPages, 1);
    assert.deepEqual(Object.keys(cache.peek().pages), [urls[0]]);
  });

  it("checkpoints sitemap-index discovery and resumes with the unread child only", async () => {
    const clock = fakeClock();
    const children = [1, 2, 3].map((n) => `https://www.opi.com/sitemap-products-${n}.xml`);
    const routes = {
      [SITEMAP_URL]: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children
        .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
        .join("")}</sitemapindex>`,
    };
    children.forEach((child, n) => {
      const url = `${PREFIXES[0]}child-${n}`;
      routes[child] = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url}</loc></url><url><loc>${PREFIXES[0]}child-0</loc></url></urlset>`;
      routes[url] = ldPage({ "@type": "Product", name: `Child ${n}`, brand: "OPI" });
    });
    const { fetchImpl, log } = stubFetch(clock, routes, { latency: 3000 });
    const cache = memoryCache();
    // 12 s before the margin: robots.txt (0 s), the index (1–4 s, paced), child 1 (4–7 s), child 2
    // (7–10 s); child 3 would start with 2 s left.
    const first = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + MARGIN + 12000 });
    assert.equal(first.metadata.catalogComplete, false);
    assert.deepEqual(cache.peek().discovery, { rootRead: true, children, done: children.slice(0, 2), foreignSkipped: 0 });
    assert.deepEqual(log.map((entry) => entry.url), [SITEMAP_URL, children[0], children[1]]);

    log.length = 0;
    const second = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000 });
    assert.deepEqual(log.map((entry) => entry.url), [children[2], `${PREFIXES[0]}child-0`, `${PREFIXES[0]}child-1`, `${PREFIXES[0]}child-2`]);
    assert.equal(second.metadata.catalogComplete, true);
    // The URL two children list is kept once.
    assert.equal(second.records.length, 3);
  });

  it("with the page limit at 300 and 400 ms pages, stops at the deadline minus the margin and resumes from the saved page", async () => {
    const clock = fakeClock();
    const { urls, routes } = syntheticSitemap(400);
    const { fetchImpl, log } = stubFetch(clock, routes, { latency: 400 });
    const cache = memoryCache();
    const deadlineMs = clock.t + 30000;
    const first = await connector(clock, fetchImpl, { maxPagesPerRun: 300 }).pullProducts({ ...PULL, catalogCache: cache, deadlineMs });

    const stopAt = deadlineMs - MARGIN;
    assert.equal(first.metadata.catalogComplete, false);
    assert.ok(first.metadata.crawledPages < 300, "the deadline, not the page limit, stopped it");
    assert.ok(log[log.length - 1].at <= stopAt - 5000, "no request started with less than 5 s left");
    assert.ok(clock.t <= stopAt);
    const fetched = first.metadata.crawledPages;
    assert.deepEqual(Object.keys(cache.peek().pages), urls.slice(0, fetched));

    log.length = 0;
    await connector(clock, fetchImpl, { maxPagesPerRun: 300 }).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 30000 });
    assert.equal(log[0].url, urls[fetched]);
  });

  it("throws checkpoint superseded when another invocation saved first, keeping its checkpoint", async () => {
    const clock = fakeClock();
    const { routes } = syntheticSitemap(20);
    const { fetchImpl } = stubFetch(clock, routes);
    const cache = memoryCache();
    await connector(clock, fetchImpl, { maxPagesPerRun: 10 }).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000 });
    const before = cache.peek();

    // The stale pull reads the checkpoint, then a newer continuation saves while it crawls.
    const realLoad = cache.loadCheckpoint;
    cache.loadCheckpoint = async () => {
      const loaded = await realLoad();
      cache.moveEtag();
      return loaded;
    };
    await assert.rejects(
      connector(clock, fetchImpl, { maxPagesPerRun: 10 }).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000 }),
      (error) => error instanceof ConnectorCheckpointSupersededError && /SitemapJsonLd checkpoint superseded/.test(error.message)
    );
    assert.deepEqual(cache.peek(), before);
  });

  it("gives up on a page left unanswered in three pulls; the crawl completes without it", async () => {
    const clock = fakeClock();
    const urls = [`${PREFIXES[0]}dead`, `${PREFIXES[0]}alive`];
    const routes = {
      // Each attempt eats the window: 6 s of a 503 leaves too little time for a retry.
      [urls[0]]: () => ({ status: 503, body: "", latencyMs: 6000 }),
      [urls[1]]: ldPage({ "@type": "Product", name: "Alive", brand: "OPI" }),
    };
    const { fetchImpl, log } = stubFetch(clock, routes);
    const cache = await seededCache(urls);
    const crawler = connector(clock, fetchImpl);
    const results = [];
    for (let pull = 0; pull < 3; pull += 1) {
      results.push(await crawler.pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + MARGIN + 10000 }));
    }
    assert.deepEqual(results.map((result) => result.metadata.catalogComplete), [false, false, false]);
    assert.deepEqual(cache.peek().attempts, {});
    assert.deepEqual(cache.peek().failed, [urls[0]]);
    assert.equal(urls[0] in cache.peek().pages, false);
    assert.equal(results[2].metadata.failedPages, 1);
    assert.equal(results[2].metadata.failedThisPull.length, 1);
    assert.equal(results[2].metadata.failedThisPull[0].url, urls[0]);
    assert.deepEqual(results[1].metadata.failedThisPull, []);

    const done = await crawler.pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000 });
    assert.equal(done.metadata.catalogComplete, true);
    assert.deepEqual(done.records.map((record) => record.externalId), ["/products/nail-lacquer-alive"]);
    // A failed page keeps its listing: it stays in the catalog ids.
    assert.deepEqual(done.catalog.externalIds, ["/products/nail-lacquer-dead", "/products/nail-lacquer-alive"]);
    assert.equal(log.filter((entry) => entry.url === urls[0]).length, 3, "never fetched after it failed");
  });

  it("gives up at once when the retries run out with time left, and moves on", async () => {
    const clock = fakeClock();
    const urls = [`${PREFIXES[0]}flaky`, `${PREFIXES[0]}fine`];
    const routes = {
      [urls[0]]: () => ({ status: 502, body: "" }),
      [urls[1]]: ldPage({ "@type": "Product", name: "Fine", brand: "OPI" }),
    };
    const { fetchImpl, log } = stubFetch(clock, routes);
    const cache = await seededCache(urls);
    const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000 });
    assert.equal(result.metadata.catalogComplete, true);
    assert.deepEqual(cache.peek().failed, [urls[0]]);
    assert.match(result.metadata.failedThisPull[0].reason, /HTTP 502/);
    assert.equal(log.filter((entry) => entry.url === urls[0]).length, 3, "the attempt plus two retries");
    assert.deepEqual(result.records.map((record) => record.externalId), ["/products/nail-lacquer-fine"]);
  });

  it("leaves a 404 page out of the catalog ids but keeps a failed one", async () => {
    const clock = fakeClock();
    const urls = [`${PREFIXES[0]}delisted`, `${PREFIXES[0]}flaky`, `${PREFIXES[0]}fine`];
    const routes = {
      [urls[0]]: () => ({ status: 404, body: "" }),
      [urls[1]]: () => ({ status: 500, body: "" }),
      [urls[2]]: ldPage({ "@type": "Product", name: "Fine", brand: "OPI" }),
    };
    const { fetchImpl } = stubFetch(clock, routes);
    const cache = await seededCache(urls);
    const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000 });
    assert.deepEqual(cache.peek().gone, [urls[0]]);
    assert.deepEqual(cache.peek().failed, [urls[1]]);
    assert.deepEqual(result.catalog.externalIds, ["/products/nail-lacquer-flaky", "/products/nail-lacquer-fine"]);
  });

  it("saves the discovery already done before rethrowing a fatal sitemap error", async () => {
    const clock = fakeClock();
    const children = ["https://www.opi.com/sitemap-1.xml", "https://www.opi.com/sitemap-2.xml"];
    const index = `<?xml version="1.0"?><sitemapindex>${children.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join("")}</sitemapindex>`;
    const routes = {
      [SITEMAP_URL]: index,
      [children[0]]: `<?xml version="1.0"?><urlset><url><loc>${PREFIXES[0]}one</loc></url></urlset>`,
    };
    const { fetchImpl: base } = stubFetch(clock, routes);
    const fetchImpl = async (url, init) => {
      if (url === children[1]) throw new TypeError("boom: invalid header value");
      return base(url, init);
    };
    const cache = memoryCache();
    await assert.rejects(
      connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000 }),
      /boom/
    );
    assert.equal(cache.peek().discovery.rootRead, true);
    assert.deepEqual(cache.peek().discovery.done, [children[0]]);
    assert.deepEqual(cache.peek().urls.map(({ url }) => url), [`${PREFIXES[0]}one`]);
    assert.equal(cache.peek().generation, 1);
    assert.equal(cache.peek().complete, false);
  });

  it("counts a page whose fetch throws (TypeError: terminated) as one attempt per pull, then records it as failed", async () => {
    const clock = fakeClock();
    const urls = [1, 2, 3].map((n) => `${PREFIXES[0]}page-${n}`);
    const routes = {
      [urls[0]]: ldPage({ "@type": "Product", name: "One", brand: "OPI" }),
      [urls[2]]: ldPage({ "@type": "Product", name: "Three", brand: "OPI" }),
    };
    const { fetchImpl: base, log } = stubFetch(clock, routes);
    let thrown = 0;
    const fetchImpl = async (url, init) => {
      if (url === urls[1]) {
        thrown += 1;
        log.push({ url, at: clock.t, headers: init.headers });
        throw new TypeError("terminated");
      }
      return base(url, init);
    };
    const cache = await seededCache(urls);
    const crawler = connector(clock, fetchImpl);
    const warnings = [];
    const pullLog = (level, message, data) => warnings.push({ level, message, data });
    const results = [];
    for (let pull = 0; pull < 3; pull += 1) {
      results.push(await crawler.pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000, log: pullLog }));
    }
    // The other pages are fetched in the first pull; the throwing one is tried once per pull.
    assert.deepEqual(results.map((result) => result.metadata.catalogComplete), [false, false, true]);
    assert.equal(thrown, 3);
    assert.deepEqual(Object.keys(cache.peek().pages).sort(), [urls[0], urls[2]].sort());
    assert.deepEqual(cache.peek().failed, [urls[1]]);
    assert.deepEqual(cache.peek().attempts, {});
    assert.deepEqual(results[2].records.map((record) => record.externalId), ["/products/nail-lacquer-page-1", "/products/nail-lacquer-page-3"]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, "warn");
    assert.match(warnings[0].message, /Crawl gave up on a page: .*page-2 \(.*terminated/);
  });

  it("gives up at once on a page whose URL is invalid", async () => {
    const clock = fakeClock();
    const urls = [`${PREFIXES[0]}bad`, `${PREFIXES[0]}fine`];
    const routes = { [urls[1]]: ldPage({ "@type": "Product", name: "Fine", brand: "OPI" }) };
    const { fetchImpl: base } = stubFetch(clock, routes);
    const fetchImpl = async (url, init) => {
      if (url === urls[0]) {
        const error = new TypeError("Invalid URL");
        error.code = "ERR_INVALID_URL";
        throw error;
      }
      return base(url, init);
    };
    const cache = await seededCache(urls);
    const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000 });
    assert.equal(result.metadata.catalogComplete, true);
    assert.deepEqual(cache.peek().failed, [urls[0]]);
    assert.match(result.metadata.failedThisPull[0].reason, /Invalid URL/);
  });

  it("logs a give-up through the pull's log when the pull later throws", async () => {
    const clock = fakeClock();
    const urls = [`${PREFIXES[0]}forbidden`, `${PREFIXES[0]}fine`];
    const routes = {
      [urls[0]]: () => ({ status: 403, body: "" }),
      [urls[1]]: ldPage({ "@type": "Product", name: "Fine", brand: "OPI" }),
    };
    const { fetchImpl } = stubFetch(clock, routes);
    const cache = await seededCache(urls);
    cache.saveCheckpoint = async () => {
      throw new Error("blob storage unavailable");
    };
    const warnings = [];
    await assert.rejects(
      connector(clock, fetchImpl).pullProducts({
        ...PULL,
        catalogCache: cache,
        deadlineMs: clock.t + 10_000_000,
        log: (level, message, data) => warnings.push({ level, message, data }),
      }),
      /blob storage unavailable/
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, "warn");
    assert.equal(warnings[0].data.url, urls[0]);
    assert.match(warnings[0].data.reason, /HTTP 403/);
  });

  it("records a page that answers 404 as fetched with nothing on it", async () => {
    const clock = fakeClock();
    const { routes, urls } = syntheticSitemap(2);
    delete routes[urls[1]];
    const { fetchImpl, log } = stubFetch(clock, routes);
    const cache = memoryCache();
    const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 120000 });
    assert.equal(log.length, 3);
    assert.equal(result.metadata.catalogComplete, true);
    assert.equal(result.records.length, 1);
    assert.equal(result.metadata.pagesWithoutProduct, 1);
    assert.equal(cache.peek().pages[urls[1]], null);
  });
});

describe("SitemapJsonLdConnector: politeness and trust", () => {
  /** A saved checkpoint with discovery done and these URLs still to fetch. */
  async function seeded(urls) {
    const cache = memoryCache();
    await cache.saveCheckpoint(
      {
        discovery: { rootRead: true, children: [], done: [] },
        urls: urls.map((url) => ({ url, lastmod: null })),
        pages: {},
        complete: false,
        generation: 1,
      },
      null
    );
    return cache;
  }

  it("stops the pull after 10 consecutive page failures, saving the checkpoint first, and fails", async () => {
    const clock = fakeClock();
    const urls = Array.from({ length: 30 }, (_, i) => `${PREFIXES[0]}blocked-${i}`);
    const routes = Object.fromEntries(urls.map((url) => [url, () => ({ status: 403, body: "" })]));
    const { fetchImpl, log } = stubFetch(clock, routes);
    const cache = await seeded(urls);
    await assert.rejects(
      connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000 }),
      /^Error: SitemapJsonLd: 10 consecutive page failures \(status 403\), stopping$/
    );
    assert.equal(log.length, 10, "10 page requests, then the pull stopped");
    assert.equal(cache.peek().generation, 2, "the checkpoint was saved before the error");
    assert.deepEqual(cache.peek().failed, urls.slice(0, 10));
    assert.equal(cache.peek().complete, false);
  });

  it("an answered page resets the consecutive-failure count", async () => {
    const clock = fakeClock();
    const urls = Array.from({ length: 19 }, (_, i) => `${PREFIXES[0]}mixed-${i}`);
    const routes = Object.fromEntries(urls.map((url) => [url, () => ({ status: 403, body: "" })]));
    routes[urls[9]] = ldPage({ "@type": "Product", name: "Fine", brand: "OPI" });
    const { fetchImpl } = stubFetch(clock, routes);
    const cache = await seeded(urls);
    const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000 });
    assert.equal(result.metadata.catalogComplete, true);
    assert.equal(cache.peek().failed.length, 18);
  });

  it("waits Retry-After before retrying a 429 when it fits before the margin", async () => {
    const clock = fakeClock();
    const url = `${PREFIXES[0]}busy`;
    const routes = {
      [url]: (attempt) =>
        attempt === 1
          ? { status: 429, body: "", headers: { "retry-after": "2" } }
          : { status: 200, body: ldPage({ "@type": "Product", name: "Busy", brand: "OPI" }) },
    };
    const { fetchImpl, log } = stubFetch(clock, routes);
    const cache = await seeded([url]);
    const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 10_000_000 });
    assert.deepEqual(log.map((entry) => entry.url), [url, url]);
    assert.equal(log[1].at - log[0].at, 2000, "retried 2 s later (Retry-After), not after the 1 s backoff");
    assert.equal(result.records.length, 1);
  });

  it("defers the page when Retry-After does not fit before the margin", async () => {
    const clock = fakeClock();
    const url = `${PREFIXES[0]}busy`;
    const routes = { [url]: () => ({ status: 429, body: "", headers: { "retry-after": "120" } }) };
    const { fetchImpl, log } = stubFetch(clock, routes);
    const cache = await seeded([url]);
    const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + MARGIN + 60000 });
    assert.equal(log.length, 1, "no retry inside this pull");
    assert.equal(result.metadata.catalogComplete, false);
    assert.equal(cache.peek().attempts[url], 1);
  });

  it("reads robots.txt once per crawling pull and refuses when it disallows a product prefix", async () => {
    for (const body of ["User-agent: *\nDisallow: /products/\n", "User-agent: SwatchWatch\nDisallow: /\n"]) {
      const clock = fakeClock();
      const routes = { ...fixtureRoutes(), "https://www.opi.com/robots.txt": body };
      const { fetchImpl, log, robotsLog } = stubFetch(clock, routes);
      await assert.rejects(
        connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: memoryCache(), deadlineMs: clock.t + 120000 }),
        /^Error: SitemapJsonLd disallowed by robots\.txt$/
      );
      assert.deepEqual(robotsLog.map((entry) => entry.url), ["https://www.opi.com/robots.txt"]);
      assert.equal(log.length, 0, "no sitemap or product request");
    }
  });

  it("crawls when robots.txt allows the prefixes or is missing (4xx)", async () => {
    for (const robots of ["User-agent: *\nDisallow: /account/\n", { status: 403 }]) {
      const clock = fakeClock();
      const routes = {
        ...fixtureRoutes(),
        "https://www.opi.com/robots.txt": typeof robots === "string" ? robots : () => ({ status: robots.status, body: "" }),
      };
      const { fetchImpl, robotsLog } = stubFetch(clock, routes);
      const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: memoryCache(), deadlineMs: clock.t + 120000 });
      assert.equal(robotsLog.length, 1);
      assert.equal(result.records.length, 3);
    }
  });

  it("skips child sitemaps on another origin and counts them", async () => {
    const clock = fakeClock();
    const own = "https://www.opi.com/sitemap-products-1.xml";
    const foreign = ["https://evil.example/sitemap.xml", "http://www.opi.com/sitemap-products-2.xml"];
    const routes = {
      [SITEMAP_URL]: `<?xml version="1.0"?><sitemapindex>${[own, ...foreign]
        .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
        .join("")}</sitemapindex>`,
      [own]: `<urlset><url><loc>${PREFIXES[0]}own</loc></url></urlset>`,
      [`${PREFIXES[0]}own`]: ldPage({ "@type": "Product", name: "Own", brand: "OPI" }),
    };
    const { fetchImpl, log } = stubFetch(clock, routes);
    const cache = memoryCache();
    const result = await connector(clock, fetchImpl).pullProducts({ ...PULL, catalogCache: cache, deadlineMs: clock.t + 120000 });
    assert.deepEqual(log.map((entry) => entry.url), [SITEMAP_URL, own, `${PREFIXES[0]}own`]);
    assert.equal(result.metadata.foreignSitemapsSkipped, 2);
    assert.deepEqual(cache.peek().discovery.children, [own]);
    assert.equal(result.records.length, 1);
  });

  it("uses the crawled URL as productUrl, never the page's JSON-LD url", () => {
    const outcome = gateCrawledPage(
      {
        url: `${PREFIXES[0]}honest`,
        lastmod: null,
        product: { "@type": "Product", name: "Honest", brand: "OPI", url: "https://phish.example/buy" },
      },
      SETTINGS,
      PREFIXES
    );
    assert.equal(outcome.accept, true);
    assert.equal(buildCrawledRecord(outcome.gated, SETTINGS).record.normalized.productUrl, `${PREFIXES[0]}honest`);
  });

  it("maps the JSON-LD brand through metadata.vendorAliases; a retailer page without a brand is vendorless", () => {
    const aliased = readSourceSettings(
      { sitemapUrl: SITEMAP_URL, productUrlPrefixes: PREFIXES, vendorAliases: { "piCture pOlish": "Picture Polish" } },
      "ShopSitemap"
    );
    const page = (brand) => ({ url: `${PREFIXES[0]}atomic`, lastmod: null, product: { "@type": "Product", name: "Atomic", ...(brand ? { brand } : {}) } });
    const outcome = gateCrawledPage(page({ name: "piCture pOlish" }), aliased, PREFIXES);
    assert.equal(outcome.accept, true);
    assert.equal(outcome.gated.brand, "Picture Polish");

    const retailer = readSourceSettings({ kind: "retailer", sitemapUrl: SITEMAP_URL, productUrlPrefixes: PREFIXES }, "ShopSitemap");
    assert.deepEqual(gateCrawledPage(page(null), retailer, PREFIXES), { accept: false, vendorless: true });
  });
});

describe("sitemap + JSON-LD vendor codes", () => {
  const page = (name) => ({
    url: "https://shop.example/products/nail-lacquer-big-apple-red",
    lastmod: null,
    product: { "@type": "Product", name, brand: { name: "OPI" }, sku: "RET-55501" },
  });
  const vendorCode = (name, settings) => {
    const outcome = gateCrawledPage(page(name), settings, ["https://shop.example/products/nail-lacquer-"]);
    assert.equal(outcome.accept, true);
    return buildCrawledRecord(outcome.gated, settings).record.normalized.vendorCode;
  };

  it("retailer/feed: vendorCode is only the #CODE parsed from the title, never the store SKU", () => {
    for (const kind of ["retailer", "feed"]) {
      const settings = readSourceSettings({ kind, sitemapUrl: SITEMAP_URL, productUrlPrefixes: PREFIXES }, "ShopSitemap");
      assert.equal(vendorCode("OPI - Big Apple Red #NLN25", settings), "NLN25");
      assert.equal(vendorCode("OPI - Big Apple Red", settings), null);
    }
  });

  it("brand mode: only the title #CODE too; the numeric SKU stays in sku", () => {
    assert.equal(vendorCode("OPI - Big Apple Red #NLN25", SETTINGS), "NLN25");
    assert.equal(vendorCode("OPI - Big Apple Red", SETTINGS), null);
  });
});

describe("sitemap + JSON-LD helpers", () => {
  it("parseSitemapXml reads a urlset and an index", () => {
    const urlset = parseSitemapXml(SITEMAP);
    assert.equal(urlset.kind, "urlset");
    assert.equal(urlset.entries.length, 10);
    assert.deepEqual(urlset.entries[1], { url: PINK_URL, lastmod: "2026-09-12T20:07:58.713Z" });
    const index = parseSitemapXml('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://x.example/a.xml</loc></sitemap></sitemapindex>');
    assert.deepEqual(index, { kind: "index", entries: [{ url: "https://x.example/a.xml", lastmod: null }] });
    assert.throws(() => parseSitemapXml("<html></html>"), /neither a <urlset> nor a <sitemapindex>/);
  });

  it("extractJsonLdProduct finds the Product past broken blocks and other types", () => {
    const html = `<script type="application/ld+json">{ broken</script><script type='application/ld+json'>{"@type":"WebSite"}</script>${ldPage({ "@graph": [{ "@type": "Product", name: "G" }] })}`;
    assert.equal(extractJsonLdProduct(html).name, "G");
    assert.equal(extractJsonLdProduct("<html></html>"), null);
    assert.equal(extractJsonLdProduct(PINK).gtin, "4064665004236");
  });

  it("jsonLdImageUrls normalizes strings, ImageObjects and arrays of either", () => {
    assert.deepEqual(jsonLdImageUrls("https://a/1.jpg"), ["https://a/1.jpg"]);
    assert.deepEqual(jsonLdImageUrls([{ url: "https://a/1.jpg" }, { contentUrl: "https://a/2.jpg" }, "https://a/1.jpg"]), ["https://a/1.jpg", "https://a/2.jpg"]);
    assert.deepEqual(jsonLdImageUrls(undefined), []);
  });

  it("parseJsonLdAvailability maps schema.org values", () => {
    assert.equal(parseJsonLdAvailability("https://schema.org/InStock"), true);
    assert.equal(parseJsonLdAvailability("PreOrder"), true);
    assert.equal(parseJsonLdAvailability("http://schema.org/OutOfStock"), false);
    assert.equal(parseJsonLdAvailability("BackOrder"), false);
    assert.equal(parseJsonLdAvailability("Mystery"), null);
    assert.equal(parseJsonLdAvailability(undefined), null);
  });
});
