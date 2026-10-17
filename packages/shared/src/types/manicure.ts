/**
 * Mani log (issue #269): a manicure history that drives the inventory wear stats.
 *
 * Logging, editing or deleting a manicure recomputes `wearCount` / `lastWornAt` (and fills
 * `triedAt` when it is empty) on the caller's inventory rows for the polishes involved; see
 * `packages/functions/README.md` ("Mani log").
 */

/** Roles a polish can play in a manicure, in display order. Mirrors the DB CHECK constraint. */
export const MANICURE_POLISH_ROLES = ["base", "color", "accent", "topper", "other"] as const;

export type ManicurePolishRole = (typeof MANICURE_POLISH_ROLES)[number];

/** Role used when a request omits one. */
export const DEFAULT_MANICURE_POLISH_ROLE: ManicurePolishRole = "color";

/** Most polishes one manicure may reference. */
export const MAX_MANICURE_POLISHES = 20;

/** Longest accepted `notes` (characters). */
export const MAX_MANICURE_NOTES_LENGTH = 2000;

/** True when `value` is one of `MANICURE_POLISH_ROLES` (exact, case-sensitive). */
export function isManicurePolishRole(value: unknown): value is ManicurePolishRole {
  return typeof value === "string" && (MANICURE_POLISH_ROLES as readonly string[]).includes(value);
}

/** One polish in a logged manicure. */
export interface ManicurePolish {
  /** Shade id (the same id as `Polish.id`). */
  shadeId: string;
  /** The caller's inventory row for the shade; null when it has since been removed. */
  inventoryItemId: string | null;
  role: ManicurePolishRole;
  /** 0-based display order within the manicure. */
  position: number;
  brand: string;
  name: string;
  vendorHex?: string | null;
  detectedHex?: string | null;
  nameHex?: string | null;
}

export interface Manicure {
  id: string;
  /** Calendar date worn, `YYYY-MM-DD` (the user's local date). */
  wornOn: string;
  notes: string | null;
  /** `image_asset` id of the optional photo (owned by the caller). */
  photoImageId: string | null;
  /** Owner-scoped `/api/images/v3.*` URL for the photo; null when there is none or it cannot be served. */
  photoUrl: string | null;
  polishes: ManicurePolish[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A polish reference in a create/update request. Send `shadeId` (the `Polish.id`) or
 * `inventoryItemId`; either must belong to the caller's inventory.
 */
export interface ManicurePolishInput {
  shadeId?: string | number;
  inventoryItemId?: string | number;
  /** Defaults to `color`. */
  role?: ManicurePolishRole;
}

export interface ManicureCreateRequest {
  /** `YYYY-MM-DD`; defaults to today's UTC date. Clients should send the user's local date. */
  wornOn?: string;
  notes?: string | null;
  /** Optional photo: an `image_asset` id the caller owns. `null` clears it on update. */
  photoImageId?: string | number | null;
  /** 1–`MAX_MANICURE_POLISHES` polishes; array order becomes `position`. */
  polishes: ManicurePolishInput[];
}

/** Partial update: omitted fields are kept; `polishes`, when sent, replaces the whole list. */
export type ManicureUpdateRequest = Partial<ManicureCreateRequest>;

/** Wear stats of one inventory row after a mani-log write. */
export interface ManicureWearStat {
  shadeId: string;
  inventoryItemId: string;
  wearCount: number;
  lastWornAt: string | null;
  triedAt: string | null;
}

/** Create/update response: the manicure plus the recomputed stats of every affected polish. */
export interface ManicureMutationResponse extends Manicure {
  wearStats: ManicureWearStat[];
}

export interface ManicureDeleteResponse {
  message: string;
  id: string;
  wearStats: ManicureWearStat[];
}

export interface ManicureListResponse {
  manicures: Manicure[];
  total: number;
  page: number;
  pageSize: number;
}

/** `GET /api/manicures` query parameters. */
export interface ManicureFilters {
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  to?: string;
  /** Only manicures that include this shade. */
  shadeId?: string | number;
  page?: number;
  /** Default 50, max 200. */
  pageSize?: number;
}
