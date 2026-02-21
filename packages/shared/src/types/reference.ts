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
