import type { DisplayHexSource } from "../color/hex-reconciliation";

/**
 * Admin review queue for `user_submitted` shades (#45).
 *
 * Shades created through the user polish API start as `status = 'user_submitted'` and stay
 * private to their creator (and anyone holding them in inventory). An admin reviews them via
 * `/api/shades-admin/review` and either approves them (`status = 'active'`), merges them into an
 * existing active shade (inventory rows are reassigned), or rejects them (they stay private).
 */

/** Last admin decision recorded on a shade (`shade.review_status`); null = not reviewed yet. */
export type ShadeReviewStatus = "approved" | "rejected" | "merged";

/** Which slice of the queue to list: never-reviewed submissions, or previously rejected ones. */
export type ShadeReviewQueueState = "pending" | "rejected";

/** Hex columns of a shade plus the hex the app would display (vendor > detected > name). */
export interface ShadeReviewHexes {
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
  displayHex: string | null;
  displaySource: DisplayHexSource;
}

/** An active catalog shade the submission could be merged into. */
export interface ShadeReviewMergeCandidate extends ShadeReviewHexes {
  shadeId: string;
  brand: string;
  name: string;
  finishes: string[];
  collection: string | null;
  colorName: string | null;
  /** Combined pg_trgm score (0–1): name/alias similarity weighted 0.7, brand similarity 0.3. */
  similarity: number;
  /** Best pg_trgm similarity of the shade name or one of its aliases (0–1). */
  nameSimilarity: number;
  /** True when the candidate belongs to the same brand row as the submission. */
  sameBrand: boolean;
  /** OKLAB distance between the two display hexes (null when either has no hex). */
  colorDistance: number | null;
  /** Number of user inventory rows that already reference the candidate. */
  inventoryCount: number;
  /** Signed catalog swatch image URL, when the candidate has a catalog swatch. */
  swatchImageUrl: string | null;
}

/** One `user_submitted` shade awaiting (or after) admin review. */
export interface ShadeReviewItem extends ShadeReviewHexes {
  shadeId: string;
  brandId: string;
  brand: string;
  name: string;
  /** Legacy single finish (part of the shade identity key). */
  finish: string | null;
  finishes: string[];
  collection: string | null;
  colorName: string | null;
  createdAt: string;
  createdByUserId: number | null;
  /** Number of distinct users whose inventory references this shade. */
  submitterCount: number;
  reviewStatus: ShadeReviewStatus | null;
  reviewedAt: string | null;
  reviewedByUserId: number | null;
  reviewNote: string | null;
  /** Best fuzzy (pg_trgm) matches among active catalog shades, best first. */
  candidates: ShadeReviewMergeCandidate[];
}

/** `GET /api/shades-admin/review` */
export interface ShadeReviewListResponse {
  items: ShadeReviewItem[];
  total: number;
  page: number;
  pageSize: number;
  state: ShadeReviewQueueState;
}

/** `GET /api/shades-admin/review/{id}/candidates?q=` */
export interface ShadeReviewCandidatesResponse {
  shadeId: string;
  /** Free-text query used, or null when ranked against the submission's own brand + name. */
  query: string | null;
  candidates: ShadeReviewMergeCandidate[];
}

/**
 * `POST /api/shades-admin/review/{id}/approve`. Every field is optional: omitted fields keep the
 * submitted value; `null` clears a nullable field. `finishes` must be valid finish names.
 */
export interface ShadeReviewApproveRequest {
  brand?: string;
  name?: string;
  finishes?: string[];
  collection?: string | null;
  colorName?: string | null;
  vendorHex?: string | null;
  nameHex?: string | null;
  note?: string;
}

/** `POST /api/shades-admin/review/{id}/merge` */
export interface ShadeReviewMergeRequest {
  targetShadeId: string | number;
  /** Add the submitted name as an alias of the target when it differs (default true). */
  keepNameAsAlias?: boolean;
  note?: string;
}

/** `POST /api/shades-admin/review/{id}/reject` */
export interface ShadeReviewRejectRequest {
  note?: string;
}

/** Result of approve / reject. */
export interface ShadeReviewActionResponse {
  shadeId: string;
  /** `shade.status` after the action (`active` after approve, `user_submitted` after reject/merge). */
  status: string;
  reviewStatus: ShadeReviewStatus;
  reviewedAt: string;
  reviewedByUserId: number;
  message: string;
}

/** Result of merging a submission into an active shade. */
export interface ShadeReviewMergeResponse extends ShadeReviewActionResponse {
  targetShadeId: string;
  /** Inventory rows re-pointed from the submission to the target (users without the target). */
  movedInventoryRows: number;
  /** Inventory rows folded into a user's existing target row (then deleted). */
  combinedInventoryRows: number;
  /** Distinct users whose inventory was touched. */
  affectedUserCount: number;
  /** Aliases copied onto the target (source aliases + the submitted name, when it differs). */
  copiedAliasRows: number;
  movedSkuRows: number;
  movedSwatchRows: number;
}
