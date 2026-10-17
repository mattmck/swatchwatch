/**
 * CSV / spreadsheet import (issue #263): column fields, header-row detection and per-cell
 * value parsing. Pure and shared, so the web wizard previews exactly what the API will do;
 * the API re-runs all of it on the uploaded text (it never trusts client-parsed rows).
 */
import { POLISH_STATUSES, type PolishStatus } from "../types/inventory";

/** Sheet columns the importer understands, in display order. */
export const POLISH_IMPORT_FIELDS = [
  "brand",
  "name",
  "finish",
  "quantity",
  "price",
  "currency",
  "purchaseDate",
  "status",
  "tried",
  "notes",
] as const;

export type PolishImportField = (typeof POLISH_IMPORT_FIELDS)[number];

export const POLISH_IMPORT_FIELD_LABELS: Readonly<Record<PolishImportField, string>> = Object.freeze({
  brand: "Brand",
  name: "Shade name",
  finish: "Finish",
  quantity: "Quantity",
  price: "Price",
  currency: "Currency",
  purchaseDate: "Purchase date",
  status: "Status",
  tried: "Tried",
  notes: "Notes",
});

/** Fields every importable row needs. */
export const POLISH_IMPORT_REQUIRED_FIELDS: readonly PolishImportField[] = ["brand", "name"];

/** Field → 0-based column index. Unmapped fields are absent. */
export type PolishImportColumnMapping = Partial<Record<PolishImportField, number>>;

/** Upload limits (enforced by the API; the web checks them first for a friendlier message). */
export const POLISH_IMPORT_MAX_BYTES = 1024 * 1024;
export const POLISH_IMPORT_MAX_ROWS = 1000;
export const POLISH_IMPORT_MAX_COLUMNS = 100;
export const POLISH_IMPORT_MAX_NOTES_LENGTH = 2000;
export const POLISH_IMPORT_MAX_NAME_LENGTH = 200;
/** How many leading records are scanned for the header row. */
export const POLISH_IMPORT_HEADER_SCAN_ROWS = 10;

/**
 * Header spellings per field, already normalized (lowercase, alphanumerics, single spaces).
 * `strong` names are unambiguous; `weak` ones are only used when no strong column exists
 * (e.g. "Color" is often the shade name, but sometimes a color description).
 */
const HEADER_SYNONYMS: Readonly<Record<PolishImportField, { strong: string[]; weak: string[] }>> = {
  brand: {
    strong: ["brand", "brand name", "polish brand", "maker", "manufacturer", "brands"],
    weak: ["company", "vendor", "label", "make"],
  },
  name: {
    strong: [
      "name",
      "shade",
      "shade name",
      "polish name",
      "polish",
      "color name",
      "colour name",
      "product name",
      "nail polish",
      "shade title",
    ],
    weak: ["color", "colour", "product", "title", "item"],
  },
  finish: {
    strong: ["finish", "finishes", "finish es", "finish type", "polish finish"],
    weak: ["type", "texture", "effect"],
  },
  quantity: {
    strong: ["qty", "quantity", "bottles", "count", "number of bottles", "no of bottles", "num bottles", "how many"],
    weak: ["amount", "number", "copies", "owned qty"],
  },
  price: {
    strong: ["price", "purchase price", "price paid", "cost", "paid", "amount paid", "unit price"],
    weak: ["msrp", "retail price", "value"],
  },
  currency: {
    strong: ["currency", "currency code", "ccy", "cur"],
    weak: [],
  },
  purchaseDate: {
    strong: [
      "purchase date",
      "date purchased",
      "purchased",
      "purchased on",
      "date bought",
      "bought",
      "bought on",
      "date acquired",
      "acquired",
      "acquired date",
      "purchase acquired date",
      "purchased acquired date",
      "order date",
    ],
    weak: ["date", "date added", "added"],
  },
  status: {
    strong: ["status", "collection status", "ownership", "inventory status", "state"],
    weak: ["owned", "own", "have", "list"],
  },
  tried: {
    strong: ["tried", "tried date", "swatched", "tried it", "worn", "used", "tried on", "have tried", "date tried", "tried at"],
    weak: ["wear", "worn yet"],
  },
  notes: {
    strong: ["notes", "note", "comments", "comment", "remarks"],
    weak: ["description", "details", "memo", "review"],
  },
};

