export interface FinishType {
  finishTypeId: number;
  name: string;
  displayName: string;
  description?: string;
  sortOrder: number;
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
}

export interface FinishTypeUpdateRequest {
  name?: string;
  displayName?: string;
  description?: string;
  sortOrder?: number;
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
