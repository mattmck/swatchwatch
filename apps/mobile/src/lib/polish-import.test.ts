import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PolishImportCandidate, PolishImportRow } from "swatchwatch-shared";
import {
  acceptTopCandidates,
  actionCounts,
  buildImportPreview,
  changedDecisions,
  checkImportFile,
  decisionValue,
  fieldForColumn,
  rowSummary,
  sortedTabRows,
  stripBom,
  utf8ByteLength,
  formatConfidence,
  importColumns,
  importDataRowCount,
  importMappingError,
  importableCount,
  parseDecisionValue,
  parseStatusChoiceValue,
  pickSearchResult,
  rowsForTab,
  rowsNeedingStatus,
  selectedCandidate,
  setActionForState,
  setColumnField,
  setRowDecision,
  setStatusChoice,
  statusChoiceValue,
  tabCounts,
  undecidedStatusCount,
} from "./polish-import";

function candidate(shadeId: string, confidence = 0.8): PolishImportCandidate {
  return {
    shadeId,
    brand: "Essie",
    name: `Shade ${shadeId}`,
    finishes: [],
    hex: "#AA0000",
    confidence,
    inCollection: false,
    userSubmitted: false,
    exactMatch: false,
  };
}

function row(rowNumber: number, overrides: Partial<PolishImportRow> = {}): PolishImportRow {
  return {
    rowNumber,
    values: { brand: "Essie", name: `Row ${rowNumber}`, finishes: [] },
    matchState: "ambiguous",
    confidence: 0.8,
    candidates: [candidate("1"), candidate("2", 0.7)],
    action: "pending",
    shadeId: null,
    warnings: [],
    errors: [],
    ...overrides,
  };
}

describe("polish-import — file checks", () => {
  it("rejects spreadsheet binaries, other types, empty and oversized files", () => {
    assert.match(checkImportFile({ name: "list.xlsx", size: 10 }) ?? "", /CSV/);
    assert.match(checkImportFile({ name: "photo.png", size: 10 }) ?? "", /\.csv/);
    assert.match(checkImportFile({ name: "list.csv", size: 0 }) ?? "", /empty/);
    assert.match(checkImportFile({ name: "list.csv", size: 2 * 1024 * 1024 }) ?? "", /limit/);
    assert.equal(checkImportFile({ name: "List.CSV", size: 100 }), null);
    assert.equal(checkImportFile({ name: "export.tsv", size: 100 }), null);
  });
});

describe("polish-import — mapping preview", () => {
  const text = "My polishes\nBrand;Shade;Qty\nEssie;Wicked;2\nOPI;'=Funny;1\n";

  it("detects the header row and columns with samples", () => {
    const preview = buildImportPreview(text);
    assert.equal(preview.delimiter, ";");
    assert.equal(preview.headerRowIndex, 1);
    assert.equal(preview.confident, true);
    assert.deepEqual(preview.mapping, { brand: 0, name: 1, quantity: 2 });
    const columns = importColumns(preview, 1);
    assert.deepEqual(columns.map((c) => c.label), ["Brand", "Shade", "Qty"]);
    assert.deepEqual(columns[1].samples, ["Wicked", "=Funny"]);
    assert.equal(importDataRowCount(preview, 1), 2);
    assert.equal(importColumns(preview, -1)[0].label, "Column 1");
  });

  it("moves a field between columns and clears the previous holder", () => {
    let mapping = setColumnField({ brand: 0, name: 1 }, 2, "name");
    assert.deepEqual(mapping, { brand: 0, name: 2 });
    mapping = setColumnField(mapping, 0, "notes");
    assert.deepEqual(mapping, { name: 2, notes: 0 });
    mapping = setColumnField(mapping, 2, null);
    assert.deepEqual(mapping, { notes: 0 });
    assert.equal(fieldForColumn({ brand: 3 }, 3), "brand");
    assert.equal(fieldForColumn({ brand: 3 }, 1), null);
  });

  it("explains blocking mapping problems", () => {
    assert.equal(importMappingError({ brand: 0, name: 1 }, 3, 10), null);
    assert.match(importMappingError({ brand: 0 }, 3, 10) ?? "", /Shade name/);
    assert.match(importMappingError({ brand: 0, name: 1 }, 3, 0) ?? "", /no rows/);
    assert.match(importMappingError({ brand: 0, name: 1 }, 3, 5000) ?? "", /limited/);
  });
});

