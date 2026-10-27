/**
 * Admin shade review queue (#45): merge / approve / reject transaction logic.
 *
 * Runs without a database. `mergeShadeInto`, `approveShade` and `rejectShade` take a pg
 * client, so they are driven here with a small in-memory fake that understands exactly the
 * statements they issue (the SQL itself was also exercised against a throwaway Postgres 16
 * while developing; see the PR notes). The fake applies the documented combine semantics only
 * when the generated SQL actually contains the matching assignment, so a regression in
 * `buildInventoryCombineSql` shows up as a wrong final state.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { POLISH_STATUSES } = require("swatchwatch-shared");
const {
  INVENTORY_STATUS_MERGE_PRIORITY,
  ShadeReviewError,
  approveShade,
  buildInventoryCombineSql,
  inventoryCombineExpression,
  mergeShadeInto,
  parseApproveEdits,
  rejectShade,
} = require("../dist/lib/shade-review");
const { DEFAULT_FINISH_CATALOG } = require("../dist/lib/finishes");

const ADMIN = 99;
const SOURCE = 500; // user_submitted
const TARGET = 100; // active catalog shade
const OTHER_PENDING = 501;

/** Columns of user_inventory_item as pg_attribute reports them (includes #261's `status`). */
const INVENTORY_COLUMNS = [
  { name: "inventory_item_id", isArray: false, isGenerated: false, isIdentity: false },
  { name: "user_id", isArray: false, isGenerated: false, isIdentity: false },
  { name: "sku_id", isArray: false, isGenerated: false, isIdentity: false },
  { name: "shade_id", isArray: false, isGenerated: false, isIdentity: false },
  { name: "quantity", isArray: false, isGenerated: false, isIdentity: false },
  { name: "purchase_date", isArray: false, isGenerated: false, isIdentity: false },
  { name: "notes", isArray: false, isGenerated: false, isIdentity: false },
  { name: "created_at", isArray: false, isGenerated: false, isIdentity: false },
  { name: "rating", isArray: false, isGenerated: false, isIdentity: false },
  { name: "tags", isArray: true, isGenerated: false, isIdentity: false },
  { name: "updated_at", isArray: false, isGenerated: false, isIdentity: false },
  { name: "status", isArray: false, isGenerated: false, isIdentity: false },
];

let state;
let statements;

function resetState() {
  statements = [];
  state = {
    shades: new Map([
      [SOURCE, { brandId: 1, productLineId: null, name: "Big Aple Red", status: "user_submitted", reviewStatus: null, mergedInto: null, finish: "creme", finishes: ["creme"] }],
      [TARGET, { brandId: 1, productLineId: null, name: "Big Apple Red", status: "active", reviewStatus: null, mergedInto: null, finish: "creme", finishes: ["creme"] }],
      [OTHER_PENDING, { brandId: 1, productLineId: null, name: "Another", status: "user_submitted", reviewStatus: null, mergedInto: null, finish: null, finishes: [] }],
    ]),
    inventory: [
      // User 1 holds only the submission → re-pointed.
      { id: 11, userId: 1, shadeId: SOURCE, quantity: 1, notes: "mine", purchaseDate: "2026-03-01", createdAt: "2026-03-01", rating: null, tags: ["red"], status: "owned" },
      // User 2 holds BOTH → combined into the target row, source row deleted.
      { id: 21, userId: 2, shadeId: SOURCE, quantity: 3, notes: "source note", purchaseDate: "2025-12-01", createdAt: "2025-12-01", rating: 4, tags: ["a", "b"], status: "owned" },
      { id: 22, userId: 2, shadeId: TARGET, quantity: 1, notes: "target note", purchaseDate: "2026-01-15", createdAt: "2026-01-15", rating: null, tags: ["b", "c"], status: "wishlist" },
      // User 3 holds only the target → untouched.
      { id: 31, userId: 3, shadeId: TARGET, quantity: 2, notes: null, purchaseDate: null, createdAt: "2026-02-01", rating: 5, tags: [], status: "owned" },
    ],
    events: [
      { id: 1, itemId: 21, userId: 2, shadeId: SOURCE, manicureId: null },
      { id: 2, itemId: 22, userId: 2, shadeId: TARGET, manicureId: null },
      { id: 3, itemId: 11, userId: 1, shadeId: SOURCE, manicureId: null },
    ],
    // Mani log (#269): id -> { userId, wornOn, polishes: [{ shadeId, role }] }. Empty by default.
    manicures: new Map(),
    // Derived wear stats written by recomputeWearStats, by inventory item id.
    wear: new Map(),
    aliases: [
      { shadeId: SOURCE, alias: "BAR" },
      { shadeId: TARGET, alias: "bar" }, // same alias, different case → not duplicated
      { shadeId: SOURCE, alias: "Apple Red Typo" },
    ],
    inventoryReferences: [{ tableName: "inventory_event", columnName: '"inventory_item_id"' }],
    // Vendor listings: the target already has product 900, the source has 900 and 901.
    sourceProducts: [
      { shadeId: TARGET, externalProductId: 900, firstSeenAt: "2026-01-01" },
      { shadeId: SOURCE, externalProductId: 900, firstSeenAt: "2026-02-01" },
      { shadeId: SOURCE, externalProductId: 901, firstSeenAt: "2026-02-01" },
    ],
    userBarcodes: [{ userId: 1, gtin: "0012345678905", shadeId: SOURCE }],
  };
}

