/**
 * Inventory status model helpers for the polishes API (issue #261).
 *
 * Request validation for the inventory fields added with the status model (`status`,
 * `triedAt`, `purchasePrice`, `purchaseCurrency`) and parsing of the list filters
 * (`status`, `untried`). Pure functions: no DB access, so they are unit-tested directly.
 */
import {
  ARCHIVE_REASONS,
  POLISH_STATUSES,
  isArchiveReason,
  isPolishStatus,
  type ArchiveReason,
  type PolishStatus,
} from "swatchwatch-shared";

/** Thrown for invalid client input; handlers answer 400 with `message`. */
export class InventoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryValidationError";
  }
}

/** Largest value `user_inventory_item.purchase_price NUMERIC(10,2)` can hold. */
export const MAX_PURCHASE_PRICE = 99_999_999.99;

/**
 * Validated inventory fields from a create/update body. For the nullable fields, `undefined`
 * means "not sent" (keep the stored value) and `null` means "clear it".
 */
export interface InventoryFieldsUpdate {
  status: PolishStatus | undefined;
  triedAt: string | null | undefined;
  purchasePrice: number | null | undefined;
  purchaseCurrency: string | null | undefined;
  /** Star rating 1-5; `null` clears it (the DB CHECK forbids 0). */
  rating: number | null | undefined;
  /** Purchase date as sent (`YYYY-MM-DD`); `null` clears it. */
  purchaseDate: string | null | undefined;
  /** Why the row is archived (only with `status: "archived"`); see `planArchiveEvent`. */
  archiveReason: ArchiveReason | undefined;
  /** The request undoes the current archive (toast Undo). */
  undoArchive: boolean;
}

/** Names of the clearable fields the request actually sent (drives the upsert's CASE guards). */
export type ProvidedInventoryField = "triedAt" | "purchasePrice" | "purchaseCurrency" | "rating" | "purchaseDate";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;
const CURRENCY_RE = /^[A-Za-z]{3}$/;

function parseStatus(value: unknown): PolishStatus | undefined {
  if (value === undefined) return undefined;
  if (!isPolishStatus(value)) {
    throw new InventoryValidationError(`status must be one of: ${POLISH_STATUSES.join(", ")}`);
  }
  return value;
}

/** ISO-8601 date (`2026-10-17`) or date-time with an explicit zone; returned as ISO UTC. */
function parseTriedAt(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new InventoryValidationError("triedAt must be an ISO-8601 date or date-time string");
  }
  const trimmed = value.trim();
  const isDate = ISO_DATE_RE.test(trimmed);
  if (!isDate && !ISO_DATE_TIME_RE.test(trimmed)) {
    throw new InventoryValidationError("triedAt must be an ISO-8601 date or date-time string");
  }
  const parsed = new Date(isDate ? `${trimmed}T00:00:00Z` : trimmed);
  // Reject impossible calendar dates (e.g. 2026-02-30) that Date silently rolls over.
  if (Number.isNaN(parsed.getTime()) || (isDate && parsed.toISOString().slice(0, 10) !== trimmed)) {
    throw new InventoryValidationError("triedAt is not a valid date");
  }
  if (parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    throw new InventoryValidationError("triedAt cannot be in the future");
  }
  return parsed.toISOString();
}

function parsePurchasePrice(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InventoryValidationError("purchasePrice must be a number");
  }
  if (value < 0 || value > MAX_PURCHASE_PRICE) {
    throw new InventoryValidationError(`purchasePrice must be between 0 and ${MAX_PURCHASE_PRICE}`);
  }
  if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) {
    throw new InventoryValidationError("purchasePrice must have at most 2 decimal places");
  }
  return Math.round(value * 100) / 100;
}

function parsePurchaseCurrency(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !CURRENCY_RE.test(value.trim())) {
    throw new InventoryValidationError("purchaseCurrency must be a 3-letter ISO 4217 code (e.g. USD)");
  }
  return value.trim().toUpperCase();
}

function parseRating(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new InventoryValidationError("rating must be a whole number from 1 to 5, or null to clear it");
  }
  return value;
}

function parsePurchaseDate(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new InventoryValidationError("purchaseDate must be a date string, or null to clear it");
  }
  return value;
}

function parseArchiveReason(value: unknown, status: PolishStatus | undefined): ArchiveReason | undefined {
  if (value === undefined) return undefined;
  if (!isArchiveReason(value)) {
    throw new InventoryValidationError(`archiveReason must be one of: ${ARCHIVE_REASONS.join(", ")}`);
  }
  if (status !== "archived") {
    throw new InventoryValidationError('archiveReason requires status "archived"');
  }
  return value;
}

function parseUndoArchive(value: unknown, status: PolishStatus | undefined, reason: ArchiveReason | undefined): boolean {
  if (value === undefined || value === false) return false;
  if (value !== true) throw new InventoryValidationError("undoArchive must be true or false");
  if (status === "archived" || reason !== undefined) {
    throw new InventoryValidationError('undoArchive cannot be combined with status "archived" or archiveReason');
  }
  return true;
}