/** Lowercase, punctuation → space, collapse whitespace. */
export function normalizeImportHeader(value: string): string {
  return String(value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase → words ("purchaseDate")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type HeaderStrength = 2 | 1;

/** Best field for one header cell, with 2 = strong synonym, 1 = weak synonym / keyword. */
export function matchImportHeader(value: string): { field: PolishImportField; strength: HeaderStrength } | null {
  const normalized = normalizeImportHeader(value);
  if (!normalized) return null;
  for (const field of POLISH_IMPORT_FIELDS) {
    if (HEADER_SYNONYMS[field].strong.includes(normalized)) return { field, strength: 2 };
  }
  for (const field of POLISH_IMPORT_FIELDS) {
    if (HEADER_SYNONYMS[field].weak.includes(normalized)) return { field, strength: 1 };
  }
  // Keyword containment ("Polish Brand Name", "Date of Purchase", "Price (USD)").
  const tokens = normalized.split(" ");
  const has = (word: string) => tokens.includes(word);
  // Identifier / derived columns (e.g. the collection export's "shade id", "display hex",
  // "color family") are never import fields, even when they contain a keyword.
  if (["id", "hex", "family", "url", "sku", "upc", "ean", "gtin"].some(has)) return null;
  if (has("brand")) return { field: "brand", strength: 1 };
  if (has("shade")) return { field: "name", strength: 1 };
  if (has("finish")) return { field: "finish", strength: 1 };
  if (has("qty") || has("quantity")) return { field: "quantity", strength: 1 };
  if (has("currency")) return { field: "currency", strength: 1 };
  if (has("price") || has("cost")) return { field: "price", strength: 1 };
  if (has("purchase") || has("purchased") || has("bought")) return { field: "purchaseDate", strength: 1 };
  if (has("status")) return { field: "status", strength: 1 };
  if (has("tried") || has("swatched")) return { field: "tried", strength: 1 };
  if (has("notes") || has("note") || has("comments")) return { field: "notes", strength: 1 };
  return null;
}

export interface PolishImportHeaderDetection {
  /** 0-based index of the header record, or -1 when no header row was recognized. */
  headerRowIndex: number;
  mapping: PolishImportColumnMapping;
  /**
   * True when brand and name were both found by strong synonyms on a header row with no
   * conflicts. When false the UI asks the user to confirm the mapping.
   */
  confident: boolean;
}

/**
 * Map the cells of one record to fields. Each field takes its best column (strong beats weak,
 * then leftmost); each column maps to at most one field.
 */
export function mapImportHeaderRow(cells: readonly string[]): {
  mapping: PolishImportColumnMapping;
  strongCount: number;
  matchedCount: number;
  strongFields: Set<PolishImportField>;
} {
  const best = new Map<PolishImportField, { column: number; strength: HeaderStrength }>();
  cells.forEach((cell, column) => {
    const match = matchImportHeader(cell);
    if (!match) return;
    const current = best.get(match.field);
    if (!current || match.strength > current.strength) {
      best.set(match.field, { column, strength: match.strength });
    }
  });
  const mapping: PolishImportColumnMapping = {};
  const strongFields = new Set<PolishImportField>();
  let strongCount = 0;
  for (const field of POLISH_IMPORT_FIELDS) {
    const hit = best.get(field);
    if (!hit) continue;
    mapping[field] = hit.column;
    if (hit.strength === 2) {
      strongCount += 1;
      strongFields.add(field);
    }
  }
  return { mapping, strongCount, matchedCount: best.size, strongFields };
}

/**
 * Find the header row among the first `POLISH_IMPORT_HEADER_SCAN_ROWS` records (title rows
 * above the table are common in exported spreadsheets) and map its columns. The row with the
 * most recognized headers wins; it needs at least two, one of them brand or name.
 */
export function detectPolishImportHeader(records: readonly string[][]): PolishImportHeaderDetection {
  let bestIndex = -1;
  let bestScore = 0;
  let bestResult: ReturnType<typeof mapImportHeaderRow> | null = null;
  const limit = Math.min(records.length, POLISH_IMPORT_HEADER_SCAN_ROWS);
  for (let index = 0; index < limit; index += 1) {
    const result = mapImportHeaderRow(records[index]);
    if (result.matchedCount < 2) continue;
    if (result.mapping.brand === undefined && result.mapping.name === undefined) continue;
    const score = result.matchedCount * 10 + result.strongCount;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
      bestResult = result;
    }
  }
  if (!bestResult) {
    return { headerRowIndex: -1, mapping: {}, confident: false };
  }
  const confident =
    bestResult.strongFields.has("brand") && bestResult.strongFields.has("name");
  return { headerRowIndex: bestIndex, mapping: bestResult.mapping, confident };
}

/** Validate a client-supplied mapping against the column count. Returns an error message or null. */
export function validateImportMapping(mapping: unknown, columnCount: number): string | null {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return "mapping must be an object of field → column index";
  }
  const used = new Map<number, string>();
  for (const [field, column] of Object.entries(mapping as Record<string, unknown>)) {
    if (!(POLISH_IMPORT_FIELDS as readonly string[]).includes(field)) {
      return `Unknown import field "${field}"`;
    }
    if (column === null || column === undefined) continue;
    if (typeof column !== "number" || !Number.isInteger(column) || column < 0 || column >= Math.max(columnCount, 1)) {
      return `Column for "${field}" is out of range`;
    }
    const other = used.get(column);
    if (other) return `Column ${column + 1} is mapped to both "${other}" and "${field}"`;
    used.set(column, field);
  }
  for (const field of POLISH_IMPORT_REQUIRED_FIELDS) {
    const column = (mapping as Record<string, unknown>)[field];
    if (typeof column !== "number") return `Map a column to "${POLISH_IMPORT_FIELD_LABELS[field]}"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cell value parsing
// ---------------------------------------------------------------------------

/**
 * Undo the spreadsheet formula guard: exports (including the SwatchWatch collection export)
 * prefix cells starting with `=`, `+`, `-` or `@` with a `'` so spreadsheets don't run them.
 */
export function stripFormulaGuard(value: string | undefined | null): string {
  const text = String(value ?? "");
  return /^'[=+\-@]/.test(text) ? text.slice(1) : text;
}

/** Collapse whitespace and trim. */
export function cleanImportText(value: string | undefined | null): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whole, non-negative bottle count. Blank → undefined. */
export function parseImportQuantity(value: string): { value?: number; error?: string } {
  const text = cleanImportText(value);
  if (!text) return {};
  const match = /^(\d{1,4})(?:[.,]0+)?(?:\s*(?:x|bottles?|pcs?))?$/i.exec(text);
  if (!match) return { error: `quantity "${text}" is not a whole number` };
  return { value: Number(match[1]) };
}

const LETTER_CODE = /^[A-Za-z]{3}$/;
const WHITESPACE = /\s/;

/**
 * A leading (`USD 9.99`) or trailing (`9.99 usd`) 3-letter currency code plus the whitespace
 * between it and the amount. Index loops instead of a `\s*`-wrapped regex keep it linear on
 * user-supplied cells (CodeQL js/polynomial-redos).
 */
function findCurrencyCode(text: string): { code: string; match: string } | undefined {
  const head = text.slice(0, 3);
  if (LETTER_CODE.test(head)) {
    let end = 3;
    while (end < text.length && WHITESPACE.test(text.charAt(end))) end++;
    return { code: head, match: text.slice(0, end) };
  }
  const tail = text.slice(-3);
  if (text.length >= 3 && LETTER_CODE.test(tail)) {
    let start = text.length - 3;
    while (start > 0 && WHITESPACE.test(text.charAt(start - 1))) start--;
    return { code: tail, match: text.slice(start) };
  }
  return undefined;
}

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { "€": "EUR", "£": "GBP", "¥": "JPY", "₩": "KRW", "₹": "INR" };

/**
 * Price with optional currency symbol or code (`$12.50`, `12,50 €`, `USD 9.99`, `1,234.50`).
 * `$` is not mapped to a currency (USD, CAD, AUD, … all use it).
 */
export function parseImportPrice(value: string): { value?: number; currency?: string; error?: string } {
  let text = cleanImportText(value);
  if (!text) return {};
  let currency: string | undefined;
  const code = findCurrencyCode(text);
  if (code) {
    currency = code.code.toUpperCase();
    text = text.replace(code.match, "").trim();
  }
  for (const [symbol, iso] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(symbol)) {
      currency = currency ?? iso;
      text = text.replace(symbol, "").trim();
    }
  }
  text = text.replace(/^\$|\$$/g, "").replace(/\s+/g, "");
  let normalized: string;
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(text)) {
    normalized = text.replace(/,/g, ""); // 1,234.50
  } else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(text)) {
    normalized = text.replace(/\./g, "").replace(",", "."); // 1.234,50
  } else if (/^\d+,\d{1,2}$/.test(text)) {
    normalized = text.replace(",", "."); // 12,50
  } else if (/^\d+(\.\d{1,2})?$/.test(text)) {
    normalized = text;
  } else {
    return { error: `price "${cleanImportText(value)}" is not a number` };
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return { error: `price "${cleanImportText(value)}" is not a number` };
  return { value: Math.round(amount * 100) / 100, currency };
}