function rowsResult(rows) {
  return { rows, rowCount: rows.length };
}

/** Combine one column like the SQL does, but only if the generated SQL assigns it as expected. */
function combineColumn(sql, column, t, s) {
  const pgName = column.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
  const assigned = (expr) => sql.includes(`"${pgName}" = ${expr}`);
  switch (column) {
    case "quantity":
      assert.ok(assigned('COALESCE(t."quantity", 0) + COALESCE(s."quantity", 0)'), "quantity must be summed");
      return (t ?? 0) + (s ?? 0);
    case "purchaseDate":
      assert.ok(assigned('LEAST(t."purchase_date", s."purchase_date")'), "purchase_date must keep the earliest");
      return [t, s].filter(Boolean).sort()[0] ?? null;
    case "createdAt":
      assert.ok(assigned('LEAST(t."created_at", s."created_at")'), "created_at must keep the earliest");
      return [t, s].filter(Boolean).sort()[0] ?? null;
    case "notes":
      assert.ok(sql.includes(`"notes" = CASE WHEN NULLIF(btrim(t."notes"), '') IS NULL THEN s."notes"`), "notes must be concatenated");
      if (!t || !t.trim()) return s;
      if (!s || !s.trim() || t.trim() === s.trim()) return t;
      return `${t}\n\n${s}`;
    case "status":
      return evalStatusCase(sql, t, s);
    case "tags":
      assert.ok(sql.includes('"tags" = CASE WHEN t."tags" IS NULL THEN s."tags"'), "array columns must be unioned");
      if (t == null) return s;
      if (s == null) return t;
      return [...new Set([...t, ...s])];
    default: {
      assert.ok(assigned(`COALESCE(t."${pgName}", s."${pgName}")`), `${pgName} must default to target-wins COALESCE`);
      return t ?? s;
    }
  }
}

/**
 * Evaluate the generated `"status" = CASE WHEN '<x>' IN (t."status", s."status") THEN '<x>' …
 * ELSE COALESCE(t."status", s."status") END` assignment for one pair, in the order the SQL lists
 * its WHEN branches, so the tests check the SQL's precedence rather than restating it.
 */
function evalStatusCase(sql, t, s) {
  const match = sql.match(/"status" = CASE ((?:WHEN '\w+' IN \(t\."status", s\."status"\) THEN '\w+' )+)ELSE COALESCE\(t\."status", s\."status"\) END/);
  assert.ok(match, `status must be combined with a precedence CASE: ${sql}`);
  for (const [, when, then] of match[1].matchAll(/WHEN '(\w+)' IN \(t\."status", s\."status"\) THEN '(\w+)'/g)) {
    if (t === when || s === when) return then;
  }
  return t ?? s;
}

/** Mirrors recomputeWearStats: wear derived from the user's manicures that include the shade. */
function recomputeWear(userId, shadeIds) {
  const rows = [];
  for (const item of state.inventory) {
    if (item.userId !== userId || !shadeIds.includes(item.shadeId)) continue;
    const dates = [...state.manicures.values()]
      .filter((m) => m.userId === userId && m.polishes.some((p) => p.shadeId === item.shadeId))
      .map((m) => m.wornOn)
      .sort();
    const stat = { wearCount: dates.length, lastWornOn: dates[dates.length - 1] ?? null };
    state.wear.set(item.id, stat);
    rows.push({ shadeId: String(item.shadeId), inventoryItemId: String(item.id), wearCount: stat.wearCount, lastWornAt: stat.lastWornOn, triedAt: null });
  }
  return rows;
}

