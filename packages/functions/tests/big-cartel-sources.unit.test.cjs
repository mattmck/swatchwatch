// Big Cartel sources (brand sources plan, Task 17): five brand stores registered disabled and
// pending, and PotionPolishShopify's notes pointing at its Big Cartel replacement. Painted Polish and
// Potion Polish were enabled on 2026-11-10 by the owner's decision without a store OK (migration
// 20261110120000000; tests/enabled-brand-sources-2026-11-10.unit.test.cjs checks that migration).
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
const FILE = "20261108190000000_add-big-cartel-sources.sql";
const MIGRATION = readFileSync(resolve(__dirname, "../migrations", FILE), "utf8");

// Enabled on 2026-11-10 by the owner's decision (no store OK); the rest stay pending.
const ENABLED = new Set(["PaintedPolishBigCartel", "PotionPolishBigCartel"]);

const SOURCES = {
  PaintedPolishBigCartel: { baseUrl: "https://paintedpolish.com", brand: "Painted Polish", subdomain: "paintedpolish" },
  PotionPolishBigCartel: { baseUrl: "https://www.potionpolish.com", brand: "Potion Polish", subdomain: "potionpolish" },
  ColoresDeCarolBigCartel: { baseUrl: "https://coloresdecarol.com", brand: "Colores de Carol", subdomain: "coloresdecarol" },
  GlistenAndGlowBigCartel: { baseUrl: "https://glistenandglow.com", brand: "Glisten & Glow", subdomain: "glistenandglow" },
  PoetryCowgirlBigCartel: {
    baseUrl: "https://poetrycowgirlnailpolish.com",
    brand: "Poetry Cowgirl Nail Polish",
    subdomain: "poetrycowgirlnailpolish",
  },
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

describe("Big Cartel sources", () => {
  for (const [name, expected] of Object.entries(SOURCES)) {
    const enabled = ENABLED.has(name);
    it(`${name} is a supported Big Cartel source, seeded ${enabled ? "enabled (owner decision 2026-11-10)" : "disabled and pending"} with a brand and a subdomain`, () => {
      assert.ok(SUPPORTED_SOURCES.includes(name));
      assert.equal(protocolOf(name), "BigCartel");
      assert.equal(isRunnableProtocol("BigCartel"), true);
      assert.equal(CONNECTOR_SOURCES_PENDING_APPROVAL.has(name), !enabled);
      assert.equal(SHOPIFY_SOURCES_PENDING_APPROVAL.has(name), false);
      const tuple = seedTuple(SEED_SQL, name);
      assert.ok(tuple.includes(`'${expected.baseUrl}',`), name);
      assert.match(tuple, enabled ? /,\s*true,\s*'\{/ : /,\s*false,\s*'\{/, `${name} seeded ${enabled ? "enabled" : "disabled"}`);
      const meta = metadataOf(SEED_SQL, name);
      assert.equal(meta.pendingApproval, enabled ? undefined : true);
      assert.equal(meta.kind, undefined, "a brand source");
      assert.equal(meta.brand, expected.brand);
      assert.equal(meta.subdomain, expected.subdomain);
      assert.equal(meta.verification.productsJson, true);
      assert.equal(meta.verification.productsJsonUrl, `https://api.bigcartel.com/${expected.subdomain}/products.json`);
      assert.match(meta.notes, /API License Agreement/);
      if (enabled) {
        // Nobody confirmed anything: the note records the owner's decision and the licence facts.
        assert.match(meta.notes, /Enabled on 2026-11-10 by the owner's decision without a store OK; ask the maker for the record\.$/);
        assert.doesNotMatch(meta.notes, /Acceptable use confirmed/);
        assert.doesNotMatch(meta.notes, /REGISTERED DISABLED AND PENDING|Terms: not read yet/);
        assert.match(meta.notes, /https:\/\/www\.bigcartel\.com\/resources\/help\/article\/api-license-agreement/);
        assert.match(meta.notes, /more than six hours older/);
        assert.match(meta.notes, /create a database by downloading and storing the Content/);
        assert.match(meta.notes, /does not meet those terms/);
        assert.match(meta.notes, /404 at \/terms and \/terms-and-conditions/);
        assert.match(meta.notes, /answered 200 with \d+ products/, "the 2026-11-08 probe facts stay");
        assert.equal(meta.verification.termsCheckedAt, "2026-11-10");
        assert.equal(meta.verification.storeTermsFound, false);
        assert.equal(typeof meta.verification.storeFilterPass, "number");
      } else {
        assert.match(
          meta.notes,
          new RegExp(`Acceptable use confirmed by <name, role> at ${expected.brand} on <date> via <channel>: <summary>`)
        );
      }
      const settings = readSourceSettings(meta, name);
      assert.equal(settings.kind, "brand");
      assert.equal(settings.brand, expected.brand);
      assert.equal(settings.subdomain, expected.subdomain);
    });
  }

  it("PotionPolishShopify stays disabled and is marked superseded in the seed", () => {
    const tuple = seedTuple(SEED_SQL, "PotionPolishShopify");
    assert.match(tuple, /,\s*false,\s*'\{/);
    assert.match(metadataOf(SEED_SQL, "PotionPolishShopify").notes, /Superseded by PotionPolishBigCartel\.$/);
  });

  it("the migration inserts the seed's metadata plus its stamp, insert-only, and its Down reverts only the stamped rows", () => {
    const at = MIGRATION.search(/^\s*--[\s-]*down\s+migration/im);
    const up = MIGRATION.slice(0, at);
    const down = MIGRATION.slice(at);
    const id = FILE.split("_")[0];
    assert.ok(id > "20261108180000000", "after the WooCommerce migration");
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

  it("the migration's only UPDATE of an existing row is PotionPolishShopify's note, guarded and reversible", () => {
    const at = MIGRATION.search(/^\s*--[\s-]*down\s+migration/im);
    const up = MIGRATION.slice(0, at).replace(/^\s*--.*$/gm, "");
    const down = MIGRATION.slice(at);
    const updates = up.match(/UPDATE data_source[\s\S]*?;/g) ?? [];
    assert.equal(updates.length, 1);
    assert.match(updates[0], /jsonb_set\(\s*metadata,\s*'\{notes\}'/);
    assert.match(updates[0], /' Superseded by PotionPolishBigCartel\.'/);
    assert.match(updates[0], /WHERE name = 'PotionPolishShopify'\s+AND COALESCE\(metadata->>'notes', ''\) NOT LIKE '%Superseded by PotionPolishBigCartel%'/);
    assert.doesNotMatch(updates[0], /enabled/);
    assert.match(down, /replace\(metadata->>'notes', ' Superseded by PotionPolishBigCartel\.', ''\)/);
    assert.match(down, /WHERE name = 'PotionPolishShopify'\s+AND metadata->>'notesUpdatedByMigration' = '20261108190000000'/);
  });
});