/** Three-letter ISO 4217 code, or a currency symbol. Blank → undefined. */
export function parseImportCurrency(value: string): { value?: string; error?: string } {
  const text = cleanImportText(value);
  if (!text) return {};
  if (/^[A-Za-z]{3}$/.test(text)) return { value: text.toUpperCase() };
  if (CURRENCY_SYMBOLS[text]) return { value: CURRENCY_SYMBOLS[text] };
  return { error: `currency "${text}" is not a 3-letter code (e.g. USD)` };
}

/** Day-order used for ambiguous numeric dates like 03/04/2026. */
export type ImportDateOrder = "mdy" | "dmy";

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

const NUMERIC_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/;

/**
 * Decide the day order for a whole date column: `dmy` when some value has a first part > 12,
 * `mdy` when some value has a second part > 12, otherwise `mdy` (the common US export default).
 */
export function detectImportDateOrder(values: readonly string[]): ImportDateOrder {
  let dmy = false;
  let mdy = false;
  for (const value of values) {
    const match = NUMERIC_DATE.exec(cleanImportText(value));
    if (!match) continue;
    if (Number(match[1]) > 12) dmy = true;
    if (Number(match[2]) > 12) mdy = true;
  }
  return dmy && !mdy ? "dmy" : "mdy";
}