/**
 * Validate the inventory-status fields of a create/update body.
 * @throws InventoryValidationError for any invalid value.
 */
export function parseInventoryFields(body: unknown): InventoryFieldsUpdate {
  const source = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const status = parseStatus(source.status);
  const archiveReason = parseArchiveReason(source.archiveReason, status);
  return {
    status,
    triedAt: parseTriedAt(source.triedAt),
    purchasePrice: parsePurchasePrice(source.purchasePrice),
    purchaseCurrency: parsePurchaseCurrency(source.purchaseCurrency),
    rating: parseRating(source.rating),
    purchaseDate: parsePurchaseDate(source.purchaseDate),
    archiveReason,
    undoArchive: parseUndoArchive(source.undoArchive, status, archiveReason),
  };
}

/** The clearable fields present in the request (sent as a `text[]` so SQL can tell "unset" from "null"). */
export function providedInventoryFields(fields: InventoryFieldsUpdate): ProvidedInventoryField[] {
  const provided: ProvidedInventoryField[] = [];
  if (fields.triedAt !== undefined) provided.push("triedAt");
  if (fields.purchasePrice !== undefined) provided.push("purchasePrice");
  if (fields.purchaseCurrency !== undefined) provided.push("purchaseCurrency");
  if (fields.rating !== undefined) provided.push("rating");
  if (fields.purchaseDate !== undefined) provided.push("purchaseDate");
  return provided;
}

/**
 * Status for a NEW inventory row whose request omitted `status` (decision D5a): adding a
 * polish with no details means you own it. Only an explicit `quantity: 0` gives `wishlist`,
 * which keeps clients written before the status model (they created wishlist rows by
 * quantity) working. Existing rows never use this: an update without `status` keeps the
 * stored status.
 */
export function defaultStatusForNewItem(quantity: number | null | undefined): PolishStatus {
  return typeof quantity === "number" && quantity <= 0 ? "wishlist" : "owned";
}

/** `inventory_event.event_type` values that record why a row was archived. */
export const ARCHIVE_EVENT_TYPES: readonly ArchiveReason[] = ARCHIVE_REASONS;

/**
 * How long after an archive its reason can still be corrected or undone. The toast that
 * offers Used up · Gave away · Undo is short-lived; the window keeps a late Undo from
 * deleting the reason of an older archive.
 */
export const ARCHIVE_EVENT_EDIT_WINDOW_HOURS = 24;

/** What to do with the archive-reason `inventory_event` rows after an inventory upsert. */
export type ArchiveEventPlan =
  | { kind: "none" }
  /** The row was just archived: record why. */
  | { kind: "insert"; eventType: ArchiveReason }
  /** Already archived: correct the reason of the current archive (insert if none). */
  | { kind: "update"; eventType: ArchiveReason }
  /** Undo: the row left `archived`; remove the current archive's reason. */
  | { kind: "retract" };

/**
 * Plan the archive-reason event for a status change (decision D5c). `previousStatus` is null
 * for a new row. Archiving something you owned records a reason even when none was sent
 * (`used_up` from owned, `decluttered` from destash); archiving a wishlist item or creating
 * an archived row records one only when the request says why.
 */
export function planArchiveEvent(
  previousStatus: PolishStatus | null,
  newStatus: PolishStatus,
  fields: Pick<InventoryFieldsUpdate, "archiveReason" | "undoArchive">
): ArchiveEventPlan {
  if (fields.undoArchive) {
    return previousStatus === "archived" && newStatus !== "archived" ? { kind: "retract" } : { kind: "none" };
  }
  if (newStatus !== "archived") return { kind: "none" };
  if (previousStatus === "archived") {
    return fields.archiveReason ? { kind: "update", eventType: fields.archiveReason } : { kind: "none" };
  }
  if (fields.archiveReason) return { kind: "insert", eventType: fields.archiveReason };
  if (previousStatus === "owned") return { kind: "insert", eventType: "used_up" };
  if (previousStatus === "destash") return { kind: "insert", eventType: "decluttered" };
  return { kind: "none" };
}

/**
 * Parse the list `status` filter: one status or a comma-separated list. Empty → no filter.
 * @throws InventoryValidationError on an unknown status.
 */
export function parseStatusFilter(param: string | null | undefined): PolishStatus[] {
  if (!param) return [];
  const values = param
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  const out: PolishStatus[] = [];
  for (const value of values) {
    if (!isPolishStatus(value)) {
      throw new InventoryValidationError(
        `Invalid status filter "${value}"; expected one or more of: ${POLISH_STATUSES.join(", ")}`
      );
    }
    if (!out.includes(value)) out.push(value);
  }
  return out.sort((a, b) => POLISH_STATUSES.indexOf(a) - POLISH_STATUSES.indexOf(b));
}

/**
 * Parse a boolean query flag (`true|1|yes` / `false|0|no`, case-insensitive). Absent → false.
 * @throws InventoryValidationError on any other value.
 */
export function parseBooleanFlag(name: string, param: string | null | undefined): boolean {
  if (param === null || param === undefined || param.trim() === "") return false;
  const normalized = param.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  throw new InventoryValidationError(`${name} must be true or false`);
}
