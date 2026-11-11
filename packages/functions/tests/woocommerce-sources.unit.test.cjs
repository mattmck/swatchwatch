// WooCommerce Store API sources (brand sources plan, Task 16): ILNP and KBShimmer known-blocked and
// seeded disabled; Picture Polish registered pending, then enabled on 2026-11-10 by the owner's
// decision without a store OK (migration 20261110120000000;
// tests/enabled-brand-sources-2026-11-10.unit.test.cjs checks that migration).
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

// Enabled on 2026-11-10 by the owner's decision (no store OK); the rest stay pending.
const ENABLED = new Set(["PicturePolishWooCommerce"]);

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
    const enabled = ENABLED.has(name);
    it(`${name} is a supported WooCommerce source, seeded ${enabled ? "enabled (owner decision 2026-11-10)" : "disabled and pending"}`, () => {
      assert.ok(SUPPORTED_SOURCES.includes(name));
      assert.equal(protocolOf(name), "WooCommerce");
      assert.equal(isRunnableProtocol("WooCommerce"), true);
      assert.equal(CONNECTOR_SOURCES_PENDING_APPROVAL.has(name), !enabled);
      assert.equal(SHOPIFY_SOURCES_PENDING_APPROVAL.has(name), false);
      const tuple = seedTuple(SEED_SQL, name);
      assert.ok(tuple.includes(`'${expected.baseUrl}',`), name);
      assert.match(tuple, enabled ? /,\s*true,\s*'\{/ : /,\s*false,\s*'\{/, `${name} seeded ${enabled ? "enabled" : "disabled"}`);
      const meta = metadataOf(SEED_SQL, name);
      assert.equal(meta.pendingApproval, enabled ? undefined : true);
      assert.equal(meta.kind, undefined, "a brand source");
      assert.equal(meta.brand, expected.brand);
      assert.equal(meta.currency, expected.currency);
      assert.equal(meta.blocked, expected.blocked);
      if (enabled) {
        assert.match(meta.notes, /Enabled on 2026-11-10 by the owner's decision without a store OK; ask the maker for the record\./);
        assert.doesNotMatch(meta.notes, /Acceptable use confirmed/);
      } else {
        assert.match(meta.notes, new RegExp(`Acceptable use confirmed by <name, role> at ${expected.brand} on <date> via <channel>: <summary>`));
      }
      const settings = readSourceSettings(meta, name);
      assert.equal(settings.kind, "brand");
      assert.equal(settings.brand, expected.brand);
    });
  }

  it("Picture Polish records the 2026-11-08 Store API probe and the terms read on 2026-11-10", () => {
    const meta = metadataOf(SEED_SQL, "PicturePolishWooCommerce");
    assert.equal(meta.verification.storeApi, true);
    assert.equal(meta.verification.termsScrapingClause, true);
    assert.equal(meta.verification.termsCheckedAt, "2026-11-10");
    assert.equal(meta.verification.robotsTxt, "store-api-not-disallowed");
    assert.equal(typeof meta.verification.storeFilterPass, "number");
    assert.match(meta.notes, /answered 200/);
    assert.doesNotMatch(meta.notes, /Terms: not read yet|REGISTERED DISABLED AND PENDING/);
    assert.match(meta.notes, /https:\/\/picturepolish\.com\.au\/terms-conditions\//);
    assert.match(meta.notes, /data mining robots or other extraction tools/);
    assert.match(meta.notes, /prior written permission/);
    assert.match(meta.notes, /Linking our website is not permitted/);
    assert.match(meta.notes, /robots\.txt does not disallow \/wp-json\//);
    assert.match(meta.notes, /Enabled on 2026-11-10 by the owner's decision without a store OK; ask the maker for the record\./);
    assert.doesNotMatch(meta.notes, /Acceptable use confirmed/);
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
      const prefix = (sql) => seedTuple(sql, name).replace(/'\{.*$/s, "");
      if (ENABLED.has(name)) {
        // Inserted disabled and pending; the 2026-11-10 enable migration changed only enabled,
        // pendingApproval, notes and verification (checked in enabled-brand-sources-2026-11-10).
        const strip = ({ notes, verification, pendingApproval, ...rest }) => rest;
        assert.deepEqual(strip(fromMigration), strip(metadataOf(SEED_SQL, name)), name);
        assert.equal(prefix(MIGRATION), prefix(SEED_SQL).replace(/\btrue,(\s*)$/, "false,$1"), name);
      } else {
        assert.deepEqual(fromMigration, metadataOf(SEED_SQL, name), name);
        assert.equal(prefix(MIGRATION), prefix(SEED_SQL), name);
      }
      assert.ok(down.includes(`'${name}'`), name);
    }
    assert.match(up, /ON CONFLICT \(name\) DO NOTHING/);
    assert.doesNotMatch(up, /DO UPDATE/);
    assert.match(down, new RegExp(`metadata->>'insertedByMigration' = '${id}'\\s+AND NOT EXISTS`));
  });
});
