/**
 * Admin Sources tab: migration 20261111120000000_admin-sources-brands, docs/schema.sql and the
 * shared ADMIN_AUDIT_ACTIONS list must agree (no database needed).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ADMIN_AUDIT_ACTIONS } = require("swatchwatch-shared");

const MIGRATION = fs.readFileSync(
  path.join(__dirname, "../migrations/20261111120000000_admin-sources-brands.sql"),
  "utf8",
);
const UP = MIGRATION.split("-- Down Migration")[0];
const SCHEMA = fs.readFileSync(path.join(__dirname, "../../../docs/schema.sql"), "utf8");

/** Quoted strings inside `CHECK (<column> IN (...))` of the named constraint or column. */
function quotedList(sql, anchorRegex) {
  const match = anchorRegex.exec(sql);
  assert.ok(match, `anchor ${anchorRegex} not found`);
  const rest = sql.slice(match.index);
  const open = rest.indexOf("IN (");
  assert.ok(open >= 0, "IN ( not found");
  const close = rest.indexOf("))", open);
  const body = rest.slice(open, close).replace(/--.*$/gm, "");
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe("sources admin migration", () => {
  it("audit CHECK in the migration, schema.sql and ADMIN_AUDIT_ACTIONS list the same actions", () => {
    const expected = [...ADMIN_AUDIT_ACTIONS].sort();
    assert.equal(expected.length, 14);
    const anchor = /admin_audit_event_action_check\s+CHECK/;
    assert.deepEqual(quotedList(UP, anchor).sort(), expected);
    assert.deepEqual(quotedList(SCHEMA, anchor).sort(), expected);
  });

  it("platform CHECK matches the seven platforms", () => {
    const expected = ["shopify", "woocommerce", "bigcartel", "custom", "feed", "none", "unknown"].sort();
    const anchor = /CHECK \(platform IN/;
    assert.deepEqual(quotedList(UP, anchor).sort(), expected);
    assert.deepEqual(quotedList(SCHEMA, anchor).sort(), expected);
  });

  it("seeds the three known blockers and the Mooncat / Cupcake grants", () => {
    for (const needle of [
      "'ILNP'",
      "'KBShimmer'",
      "'I Scream Nails'",
      "'MooncatShopify'",
      "'CupcakePolishShopify'",
      '"recordedByMigration"',
    ]) {
      // recordedByMigration is a jsonb key written as a SQL string literal
      const found = MIGRATION.includes(needle) || (needle.startsWith('"') && MIGRATION.includes("'recordedByMigration'"));
      assert.ok(found, `missing ${needle}`);
    }
  });
});
