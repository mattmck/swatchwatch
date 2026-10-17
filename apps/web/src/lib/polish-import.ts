/**
 * Pure helpers for the CSV import wizard (`/polishes/import`, issue #263): file checks, the
 * column-mapping preview (same shared parser + header detection the API runs), and the local
 * review state (decisions per row, tabs, bulk actions). No React, no fetch: unit-tested in
 * `polish-import.test.ts`.
 */
import {
  POLISH_IMPORT_FIELDS,
  POLISH_IMPORT_MAX_BYTES,
  POLISH_IMPORT_MAX_ROWS,
  detectPolishImportHeader,
  parseCsv,
  stripFormulaGuard,
  validateImportMapping,
  type CatalogSearchResult,
  type CsvDelimiter,
  type PolishImportAction,
  type PolishImportCandidate,
  type PolishImportColumnMapping,
  type PolishImportDecision,
  type PolishImportField,
  type PolishImportMatchState,
  type PolishImportRow,
} from "swatchwatch-shared";

export const IMPORT_ACCEPT = ".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain";
const ALLOWED_EXTENSIONS = [".csv", ".tsv", ".txt"];
/** Sample values shown per column in the mapping step. */
const SAMPLE_VALUES = 3;

/** Reject files the API would refuse before reading them. Returns an error message or null. */
export function checkImportFile(file: { name: string; size: number }): string | null {
  const lower = file.name.toLowerCase();
  if (/\.(xlsx|xls|numbers|ods)$/.test(lower)) {
    return "Spreadsheet files can't be read directly. Export or \"Save as\" CSV first, then upload that file.";
  }
  if (lower.includes(".") && !ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return "Upload a .csv file (comma, semicolon or tab separated).";
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > POLISH_IMPORT_MAX_BYTES) {
    return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${POLISH_IMPORT_MAX_BYTES / 1024 / 1024} MB. Split it and import each part.`;
  }
  return null;
}

export interface ImportColumn {
  index: number;
  /** Header cell, or "Column N" for a headerless sheet. */
  label: string;
  samples: string[];
}

export interface ImportPreview {
  delimiter: CsvDelimiter;
  /** Every non-blank record (header included), for re-deriving columns when the header row changes. */
  records: string[][];
  headerRowIndex: number;
  mapping: PolishImportColumnMapping;
  /** False when the header could not be recognized with confidence: the user must check the mapping. */
  confident: boolean;
  columnCount: number;
}

/** Parse the file locally and detect its header row + mapping (mirrors the API). */
export function buildImportPreview(text: string): ImportPreview {
  const parsed = parseCsv(text, { maxRecords: POLISH_IMPORT_MAX_ROWS + 12 });
  const detected = detectPolishImportHeader(parsed.records);
  const columnCount = parsed.records.reduce((max, record) => Math.max(max, record.length), 0);
  return {
    delimiter: parsed.delimiter,
    records: parsed.records,
    headerRowIndex: detected.headerRowIndex,
    mapping: detected.mapping,
    confident: detected.confident,
    columnCount,
  };
}

/** Columns with their header label and a few sample values below the header row. */
export function importColumns(preview: Pick<ImportPreview, "records" | "columnCount">, headerRowIndex: number): ImportColumn[] {
  const header = headerRowIndex >= 0 ? preview.records[headerRowIndex] ?? [] : [];
  const data = preview.records.slice(headerRowIndex + 1);
  return Array.from({ length: preview.columnCount }, (_, index) => ({
    index,
    label: header[index]?.trim() || `Column ${index + 1}`,
    samples: data
      .map((record) => stripFormulaGuard(record[index] ?? "").trim())
      .filter((value) => value.length > 0)
      .slice(0, SAMPLE_VALUES),
  }));
}

/** Data rows the import will contain for a header row choice. */
export function importDataRowCount(preview: Pick<ImportPreview, "records">, headerRowIndex: number): number {
  return Math.max(0, preview.records.length - (headerRowIndex + 1));
}

/** Field mapped to a column, if any. */
export function fieldForColumn(mapping: PolishImportColumnMapping, column: number): PolishImportField | null {
  return POLISH_IMPORT_FIELDS.find((field) => mapping[field] === column) ?? null;
}

/**
 * Assign `field` to `column` (or clear the column with `null`). A field lives on one column
 * and a column holds one field, so the previous holders are cleared.
 */
export function setColumnField(
  mapping: PolishImportColumnMapping,
  column: number,
  field: PolishImportField | null
): PolishImportColumnMapping {
  const next: PolishImportColumnMapping = {};
  for (const key of POLISH_IMPORT_FIELDS) {
    const current = mapping[key];
    if (current === undefined || current === column || key === field) continue;
    next[key] = current;
  }
  if (field) next[field] = column;
  return next;
}

/** Problem with the mapping that blocks upload, or null. */
export function importMappingError(mapping: PolishImportColumnMapping, columnCount: number, dataRows: number): string | null {
  if (dataRows === 0) return "There are no rows below the header row.";
  if (dataRows > POLISH_IMPORT_MAX_ROWS) {
    return `This file has ${dataRows} rows; imports are limited to ${POLISH_IMPORT_MAX_ROWS}. Split it and import each part.`;
  }
  return validateImportMapping(mapping, columnCount);
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export type ImportTab = PolishImportMatchState;
export const IMPORT_TABS: readonly ImportTab[] = ["matched", "ambiguous", "unmatched", "invalid"];

export const IMPORT_TAB_LABELS: Readonly<Record<ImportTab, string>> = {
  matched: "Matched",
  ambiguous: "Needs review",
  unmatched: "Not in catalog",
  invalid: "Can't import",
};

export function rowsForTab(rows: readonly PolishImportRow[], tab: ImportTab): PolishImportRow[] {
  return rows.filter((row) => row.matchState === tab);
}

export function tabCounts(rows: readonly PolishImportRow[]): Record<ImportTab, number> {
  const counts: Record<ImportTab, number> = { matched: 0, ambiguous: 0, unmatched: 0, invalid: 0 };
  for (const row of rows) counts[row.matchState] += 1;
  return counts;
}

/** What will happen on commit, per action (pending rows are skipped). */
export function actionCounts(rows: readonly PolishImportRow[]): Record<PolishImportAction, number> {
  const counts: Record<PolishImportAction, number> = { match: 0, create: 0, skip: 0, pending: 0 };
  for (const row of rows) counts[row.action] += 1;
  return counts;
}

/** Set one row's decision. `shadeId` is required for `match` and ignored otherwise. */
export function setRowDecision(
  rows: readonly PolishImportRow[],
  rowNumber: number,
  action: PolishImportAction,
  shadeId?: string | null
): PolishImportRow[] {
  return rows.map((row) => {
    if (row.rowNumber !== rowNumber || row.matchState === "invalid") return row;
    if (action === "match" && !shadeId) return row;
    return { ...row, action, shadeId: action === "match" ? shadeId ?? null : null };
  });
}

/** Ambiguous rows still pending → match their best candidate. */
export function acceptTopCandidates(rows: readonly PolishImportRow[]): PolishImportRow[] {
  return rows.map((row) =>
    row.matchState === "ambiguous" && row.action === "pending" && row.candidates[0]
      ? { ...row, action: "match", shadeId: row.candidates[0].shadeId }
      : row
  );
}

/** Set every row in `state` to `action` (create / skip), e.g. "create all unmatched". */
export function setActionForState(
  rows: readonly PolishImportRow[],
  state: Exclude<PolishImportMatchState, "invalid">,
  action: "create" | "skip"
): PolishImportRow[] {
  return rows.map((row) => (row.matchState === state ? { ...row, action, shadeId: null } : row));
}

/** Add a catalog-search pick as a candidate (if new) and match the row to it. */
export function pickSearchResult(
  rows: readonly PolishImportRow[],
  rowNumber: number,
  result: Pick<CatalogSearchResult, "shadeId" | "brand" | "name" | "finishes" | "similarity">
): PolishImportRow[] {
  return rows.map((row) => {
    if (row.rowNumber !== rowNumber || row.matchState === "invalid") return row;
    const known = row.candidates.some((candidate) => candidate.shadeId === result.shadeId);
    const candidate: PolishImportCandidate = {
      shadeId: result.shadeId,
      brand: result.brand,
      name: result.name,
      finishes: result.finishes ?? [],
      hex: null,
      confidence: Math.round(result.similarity * 1000) / 1000,
      inCollection: false,
      userSubmitted: false,
      exactMatch: false,
    };
    return {
      ...row,
      candidates: known ? row.candidates : [...row.candidates, candidate],
      action: "match",
      shadeId: result.shadeId,
    };
  });
}

/** Decisions that differ from what the server stored (sent with commit). */
export function changedDecisions(
  original: readonly PolishImportRow[],
  edited: readonly PolishImportRow[]
): PolishImportDecision[] {
  const before = new Map(original.map((row) => [row.rowNumber, row]));
  const out: PolishImportDecision[] = [];
  for (const row of edited) {
    const prior = before.get(row.rowNumber);
    if (!prior || row.action === "pending") continue;
    if (prior.action === row.action && prior.shadeId === row.shadeId) continue;
    out.push(
      row.action === "match"
        ? { rowNumber: row.rowNumber, action: "match", shadeId: row.shadeId ?? undefined }
        : { rowNumber: row.rowNumber, action: row.action }
    );
  }
  return out;
}

/** Encode/decode a row decision as one Select value. */
export function decisionValue(row: Pick<PolishImportRow, "action" | "shadeId">): string {
  return row.action === "match" && row.shadeId ? `match:${row.shadeId}` : row.action;
}

export function parseDecisionValue(value: string): { action: PolishImportAction; shadeId?: string } {
  if (value.startsWith("match:")) return { action: "match", shadeId: value.slice("match:".length) };
  if (value === "create" || value === "skip" || value === "pending") return { action: value };
  return { action: "pending" };
}

export function formatConfidence(confidence: number): string {
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}

/** The candidate a row is currently matched to, if any. */
export function selectedCandidate(row: PolishImportRow): PolishImportCandidate | null {
  if (row.action !== "match" || !row.shadeId) return null;
  return row.candidates.find((candidate) => candidate.shadeId === row.shadeId) ?? null;
}
