/**
 * CSV / spreadsheet import (issue #263): the pure half of the import API.
 *
 * - `buildImportRows` parses the uploaded text (shared CSV parser), finds or applies the
 *   column mapping, and turns every record into validated values + warnings/errors. Finishes
 *   go through the DB-backed finish catalog; prices/currencies/dates go through the #261
 *   inventory validation (`parseInventoryFields`) so commit never sees a value it would reject.
 * - `rankCandidates` / `classifyMatch` score fuzzy catalog hits and decide matched /
 *   ambiguous / unmatched.
 * - `applyDecisions` validates review decisions; `buildUpsertRequest` turns a row into the
 *   body the #261 inventory upsert takes.
 *
 * No DB access here: the handlers in `functions/polish-imports.ts` do the queries.
 */
import {
  POLISH_IMPORT_FIELDS,
  POLISH_IMPORT_MAX_COLUMNS,
  POLISH_IMPORT_MAX_NAME_LENGTH,
  POLISH_IMPORT_MAX_NOTES_LENGTH,
  POLISH_IMPORT_MAX_ROWS,
  cleanImportText,
  detectImportDateOrder,
  detectPolishImportHeader,
  importMatchKey,
  parseCsv,
  parseImportCurrency,
  parseImportDate,
  parseImportPrice,
  parseImportQuantity,
  parseImportStatus,
  parseImportTried,
  splitImportFinishes,
  stripFormulaGuard,
  validateImportMapping,
  type CsvDelimiter,
  type PolishImportAction,
  type PolishImportCandidate,
  type PolishImportColumnMapping,
  type PolishImportCounts,
  type PolishImportDecision,
  type PolishImportMatchState,
  type PolishImportRow,
  type PolishImportRowValues,
  type PolishStatus,
  type PolishUpdateRequest,
} from "swatchwatch-shared";
import { canonicalizeFinish, type FinishCatalog, DEFAULT_FINISH_CATALOG } from "./finishes";
import {
  InventoryValidationError,
  parseInventoryFields,
  type InventoryFieldsUpdate,
} from "./inventory";

/** Thrown for invalid client input; handlers answer 400 with `message`. */
export class ImportRequestError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "ImportRequestError";
  }
}

/** Score at or above which a single clear candidate is auto-matched. */
export const MATCHED_MIN_CONFIDENCE = 0.9;
/** Required lead of the best candidate over the runner-up for an auto-match. */
export const MATCHED_MIN_MARGIN = 0.08;
/** Below this the row is `unmatched` (candidates are still offered as suggestions). */
export const AMBIGUOUS_MIN_CONFIDENCE = 0.45;
/** Weights of brand vs shade-name similarity in a candidate's confidence. */
export const BRAND_WEIGHT = 0.35;
export const NAME_WEIGHT = 0.65;
/** Finish agreement nudges the score (helps pick between same-name shades). */
export const FINISH_BONUS = 0.05;
export const MAX_CANDIDATES = 5;

