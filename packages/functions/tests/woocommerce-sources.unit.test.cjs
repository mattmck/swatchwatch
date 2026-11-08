// WooCommerce Store API sources (brand sources plan, Task 16): Picture Polish pending, ILNP and
// KBShimmer known-blocked, all seeded disabled.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const { CONNECTOR_SOURCES_PENDING_APPROVAL, isRunnableProtocol, protocolOf } = require("../dist/lib/connectors/registry");
const { SUPPORTED_SOURCES } = require("../dist/lib/connectors/generated-types");
const { SHOPIFY_SOURCES_PENDING_APPROVAL } = require("../dist/lib/connectors/shopify-generic");
const { readSourceSettings } = require("../dist/lib/source-settings");

const REPO_ROOT = resolve(__dirname, "../../..");
const SEED_SQL = readFileSync(resolve(REPO_ROOT, "docs/seed_data_sources.sql"), "utf8");
const FILE = "20261108180000000_add-woocommerce-sources.sql";
const MIGRATION = readFileSync(resolve(__dirname, "../migrations", FILE), "utf8");

const SOURCES = {
  PicturePolishWooCommerce: { baseUrl: "https://picturepolish.com.au", brand: "Picture Polish", currency: "AUD", blocked: undefined },
  IlnpWooCommerce: { baseUrl: "https://ilnp.com", brand: "ILNP", currency: "USD", blocked: "robots" },
  KbshimmerWooCommerce: { baseUrl: "https://kbshimmer.com", brand: "KBShimmer", currency: "USD", blocked: "cloudflare" },
};

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

describe("WooCommerce sources", () => {
  for (const [name, expected] of Object.entries(SOURCES)) {
    it(`${name} is a supported WooCommerce source, seeded disabled and pending`, () => {
      assert.ok(SUPPORTED_SOURCES.includes(name));
      assert.equal(protocolOf(name), "WooCommerce");
      assert.equal(isRunnableProtocol("WooCommerce"), true);
      assert.equal(CONNECTOR_SOURCES_PENDING_APPROVAL.has(name), true);
      assert.equal(SHOPIFY_SOURCES_PENDING_APPROVAL.has(name), false);
      const tuple = seedTuple(SEED_SQL, name);
      assert.ok(tuple.includes(`'${expected.baseUrl}',`), name);
      assert.match(tuple, /,\s*false,\s*'\{/, `${name} must be seeded disabled`);
      const meta = metadataOf(SEED_SQL, name);
      assert.equal(meta.pendingApproval, true);
      assert.equal(meta.kind, undefined, "a brand source");
      assert.equal(meta.brand, expected.brand);
      assert.equal(meta.currency, expected.currency);
      assert.equal(meta.blocked, expected.blocked);
      assert.match(meta.notes, new RegExp(`Acceptable use confirmed by <name, role> at ${expected.brand} on <date> via <channel>: <summary>`));
      const settings = readSourceSettings(meta, name);
      assert.equal(settings.kind, "brand");
      assert.equal(settings.brand, expected.brand);
    });
  }

  it("Picture Polish records the 2026-11-08 Store API probe and unread terms", () => {
    const meta = metadataOf(SEED_SQL, "PicturePolishWooCommerce");
    assert.equal(meta.verification.storeApi, true);
    assert.equal(meta.verification.termsScrapingClause, null);
    assert.match(meta.notes, /answered 200/);
    assert.match(meta.notes, /Terms: not read yet/);
  });

  it("the migration inserts the seed's metadata plus its stamp, insert-only, and its Down reverts only the stamped rows", () => {
    const at = MIGRATION.search(/^\s*--[\s-]*down\s+migration/im);
    const up = MIGRATION.slice(0, at);
    const down = MIGRATION.slice(at);
    const id = FILE.split("_")[0];
    assert.ok(id > "20261108170000000", "after the OPI sitemap migration");
    for (const name of Object.keys(SOURCES)) {
      const fromMigration = metadataOf(MIGRATION, name);
      assert.equal(fromMigration.insertedByMigration, id, name);
      delete fromMigration.insertedByMigration;
      assert.deepEqual(fromMigration, metadataOf(SEED_SQL, name), name);
      assert.equal(seedTuple(MIGRATION, name).replace(/'\{.*$/s, ""), seedTuple(SEED_SQL, name).replace(/'\{.*$/s, ""), name);
      assert.ok(down.includes(`'${name}'`), name);
    }
    assert.match(up, /ON CONFLICT \(name\) DO NOTHING/);
    assert.doesNotMatch(up, /DO UPDATE/);
    assert.match(down, new RegExp(`metadata->>'insertedByMigration' = '${id}'\\s+AND NOT EXISTS`));
  });
});
