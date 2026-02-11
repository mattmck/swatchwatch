export type IngestionSourceName =
  | "OpenBeautyFacts"
  | "MakeupAPI"
  | "HoloTacoShopify"
  | "CosIng"
  | "ImpactAffiliateNetwork"
  | "RakutenAdvertising"
  | "ManualEntry"
  | "UserCapture";

export type IngestionJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface IngestionJobRunRequest {
  source: IngestionSourceName;
  searchTerm?: string;
  page?: number;
  pageSize?: number;
  maxRecords?: number;
  recentDays?: number;
  materializeToInventory?: boolean;
  detectHexFromImage?: boolean;
  overwriteDetectedHex?: boolean;
}

export interface IngestionJobRecord {
  jobId: string;
  source: IngestionSourceName | string;
  jobType: string;
  status: IngestionJobStatus;
  startedAt: string;
  finishedAt?: string;
  metrics?: Record<string, unknown>;
  error?: string;
}

export interface IngestionJobRunResponse {
  job: IngestionJobRecord;
}

export interface IngestionJobListResponse {
  jobs: IngestionJobRecord[];
  total: number;
}