async function fakeQuery(sql, params = []) {
  const text = String(sql).trim();
  statements.push({ sql: text, params });

  if (/FOR UPDATE/i.test(text) && /FROM shade/i.test(text)) {
    const ids = params[0].map(Number);
    return rowsResult(
      ids
        .filter((id) => state.shades.has(id))
        .sort((a, b) => a - b)
        .map((id) => {
          const s = state.shades.get(id);
          return {
            shadeId: String(id),
            brandId: String(s.brandId),
            productLineId: s.productLineId,
            name: s.name,
            status: s.status,
            reviewStatus: s.reviewStatus,
            mergedIntoShadeId: s.mergedInto === null ? null : String(s.mergedInto),
          };
        })
    );
  }
  if (/FROM pg_attribute/i.test(text)) return rowsResult(INVENTORY_COLUMNS);
  if (/FROM pg_constraint/i.test(text)) return rowsResult(state.inventoryReferences);

  if (/^UPDATE user_inventory_item AS t/i.test(text)) {
    const [sourceId, targetId] = params.map(Number);
    const pairs = [];
    for (const s of state.inventory.filter((row) => row.shadeId === sourceId)) {
      const t = state.inventory.find((row) => row.shadeId === targetId && row.userId === s.userId);
      if (!t) continue;
      for (const column of ["quantity", "purchaseDate", "createdAt", "notes", "tags", "rating", "status"]) {
        t[column] = combineColumn(text, column, t[column], s[column]);
      }
      pairs.push({ targetItemId: String(t.id), sourceItemId: String(s.id), userId: String(s.userId) });
    }
    return rowsResult(pairs);
  }
  if (/^UPDATE inventory_event AS ref/i.test(text)) {
    const [sources, targets] = params;
    let count = 0;
    for (const event of state.events) {
      const idx = sources.map(Number).indexOf(event.itemId);
      if (idx >= 0) {
        event.itemId = Number(targets[idx]);
        count += 1;
      }
    }
    return { rows: [], rowCount: count };
  }
  if (/^DELETE FROM user_inventory_item/i.test(text)) {
    const ids = params[0].map(Number);
    const shadeId = Number(params[1]);
    const before = state.inventory.length;
    state.inventory = state.inventory.filter((row) => !(ids.includes(row.id) && row.shadeId === shadeId));
    // ON DELETE SET NULL (D8, #317): events still pointing at a deleted row are detached.
    for (const event of state.events) {
      if (event.itemId !== null && !state.inventory.some((row) => row.id === event.itemId)) event.itemId = null;
    }
    return { rows: [], rowCount: before - state.inventory.length };
  }
  if (/^UPDATE user_inventory_item\s+SET shade_id = \$2/i.test(text)) {
    const [sourceId, targetId] = params.map(Number);
    const moved = state.inventory.filter((row) => row.shadeId === sourceId);
    for (const row of moved) row.shadeId = targetId;
    return rowsResult(moved.map((row) => ({ userId: String(row.userId) })));
  }
  if (/^DELETE FROM manicure_polish AS s\s+USING manicure_polish AS t/i.test(text)) {
    const [sourceId, targetId] = params.map(Number);
    let count = 0;
    for (const m of state.manicures.values()) {
      const before = m.polishes.length;
      m.polishes = m.polishes.filter(
        (p) => !(p.shadeId === sourceId && m.polishes.some((q) => q.shadeId === targetId && q.role === p.role))
      );
      count += before - m.polishes.length;
    }
    return { rows: [], rowCount: count };
  }
  if (/^UPDATE manicure_polish AS mp\s+SET shade_id = \$2/i.test(text)) {
    const [sourceId, targetId] = params.map(Number);
    const rows = [];
    for (const m of state.manicures.values()) {
      for (const p of m.polishes.filter((q) => q.shadeId === sourceId)) {
        p.shadeId = targetId;
        rows.push({ userId: String(m.userId) });
      }
    }
    return rowsResult(rows);
  }
  if (/^DELETE FROM inventory_event AS s\s+USING inventory_event AS t/i.test(text)) {
    const [sourceId, targetId] = params.map(Number);
    const superseded = (e) =>
      e.shadeId === sourceId && e.manicureId !== null &&
      state.events.some((t) => t.shadeId === targetId && t.manicureId === e.manicureId && t.userId === e.userId);
    const before = state.events.length;
    state.events = state.events.filter((e) => !superseded(e));
    return { rows: [], rowCount: before - state.events.length };
  }
  if (/^UPDATE inventory_event SET shade_id = \$2 WHERE shade_id = \$1$/i.test(text)) {
    const [sourceId, targetId] = params.map(Number);
    const moved = state.events.filter((e) => e.shadeId === sourceId);
    for (const e of moved) e.shadeId = targetId;
    return { rows: [], rowCount: moved.length };
  }
  if (/^UPDATE inventory_event ie\s+SET inventory_item_id = ui\.inventory_item_id/i.test(text)) {
    // reattachInventoryEvents: the caller's detached events → their current row for the shade.
    const [userId, shadeIds] = [Number(params[0]), params[1].map(Number)];
    for (const e of state.events) {
      if (e.userId !== userId || e.itemId !== null || !shadeIds.includes(e.shadeId)) continue;
      const row = state.inventory.find((r) => r.userId === userId && r.shadeId === e.shadeId);
      if (row) e.itemId = row.id;
    }
    return { rows: [], rowCount: 0 };
  }
  if (/^WITH target AS/i.test(text) && /UPDATE user_inventory_item ui\s+SET wear_count/i.test(text)) {
    return rowsResult(recomputeWear(Number(params[0]), params[1].map(Number)));
  }
  if (/^INSERT INTO shade_alias/i.test(text) && /FROM shade_alias sa/i.test(text)) {
    const [sourceId, targetId] = params.map(Number);
    let count = 0;
    for (const alias of state.aliases.filter((a) => a.shadeId === sourceId)) {
      const exists = state.aliases.some((a) => a.shadeId === targetId && a.alias.toLowerCase() === alias.alias.toLowerCase());
      if (!exists) {
        state.aliases.push({ shadeId: targetId, alias: alias.alias });
        count += 1;
      }
    }
    return { rows: [], rowCount: count };
  }
  if (/^INSERT INTO shade_alias/i.test(text)) {
    const [targetId, alias] = [Number(params[0]), params[1]];
    if (state.aliases.some((a) => a.shadeId === targetId && a.alias.toLowerCase() === alias.toLowerCase())) {
      return { rows: [], rowCount: 0 };
    }
    state.aliases.push({ shadeId: targetId, alias });
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE sku/i.test(text) || /^UPDATE swatch/i.test(text)) return { rows: [], rowCount: 0 };
  if (/^INSERT INTO shade_source_product/i.test(text) && /FROM shade_source_product ssp/i.test(text)) {
    const [sourceId, targetId] = params.map(Number);
    let count = 0;
    for (const link of state.sourceProducts.filter((l) => l.shadeId === sourceId)) {
      if (state.sourceProducts.some((l) => l.shadeId === targetId && l.externalProductId === link.externalProductId)) continue;
      state.sourceProducts.push({ ...link, shadeId: targetId });
      count += 1;
    }
    return { rows: [], rowCount: count };
  }
  if (/^DELETE FROM shade_source_product WHERE shade_id = \$1$/i.test(text)) {
    const before = state.sourceProducts.length;
    state.sourceProducts = state.sourceProducts.filter((l) => l.shadeId !== Number(params[0]));
    return { rows: [], rowCount: before - state.sourceProducts.length };
  }
  if (/^UPDATE user_shade_barcode SET shade_id = \$2 WHERE shade_id = \$1$/i.test(text)) {
    const [sourceId, targetId] = params.map(Number);
    const moved = state.userBarcodes.filter((b) => b.shadeId === sourceId);
    for (const b of moved) b.shadeId = targetId;
    return { rows: [], rowCount: moved.length };
  }
  if (/^UPDATE shade\s+SET review_status = 'merged'/i.test(text)) {
    const shade = state.shades.get(Number(params[0]));
    Object.assign(shade, { reviewStatus: "merged", mergedInto: Number(params[1]), reviewedBy: params[2], note: params[3] });
    if (/status = 'excluded'/.test(text)) shade.status = "excluded";
    return rowsResult([{ reviewedAt: new Date("2026-10-17T00:00:00Z") }]);
  }
  if (/^UPDATE shade\s+SET review_status = 'rejected'/i.test(text)) {
    const shade = state.shades.get(Number(params[0]));
    Object.assign(shade, { reviewStatus: "rejected", reviewedBy: params[1], note: params[2] });
    return rowsResult([{ reviewedAt: "2026-10-17T00:00:00.000Z" }]);
  }
  if (/^INSERT INTO brand/i.test(text)) return { rows: [], rowCount: 1 };
  if (/^SELECT brand_id/i.test(text)) return rowsResult([{ brandId: "7" }]);
  if (/s\.status = 'active'/i.test(text) && /lower\(s\.shade_name_canonical\) = lower\(\$3\)/i.test(text)) {
    const [selfId, brandId, name, finish] = params;
    const self = state.shades.get(Number(selfId));
    const primary = (s) => s.finishes[0] ?? s.finish ?? "";
    const wanted = finish ?? primary(self);
    const dup = [...state.shades.entries()].find(
      ([id, s]) =>
        s.status === "active" && id !== Number(selfId) && s.brandId === Number(brandId) &&
        s.name.toLowerCase() === String(name).toLowerCase() && primary(s) === wanted
    );
    return rowsResult(dup ? [{ shadeId: String(dup[0]) }] : []);
  }
  if (/^UPDATE shade SET status = 'active'/i.test(text)) {
    const shade = state.shades.get(Number(params[0]));
    shade.status = "active";
    shade.reviewStatus = "approved";
    shade.reviewedBy = params[1];
    shade.note = params[2];
    shade.lastApproveSql = text;
    shade.lastApproveParams = params;
    return rowsResult([{ reviewedAt: "2026-10-17T00:00:00.000Z" }]);
  }
  if (/FROM user_inventory_item WHERE shade_id = \$1/i.test(text)) {
    const ids = [...new Set(state.inventory.filter((r) => r.shadeId === Number(params[0])).map((r) => r.userId))];
    return rowsResult(ids.map((id) => ({ userId: String(id) })));
  }
  throw new Error(`fake client: unexpected statement: ${text.slice(0, 120)}`);
}

