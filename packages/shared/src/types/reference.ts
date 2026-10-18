import type { FinishFamily } from "../constants/finishes";

export interface FinishType {
  finishTypeId: number;
  name: string;
  displayName: string;
  description?: string;
  sortOrder: number;
  /**
   * Dupe-grading family (#320). `null` when the finish type has none: such a finish grades
   * `unknown` against other finishes and is never penalized. The API always sends it; it is only
   * missing from older cached payloads and the web's offline fallback, where the built-in family
   * (`DUPE_FINISH_FAMILIES`) applies.
   */
  family?: FinishFamily | null;
  createdAt: string;
  updatedAt: string;
  updatedByUserId?: number;
}

export interface HarmonyType {
  harmonyTypeId: number;
  name: string;
  displayName: string;
  description?: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  updatedByUserId?: number;
}

export interface FinishTypeCreateRequest {
  name: string;
  displayName: string;
  description?: string;
  sortOrder?: number;
  /** One of `FINISH_FAMILIES`; omitted or `null` = no family. */
  family?: FinishFamily | null;
}

export interface FinishTypeUpdateRequest {
  name?: string;
  displayName?: string;
  description?: string;
  sortOrder?: number;
  /** One of `FINISH_FAMILIES`; `null` clears it, omitted leaves it unchanged. */
  family?: FinishFamily | null;
}

/**
 * 409 body of `DELETE /api/reference-admin/finishes/{id}` when the finish type is still in use.
 * A finish type referenced by any shade (`shade.finishes` or the legacy `shade.finish`) or by a
 * `finish_normalization` alias cannot be deleted.
 */
export interface FinishTypeInUseResponse {
  /** Human-readable message (shown as-is in the admin console). */
  error: string;
  code: "FINISH_TYPE_IN_USE";
  finishTypeId: number;
  name: string;
  /** Shades whose `finishes` array or legacy `finish` holds this finish. */
  shadeCount: number;
  /** `finish_normalization` alias rows that map to this finish. */
  normalizationCount: number;
}

/**
 * What a rename (`PUT /api/reference-admin/finishes/{id}` with a changed `name`) rewrote. The
 * rename cascades in one transaction. The legacy `shade.finish` column is NOT rewritten: it is the
 * shade's raw vendor identity/dedup key, so the old spelling is kept as an alias instead.
 */
export interface FinishTypeRenameSummary {
  /** `finish_type.name` before the rename. */
  previousName: string;
  /**
   * Shades rewritten: the old finish replaced in `finishes` / `detected_finishes` (order kept,
   * duplicates dropped), or an empty `finishes` filled from a legacy `finish` equal to the old name.
   */
  shadeCount: number;
  /** `finish_normalization` rows repointed from the old name to the new one. */
  normalizationCount: number;
  /** True when a `finish_normalization` alias (old name → new name) was added. */
  aliasCreated: boolean;
}

/** 200 body of `PUT /api/reference-admin/finishes/{id}`; `rename` is set only when `name` changed. */
export interface FinishTypeUpdateResponse extends FinishType {
  rename?: FinishTypeRenameSummary;
}

/**
 * 409 body of `PUT /api/reference-admin/finishes/{id}` when the new name already belongs to another
 * finish type (compared case-insensitively, whitespace collapsed). Nothing is changed.
 */
export interface FinishTypeNameTakenResponse {
  /** Human-readable message (shown as-is in the admin console). */
  error: string;
  code: "FINISH_TYPE_NAME_TAKEN";
  finishTypeId: number;
  /** Current name of the finish type being renamed. */
  name: string;
  requestedName: string;
  /** The other finish type that already has this name, when known. */
  conflictingFinishTypeId?: number;
  conflictingName?: string;
}

export interface HarmonyTypeCreateRequest {
  name: string;
  displayName: string;
  description?: string;
  sortOrder?: number;
}

export interface HarmonyTypeUpdateRequest {
  name?: string;
  displayName?: string;
  description?: string;
  sortOrder?: number;
}

export interface FinishTypeListResponse {
  finishTypes: FinishType[];
}

export interface HarmonyTypeListResponse {
  harmonyTypes: HarmonyType[];
}

export interface FinishNormalization {
  finishNormalizationId: number;
  sourceValue: string;
  normalizedFinishName: string;
  createdAt: string;
  updatedAt: string;
  updatedByUserId?: number;
}

export interface FinishNormalizationCreateRequest {
  sourceValue: string;
  normalizedFinishName: string;
}

export interface FinishNormalizationUpdateRequest {
  sourceValue?: string;
  normalizedFinishName?: string;
}

export interface FinishNormalizationListResponse {
  finishNormalizations: FinishNormalization[];
}

export interface IngestionJob {
  ingestionJobId: number;
  dataSourceId: number;
  dataSourceName?: string;
  jobType: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  errorSummary?: string;
  recordsProcessed?: number;
}

export interface AdminJobsListResponse {
  jobs: IngestionJob[];
  total: number;
  page: number;
  pageSize: number;
}
