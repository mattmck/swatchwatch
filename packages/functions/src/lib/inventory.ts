/**
 * Inventory status model helpers for the polishes API (issue #261).
 *
 * Request validation for the inventory fields added with the status model (`status`,
 * `triedAt`, `purchasePrice`, `purchaseCurrency`) and parsing of the list filters
 * (`status`, `untried`). Pure functions: no DB access, so they are unit-tested directly.
 */
import { POLISH_STATUSES, isPolishStatus, type PolishStatus } from "swatchwatch-shared";

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
}

/** Names of the clearable fields the request actually sent (drives the upsert's CASE guards). */
export type ProvidedInventoryField = "triedAt" | "purchasePrice" | "purchaseCurrency";

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

/**
 * Validate the inventory-status fields of a create/update body.
 * @throws InventoryValidationError for any invalid value.
 */
export function parseInventoryFields(body: unknown): InventoryFieldsUpdate {
  const source = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    status: parseStatus(source.status),
    triedAt: parseTriedAt(source.triedAt),
    purchasePrice: parsePurchasePrice(source.purchasePrice),
    purchaseCurrency: parsePurchaseCurrency(source.purchaseCurrency),
  };
}

/** The clearable fields present in the request (sent as a `text[]` so SQL can tell "unset" from "null"). */
export function providedInventoryFields(fields: InventoryFieldsUpdate): ProvidedInventoryField[] {
  const provided: ProvidedInventoryField[] = [];
  if (fields.triedAt !== undefined) provided.push("triedAt");
  if (fields.purchasePrice !== undefined) provided.push("purchasePrice");
  if (fields.purchaseCurrency !== undefined) provided.push("purchaseCurrency");
  return provided;
}

/**
 * Status for a NEW inventory row whose request omitted `status`. Keeps clients written before
 * the status model working: they create rows by quantity, and the result matches the
 * migration's backfill (`quantity > 0` → owned, otherwise wishlist). Existing rows never use
 * this: an update without `status` keeps the stored status.
 */
export function defaultStatusForNewItem(quantity: number | null | undefined): PolishStatus {
  return typeof quantity === "number" && quantity > 0 ? "owned" : "wishlist";
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