const client = { query: (sql, params) => fakeQuery(sql, params) };
const mutations = () => statements.filter((s) => /^(INSERT|UPDATE|DELETE)\b/i.test(s.sql));

beforeEach(resetState);

describe("buildInventoryCombineSql", () => {
  it("never assigns key/ownership, generated or identity columns", () => {
    for (const name of ["inventory_item_id", "user_id", "shade_id"]) {
      assert.equal(inventoryCombineExpression({ name, isArray: false, isGenerated: false, isIdentity: false }), null);
    }
    assert.equal(inventoryCombineExpression({ name: "x", isArray: false, isGenerated: true, isIdentity: false }), null);
    assert.equal(inventoryCombineExpression({ name: "y", isArray: false, isGenerated: false, isIdentity: true }), null);
  });

  it("carries unknown/new columns generically: target wins, NULLs filled", () => {
    const sql = buildInventoryCombineSql([
      ...INVENTORY_COLUMNS,
      { name: "acquired_from", isArray: false, isGenerated: false, isIdentity: false },
    ]);
    assert.match(sql, /"acquired_from" = COALESCE\(t\."acquired_from", s\."acquired_from"\)/);
    assert.match(sql, /"updated_at" = now\(\)/);
    assert.doesNotMatch(sql, /"user_id" =|"shade_id" =|"inventory_item_id" =/);
    assert.match(sql, /WHERE s\.shade_id = \$1\s+AND t\.shade_id = \$2\s+AND t\.user_id = s\.user_id/);
  });

  it("combines status by precedence, highest first (D7, #316)", () => {
    assert.equal(
      inventoryCombineExpression({ name: "status", isArray: false, isGenerated: false, isIdentity: false }),
      `CASE WHEN 'owned' IN (t."status", s."status") THEN 'owned' ` +
        `WHEN 'destash' IN (t."status", s."status") THEN 'destash' ` +
        `WHEN 'wishlist' IN (t."status", s."status") THEN 'wishlist' ` +
        `WHEN 'archived' IN (t."status", s."status") THEN 'archived' ` +
        `ELSE COALESCE(t."status", s."status") END`
    );
  });

  it("ranks every inventory status exactly once", () => {
    assert.deepEqual([...INVENTORY_STATUS_MERGE_PRIORITY], ["owned", "destash", "wishlist", "archived"]);
    assert.deepEqual([...INVENTORY_STATUS_MERGE_PRIORITY].sort(), [...POLISH_STATUSES].sort());
  });

  it("quotes identifiers", () => {
    const expr = inventoryCombineExpression({ name: 'we"ird', isArray: false, isGenerated: false, isIdentity: false });
    assert.equal(expr, 'COALESCE(t."we""ird", s."we""ird")');
  });
});

