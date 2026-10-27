/**
 * Imported-wishlist cleanup: removes the untouched wishlist rows ingestion used to add for the
 * admin who ran each job. Runs without a database (the rule itself is SQL, checked by shape).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  IMPORTED_WISHLIST_ROW_SQL,
  importNoteSource,
  parseImportedWishlistCleanupBody,
  runImportedWishlistCleanupBatch,
} = require("../dist/lib/imported-wishlist-cleanup");

function fakeDb(candidates, { deleteReturns } = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*DELETE FROM user_inventory_item/.test(sql)) {
        const rows = (deleteReturns ?? candidates).map((row) => ({ userId: row.userId, shadeId: row.shadeId }));
        return { rows, rowCount: rows.length };
      }
      return { rows: candidates.slice(0, params[1]), rowCount: candidates.length };
    },
  };
  return { calls, db: { query: client.query, transaction: (cb) => cb(client) } };
}

const rows = [
  { inventoryItemId: "10", userId: "2", shadeId: "100", notes: "Imported from MakeupAPI external_id=740" },
  { inventoryItemId: "11", userId: "2", shadeId: "101", notes: "Imported from HoloTaco external_id=55" },
  { inventoryItemId: "12", userId: "3", shadeId: "100", notes: "Imported from MakeupAPI external_id=741" },
];

describe("imported wishlist cleanup", () => {
  it("only matches untouched ingestion rows", () => {
    for (const clause of [
      "ui.status = 'wishlist'",
      "ui.quantity = 0",
      "ui.notes LIKE 'Imported from % external_id=%'",
      "ui.tags @> ARRAY['imported']::text[]",
      "ui.rating IS NULL",
      "ui.purchase_price IS NULL",
      "ui.purchase_date IS NULL",
      "ui.tried_at IS NULL",
      "ui.wear_count = 0",
      "FROM inventory_event",
      "FROM inventory_nail_photo",
      "FROM manicure_polish",
    ]) {
      assert.ok(IMPORTED_WISHLIST_ROW_SQL.includes(clause), clause);
    }
  });

  it("reads the source from the import note", () => {
    assert.equal(importNoteSource("Imported from MakeupAPI external_id=740"), "MakeupAPI");
    assert.equal(importNoteSource("Imported from CrackedPolishShopify external_id=a b"), "CrackedPolishShopify");
    assert.equal(importNoteSource("my note"), "unknown");
    assert.equal(importNoteSource(null), "unknown");
  });

  it("validates the body and defaults to a dry run", () => {
    assert.deepEqual(parseImportedWishlistCleanupBody({}), { afterInventoryItemId: 0, limit: 500, dryRun: true });
    assert.match(parseImportedWishlistCleanupBody({ limit: 0 }), /limit/);
    assert.match(parseImportedWishlistCleanupBody({ afterInventoryItemId: -1 }), /afterInventoryItemId/);
    assert.match(parseImportedWishlistCleanupBody({ dryRun: "no" }), /dryRun/);
  });

  it("reports without deleting in a dry run", async () => {
    const { calls, db } = fakeDb(rows);
    const { report, affected } = await runImportedWishlistCleanupBatch(db, { afterInventoryItemId: 0, limit: 500, dryRun: true });
    assert.equal(report.scanned, 3);
    assert.equal(report.removed, 0);
    assert.deepEqual(report.byUser, { 2: 2, 3: 1 });
    assert.deepEqual(report.bySource, { MakeupAPI: 2, HoloTaco: 1 });
    assert.equal(report.nextAfterInventoryItemId, null);
    assert.equal(affected.size, 0);
    assert.ok(!calls.some((call) => call.sql.includes("DELETE")));
  });

  it("deletes with the rule re-checked and returns the affected users", async () => {
    // Row 11 was touched between the scan and the delete: the re-check keeps it.
    const { calls, db } = fakeDb(rows, { deleteReturns: [rows[0], rows[2]] });
    const { report, affected } = await runImportedWishlistCleanupBatch(db, { afterInventoryItemId: 0, limit: 500, dryRun: false });
    const del = calls.find((call) => call.sql.includes("DELETE FROM user_inventory_item"));
    assert.ok(del.sql.includes(IMPORTED_WISHLIST_ROW_SQL));
    assert.deepEqual(del.params[0], ["10", "11", "12"]);
    assert.equal(report.removed, 2);
    assert.deepEqual([...affected], [[2, [100]], [3, [100]]]);
  });

  it("pages by inventory item id", async () => {
    const { db } = fakeDb(rows);
    const { report } = await runImportedWishlistCleanupBatch(db, { afterInventoryItemId: 0, limit: 2, dryRun: true });
    assert.equal(report.scanned, 2);
    assert.equal(report.nextAfterInventoryItemId, 11);
  });
});