/**
 * Calendar date → `YYYY-MM-DD`. Accepts ISO (`2026-10-17`, also with a time), `2026/10/17`,
 * numeric `M/D/YYYY` or `D/M/YYYY` (per `order`), two-digit years (→ 20xx), and month names
 * (`Oct 17, 2026`, `17 October 2026`, `October 2026` → first of the month).
 */
export function parseImportDate(value: string, order: ImportDateOrder = "mdy"): { value?: string; error?: string } {
  const text = cleanImportText(value);
  if (!text) return {};
  const fail = { error: `date "${text}" is not a recognized date (use YYYY-MM-DD)` };

  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(text);
  if (match) {
    const iso = isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    return iso ? { value: iso } : fail;
  }
  match = NUMERIC_DATE.exec(text);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    let year = Number(match[3]);
    if (match[3].length === 2) year += 2000;
    const [month, day] = order === "dmy" ? [b, a] : [a, b];
    const iso = isoDate(year, month, day);
    return iso ? { value: iso } : fail;
  }
  const words = text.toLowerCase().replace(/,/g, " ").replace(/(\d)(st|nd|rd|th)\b/g, "$1").split(/\s+/);
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  for (const word of words) {
    const monthKey = word.slice(0, word.startsWith("sept") ? 4 : 3);
    if (/^[a-z]+\.?$/.test(word) && MONTHS[monthKey] && month === undefined) {
      month = MONTHS[monthKey];
    } else if (/^\d{4}$/.test(word) && year === undefined) {
      year = Number(word);
    } else if (/^\d{1,2}$/.test(word) && day === undefined) {
      day = Number(word);
    } else {
      return fail;
    }
  }
  if (year !== undefined && month !== undefined) {
    const iso = isoDate(year, month, day ?? 1);
    return iso ? { value: iso } : fail;
  }
  return fail;
}

