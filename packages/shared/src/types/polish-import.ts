/**
 * CSV / spreadsheet import API (issue #263): `POST /api/polish-imports` parses + matches a
 * sheet into a session, the user reviews it, and `POST /api/polish-imports/{id}/commit`
 * upserts the inventory rows.
 */
import type { PolishStatus } from "./inventory";
import type { PolishImportColumnMapping } from "../import/polish-import";
import type { CsvDelimiter } from "../import/csv";

/**
 * How a row matched the catalog:
 * - `matched`   — one confident candidate (it is pre-selected)
 * - `ambiguous` — plausible candidates, the user must pick one (or create / skip)
 * - `unmatched` — no plausible candidate; create a private shade or skip
 * - `invalid`   — the row cannot be imported (missing brand or shade name)
 */
export type PolishImportMatchState = "matched" | "ambiguous" | "unmatched" | "invalid";

/**
 * What commit does with a row. `pending` = not decided yet; commit skips it.
 * - `match`  — upsert inventory for the chosen `shadeId`
 * - `create` — create (or reuse) the caller's private `user_submitted` shade, then upsert
 * - `skip`   — leave the row out
 */
export type PolishImportAction = "match" | "create" | "skip" | "pending";

export interface PolishImportCandidate {
  shadeId: string;
  brand: string;
  name: string;
  finishes: string[];
  /** Display hex (vendor > detected > name) for the swatch, if any. */
  hex: string | null;
  /** 0–1 match score (brand + shade similarity, finish agreement). */
  confidence: number;
  /** The caller already has an inventory row for this shade (commit will update it). */
  inCollection: boolean;
  /** The caller's own private submission (not yet in the shared catalog). */
  userSubmitted: boolean;
  /** Brand and shade name equal the row's (ignoring case/punctuation, or via an alias). */
  exactMatch: boolean;
}

/** Parsed, validated values of one sheet row (blank cells are omitted). */
export interface PolishImportRowValues {
  brand: string;
  name: string;
  /** Canonical finishes (finish catalog), primary first. */
  finishes: string[];
  quantity?: number;
  purchasePrice?: number;
  purchaseCurrency?: string;
  /** `YYYY-MM-DD`. */
  purchaseDate?: string;
  status?: PolishStatus;
  /** true / false from the sheet; undefined when blank. */
  tried?: boolean;
  /** `YYYY-MM-DD` when the tried cell held a date. */
  triedOn?: string;
  notes?: string;
}

export type PolishImportRowOutcome = "created" | "updated" | "skipped" | "failed";

export interface PolishImportRow {
  /** 1-based line of the row in the uploaded file (unique within a session; the row key). */
  rowNumber: number;
  values: PolishImportRowValues;
  matchState: PolishImportMatchState;
  /** Best candidate's confidence (0 when there is none). */
  confidence: number;
  /** Ranked candidates, best first (at most 5). */
  candidates: PolishImportCandidate[];
  action: PolishImportAction;
  /** Shade the row is matched to when `action === "match"`. */
  shadeId: string | null;
  /** Cells that were ignored (unparseable price, unknown finish, …); the row still imports. */
  warnings: string[];
  /** Reasons the row cannot be imported (`matchState === "invalid"`). */
  errors: string[];
  /** Set after commit. */
  outcome?: PolishImportRowOutcome;
  outcomeMessage?: string;
}

export interface PolishImportCounts {
  total: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  invalid: number;
}

export interface PolishImportCommitResult {
  /** New inventory rows. */
  created: number;
  /** Existing inventory rows updated (re-imports land here, never as duplicates). */
  updated: number;
  /** Rows skipped (by choice, undecided, invalid, or a duplicate of an earlier row). */
  skipped: number;
  /** Rows that hit an error; the rest of the import still commits. */
  failed: number;
  /** Private `user_submitted` shades created for unmatched rows. */
  shadesCreated: number;
}

export type PolishImportSessionStatus = "review" | "committed";

export interface PolishImportSession {
  id: string;
  fileName: string | null;
  status: PolishImportSessionStatus;
  delimiter: CsvDelimiter;
  /** Header cells (empty when the sheet had no header row). */
  headers: string[];
  /** 0-based record index of the header row, -1 for none. */
  headerRowIndex: number;
  mapping: PolishImportColumnMapping;
  rows: PolishImportRow[];
  counts: PolishImportCounts;
  createdAt: string;
  expiresAt: string;
  committedAt: string | null;
  result: PolishImportCommitResult | null;
}

/** `POST /api/polish-imports` */
export interface PolishImportCreateRequest {
  /** Raw CSV text (max `POLISH_IMPORT_MAX_BYTES`). */
  csv: string;
  fileName?: string;
  /** Explicit column mapping; detected from the header row when omitted. */
  mapping?: PolishImportColumnMapping;
  /** 0-based header record index, -1 when the sheet has no header row. Detected when omitted. */
  headerRowIndex?: number;
}

/** One review decision. `shadeId` is required for `match`. */
export interface PolishImportDecision {
  rowNumber: number;
  action: Exclude<PolishImportAction, "pending">;
  shadeId?: string;
}

/** `PATCH /api/polish-imports/{id}` and the optional body of `POST …/commit`. */
export interface PolishImportDecisionsRequest {
  decisions: PolishImportDecision[];
}

/** `POST /api/polish-imports/{id}/commit` response. */
export interface PolishImportCommitResponse {
  session: PolishImportSession;
  result: PolishImportCommitResult;
  /** True when the session had already been committed (the stored result is returned). */
  alreadyCommitted: boolean;
}
