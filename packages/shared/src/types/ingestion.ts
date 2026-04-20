export type IngestionSourceName =
  | "BeesKneesLacquerShopify"
  | "ChinaGlazeShopify"
  | "ClionadhShopify"
  | "ColorClubShopify"
  | "CosIng"
  | "CrackedPolishShopify"
  | "CupcakePolishShopify"
  | "DrunkFairyPolishShopify"
  | "GS1Lookup"
  | "GardenPathLacquersShopify"
  | "GreatLakesLacquerShopify"
  | "HoloTacoShopify"
  | "ImpactAffiliateNetwork"
  | "KathleenAndCoShopify"
  | "LeMiniMacaronShopify"
  | "LightsLacquerShopify"
  | "LoudBabbsShopify"
  | "MakeupAPI"
  | "MooncatShopify"
  | "OliveAvePolishShopify"
  | "OpenBeautyFacts"
  | "OrlyShopify"
  | "PaintItPrettyPolishShopify"
  | "PotionPolishShopify"
  | "PrismParadeShopify"
  | "RakutenAdvertising"
  | "RedEyedLacquerShopify"
  | "RogueLacquerShopify"
  | "RoylaleeShopify"
  | "SassysaucePolishShopify"
  | "StarrilyShopify"
  | "TylerStrinketsShopify"
  | "UserCapture"
  | "ZombieClawPolishShopify"
  | "openFDA_CosmeticEvents";

export type ConnectorProtocol =
  | "HoloTaco"
  | "Shopify"
  | "OpenBeautyFacts"
  | "MakeupAPI"
  | "GS1"
  | "Custom";

export type IngestionJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type IngestionLogLevel = "debug" | "info" | "warn" | "error";

export interface IngestionLogEntry {
  ts: string;
  level: IngestionLogLevel;
  msg: string;
  data?: Record<string, unknown>;
}

export interface IngestionJobRunRequest {
  source: IngestionSourceName;
  searchTerm?: string;
  page?: number;
  pageSize?: number;
  maxRecords?: number;
  recentDays?: number;
  materializeToInventory?: boolean;
  detectHexFromImage?: boolean;
  /** When true, only run AI image detection when vendor hex looks suspicious (placeholder-like) */
  detectHexOnSuspiciousOnly?: boolean;
  overwriteDetectedHex?: boolean;
  /** When true and vendor provides hex in product options, save image+hex pairs for training custom color AI */
  collectTrainingData?: boolean;
  /** When true and collectTrainingData=true, download images to blob storage. When false, just store vendor URLs (default: false) */
  downloadTrainingImages?: boolean;
  /** When true, loop through all pages until source returns empty (ignores maxRecords cap) */
  exhaustive?: boolean;
}

export interface BulkIngestionRequest {
  sources: IngestionSourceName[];
  options?: {
    materializeToInventory?: boolean;
    detectHexFromImage?: boolean;
    overwriteDetectedHex?: boolean;
  };
}

export interface BulkIngestionResponse {
  enqueued: number;
  jobs: IngestionJobRecord[];
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