const STATUS_SYNONYMS: Readonly<Record<string, PolishStatus>> = {
  owned: "owned",
  own: "owned",
  have: "owned",
  "have it": "owned",
  "in collection": "owned",
  collection: "owned",
  stash: "owned",
  "in stash": "owned",
  yes: "owned",
  y: "owned",
  untried: "owned",
  wishlist: "wishlist",
  "wish list": "wishlist",
  wish: "wishlist",
  wishlisted: "wishlist",
  want: "wishlist",
  wanted: "wishlist",
  "want it": "wishlist",
  "to buy": "wishlist",
  destash: "destash",
  destashing: "destash",
  "for sale": "destash",
  selling: "destash",
  sell: "destash",
  swap: "destash",
  "for swap": "destash",
  trade: "destash",
  archived: "archived",
  archive: "archived",
  gone: "archived",
  "used up": "archived",
  empty: "archived",
  finished: "archived",
  sold: "archived",
  "gave away": "archived",
  "given away": "archived",
  decluttered: "archived",
  traded: "archived",
};

/** Status cell → `PolishStatus` (case-insensitive, common synonyms). Blank → undefined. */
export function parseImportStatus(value: string): { value?: PolishStatus; error?: string } {
  const text = cleanImportText(value).toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return {};
  const status = STATUS_SYNONYMS[text];
  if (status) return { value: status };
  return { error: `status "${cleanImportText(value)}" is not one of ${POLISH_STATUSES.join(", ")}` };
}

const TRUE_WORDS = new Set(["yes", "y", "true", "1", "x", "tried", "swatched", "worn", "done", "✓", "✔", "☑"]);
const FALSE_WORDS = new Set(["no", "n", "false", "0", "untried", "not yet", "never", "-", "✗", "✘", "☐"]);

/**
 * Tried cell → `true` / `false`, or a date (tried on that day). Blank → undefined.
 */
export function parseImportTried(
  value: string,
  order: ImportDateOrder = "mdy"
): { value?: boolean; date?: string; error?: string } {
  const text = cleanImportText(value);
  if (!text) return {};
  const lower = text.toLowerCase();
  if (TRUE_WORDS.has(lower)) return { value: true };
  if (FALSE_WORDS.has(lower)) return { value: false };
  const date = parseImportDate(text, order);
  if (date.value) return { value: true, date: date.value };
  return { error: `tried "${text}" should be yes/no or a date` };
}

/**
 * Split a finish cell into raw finish strings (`Holo / Shimmer`, `jelly, glitter`,
 * `crelly + flakies`). Canonicalization happens on the API against the finish catalog.
 */
export function splitImportFinishes(value: string): string[] {
  return cleanImportText(value)
    // No `\s*` around the delimiter (polynomial backtracking on space runs); parts are trimmed.
    .split(/[/,;|+&]|\band\b|\bw\/|\bwith\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Normalize brand/shade names for exact comparison (case-, accent-, punctuation-insensitive). */
export function importMatchKey(value: string): string {
  return cleanImportText(value)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