describe("polish-import — review state", () => {
  const rows = [
    row(2, { matchState: "matched", action: "match", shadeId: "1" }),
    row(3),
    row(4, { matchState: "unmatched", candidates: [] }),
    row(5, { matchState: "invalid", action: "skip", candidates: [], errors: ["Brand is missing"] }),
  ];

  it("groups rows into tabs and counts actions", () => {
    assert.deepEqual(tabCounts(rows), { matched: 1, ambiguous: 1, unmatched: 1, invalid: 1 });
    assert.deepEqual(rowsForTab(rows, "unmatched").map((r) => r.rowNumber), [4]);
    assert.deepEqual(actionCounts(rows), { match: 1, create: 0, skip: 1, pending: 2 });
  });

  it("sets decisions, never on invalid rows, and requires a shade for match", () => {
    const next = setRowDecision(rows, 3, "match", "2");
    assert.equal(next[1].action, "match");
    assert.equal(next[1].shadeId, "2");
    assert.equal(selectedCandidate(next[1])?.shadeId, "2");
    assert.equal(setRowDecision(rows, 3, "match")[1].action, "pending");
    assert.equal(setRowDecision(rows, 5, "create")[3].action, "skip");
    assert.equal(setRowDecision(rows, 2, "create")[0].shadeId, null);
  });

  it("bulk-accepts top candidates and bulk-creates unmatched rows", () => {
    const accepted = acceptTopCandidates(rows);
    assert.equal(accepted[1].shadeId, "1");
    assert.equal(accepted[0].shadeId, "1");
    const created = setActionForState(rows, "unmatched", "create");
    assert.equal(created[2].action, "create");
    assert.equal(created[1].action, "pending");
  });

  it("adds a catalog-search pick as a candidate and matches it", () => {
    const next = pickSearchResult(rows, 4, { shadeId: "77", brand: "OPI", name: "Funny Bunny", finishes: ["sheer"], similarity: 0.61 });
    assert.equal(next[2].action, "match");
    assert.equal(next[2].shadeId, "77");
    assert.equal(next[2].candidates.length, 1);
    assert.equal(next[2].candidates[0].confidence, 0.61);
    const again = pickSearchResult(next, 4, { shadeId: "77", brand: "OPI", name: "Funny Bunny", finishes: [], similarity: 0.61 });
    assert.equal(again[2].candidates.length, 1);
  });

  it("sends only decisions that changed, never pending ones", () => {
    let edited = setRowDecision(rows, 3, "match", "2");
    edited = setRowDecision(edited, 4, "create");
    edited = setRowDecision(edited, 2, "match", "1"); // unchanged
    assert.deepEqual(changedDecisions(rows, edited), [
      { rowNumber: 3, action: "match", shadeId: "2" },
      { rowNumber: 4, action: "create" },
    ]);
  });

  it("round-trips Select values and formats confidence", () => {
    assert.equal(decisionValue({ action: "match", shadeId: "9" }), "match:9");
    assert.equal(decisionValue({ action: "skip", shadeId: null }), "skip");
    assert.deepEqual(parseDecisionValue("match:9"), { action: "match", shadeId: "9" });
    assert.deepEqual(parseDecisionValue("create"), { action: "create" });
    assert.deepEqual(parseDecisionValue("bogus"), { action: "pending" });
    assert.equal(formatConfidence(0.942), "94%");
    assert.equal(formatConfidence(1.2), "100%");
  });
});

