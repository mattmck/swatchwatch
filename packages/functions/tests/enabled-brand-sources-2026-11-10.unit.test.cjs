// Picture Polish (WooCommerce), Painted Polish and Potion Polish (Big Cartel): registered disabled
// and pending on 2026-11-08, enabled on 2026-11-10 by the owner's decision WITHOUT a store OK
// (docs/decisions-2026-10.md D27). The enable migration must only touch rows still pending, stamp
// them so its Down reverts exactly what Up changed, and leave the seed equal to "insert migration,
// then enable migration".
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const { CONNECTOR_SOURCES_PENDING_APPROVAL } = require("../dist/lib/connectors/registry");
const { SHOPIFY_STORE_PRODUCT_FILTERS } = require("../dist/lib/connectors/store-filters");
const { SHOPIFY_STORE_TITLE_PARSERS } = require("../dist/lib/connectors/shopify-title");

const REPO_ROOT = resolve(__dirname, "../../..");
const SEED_SQL = readFileSync(resolve(REPO_ROOT, "docs/seed_data_sources.sql"), "utf8");
const MIGRATIONS = resolve(__dirname, "../migrations");
const FILE = "20261110120000000_enable-picture-painted-potion-polish-sources.sql";
const MIGRATION = readFileSync(resolve(MIGRATIONS, FILE), "utf8");
const ID = FILE.split("_")[0];

/** The migration that inserted each row disabled and pending. */
const INSERTED_BY = {
  PicturePolishWooCommerce: "20261108180000000_add-woocommerce-sources.sql",
  PaintedPolishBigCartel: "20261108190000000_add-big-cartel-sources.sql",
  PotionPolishBigCartel: "20261108190000000_add-big-cartel-sources.sql",
};
const ENABLED = Object.keys(INSERTED_BY);
const STILL_PENDING = ["OpiSitemap", "IlnpWooCommerce", "KbshimmerWooCommerce", "ColoresDeCarolBigCartel", "GlistenAndGlowBigCartel", "PoetryCowgirlBigCartel"];
const DECISION = "Enabled on 2026-11-10 by the owner's decision without a store OK; ask the maker for the record.";

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

const at = MIGRATION.search(/^\s*--[\s-]*down\s+migration/im);
const UP = MIGRATION.slice(0, at).replace(/^\s*--.*$/gm, "");
const DOWN = MIGRATION.slice(at).replace(/^\s*--.*$/gm, "");

/** Every UPDATE statement of a section (a statement ends with ";" at the end of a line: notes contain "; "). */
const updates = (sql) => sql.match(/UPDATE data_source[\s\S]*?;$/gm) ?? [];

/** The Up UPDATE statement for one row. */
function upStatement(name) {
  const statements = updates(UP).filter((statement) => statement.includes(`'${name}'`));
  assert.equal(statements.length, 1, `one Up UPDATE for ${name}`);
  return statements[0];
}

/** The JSON object literals (`'{…}'::jsonb`) of a statement, parsed; `{}` skipped. */
function jsonLiterals(statement) {
  return [...statement.matchAll(/'(\{(?:[^']|'')*\})'::jsonb/g)]
    .map((match) => JSON.parse(match[1].replace(/''/g, "'")))
    .filter((value) => Object.keys(value).length > 0);
}

describe("enable migration 20261110120000000 (owner decision, no store OK)", () => {
  it("runs after the Big Cartel registrations and has a Down section", () => {
    assert.ok(ID > "20261108190000000");
    assert.ok(at > 0, "-- Down Migration");
    assert.match(FILE, /^\d{17}_[a-z0-9-]+\.sql$/);
  });

  for (const name of ENABLED) {
    it(`${name}: Up enables only a still-pending row, stamps it and keeps what it replaced`, () => {
      const statement = upStatement(name);
      assert.match(statement, /SET enabled = true/);
      assert.match(statement, new RegExp(`WHERE name = '${name}'\\s+AND metadata->>'pendingApproval' = 'true'`));
      assert.match(statement, /\(metadata - 'pendingApproval'\)/);
      assert.match(statement, new RegExp(`'enabledByMigration', '${ID}'`));
      assert.match(statement, /'preEnableMetadata', jsonb_build_object\('notes', metadata->'notes', 'verification', metadata->'verification'\)/);
    });

    it(`${name}: insert migration + enable migration = the seed row (enabled, no pendingApproval)`, () => {
      const inserted = metadataOf(readFileSync(resolve(MIGRATIONS, INSERTED_BY[name]), "utf8"), name);
      delete inserted.insertedByMigration;
      const literals = jsonLiterals(upStatement(name));
      const notes = literals.find((value) => "notes" in value);
      const patch = literals.find((value) => !("notes" in value));
      assert.ok(notes && patch, "a verification patch and a notes object");
      const { pendingApproval, ...rest } = inserted;
      assert.equal(pendingApproval, true);
      const expected = { ...rest, verification: { ...inserted.verification, ...patch }, notes: notes.notes };
      assert.deepEqual(expected, metadataOf(SEED_SQL, name));
      assert.match(seedTuple(SEED_SQL, name), /,\s*true,\s*'\{/);
    });

    it(`${name}: the note records the decision, never a confirmation`, () => {
      const { notes } = metadataOf(SEED_SQL, name);
      assert.ok(notes.endsWith(DECISION) || notes.includes(`${DECISION} `), notes);
      assert.doesNotMatch(notes, /Acceptable use confirmed/);
      assert.doesNotMatch(notes, /REGISTERED DISABLED AND PENDING|Terms: not read yet/);
    });

    it(`${name}: is no longer pending and has a store filter and a title parser`, () => {
      assert.equal(CONNECTOR_SOURCES_PENDING_APPROVAL.has(name), false);
      assert.equal(typeof SHOPIFY_STORE_PRODUCT_FILTERS[name], "function");
      assert.equal(typeof SHOPIFY_STORE_TITLE_PARSERS[name], "function");
    });
  }

  it("Down disables, restores pendingApproval, notes and verification, and drops the stamps, only on rows Up stamped", () => {
    const statements = updates(DOWN);
    assert.equal(statements.length, 1);
    const [statement] = statements;
    assert.match(statement, /SET enabled = false/);
    for (const name of ENABLED) assert.ok(statement.includes(`'${name}'`), name);
    assert.match(statement, new RegExp(`AND metadata->>'enabledByMigration' = '${ID}'`));
    assert.match(statement, /- 'enabledByMigration'/);
    assert.match(statement, /- 'preEnableMetadata'/);
    assert.match(statement, /'notes', metadata->'preEnableMetadata'->'notes'/);
    assert.match(statement, /'verification', metadata->'preEnableMetadata'->'verification'/);
    assert.match(statement, /'\{"pendingApproval": true\}'::jsonb/);
  });

  it("touches no other source, and the other non-Shopify registrations stay pending", () => {
    for (const name of STILL_PENDING) {
      assert.ok(!MIGRATION.includes(`'${name}'`), name);
      assert.equal(CONNECTOR_SOURCES_PENDING_APPROVAL.has(name), true, name);
      assert.equal(metadataOf(SEED_SQL, name).pendingApproval, true, name);
    }
    assert.doesNotMatch(UP, /INSERT|DELETE/);
    assert.equal((UP.match(/UPDATE data_source/g) ?? []).length, ENABLED.length);
  });
});
