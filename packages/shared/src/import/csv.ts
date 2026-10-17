/**
 * Small RFC 4180-style CSV parser shared by the web import wizard (column mapping preview)
 * and the Functions import API (authoritative parse). No dependencies, no I/O.
 *
 * Handles: a UTF-8 BOM, quoted fields with `""` escapes, delimiters and newlines inside
 * quotes, CRLF / LF / CR line endings, an Excel `sep=;` first line, and delimiter
 * auto-detection (`,` `;` tab `|`). Blank records are dropped but every record keeps the
 * physical line it started on, so errors can point at the spreadsheet row.
 */

export type CsvDelimiter = "," | ";" | "\t" | "|";

export const CSV_DELIMITERS: readonly CsvDelimiter[] = [",", ";", "\t", "|"];

export interface CsvParseOptions {
  /** Force a delimiter; auto-detected when omitted. */
  delimiter?: CsvDelimiter;
  /** Stop after this many non-blank records (the result is then `truncated`). */
  maxRecords?: number;
}

export interface CsvParseResult {
  /** Non-blank records; cells are untrimmed strings. */
  records: string[][];
  /** 1-based physical line each record starts on (parallel to `records`). */
  lineNumbers: number[];
  delimiter: CsvDelimiter;
  /** True when a quoted field was still open at end of input (it was closed leniently). */
  unterminatedQuote: boolean;
  /** True when `maxRecords` stopped the parse early. */
  truncated: boolean;
}

const SEP_DIRECTIVE = /^sep=(.)\r?\n?/i;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Count each candidate delimiter outside quotes on the first few lines and pick the one that
 * appears most consistently (same non-zero count on most lines, then highest count).
 * Defaults to `,`.
 */
export function detectCsvDelimiter(text: string): CsvDelimiter {
  const body = stripBom(text);
  const directive = SEP_DIRECTIVE.exec(body);
  if (directive && (CSV_DELIMITERS as readonly string[]).includes(directive[1])) {
    return directive[1] as CsvDelimiter;
  }

  const counts: Array<Record<CsvDelimiter, number>> = [];
  let current: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  let inQuotes = false;
  for (let i = 0; i < body.length && counts.length < 10; i += 1) {
    const ch = body[i];
    if (ch === '"') {
      if (inQuotes && body[i + 1] === '"') {
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && body[i + 1] === "\n") i += 1;
      counts.push(current);
      current = { ",": 0, ";": 0, "\t": 0, "|": 0 };
    } else if (!inQuotes && (ch === "," || ch === ";" || ch === "\t" || ch === "|")) {
      current[ch] += 1;
    }
  }
  counts.push(current);
  const lines = counts.filter((line) => CSV_DELIMITERS.some((d) => line[d] > 0));
  if (lines.length === 0) return ",";

  let best: CsvDelimiter = ",";
  let bestScore = -1;
  for (const delimiter of CSV_DELIMITERS) {
    const perLine = lines.map((line) => line[delimiter]);
    const nonZero = perLine.filter((n) => n > 0);
    if (nonZero.length === 0) continue;
    // Most common non-zero count, and on how many lines it occurs.
    const freq = new Map<number, number>();
    for (const n of nonZero) freq.set(n, (freq.get(n) ?? 0) + 1);
    let modeCount = 0;
    let mode = 0;
    for (const [n, f] of freq) {
      if (f > modeCount || (f === modeCount && n > mode)) {
        modeCount = f;
        mode = n;
      }
    }
    // Consistency dominates; the per-line count breaks ties (`;` sheets often contain commas
    // inside unquoted decimal prices, but not on every line with the same count).
    const score = modeCount * 1000 + mode;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** Parse CSV text into records. Never throws; see `CsvParseResult` for lenient cases. */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvParseResult {
  let body = stripBom(text ?? "");
  let line = 1;
  const directive = SEP_DIRECTIVE.exec(body);
  let delimiter: CsvDelimiter;
  if (directive && (CSV_DELIMITERS as readonly string[]).includes(directive[1])) {
    delimiter = options.delimiter ?? (directive[1] as CsvDelimiter);
    body = body.slice(directive[0].length);
    line = 2;
  } else {
    delimiter = options.delimiter ?? detectCsvDelimiter(body);
  }
  const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;

  const records: string[][] = [];
  const lineNumbers: number[] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false; // a quoted field opened at the start of this field
  let recordLine = line;
  let truncated = false;

  const pushRecord = (): boolean => {
    record.push(field);
    field = "";
    fieldStarted = false;
    const blank = record.every((cell) => cell.trim() === "");
    if (!blank) {
      records.push(record);
      lineNumbers.push(recordLine);
    }
    record = [];
    if (records.length >= maxRecords) {
      truncated = true;
      return false;
    }
    return true;
  };

  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        // Embedded newline: normalize to \n and keep counting physical lines.
        field += "\n";
        line += 1;
        i += ch === "\r" && body[i + 1] === "\n" ? 2 : 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field.trim() === "" && !fieldStarted) {
      // Opening quote (leading spaces before it are dropped, as spreadsheets do).
      field = "";
      inQuotes = true;
      fieldStarted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      record.push(field);
      field = "";
      fieldStarted = false;
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      i += ch === "\r" && body[i + 1] === "\n" ? 2 : 1;
      if (!pushRecord()) break;
      line += 1;
      recordLine = line;
      continue;
    }
    field += ch;
    i += 1;
  }

  const unterminatedQuote = inQuotes;
  if (!truncated && (field !== "" || record.length > 0)) {
    pushRecord();
    // A record ending exactly at maxRecords is complete, not truncated.
    truncated = false;
  }
  if (truncated) {
    // Truncated only if non-blank content remains after the last record we kept.
    truncated = body.slice(i).trim() !== "";
  }

  return { records, lineNumbers, delimiter, unterminatedQuote, truncated };
}
