/**
 * RFC 4180 CSV writing with spreadsheet formula-injection protection (issue #264).
 *
 * - Records end with CRLF; a cell is quoted when it contains `"`, `,`, CR or LF, or has
 *   leading/trailing whitespace, and embedded quotes are doubled.
 * - Formula injection (CWE-1236): a cell starting with `=`, `+`, `-`, `@`, TAB or CR would be
 *   evaluated by Excel / Sheets / LibreOffice. Such cells are prefixed with `'` so they open as
 *   text. The guard runs before quoting, so a guarded cell is still quoted when it needs to be.
 * - `CSV_UTF8_BOM` makes Excel open the file as UTF-8 (otherwise accents and emoji are garbled).
 */

/** UTF-8 byte-order mark, written once at the very start of the file. */
export const CSV_UTF8_BOM = "\uFEFF";

/** RFC 4180 record separator. */
export const CSV_RECORD_SEPARATOR = "\r\n";

/** Leading characters a spreadsheet may interpret as a formula (OWASP CSV injection list). */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]|^\s|\s$/;

/** Prefix `'` when the value would be treated as a formula by a spreadsheet. */
export function neutralizeCsvFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/** Encode one cell: formula guard, then RFC 4180 quoting. null/undefined → empty cell. */
export function encodeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = neutralizeCsvFormula(String(value));
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Encode one record (cells joined by `,`, terminated by CRLF). */
export function encodeCsvRecord(cells: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return cells.map(encodeCsvCell).join(",") + CSV_RECORD_SEPARATOR;
}
