// WooCommerce Store API sources (brand sources plan, Task 16): Picture Polish registered pending,
// then enabled on 2026-11-10 by the owner's decision without a store OK (migration 20261110120000000;
// tests/enabled-brand-sources-2026-11-10.unit.test.cjs checks that migration). ILNP and KBShimmer
// registered known-blocked by 20261108180000000, then enabled on 2026-11-11 with the stores'
// temporary OK (20261111060000000: ILNP with robotsOverride, KBShimmer through the Bright Data Web
// Unlocker).
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
const ALLOW_FILE = "20261111060000000_allow-ilnp-kbshimmer-woocommerce.sql";
const ALLOW_MIGRATION = readFileSync(resolve(__dirname, "../migrations", ALLOW_FILE), "utf8");

// Enabled on 2026-11-10 by the owner's decision (no store OK).
const ENABLED = new Set(["PicturePolishWooCommerce"]);

// As registered by 20261108180000000.
const SOURCES = {
  PicturePolishWooCommerce: { baseUrl: "https://picturepolish.com.au", brand: "Picture Polish", currency: "AUD", blocked: undefined },
  IlnpWooCommerce: { baseUrl: "https://ilnp.com", brand: "ILNP", currency: "USD", blocked: "robots" },
  KbshimmerWooCommerce: { baseUrl: "https://kbshimmer.com", brand: "KBShimmer", currency: "USD", blocked: "cloudflare" },
};
// Enabled by 20261111060000000; the seed holds their enabled state.
const ALLOWED = {
  IlnpWooCommerce: { baseUrl: "https://www.ilnp.com", fetchVia: null, robotsOverride: true, blocked: "robots" },
  KbshimmerWooCommerce: { baseUrl: "https://www.kbshimmer.com", fetchVia: "brightdata-unlocker", robotsOverride: false, blocked: "cloudflare" },
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
  for (const name of Object.keys(SOURCES)) {
    it(`${name} is a supported WooCommerce source, no longer pending`, () => {
      assert.ok(SUPPORTED_SOURCES.includes(name));
      assert.equal(protocolOf(name), "WooCommerce");
      assert.equal(isRunnableProtocol("WooCommerce"), true);
      assert.equal(SHOPIFY_SOURCES_PENDING_APPROVAL.has(name), false);
      assert.equal(CONNECTOR_SOURCES_PENDING_APPROVAL.has(name), false);
    });
  }

  for (const [name, expected] of Object.entries(SOURCES).filter(([name]) => !(name in ALLOWED))) {
    const enabled = ENABLED.has(name);
    it(`${name} is seeded ${enabled ? "enabled (owner decision 2026-11-10)" : "disabled and pending"}`, () => {
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
    for (const [name, expected] of Object.entries(SOURCES)) {
      const fromMigration = metadataOf(MIGRATION, name);
      assert.equal(fromMigration.insertedByMigration, id, name);
      delete fromMigration.insertedByMigration;
      assert.ok(down.includes(`'${name}'`), name);
      assert.ok(seedTuple(MIGRATION, name).includes(`'${expected.baseUrl}',`), name);
      assert.equal(fromMigration.blocked, expected.blocked, name);
      if (name in ALLOWED) continue; // the seed holds the state after 20261111060000000
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
    }
    assert.match(up, /ON CONFLICT \(name\) DO NOTHING/);
    assert.doesNotMatch(up, /DO UPDATE/);
    assert.match(down, new RegExp(`metadata->>'insertedByMigration' = '${id}'\\s+AND NOT EXISTS`));
  });

  for (const [name, expected] of Object.entries(ALLOWED)) {
    it(`${name} is seeded enabled and unblocked, on its www host, with the temporary OK in the notes`, () => {
      const tuple = seedTuple(SEED_SQL, name);
      assert.ok(tuple.includes(`'${expected.baseUrl}',`), name);
      assert.match(tuple, /,\s*true,\s*'\{/, `${name} must be seeded enabled`);
      const meta = metadataOf(SEED_SQL, name);
      assert.equal(meta.pendingApproval, undefined);
      assert.equal(meta.blocked, undefined);
      assert.match(meta.notes, /Update 2026-11-11: acceptable use confirmed/);
      assert.match(meta.notes, /not recorded here yet/, "the missing who/how/until is called out");
      assert.equal(meta.permission.status, "granted");
      assert.equal(meta.permission.decidedAt, "2026-11-11");
      assert.equal(meta.permission.imagesGranted, true);
      const settings = readSourceSettings(meta, name);
      assert.equal(settings.fetchVia, expected.fetchVia);
      assert.equal(settings.robotsOverride !== null, expected.robotsOverride);
    });
  }

  it("the 2026-11-11 migration touches only still-blocked rows, and its Down restores only rows it changed", () => {
    const at = ALLOW_MIGRATION.search(/^\s*--[\s-]*down\s+migration/im);
    const up = ALLOW_MIGRATION.slice(0, at);
    const down = ALLOW_MIGRATION.slice(at);
    const id = ALLOW_FILE.split("_")[0];
    assert.ok(id > "20261108190000000", "after the Big Cartel migration");
    for (const [name, expected] of Object.entries(ALLOWED)) {
      assert.match(up, new RegExp(`WHERE name = '${name}'\\s+AND metadata->>'blocked' = '${expected.blocked}'`), name);
      assert.ok(up.includes(`base_url = '${expected.baseUrl}'`), name);
      assert.match(down, new RegExp(`WHERE name = '${name}'\\s+AND metadata->>'enabledByMigration' = '${id}'`), name);
      assert.ok(down.includes(`"blocked": "${expected.blocked}"`), name);
      assert.ok(down.includes(`base_url = '${SOURCES[name].baseUrl}'`), name);
    }
    assert.match(up, /'fetchVia', 'brightdata-unlocker'/);
    assert.match(up, /'robotsOverride', 'Temporary OK/);
    assert.equal((up.match(/'status', 'granted'/g) ?? []).length, 2, "both rows record a granted permission");
    assert.equal((down.match(/- 'permission'/g) ?? []).length, 2, "the Down removes it from both");
  });
});
