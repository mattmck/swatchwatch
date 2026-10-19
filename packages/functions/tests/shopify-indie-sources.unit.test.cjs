const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { resolve } = require("node:path");

const {
  ShopifyGenericConnector,
  SHOPIFY_SOURCE_BASE_URLS,
  SHOPIFY_SOURCES_PENDING_APPROVAL,
  isShopifySourceEnabledByDefault,
  resolveShopifyVendor,
} = require("../dist/lib/connectors/shopify-generic");
const { SUPPORTED_SOURCES } = require("../dist/lib/connectors/generated-types");

const REPO_ROOT = resolve(__dirname, "../../..");
const SEED_SQL = readFileSync(resolve(REPO_ROOT, "docs/seed_data_sources.sql"), "utf8");
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

/** The VALUES tuple for `name` in a data_source INSERT, as raw SQL text. */
function seedTuple(sql, name) {
  const start = sql.indexOf(`'${name}',`);
  assert.notEqual(start, -1, `${name} missing`);
  return sql.slice(start, sql.indexOf("::jsonb", start));
}

describe("indie Shopify sources pending approval (#273)", () => {
  it("are supported generic Shopify sources with an explicit base URL", () => {
    assert.ok(SHOPIFY_SOURCES_PENDING_APPROVAL.size > 0);
    for (const source of SHOPIFY_SOURCES_PENDING_APPROVAL) {
      assert.ok(SUPPORTED_SOURCES.includes(source), `${source} not in generated SUPPORTED_SOURCES`);
      assert.match(SHOPIFY_SOURCE_BASE_URLS[source] ?? "", /^https:\/\//, `${source} has no base URL`);
    }
  });

  it("are auto-provisioned disabled while existing sources stay enabled", () => {
    for (const source of SHOPIFY_SOURCES_PENDING_APPROVAL) {
      assert.equal(isShopifySourceEnabledByDefault(source), false, source);
    }
    assert.equal(isShopifySourceEnabledByDefault("MooncatShopify"), true);
    assert.equal(isShopifySourceEnabledByDefault("DamNailPolishShopify"), true);
  });

  it("enables approved sources: Night Owl Lacquer (decision D2)", () => {
    assert.equal(SHOPIFY_SOURCES_PENDING_APPROVAL.has("NightOwlLacquerShopify"), false);
    assert.equal(isShopifySourceEnabledByDefault("NightOwlLacquerShopify"), true);
    const tuple = seedTuple(SEED_SQL, "NightOwlLacquerShopify");
    assert.match(tuple, /,\s*true,\s*'\{/, "NightOwlLacquerShopify must be seeded enabled");
    assert.doesNotMatch(tuple, /"pendingApproval"/);
  });

  it("are seeded disabled, with verification notes, in docs/seed_data_sources.sql", () => {
    for (const source of SHOPIFY_SOURCES_PENDING_APPROVAL) {
      const tuple = seedTuple(SEED_SQL, source);
      assert.match(tuple, /,\s*false,\s*'\{/, `${source} must be seeded with enabled=false`);
      assert.match(tuple, /Verified \d{4}-\d{2}-\d{2}/, `${source} notes must record the verification`);
      assert.match(tuple, /"pendingApproval": true/, source);
    }
  });

  it("are inserted disabled by a migration", () => {
    const ups = readdirSync(MIGRATIONS_DIR)
      .filter((file) => /_add-(?:more-)?indie-shopify-sources\.sql$/.test(file))
      .map((file) => readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"))
      .map((migration) => migration.slice(0, migration.indexOf("-- Down Migration")));
    assert.ok(ups.length > 0, "indie Shopify sources migration missing");
    for (const up of ups) {
      assert.match(up, /enabled\s+=\s+false/, "an existing row must be disabled on conflict");
    }
    for (const source of SHOPIFY_SOURCES_PENDING_APPROVAL) {
      const up = ups.find((sql) => sql.includes(`'${source}',`));
      assert.ok(up, `${source} is inserted by no indie Shopify sources migration`);
      assert.match(seedTuple(up, source), /,\s*false,\s*'\{/, `${source} must be inserted with enabled=false`);
    }
  });

  it("registers the 2026-10-18 survey candidates (#273) pending approval", () => {
    const expected = {
      EmilyDeMollyShopify: "https://emilydemolly.com",
      CirqueColorsShopify: "https://cirquecolors.com",
    };
    for (const [source, baseUrl] of Object.entries(expected)) {
      assert.equal(SHOPIFY_SOURCE_BASE_URLS[source], baseUrl, source);
      assert.equal(SHOPIFY_SOURCES_PENDING_APPROVAL.has(source), true, source);
      assert.equal(isShopifySourceEnabledByDefault(source), false, source);
      // Shopify's default ToS forbids spidering/scraping: the note must say so.
      assert.match(seedTuple(SEED_SQL, source), /spider, crawl, or scrape/, source);
    }
    assert.equal(SHOPIFY_SOURCES_PENDING_APPROVAL.has("PahlishShopify"), true);
  });
});

describe("resolveShopifyVendor", () => {
  it("keeps a real vendor", () => {
    assert.equal(resolveShopifyVendor("Night Owl Lacquer", "Fallback"), "Night Owl Lacquer");
  });

  it("falls back to the source brand for missing or placeholder vendors", () => {
    for (const vendor of [null, undefined, "", "  ", "vendor-unknown", "Vendor-Unknown", "Default Vendor"]) {
      assert.equal(resolveShopifyVendor(vendor, "Night Owl Lacquer"), "Night Owl Lacquer", String(vendor));
    }
  });
});

describe("generic Shopify connector with a placeholder vendor", () => {
  let originalFetch;
  let originalEndpoint;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_ENDPOINT; // keep color-name detection offline
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          products: [
            {
              id: 1,
              title: "Seance Wine",
              handle: "seance-wine",
              vendor: "vendor-unknown",
              product_type: "Polish",
              tags: ["Fall", "Halloween"],
              published_at: "2026-10-01T00:00:00Z",
              variants: [{ id: 11, title: "Default Title", option1: "Default Title" }],
              images: [],
            },
          ],
        }),
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEndpoint !== undefined) process.env.AZURE_OPENAI_ENDPOINT = originalEndpoint;
  });

  it("uses the brand derived from the source name", async () => {
    const result = await new ShopifyGenericConnector("NightOwlLacquerShopify").pullProducts({
      searchTerm: "",
      page: 1,
      pageSize: 50,
      maxRecords: 50,
    });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].normalized.brand, "Night Owl Lacquer");
    assert.equal(result.records[0].normalized.productUrl, "https://nightowllacquer.com/products/seance-wine");
  });
});