describe("polish-import — quantity-0 rows need a status (D5b)", () => {
  const zero = (n: number, overrides: Partial<PolishImportRow> = {}) =>
    row(n, {
      matchState: "matched",
      action: "match",
      shadeId: "1",
      values: { brand: "Essie", name: `Row ${n}`, finishes: [], quantity: 0 },
      ...overrides,
    });
  const rows = [
    zero(2),
    zero(3),
    zero(4, { action: "skip", shadeId: null }), // skipped: no choice needed
    zero(5, { values: { brand: "Essie", name: "Row 5", finishes: [], quantity: 0, status: "wishlist" } }),
    row(6, { matchState: "matched", action: "match", shadeId: "1" }), // no quantity → owned
    zero(7, { matchState: "invalid", action: "skip", shadeId: null }),
  ];

  it("starts quantity-0 rows without a status undecided, and leaves them out of the import count", () => {
    assert.deepEqual(rowsNeedingStatus(rows).map((r) => r.rowNumber), [2, 3]);
    assert.equal(undecidedStatusCount(rows), 2);
    assert.equal(importableCount(rows), 2, "rows 5 and 6 only");
  });

  it("bulk-marks every row that needs a status, with the archive reason", () => {
    const wish = setStatusChoice(rows, "wishlist");
    assert.deepEqual(wish.map((r) => r.statusChoice ?? null), ["wishlist", "wishlist", "wishlist", null, null, null]);
    assert.equal(undecidedStatusCount(wish), 0);
    assert.equal(importableCount(wish), 4);

    const archived = setStatusChoice(rows, "archived", "decluttered");
    assert.equal(archived[0].statusChoice, "archived");
    assert.equal(archived[0].archiveReason, "decluttered");
    assert.equal(setStatusChoice(rows, "archived")[1].archiveReason, "used_up", "default reason");
  });

  it("sets one row's choice and sends status decisions with commit", () => {
    const edited = setStatusChoice(setStatusChoice(rows, "wishlist", undefined, 2), "archived", "decluttered", 3);
    assert.equal(edited[0].statusChoice, "wishlist");
    assert.equal(edited[1].archiveReason, "decluttered");
    assert.equal(edited[2].statusChoice, undefined);
    assert.deepEqual(changedDecisions(rows, edited), [
      { rowNumber: 2, statusChoice: "wishlist" },
      { rowNumber: 3, statusChoice: "archived", archiveReason: "decluttered" },
    ]);
    // A match change and a status choice on the same row travel in one decision.
    const both = setRowDecision(edited, 2, "match", "2");
    assert.deepEqual(changedDecisions(rows, both)[0], { rowNumber: 2, action: "match", shadeId: "2", statusChoice: "wishlist" });
  });

  it("round-trips the status Select value", () => {
    assert.equal(statusChoiceValue({ statusChoice: "wishlist" }), "wishlist");
    assert.equal(statusChoiceValue({ statusChoice: "archived", archiveReason: "decluttered" }), "archived:decluttered");
    assert.equal(statusChoiceValue({ statusChoice: "archived" }), "archived:used_up");
    assert.equal(statusChoiceValue({}), "");
    assert.deepEqual(parseStatusChoiceValue("archived:used_up"), { choice: "archived", reason: "used_up" });
    assert.deepEqual(parseStatusChoiceValue("wishlist"), { choice: "wishlist" });
    assert.equal(parseStatusChoiceValue("owned"), null);
  });
});

describe("mobile additions", () => {
  it("counts UTF-8 bytes, not characters", () => {
    assert.equal(utf8ByteLength("abc"), 3);
    assert.equal(utf8ByteLength("é"), 2);
    assert.equal(utf8ByteLength("€"), 3);
    assert.equal(utf8ByteLength("💅"), 4);
  });

  it("strips a byte order mark only at the start", () => {
    assert.equal(stripBom("\ufeffBrand,Name"), "Brand,Name");
    assert.equal(stripBom("Brand\ufeff"), "Brand\ufeff");
  });

  it("sorts a tab's rows by row number", () => {
    const rows = [row(5), row(2), row(9, { matchState: "matched" })];
    assert.deepEqual(sortedTabRows(rows, "ambiguous").map((r) => r.rowNumber), [2, 5]);
  });

  it("summarizes a sheet row", () => {
    assert.equal(rowSummary({ values: { brand: "Essie", name: "Ballet Slippers", finishes: ["creme", "shimmer", "glitter"] } }), "Ballet Slippers · Essie · creme, shimmer");
  });
});
