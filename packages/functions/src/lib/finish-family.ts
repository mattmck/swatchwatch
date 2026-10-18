/**
 * Request validation for the optional `finish_type.family` (issue #320, decision D10), used by the
 * admin finish create/update endpoints (`/api/reference-admin/finishes`). The allowed values are
 * `FINISH_FAMILIES` in `swatchwatch-shared`, which the DB CHECK constraint mirrors.
 */
import { FINISH_FAMILIES, isFinishFamily, type FinishFamily } from "swatchwatch-shared";

export const FINISH_FAMILY_INVALID_MESSAGE = `family must be one of ${FINISH_FAMILIES.join(", ")}, or null`;

export interface FinishFamilyField {
  /** True when the body has a `family` key at all (update: omitted = leave unchanged). */
  provided: boolean;
  /** The family to store; `null` = no family. */
  value: FinishFamily | null;
  invalid: boolean;
}

/**
 * Read `family` from a request body: absent → not provided; `null` or a blank string → no family;
 * otherwise a case-insensitive, trimmed member of `FINISH_FAMILIES`. Anything else is invalid.
 */
export function parseFinishFamilyField(body: unknown): FinishFamilyField {
  if (typeof body !== "object" || body === null || !Object.prototype.hasOwnProperty.call(body, "family")) {
    return { provided: false, value: null, invalid: false };
  }
  const raw = (body as Record<string, unknown>).family;
  if (raw === null) {
    return { provided: true, value: null, invalid: false };
  }
  if (typeof raw !== "string") {
    return { provided: true, value: null, invalid: true };
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return { provided: true, value: null, invalid: false };
  }
  if (!isFinishFamily(normalized)) {
    return { provided: true, value: null, invalid: true };
  }
  return { provided: true, value: normalized, invalid: false };
}

/** A stored `finish_type.family` value as the API type (`null` = no family; unknown values too). */
export function toFinishFamily(value: unknown): FinishFamily | null {
  return isFinishFamily(value) ? value : null;
}