describe("mergeShadeInto", () => {
  it("re-points inventory, combines duplicates, keeps history and retires the source", async () => {
    const outcome = await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN, note: "typo" });

    assert.equal(outcome.movedInventoryRows, 1);
    assert.equal(outcome.combinedInventoryRows, 1);
    assert.deepEqual(outcome.affectedUserIds, [1, 2]);
    assert.equal(outcome.reviewedAt, "2026-10-17T00:00:00.000Z");

    // Nothing references the source any more.
    assert.equal(state.inventory.filter((r) => r.shadeId === SOURCE).length, 0);
    // User 1: re-pointed, data untouched.
    const u1 = state.inventory.filter((r) => r.userId === 1);
    assert.equal(u1.length, 1);
    assert.deepEqual({ ...u1[0] }, { id: 11, userId: 1, shadeId: TARGET, quantity: 1, notes: "mine", purchaseDate: "2026-03-01", createdAt: "2026-03-01", rating: null, tags: ["red"], status: "owned" });
    // User 2: one row (unique user+shade), quantities summed, earliest date, notes concatenated,
    // tags unioned, rating filled from the source, the higher status (source owned > target
    // wishlist) kept (D7, #316).
    const u2 = state.inventory.filter((r) => r.userId === 2);
    assert.equal(u2.length, 1);
    assert.equal(u2[0].id, 22);
    assert.equal(u2[0].quantity, 4);
    assert.equal(u2[0].purchaseDate, "2025-12-01");
    assert.equal(u2[0].createdAt, "2025-12-01");
    assert.equal(u2[0].notes, "target note\n\nsource note");
    assert.deepEqual(u2[0].tags, ["b", "c", "a"]);
    assert.equal(u2[0].rating, 4);
    assert.equal(u2[0].status, "owned");
    // User 3 untouched.
    assert.deepEqual(state.inventory.filter((r) => r.userId === 3).map((r) => [r.id, r.quantity]), [[31, 2]]);
    // History of the deleted duplicate moved to the surviving row (not cascaded away).
    assert.deepEqual(state.events.map((e) => [e.id, e.itemId]), [[1, 22], [2, 22], [3, 11]]);

    // Source retired in place, private (status unchanged) with the audit trail.
    const source = state.shades.get(SOURCE);
    assert.equal(source.status, "user_submitted");
    assert.equal(source.reviewStatus, "merged");
    assert.equal(source.mergedInto, TARGET);
    assert.equal(source.reviewedBy, ADMIN);
    assert.equal(source.note, "typo");
    // Target catalog data never modified.
    assert.equal(state.shades.get(TARGET).name, "Big Apple Red");
    assert.ok(!mutations().some((m) => /^UPDATE shade\b/i.test(m.sql) && Number(m.params[0]) === TARGET));
  });

  it("re-points references before deleting duplicate rows, all inside the caller's transaction", async () => {
    await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN });
    const order = statements.map((s) => s.sql.split(/\s+/).slice(0, 3).join(" "));
    const lock = order.findIndex((s) => /^SELECT shade_id/.test(s));
    const combine = order.findIndex((s) => s === "UPDATE user_inventory_item AS");
    const repoint = order.findIndex((s) => s === "UPDATE inventory_event AS");
    const del = order.findIndex((s) => s === "DELETE FROM user_inventory_item");
    const move = statements.findIndex((s) => /^UPDATE user_inventory_item\s+SET shade_id/i.test(s.sql));
    assert.ok(lock === 0, "shades are locked first");
    assert.ok(lock < combine && combine < repoint && repoint < del && del < move, order.join(" | "));
    // The delete is limited to the combined source rows of the source shade.
    assert.deepEqual(statements[del].params, [["21"], SOURCE]);
  });

  it("copies aliases case-insensitively and adds the submitted name as an alias", async () => {
    const outcome = await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN });
    const targetAliases = state.aliases.filter((a) => a.shadeId === TARGET).map((a) => a.alias).sort();
    assert.deepEqual(targetAliases, ["Apple Red Typo", "Big Aple Red", "bar"]);
    assert.equal(outcome.copiedAliasRows, 2);
  });

  it("keepNameAsAlias=false skips the submitted-name alias", async () => {
    await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN, keepNameAsAlias: false });
    assert.ok(!state.aliases.some((a) => a.shadeId === TARGET && a.alias === "Big Aple Red"));
  });

  it("does not add the name alias when it equals the target name (case-insensitive)", async () => {
    state.shades.get(SOURCE).name = "big apple red";
    await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN });
    assert.equal(statements.filter((s) => /^INSERT INTO shade_alias \(shade_id, alias\)\s+SELECT \$1, \$2::text/i.test(s.sql)).length, 0);
  });

  it("with no duplicates it skips the reference/delete steps", async () => {
    state.inventory = state.inventory.filter((r) => r.id !== 22);
    const outcome = await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN });
    assert.equal(outcome.combinedInventoryRows, 0);
    assert.equal(outcome.movedInventoryRows, 2);
    assert.ok(!statements.some((s) => /^DELETE FROM user_inventory_item/i.test(s.sql) || /FROM pg_constraint/i.test(s.sql)));
  });

  const refusals = [
    ["merging a shade into itself", { targetShadeId: SOURCE }, 400, () => {}],
    ["a missing source", { sourceShadeId: 999 }, 404, () => {}],
    ["a missing target", { targetShadeId: 999 }, 404, () => {}],
    ["a target that is not active", { targetShadeId: OTHER_PENDING }, 409, () => {}],
    ["a source that is already active", {}, 409, () => { state.shades.get(SOURCE).status = "active"; }],
    ["a source that was already merged", {}, 409, () => Object.assign(state.shades.get(SOURCE), { reviewStatus: "merged", mergedInto: TARGET })],
  ];
  for (const [label, overrides, status, setup] of refusals) {
    it(`refuses ${label} (${status}) without writing anything`, async () => {
      setup();
      await assert.rejects(
        mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN, ...overrides }),
        (error) => error instanceof ShadeReviewError && error.status === status
      );
      assert.deepEqual(mutations(), []);
    });
  }

  it("a rejected submission can still be merged later", async () => {
    state.shades.get(SOURCE).reviewStatus = "rejected";
    await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN });
    assert.equal(state.shades.get(SOURCE).reviewStatus, "merged");
  });

  it("moves every vendor listing and learned barcode to the target", async () => {
    const outcome = await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN });
    assert.equal(outcome.movedSourceProductRows, 1, "product 900 was already on the target");
    assert.deepEqual(
      state.sourceProducts.map((l) => [l.shadeId, l.externalProductId, l.firstSeenAt]).sort(),
      [[TARGET, 900, "2026-01-01"], [TARGET, 901, "2026-02-01"]].sort(),
      "the target keeps its own row for a shared product and gains the others with their dates"
    );
    assert.deepEqual(state.userBarcodes, [{ userId: 1, gtin: "0012345678905", shadeId: TARGET }]);
    assert.equal(state.shades.get(SOURCE).status, "user_submitted", "a review merge keeps the source private");
  });

  it("a catalog merge takes an active source and retires it as excluded", async () => {
    const DUP = 600;
    state.shades.set(DUP, { brandId: 1, productLineId: null, name: "Big Apple Red (40052)", status: "active", reviewStatus: null, mergedInto: null, finish: null, finishes: [] });
    await assert.rejects(
      mergeShadeInto(client, { sourceShadeId: DUP, targetShadeId: TARGET, adminUserId: ADMIN }),
      (e) => e instanceof ShadeReviewError && e.status === 409,
      "the review merge refuses a catalog shade"
    );
    await mergeShadeInto(client, { sourceShadeId: DUP, targetShadeId: TARGET, adminUserId: ADMIN, sourceKind: "catalog" });
    const dup = state.shades.get(DUP);
    assert.equal(dup.status, "excluded");
    assert.equal(dup.reviewStatus, "merged");
    assert.equal(dup.mergedInto, TARGET);
    assert.ok(state.aliases.some((a) => a.shadeId === TARGET && a.alias === "Big Apple Red (40052)"));

    await assert.rejects(
      mergeShadeInto(client, { sourceShadeId: DUP, targetShadeId: TARGET, adminUserId: ADMIN, sourceKind: "catalog" }),
      (e) => e instanceof ShadeReviewError && e.status === 409,
      "an already merged shade cannot be merged again"
    );
    await assert.rejects(
      mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN, sourceKind: "catalog" }),
      (e) => e instanceof ShadeReviewError && e.status === 409,
      "a catalog merge refuses a user_submitted shade"
    );
  });
});