export interface ParsedImport {
  delimiter: CsvDelimiter;
  headers: string[];
  headerRowIndex: number;
  mapping: PolishImportColumnMapping;
  /** True when the mapping was detected (not client-supplied) with full confidence. */
  confident: boolean;
  rows: PolishImportRow[];
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Parse + map + validate an uploaded sheet. Throws `ImportRequestError` for whole-file
 * problems (empty, too many rows/columns, no usable mapping); per-row problems become row
 * `warnings` (value ignored) or `errors` (row is `invalid`).
 */
export function buildImportRows(
  csv: string,
  options: { mapping?: PolishImportColumnMapping; headerRowIndex?: number; finishCatalog?: FinishCatalog; now?: Date } = {}
): ParsedImport {
  const catalog = options.finishCatalog ?? DEFAULT_FINISH_CATALOG;
  // +12 leaves room for a title block and the header row above the data.
  const parsed = parseCsv(csv, { maxRecords: POLISH_IMPORT_MAX_ROWS + 12 });
  if (parsed.records.length === 0) {
    throw new ImportRequestError("The file has no rows");
  }
  const columnCount = Math.max(...parsed.records.map((record) => record.length));
  if (columnCount > POLISH_IMPORT_MAX_COLUMNS) {
    throw new ImportRequestError(`The file has more than ${POLISH_IMPORT_MAX_COLUMNS} columns`);
  }

  let headerRowIndex: number;
  let mapping: PolishImportColumnMapping;
  let confident = false;
  if (options.mapping) {
    headerRowIndex = options.headerRowIndex ?? detectPolishImportHeader(parsed.records).headerRowIndex;
    if (!Number.isInteger(headerRowIndex) || headerRowIndex < -1 || headerRowIndex >= parsed.records.length) {
      throw new ImportRequestError("headerRowIndex is out of range");
    }
    const mappingError = validateImportMapping(options.mapping, columnCount);
    if (mappingError) throw new ImportRequestError(mappingError);
    mapping = {};
    for (const field of POLISH_IMPORT_FIELDS) {
      const column = options.mapping[field];
      if (typeof column === "number") mapping[field] = column;
    }
  } else {
    const detected = detectPolishImportHeader(parsed.records);
    if (detected.headerRowIndex < 0 || detected.mapping.brand === undefined || detected.mapping.name === undefined) {
      throw new ImportRequestError(
        "Could not find brand and shade name columns; map the columns and try again",
        422
      );
    }
    headerRowIndex = detected.headerRowIndex;
    mapping = detected.mapping;
    confident = detected.confident;
  }

  const dataRecords = parsed.records.slice(headerRowIndex + 1);
  const dataLines = parsed.lineNumbers.slice(headerRowIndex + 1);
  if (dataRecords.length === 0) {
    throw new ImportRequestError("The file has a header row but no data rows");
  }
  if (dataRecords.length > POLISH_IMPORT_MAX_ROWS || parsed.truncated) {
    throw new ImportRequestError(`Imports are limited to ${POLISH_IMPORT_MAX_ROWS} rows; split the file and import each part`);
  }

  const cell = (record: string[], field: keyof PolishImportColumnMapping): string => {
    const column = mapping[field];
    return typeof column === "number" ? stripFormulaGuard(record[column] ?? "") : "";
  };
  const dateValues = dataRecords.flatMap((record) => [cell(record, "purchaseDate"), cell(record, "tried")]);
  const dateOrder = detectImportDateOrder(dateValues);

  const rows = dataRecords.map((record, index) =>
    buildRow(record, dataLines[index], cell, dateOrder, catalog, options.now ?? new Date())
  );
  return {
    delimiter: parsed.delimiter,
    headers: headerRowIndex >= 0 ? parsed.records[headerRowIndex].map((value) => cleanImportText(value)) : [],
    headerRowIndex,
    mapping,
    confident,
    rows,
  };
}

/** Run one value through the #261 validation; returns the error message, if any. */
function inventoryError(body: Record<string, unknown>): string | null {
  try {
    parseInventoryFields(body);
    return null;
  } catch (error) {
    if (error instanceof InventoryValidationError) return error.message;
    throw error;
  }
}

function buildRow(
  record: string[],
  rowNumber: number,
  cell: (record: string[], field: keyof PolishImportColumnMapping) => string,
  dateOrder: "mdy" | "dmy",
  catalog: FinishCatalog,
  now: Date
): PolishImportRow {
  const warnings: string[] = [];
  const errors: string[] = [];
  const brand = truncate(cleanImportText(cell(record, "brand")), POLISH_IMPORT_MAX_NAME_LENGTH);
  const name = truncate(cleanImportText(cell(record, "name")), POLISH_IMPORT_MAX_NAME_LENGTH);
  if (!brand) errors.push("Brand is missing");
  if (!name) errors.push("Shade name is missing");

  const values: PolishImportRowValues = { brand, name, finishes: [] };

  for (const raw of splitImportFinishes(cell(record, "finish"))) {
    const canonical = canonicalizeFinish(raw, catalog);
    if (canonical) {
      if (!values.finishes.includes(canonical)) values.finishes.push(canonical);
    } else {
      warnings.push(`Unknown finish "${raw}" ignored`);
    }
  }

  const quantity = parseImportQuantity(cell(record, "quantity"));
  if (quantity.error) warnings.push(`Ignored ${quantity.error}`);
  else if (quantity.value !== undefined) values.quantity = quantity.value;

  const price = parseImportPrice(cell(record, "price"));
  if (price.error) {
    warnings.push(`Ignored ${price.error}`);
  } else if (price.value !== undefined) {
    const message = inventoryError({ purchasePrice: price.value });
    if (message) warnings.push(`Ignored price: ${message}`);
    else values.purchasePrice = price.value;
  }

  const currency = parseImportCurrency(cell(record, "currency"));
  if (currency.error) warnings.push(`Ignored ${currency.error}`);
  const currencyValue = currency.value ?? price.currency;
  if (currencyValue) {
    const message = inventoryError({ purchaseCurrency: currencyValue });
    if (message) warnings.push(`Ignored currency: ${message}`);
    else values.purchaseCurrency = currencyValue;
  }

  const purchaseDate = parseImportDate(cell(record, "purchaseDate"), dateOrder);
  if (purchaseDate.error) {
    warnings.push(`Ignored purchase ${purchaseDate.error}`);
  } else if (purchaseDate.value) {
    if (Date.parse(`${purchaseDate.value}T00:00:00Z`) > now.getTime() + 24 * 60 * 60 * 1000) {
      warnings.push(`Ignored purchase date ${purchaseDate.value}: it is in the future`);
    } else {
      values.purchaseDate = purchaseDate.value;
    }
  }

  const status = parseImportStatus(cell(record, "status"));
  if (status.error) warnings.push(`Ignored ${status.error}`);
  else if (status.value) values.status = status.value;

  const tried = parseImportTried(cell(record, "tried"), dateOrder);
  if (tried.error) {
    warnings.push(`Ignored ${tried.error}`);
  } else if (tried.value !== undefined) {
    values.tried = tried.value;
    if (tried.date) {
      const message = inventoryError({ triedAt: tried.date });
      if (message) warnings.push(`Ignored tried date ${tried.date}: ${message}`);
      else values.triedOn = tried.date;
    }
  }

  const notes = String(cell(record, "notes") ?? "").trim();
  if (notes) {
    if (notes.length > POLISH_IMPORT_MAX_NOTES_LENGTH) {
      warnings.push(`Notes truncated to ${POLISH_IMPORT_MAX_NOTES_LENGTH} characters`);
    }
    values.notes = truncate(notes, POLISH_IMPORT_MAX_NOTES_LENGTH);
  }

  const invalid = errors.length > 0;
  return {
    rowNumber,
    values,
    matchState: invalid ? "invalid" : "unmatched",
    confidence: 0,
    candidates: [],
    action: invalid ? "skip" : "pending",
    shadeId: null,
    warnings,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** One fuzzy catalog hit for a row (from the batched trigram queries). */
export interface CatalogHit {
  shadeId: string;
  brand: string;
  name: string;
  finishes: string[];
  hex: string | null;
  /** 0–1 trigram similarity of the row's brand to the shade's brand (0 for a brand-less search). */
  brandSimilarity: number;
  /** 0–1 trigram similarity of the row's shade name to the shade name or one of its aliases. */
  nameSimilarity: number;
  inCollection: boolean;
  userSubmitted: boolean;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Brand and shade name both equal the row's (ignoring case, accents and punctuation, or via an alias). */
export function isExactHit(values: Pick<PolishImportRowValues, "brand" | "name">, hit: CatalogHit): boolean {
  const brand = importMatchKey(values.brand) === importMatchKey(hit.brand) || hit.brandSimilarity >= 0.999;
  const name = importMatchKey(values.name) === importMatchKey(hit.name) || hit.nameSimilarity >= 0.999;
  return brand && name;
}

/** Confidence of one hit for a row: weighted brand + name similarity, nudged by finish agreement. */
export function scoreCandidate(values: Pick<PolishImportRowValues, "brand" | "name" | "finishes">, hit: CatalogHit): number {
  const brandSimilarity = importMatchKey(values.brand) === importMatchKey(hit.brand) ? 1 : hit.brandSimilarity;
  const nameSimilarity = importMatchKey(values.name) === importMatchKey(hit.name) ? 1 : hit.nameSimilarity;
  let score = BRAND_WEIGHT * brandSimilarity + NAME_WEIGHT * nameSimilarity;
  if (values.finishes.length > 0 && hit.finishes.length > 0) {
    const overlap = values.finishes.some((finish) => hit.finishes.includes(finish));
    score += overlap ? FINISH_BONUS : -FINISH_BONUS;
  }
  return round3(Math.min(1, Math.max(0, score)));
}

/**
 * Merge hits for a row (one shade can come back once per candidate brand), score them, and
 * rank best first: confidence, then shades already in the caller's collection (so a re-import
 * lands on the row it created last time), then shared catalog rows before private ones.
 */
export function rankCandidates(
  values: Pick<PolishImportRowValues, "brand" | "name" | "finishes">,
  hits: readonly CatalogHit[]
): PolishImportCandidate[] {
  const byShade = new Map<string, PolishImportCandidate>();
  for (const hit of hits) {
    const confidence = scoreCandidate(values, hit);
    const existing = byShade.get(hit.shadeId);
    if (existing && existing.confidence >= confidence) continue;
    byShade.set(hit.shadeId, {
      shadeId: hit.shadeId,
      brand: hit.brand,
      name: hit.name,
      finishes: hit.finishes,
      hex: hit.hex,
      confidence,
      inCollection: hit.inCollection,
      userSubmitted: hit.userSubmitted,
      exactMatch: isExactHit(values, hit),
    });
  }
  return [...byShade.values()]
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        Number(b.inCollection) - Number(a.inCollection) ||
        Number(a.userSubmitted) - Number(b.userSubmitted) ||
        Number(a.shadeId) - Number(b.shadeId)
    )
    .slice(0, MAX_CANDIDATES);
}

/**
 * matched / ambiguous / unmatched from ranked candidates, plus the shade to pre-select.
 *
 * A single exact brand + name candidate is matched outright (sheets often hold "Shade 1" next
 * to "Shade 10"); several exact candidates (same name, different finishes) are matched only
 * when the row's finish singles one out. Otherwise the best candidate is matched when it is
 * confident and clearly ahead of the runner-up.
 */
export function classifyMatch(
  candidates: readonly PolishImportCandidate[],
  rowFinishes: readonly string[] = []
): { state: PolishImportMatchState; shadeId: string | null } {
  const exact = candidates.filter((candidate) => candidate.exactMatch);
  if (exact.length === 1) return { state: "matched", shadeId: exact[0].shadeId };
  if (exact.length > 1) {
    const byFinish = rowFinishes.length
      ? exact.filter((candidate) => candidate.finishes.some((finish) => rowFinishes.includes(finish)))
      : [];
    if (byFinish.length === 1) return { state: "matched", shadeId: byFinish[0].shadeId };
    return { state: "ambiguous", shadeId: null };
  }
  const state = classifyByScore(candidates);
  return { state, shadeId: state === "matched" ? candidates[0].shadeId : null };
}

function classifyByScore(candidates: readonly PolishImportCandidate[]): PolishImportMatchState {
  const [top, second] = candidates;
  if (!top || top.confidence < AMBIGUOUS_MIN_CONFIDENCE) return "unmatched";
  if (
    top.confidence >= MATCHED_MIN_CONFIDENCE &&
    (!second || top.confidence - second.confidence >= MATCHED_MIN_MARGIN)
  ) {
    return "matched";
  }
  return "ambiguous";
}

/** Attach ranked candidates and the default decision to a (valid) row. */
export function withMatchResult(row: PolishImportRow, hits: readonly CatalogHit[]): PolishImportRow {
  if (row.matchState === "invalid") return row;
  const candidates = rankCandidates(row.values, hits);
  const { state, shadeId } = classifyMatch(candidates, row.values.finishes);
  return {
    ...row,
    candidates,
    matchState: state,
    confidence: candidates[0]?.confidence ?? 0,
    action: state === "matched" ? "match" : "pending",
    shadeId,
  };
}

export function countRows(rows: readonly PolishImportRow[]): PolishImportCounts {
  const counts: PolishImportCounts = { total: rows.length, matched: 0, ambiguous: 0, unmatched: 0, invalid: 0 };
  for (const row of rows) counts[row.matchState] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Review decisions
// ---------------------------------------------------------------------------

const DECISION_ACTIONS: ReadonlySet<string> = new Set(["match", "create", "skip"]);
export const MAX_DECISIONS = 5000;

/** Strict positive-integer id (as in the add-endpoint conventions). */
export function parseShadeIdParam(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

/** Validate the shape of a decisions body. @throws ImportRequestError */
export function parseDecisions(body: unknown): PolishImportDecision[] {
  if (body === undefined || body === null) return [];
  const source = body as { decisions?: unknown };
  if (typeof body !== "object" || !Array.isArray(source.decisions)) {
    throw new ImportRequestError("decisions must be an array");
  }
  if (source.decisions.length > MAX_DECISIONS) {
    throw new ImportRequestError(`At most ${MAX_DECISIONS} decisions per request`);
  }
  return source.decisions.map((raw, index) => {
    const decision = (raw ?? {}) as Record<string, unknown>;
    const rowNumber = decision.rowNumber;
    if (typeof rowNumber !== "number" || !Number.isSafeInteger(rowNumber) || rowNumber < 1) {
      throw new ImportRequestError(`decisions[${index}].rowNumber must be a positive integer`);
    }
    if (typeof decision.action !== "string" || !DECISION_ACTIONS.has(decision.action)) {
      throw new ImportRequestError(`decisions[${index}].action must be match, create or skip`);
    }
    const action = decision.action as PolishImportDecision["action"];
    if (action === "match") {
      const shadeId = parseShadeIdParam(decision.shadeId);
      if (!shadeId) throw new ImportRequestError(`decisions[${index}].shadeId is required for match`);
      return { rowNumber, action, shadeId };
    }
    return { rowNumber, action };
  });
}

/**
 * Apply decisions to stored rows. Returns the updated rows and the chosen shade ids that are
 * NOT among a row's own candidates (the caller must check those are visible to the user).
 * @throws ImportRequestError for an unknown row or a decision the row cannot take.
 */
export function applyDecisions(
  rows: readonly PolishImportRow[],
  decisions: readonly PolishImportDecision[]
): { rows: PolishImportRow[]; shadeIdsToVerify: string[] } {
  const byNumber = new Map(rows.map((row, index) => [row.rowNumber, index]));
  const next = rows.slice();
  const toVerify = new Set<string>();
  for (const decision of decisions) {
    const index = byNumber.get(decision.rowNumber);
    if (index === undefined) throw new ImportRequestError(`Row ${decision.rowNumber} is not in this import`);
    const row = next[index];
    if (row.matchState === "invalid" && decision.action !== "skip") {
      throw new ImportRequestError(`Row ${decision.rowNumber} is invalid and can only be skipped`);
    }
    const action: PolishImportAction = decision.action;
    const shadeId = decision.action === "match" ? decision.shadeId ?? null : null;
    if (shadeId && !row.candidates.some((candidate) => candidate.shadeId === shadeId)) {
      toVerify.add(shadeId);
    }
    next[index] = { ...row, action, shadeId };
  }
  return { rows: next, shadeIdsToVerify: [...toVerify] };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface ExistingInventory {
  inCollection: boolean;
  /** ISO timestamp of the stored `tried_at`, null when untried. */
  triedAt: string | null;
}

/**
 * Build the #261 upsert body + validated fields for a row.
 *
 * - Blank cells are omitted, so a re-import never clears a value the sheet does not carry.
 * - A NEW inventory row without a status column defaults to `owned` (an imported sheet is a
 *   collection), or `wishlist` when the sheet says quantity 0. Existing rows keep their status.
 * - tried = yes keeps an existing `tried_at`; otherwise it stores the tried date from the
 *   sheet, else the purchase date, else today. tried = no clears it.
 */
export function buildUpsertRequest(
  values: PolishImportRowValues,
  existing: ExistingInventory,
  now: Date = new Date()
): { body: PolishUpdateRequest; fields: InventoryFieldsUpdate } {
  const body: PolishUpdateRequest = {};
  if (values.quantity !== undefined) body.quantity = values.quantity;
  if (values.notes) body.notes = values.notes;
  if (values.purchaseDate) body.purchaseDate = values.purchaseDate;
  if (values.purchasePrice !== undefined) body.purchasePrice = values.purchasePrice;
  if (values.purchaseCurrency) body.purchaseCurrency = values.purchaseCurrency;

  let status: PolishStatus | undefined = values.status;
  if (!status && !existing.inCollection) {
    status = values.quantity === 0 ? "wishlist" : "owned";
  }
  if (status) body.status = status;

  if (values.tried === false) {
    body.triedAt = null;
  } else if (values.tried === true) {
    if (values.triedOn) {
      body.triedAt = values.triedOn;
    } else if (!existing.triedAt) {
      body.triedAt = values.purchaseDate ?? now.toISOString().slice(0, 10);
    }
  }
  return { body, fields: parseInventoryFields(body) };
}

/** Key for spotting the same new shade twice in one sheet. */
export function createKey(values: Pick<PolishImportRowValues, "brand" | "name">): string {
  return `${importMatchKey(values.brand)}|${importMatchKey(values.name)}`;
}
