/**
 * "Buy from brand" links (#267): URL validation and deterministic selection.
 * Runs without a database (query functions are injected).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeBuyUrl,
  applyAffiliateParams,
  selectBuyFromBrandUrl,
  selectBuyUrlsByShade,
  loadBuyUrlsForShades,
  withBuyUrls,
  selectBuyFromBrandLink,
  selectBuyLinksByShade,
  loadBuyLinksForShades,
  buyLinkFields,
  recordShadeSourceProduct,
  BUY_LINK_CANDIDATES_SQL,
  MAX_BUY_URL_LENGTH,
} = require("../dist/lib/buy-link");

describe("sanitizeBuyUrl", () => {
  it("accepts absolute http and https URLs", () => {
    assert.equal(
      sanitizeBuyUrl("https://www.holotaco.com/products/blurple"),
      "https://www.holotaco.com/products/blurple"
    );
    assert.equal(sanitizeBuyUrl("http://example.com/p?x=1#y"), "http://example.com/p?x=1#y");
  });

  it("normalizes scheme/host case and trims surrounding whitespace", () => {
    assert.equal(sanitizeBuyUrl("  HTTPS://Shop.Example.COM/products/a  "), "https://shop.example.com/products/a");
    assert.equal(sanitizeBuyUrl("https://example.com"), "https://example.com/");
  });

  for (const [label, value] of [
    ["javascript: scheme", "javascript:alert(1)"],
    ["javascript: with mixed case", "JaVaScRiPt:alert(document.cookie)"],
    ["javascript: with leading space", " javascript:alert(1)"],
    ["javascript: split by a newline", "java\nscript:alert(1)"],
    ["javascript: disguised with a tab", "\tjavascript:alert(1)//https://x.com"],
    ["data: URL", "data:text/html,<script>alert(1)</script>"],
    ["vbscript: URL", "vbscript:msgbox(1)"],
    ["file: URL", "file:///etc/passwd"],
    ["ftp: URL", "ftp://example.com/file"],
    ["mailto: URL", "mailto:shop@example.com"],
    ["relative path", "/products/blurple"],
    ["protocol-relative URL", "//evil.example/products"],
    ["scheme without slashes", "https:evil.example/products"],
    ["missing host", "https://"],
    ["username", "https://user@example.com/products/a"],
    ["username and password", "https://user:secret@example.com/products/a"],
    ["empty password", "https://user:@example.com/"],
    ["embedded space", "https://example.com/a b"],
    ["embedded newline", "https://example.com/a\nb"],
    ["embedded NUL", "https://example.com/a\u0000b"],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["over-long URL", `https://example.com/${"a".repeat(MAX_BUY_URL_LENGTH)}`],
  ]) {
    it(`rejects ${label}`, () => {
      assert.equal(sanitizeBuyUrl(value), null);
    });
  }

  it("rejects non-strings", () => {
    for (const value of [null, undefined, 42, {}, ["https://example.com"], new URL("https://example.com")]) {
      assert.equal(sanitizeBuyUrl(value), null);
    }
  });
});

describe("applyAffiliateParams", () => {
  it("adds no affiliate parameters today", () => {
    const url = "https://example.com/products/a?variant=1";
    assert.equal(applyAffiliateParams(url), url);
  });
});

const T = (iso) => new Date(iso);

describe("selectBuyFromBrandUrl", () => {
  const base = {
    shadeId: "1",
    sourceEnabled: true,
    lastSeenAt: T("2026-10-01T00:00:00Z"),
    fetchedAt: T("2026-10-01T00:00:00Z"),
    externalProductId: "10",
  };

  it("returns null when there are no candidates or none is valid", () => {
    assert.equal(selectBuyFromBrandUrl([]), null);
    assert.equal(
      selectBuyFromBrandUrl([
        { ...base, url: "javascript:alert(1)" },
        { ...base, url: null },
        { ...base, url: "https://u:p@example.com/" },
      ]),
      null
    );
  });

  it("prefers an enabled source over a more recently seen disabled one", () => {
    const enabled = { ...base, url: "https://enabled.example/p", lastSeenAt: T("2026-01-01T00:00:00Z") };
    const disabled = {
      ...base,
      url: "https://disabled.example/p",
      sourceEnabled: false,
      lastSeenAt: T("2026-10-10T00:00:00Z"),
    };
    assert.equal(selectBuyFromBrandUrl([disabled, enabled]), "https://enabled.example/p");
  });

  it("falls back to a disabled source when it is the only valid one", () => {
    assert.equal(
      selectBuyFromBrandUrl([
        { ...base, url: "javascript:alert(1)" },
        { ...base, url: "https://disabled.example/p", sourceEnabled: false },
      ]),
      "https://disabled.example/p"
    );
  });

  it("then prefers the most recently seen link (Date or ISO string)", () => {
    const older = { ...base, url: "https://old.example/p", lastSeenAt: "2026-09-01T00:00:00Z", externalProductId: "99" };
    const newer = { ...base, url: "https://new.example/p", lastSeenAt: T("2026-10-05T00:00:00Z"), externalProductId: "1" };
    assert.equal(selectBuyFromBrandUrl([older, newer]), "https://new.example/p");
    assert.equal(selectBuyFromBrandUrl([newer, older]), "https://new.example/p");
  });

  it("then the most recently fetched product, then the highest product id", () => {
    const a = { ...base, url: "https://a.example/p", fetchedAt: T("2026-10-02T00:00:00Z"), externalProductId: "1" };
    const b = { ...base, url: "https://b.example/p", fetchedAt: T("2026-10-03T00:00:00Z"), externalProductId: "2" };
    assert.equal(selectBuyFromBrandUrl([a, b]), "https://b.example/p");

    const c = { ...base, url: "https://c.example/p", externalProductId: "7" };
    const d = { ...base, url: "https://d.example/p", externalProductId: 12 };
    assert.equal(selectBuyFromBrandUrl([c, d]), "https://d.example/p");
    assert.equal(selectBuyFromBrandUrl([d, c]), "https://d.example/p");
  });

  it("skips an invalid best candidate in favour of the next valid one", () => {
    const bestButUnsafe = { ...base, url: "javascript:alert(1)", lastSeenAt: T("2026-10-16T00:00:00Z") };
    const next = { ...base, url: "https://ok.example/p", lastSeenAt: T("2026-10-01T00:00:00Z") };
    assert.equal(selectBuyFromBrandUrl([bestButUnsafe, next]), "https://ok.example/p");
  });

  it("is independent of input order", () => {
    const candidates = [
      { ...base, url: "https://one.example/p", externalProductId: "1" },
      { ...base, url: "https://two.example/p", externalProductId: "2", lastSeenAt: T("2026-10-02T00:00:00Z") },
      { ...base, url: "https://three.example/p", externalProductId: "3", sourceEnabled: false, lastSeenAt: T("2026-10-09T00:00:00Z") },
      { ...base, url: "https://four.example/p", externalProductId: "4" },
    ];
    const expected = "https://two.example/p";
    for (let i = 0; i < 6; i++) {
      const shuffled = candidates.slice(i % 4).concat(candidates.slice(0, i % 4));
      if (i % 2) shuffled.reverse();
      assert.equal(selectBuyFromBrandUrl(shuffled), expected);
    }
  });
});

describe("selectBuyUrlsByShade", () => {
  it("selects one URL per shade and omits shades without a valid URL", () => {
    const map = selectBuyUrlsByShade([
      { shadeId: "1", url: "https://a.example/1", sourceEnabled: true, lastSeenAt: null, externalProductId: "1" },
      { shadeId: "1", url: "https://a.example/2", sourceEnabled: true, lastSeenAt: null, externalProductId: "2" },
      { shadeId: "2", url: "javascript:alert(1)", sourceEnabled: true, lastSeenAt: null, externalProductId: "3" },
      { shadeId: 3, url: "http://c.example/", sourceEnabled: true, lastSeenAt: null, externalProductId: "4" },
    ]);
    assert.deepEqual(Object.fromEntries(map), {
      "1": "https://a.example/2",
      "3": "http://c.example/",
    });
  });
});

describe("loadBuyUrlsForShades", () => {
  it("queries the link table once with deduplicated, valid shade ids", async () => {
    const calls = [];
    const queryFn = async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: [
          { shadeId: "5", url: "https://shop.example/products/x", sourceEnabled: true, lastSeenAt: null, externalProductId: "1" },
        ],
      };
    };
    const map = await loadBuyUrlsForShades(["5", 5, "abc", null, "-1", "0", "6"], queryFn);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sql, BUY_LINK_CANDIDATES_SQL);
    assert.deepEqual(calls[0].params, [["5", "6"]]);
    assert.match(calls[0].sql, /FROM shade_source_product/);
    assert.match(calls[0].sql, /ds\.enabled/);
    assert.deepEqual(Object.fromEntries(map), { "5": "https://shop.example/products/x" });
  });

  it("skips the query when there are no shade ids", async () => {
    let called = false;
    const map = await loadBuyUrlsForShades([], async () => {
      called = true;
      return { rows: [] };
    });
    assert.equal(called, false);
    assert.equal(map.size, 0);
  });

  it("never throws: a failed lookup yields no links", async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const map = await loadBuyUrlsForShades(["1"], async () => {
        throw new Error('relation "shade_source_product" does not exist');
      });
      assert.equal(map.size, 0);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("withBuyUrls", () => {
  it("sets buyUrl only on rows that have a valid link", async () => {
    const rows = [{ id: "1", name: "A" }, { id: "2", name: "B" }];
    const result = await withBuyUrls(rows, (row) => row.id, async () => ({
      rows: [
        { shadeId: "1", url: "https://brand.example/a", sourceEnabled: true, lastSeenAt: null, externalProductId: "1" },
        { shadeId: "2", url: "javascript:alert(1)", sourceEnabled: true, lastSeenAt: null, externalProductId: "2" },
      ],
    }));
    assert.deepEqual(result, [
      { id: "1", name: "A", buyUrl: "https://brand.example/a" },
      { id: "2", name: "B" },
    ]);
    assert.ok(!("buyUrl" in result[1]), "rows without a link must not carry a buyUrl key");
    assert.ok(!("buyUrl" in rows[0]), "input rows are not mutated");
  });
});

describe("buy link prices", () => {
  const base = { shadeId: "7", sourceEnabled: true, lastSeenAt: "2026-10-20T00:00:00Z", fetchedAt: "2026-10-21T12:00:00Z" };

  it("carries the chosen product's price, currency and fetch time", () => {
    assert.deepEqual(
      selectBuyFromBrandLink([{ ...base, url: "https://brand.example/a", externalProductId: "1", price: "12.5", currency: "usd" }]),
      { url: "https://brand.example/a", price: 12.5, currency: "USD", priceSeenAt: "2026-10-21T12:00:00.000Z" }
    );
  });

  it("never mixes in a runner-up's price: the chosen product without a price gives no price", () => {
    const link = selectBuyFromBrandLink([
      { ...base, url: "https://brand.example/new", externalProductId: "2", price: null, currency: null },
      { ...base, lastSeenAt: "2026-01-01T00:00:00Z", url: "https://brand.example/old", externalProductId: "1", price: "9.00", currency: "USD" },
    ]);
    assert.deepEqual(link, { url: "https://brand.example/new" });
  });

  it("drops the price without a valid currency or with a junk amount", () => {
    for (const [price, currency] of [["12.00", null], ["12.00", "$"], ["0", "USD"], ["abc", "USD"], [null, "USD"]]) {
      const link = selectBuyFromBrandLink([{ ...base, url: "https://brand.example/a", externalProductId: "1", price, currency }]);
      assert.deepEqual(link, { url: "https://brand.example/a" }, `${price} ${currency}`);
    }
  });

  it("omits priceSeenAt when the fetch time is unknown", () => {
    const link = selectBuyFromBrandLink([{ ...base, fetchedAt: null, url: "https://brand.example/a", externalProductId: "1", price: "3", currency: "EUR" }]);
    assert.deepEqual(link, { url: "https://brand.example/a", price: 3, currency: "EUR" });
  });

  it("selectBuyLinksByShade / loadBuyLinksForShades return links per shade", async () => {
    const rows = [{ ...base, url: "https://brand.example/a", externalProductId: "1", price: "4.00", currency: "CAD" }];
    assert.equal(selectBuyLinksByShade(rows).get("7").price, 4);
    let sql = "";
    const links = await loadBuyLinksForShades(["7"], async (text) => {
      sql = text;
      return { rows };
    });
    assert.equal(links.get("7").currency, "CAD");
    assert.match(sql, /normalized_json ->> 'price'/);
    assert.match(sql, /normalized_json ->> 'currency'/);
  });

  it("buyLinkFields maps a link to response fields, with no keys when there is none", () => {
    assert.deepEqual(buyLinkFields(null), {});
    assert.deepEqual(buyLinkFields({ url: "https://b.example/" }), { buyUrl: "https://b.example/" });
    assert.deepEqual(buyLinkFields({ url: "https://b.example/", price: 9, currency: "USD", priceSeenAt: "2026-10-21T00:00:00.000Z" }), {
      buyUrl: "https://b.example/",
      buyPrice: 9,
      buyCurrency: "USD",
      buyPriceSeenAt: "2026-10-21T00:00:00.000Z",
    });
  });

  it("withBuyUrls adds the price fields next to buyUrl", async () => {
    const result = await withBuyUrls([{ id: "7" }], (row) => row.id, async () => ({
      rows: [{ ...base, url: "https://brand.example/a", externalProductId: "1", price: "11.00", currency: "GBP" }],
    }));
    assert.deepEqual(result, [
      { id: "7", buyUrl: "https://brand.example/a", buyPrice: 11, buyCurrency: "GBP", buyPriceSeenAt: "2026-10-21T12:00:00.000Z" },
    ]);
  });
});

describe("recordShadeSourceProduct", () => {
  it("upserts the shade ↔ product link by (data source, external id) and bumps last_seen_at", async () => {
    const calls = [];
    const client = { query: async (sql, params) => calls.push({ sql, params }) };
    await recordShadeSourceProduct(client, 42, 3, "  gid://shopify/Product/1 ");
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO shade_source_product/);
    assert.match(calls[0].sql, /ep\.data_source_id = \$2\s+AND ep\.external_id = \$3/);
    assert.match(calls[0].sql, /ON CONFLICT \(shade_id, external_product_id\)\s+DO UPDATE SET last_seen_at = now\(\)/);
    assert.deepEqual(calls[0].params, [42, 3, "gid://shopify/Product/1"]);
  });

  it("is a no-op without an external id", async () => {
    const calls = [];
    const client = { query: async (sql, params) => calls.push({ sql, params }) };
    await recordShadeSourceProduct(client, 42, 3, "  ");
    await recordShadeSourceProduct(client, 42, 3, null);
    assert.equal(calls.length, 0);
  });
});