describe("approve / reject", () => {
  it("parseApproveEdits validates finishes, hexes and text", () => {
    const edits = parseApproveEdits(
      { brand: "  OPI ", name: "Big Apple Red", finishes: ["Holo", "creme", "creme"], vendorHex: "c4113c", nameHex: null, collection: "", note: " ok " },
      DEFAULT_FINISH_CATALOG
    );
    assert.equal(edits.brand, "OPI");
    assert.deepEqual(edits.finishes, ["holographic", "creme"]);
    assert.equal(edits.vendorHex, "#C4113C");
    assert.equal(edits.nameHex, null);
    assert.equal(edits.collection, null);
    assert.equal(edits.colorName, undefined, "omitted fields stay undefined (keep submitted value)");
    assert.equal(edits.note, "ok");

    for (const bad of [{ finishes: ["sparkly-unicorn"] }, { finishes: "creme" }, { vendorHex: "red" }, { name: "  " }, { brand: 5 }, [], "x"]) {
      assert.throws(() => parseApproveEdits(bad, DEFAULT_FINISH_CATALOG), (e) => e instanceof ShadeReviewError && e.status === 400, JSON.stringify(bad));
    }
  });

  it("approve promotes the shade to active with only the edited columns and the audit fields", async () => {
    const edits = parseApproveEdits({ name: "Big Aple Red (fixed)", finishes: ["shimmer"], vendorHex: "#aabbcc", note: "fixed" }, DEFAULT_FINISH_CATALOG);
    const outcome = await approveShade(client, OTHER_PENDING, edits, ADMIN);
    const shade = state.shades.get(OTHER_PENDING);
    assert.equal(shade.status, "active");
    assert.equal(shade.reviewStatus, "approved");
    assert.equal(shade.reviewedBy, ADMIN);
    assert.equal(shade.note, "fixed");
    assert.match(shade.lastApproveSql, /shade_name_canonical = \$\d+/);
    assert.match(shade.lastApproveSql, /finishes = \$\d+::text\[\]/);
    assert.match(shade.lastApproveSql, /vendor_hex = \$\d+/);
    assert.doesNotMatch(shade.lastApproveSql, /brand_id =|collection =|color_name =|name_hex =|\bfinish =/);
    assert.ok(shade.lastApproveParams.includes("#AABBCC"));
    assert.equal(outcome.reviewedAt, "2026-10-17T00:00:00.000Z");
  });

  it("approve refuses (409) a duplicate of an active shade and writes nothing to the shade", async () => {
    const edits = parseApproveEdits({ name: "BIG APPLE RED" }, DEFAULT_FINISH_CATALOG);
    await assert.rejects(
      approveShade(client, SOURCE, edits, ADMIN),
      (e) => e instanceof ShadeReviewError && e.status === 409 && e.details.conflictShadeId === String(TARGET)
    );
    assert.equal(state.shades.get(SOURCE).status, "user_submitted");
    assert.ok(!mutations().some((m) => /^UPDATE shade/i.test(m.sql)));
  });

  it("approve refuses shades that are not awaiting review", async () => {
    const edits = parseApproveEdits({}, DEFAULT_FINISH_CATALOG);
    await assert.rejects(approveShade(client, TARGET, edits, ADMIN), (e) => e.status === 409);
    await assert.rejects(approveShade(client, 999, edits, ADMIN), (e) => e.status === 404);
  });

  it("reject keeps the shade user_submitted (private) and deletes nothing", async () => {
    await rejectShade(client, SOURCE, ADMIN, "not a polish");
    const shade = state.shades.get(SOURCE);
    assert.equal(shade.status, "user_submitted");
    assert.equal(shade.reviewStatus, "rejected");
    assert.equal(shade.note, "not a polish");
    const reject = statements.find((s) => /review_status = 'rejected'/.test(s.sql));
    assert.doesNotMatch(reject.sql, /\bstatus\s*=\s*'(?!rejected)/, "reject must not change shade.status");
    assert.ok(!statements.some((s) => /^DELETE/i.test(s.sql)));
    assert.equal(state.inventory.filter((r) => r.shadeId === SOURCE).length, 2);
  });
});

describe("mergeShadeInto: combined inventory status (D7, #316)", () => {
  // Highest first: owned > destash > wishlist > archived.
  const rank = { owned: 0, destash: 1, wishlist: 2, archived: 3 };
  for (const targetStatus of POLISH_STATUSES) {
    for (const sourceStatus of POLISH_STATUSES) {
      const expected = rank[targetStatus] <= rank[sourceStatus] ? targetStatus : sourceStatus;
      it(`target ${targetStatus} + source ${sourceStatus} → ${expected}`, async () => {
        state.inventory.find((r) => r.id === 22).status = targetStatus;
        state.inventory.find((r) => r.id === 21).status = sourceStatus;
        await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN });
        const rows = state.inventory.filter((r) => r.userId === 2);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, expected);
      });
    }
  }
});

