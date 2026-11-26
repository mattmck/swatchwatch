// Sitemap + JSON-LD sources (brand sources plan, Task 15): OPI is registered disabled and pending.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const { CONNECTOR_SOURCES_PENDING_APPROVAL, protocolOf } = require("../dist/lib/connectors/registry");
const { SUPPORTED_SOURCES } = require("../dist/lib/connectors/generated-types");
const { SHOPIFY_SOURCES_PENDING_APPROVAL } = require("../dist/lib/connectors/shopify-generic");
const { readSourceSettings } = require("../dist/lib/source-settings");

const REPO_ROOT = resolve(__dirname, "../../..");
const SEED_SQL = readFileSync(resolve(REPO_ROOT, "docs/seed_data_sources.sql"), "utf8");
const FILE = "20261108170000000_add-opi-sitemap-source.sql";
const MIGRATION = readFileSync(resolve(__dirname, "../migrations", FILE), "utf8");

function seedTuple(sql, name) {
  const start = sql.indexOf(`'${name}',`);
  assert.notEqual(start, -1, `${name} missing`);
  return sql.slice(start, sql.indexOf("::jsonb", start));
}

const metadataOf = (sql, name) => {
  const tuple = seedTuple(sql, name);
  const literal = tuple.slice(tuple.indexOf("'{"), tuple.lastIndexOf("}'") + 1);
  return JSON.parse(literal.slice(1).replace(/''/g, "'"));
};

describe("OpiSitemap source", () => {
  it("is a supported SitemapJsonLd source, pending, seeded disabled with the crawl settings", () => {
    assert.ok(SUPPORTED_SOURCES.includes("OpiSitemap"));
    assert.equal(protocolOf("OpiSitemap"), "SitemapJsonLd");
    assert.equal(CONNECTOR_SOURCES_PENDING_APPROVAL.has("OpiSitemap"), true);
    assert.equal(SHOPIFY_SOURCES_PENDING_APPROVAL.has("OpiSitemap"), false);
    const tuple = seedTuple(SEED_SQL, "OpiSitemap");
    assert.match(tuple, /'https:\/\/www\.opi\.com',/);
    assert.match(tuple, /,\s*false,\s*'\{/, "OpiSitemap must be seeded disabled");
    const meta = metadataOf(SEED_SQL, "OpiSitemap");
    assert.equal(meta.pendingApproval, true);
    assert.equal(meta.kind, undefined, "a brand source");
    assert.equal(meta.brand, "OPI");
    assert.equal(meta.currency, "USD");
    assert.equal(meta.verification.termsScrapingClause, null);
    assert.equal(meta.verification.sitemap, true);
    assert.match(meta.notes, /no terms page at \/terms-of-use on 2026-11-08/);
    assert.match(meta.notes, /Acceptable use confirmed by <name, role> at OPI on <date> via <channel>: <summary>/);
    const settings = readSourceSettings(meta, "OpiSitemap");
    assert.equal(settings.kind, "brand");
    assert.equal(settings.sitemapUrl, "https://www.opi.com/sitemap.xml");
    assert.deepEqual(settings.productUrlPrefixes, [
      "https://www.opi.com/products/nail-lacquer-",
      "https://www.opi.com/products/infinite-shine-",
    ]);
  });

  it("every non-Shopify pending source is seeded disabled and pending", () => {
    for (const source of CONNECTOR_SOURCES_PENDING_APPROVAL) {
      assert.ok(SUPPORTED_SOURCES.includes(source), source);
      assert.match(seedTuple(SEED_SQL, source), /,\s*false,\s*'\{/, source);
      assert.equal(metadataOf(SEED_SQL, source).pendingApproval, true, source);
    }
  });

  it("the migration inserts the seed's metadata plus its stamp, insert-only, and its Down reverts only the stamped row", () => {
    const at = MIGRATION.search(/^\s*--[\s-]*down\s+migration/im);
    const up = MIGRATION.slice(0, at);
    const down = MIGRATION.slice(at);
    const id = FILE.split("_")[0];
    const fromMigration = metadataOf(MIGRATION, "OpiSitemap");
    assert.equal(fromMigration.insertedByMigration, id);
    delete fromMigration.insertedByMigration;
    assert.deepEqual(fromMigration, metadataOf(SEED_SQL, "OpiSitemap"));
    assert.equal(seedTuple(MIGRATION, "OpiSitemap").replace(/'\{.*$/s, ""), seedTuple(SEED_SQL, "OpiSitemap").replace(/'\{.*$/s, ""));
    assert.match(up, /ON CONFLICT \(name\) DO NOTHING/);
    assert.doesNotMatch(up, /DO UPDATE/);
    assert.ok(down.includes("'OpiSitemap'"));
    assert.match(down, new RegExp(`metadata->>'insertedByMigration' = '${id}'\\s+AND NOT EXISTS`));
  });
});