describe("mergeShadeInto: mani log and wear history follow the shade (#269, D8 / #317)", () => {
  beforeEach(() => {
    // User 2 wore the submission alone, then with the target in the same role; user 4 deleted
    // the submission from their collection (event detached) but holds the target.
    state.inventory.push({ id: 41, userId: 4, shadeId: TARGET, quantity: 1, notes: null, purchaseDate: null, createdAt: "2026-01-01", rating: null, tags: [], status: "owned" });
    state.manicures.set(1, { userId: 2, wornOn: "2026-09-01", polishes: [{ shadeId: SOURCE, role: "color" }] });
    state.manicures.set(2, { userId: 2, wornOn: "2026-09-10", polishes: [{ shadeId: SOURCE, role: "color" }, { shadeId: TARGET, role: "color" }] });
    state.manicures.set(3, { userId: 4, wornOn: "2026-08-01", polishes: [{ shadeId: SOURCE, role: "accent" }] });
    state.events.push(
      { id: 4, itemId: 21, userId: 2, shadeId: SOURCE, manicureId: 1 },
      { id: 5, itemId: 21, userId: 2, shadeId: SOURCE, manicureId: 2 },
      { id: 6, itemId: 22, userId: 2, shadeId: TARGET, manicureId: 2 },
      { id: 7, itemId: null, userId: 4, shadeId: SOURCE, manicureId: 3 }
    );
  });

  it("moves manicure polishes to the target without duplicating a shade + role", async () => {
    await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN });
    assert.deepEqual(state.manicures.get(1).polishes, [{ shadeId: TARGET, role: "color" }]);
    assert.deepEqual(state.manicures.get(2).polishes, [{ shadeId: TARGET, role: "color" }]);
    assert.deepEqual(state.manicures.get(3).polishes, [{ shadeId: TARGET, role: "accent" }]);
  });

  it("moves events to the target, drops superseded ones and re-attaches detached ones", async () => {
    await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN });
    assert.ok(!state.events.some((e) => e.shadeId === SOURCE), "no event keeps the retired shade");
    const byId = new Map(state.events.map((e) => [e.id, e]));
    assert.equal(byId.get(4).itemId, 22, "user 2's source-row event follows the combined row");
    assert.equal(byId.has(5), false, "manicure 2 already had a target event");
    assert.equal(byId.get(6).itemId, 22);
    assert.equal(byId.get(7).itemId, 41, "user 4's detached event re-attaches to their target row");
    assert.equal(byId.get(7).userId, 4);
  });

  it("recomputes wear stats for the target and reports every user whose stats changed", async () => {
    const outcome = await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN });
    assert.deepEqual(state.wear.get(22), { wearCount: 2, lastWornOn: "2026-09-10" });
    assert.deepEqual(state.wear.get(41), { wearCount: 1, lastWornOn: "2026-08-01" });
    assert.deepEqual(outcome.affectedUserIds, [1, 2, 4]);
    // Recomputation is per user and bound to that user.
    const recomputes = statements.filter((s) => /^WITH target AS/i.test(s.sql));
    assert.deepEqual(recomputes.map((s) => [Number(s.params[0]), s.params[1].map(Number)]), [[1, [TARGET]], [2, [TARGET]], [4, [TARGET]]]);
  });

  it("runs the mani-log moves after the inventory moves and before retiring the source", async () => {
    await mergeShadeInto(client, { sourceShadeId: SOURCE, targetShadeId: TARGET, adminUserId: ADMIN });
    const at = (re) => statements.findIndex((s) => re.test(s.sql));
    const moveInventory = at(/^UPDATE user_inventory_item\s+SET shade_id/i);
    const movePolishes = at(/^UPDATE manicure_polish AS mp/i);
    const moveEvents = at(/^UPDATE inventory_event SET shade_id/i);
    const recompute = at(/^WITH target AS/i);
    const retire = at(/^UPDATE shade\s+SET review_status = 'merged'/i);
    assert.ok(moveInventory < movePolishes && movePolishes < moveEvents && moveEvents < recompute && recompute < retire);
  });
});
