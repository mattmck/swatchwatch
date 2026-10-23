export type IngestionSourceName =
  | "BeesKneesLacquerShopify"
  | "ChinaGlazeShopify"
  | "CirqueColorsShopify"
  | "ClionadhShopify"
  | "ColorClubShopify"
  | "CosIng"
  | "CrackedPolishShopify"
  | "CupcakePolishShopify"
  | "DrunkFairyPolishShopify"
  | "EmilyDeMollyShopify"
  | "GS1Lookup"
  | "GardenPathLacquersShopify"
  | "GreatLakesLacquerShopify"
  | "HoloTacoShopify"
  | "ImpactAffiliateNetwork"
  | "KathleenAndCoShopify"
  | "LemmingLacquerShopify"
  | "LeMiniMacaronShopify"
  | "LightsLacquerShopify"
  | "LoudBabbsShopify"
  | "MakeupAPI"
  | "MooncatShopify"
  | "NightOwlLacquerShopify"
  | "OliveAvePolishShopify"
  | "OpenBeautyFacts"
  | "OrlyShopify"
  | "PahlishShopify"
  | "PaintItPrettyPolishShopify"
  | "PotionPolishShopify"
  | "PrismParadeShopify"
  | "RakutenAdvertising"
  | "RedEyedLacquerShopify"
  | "RogueLacquerShopify"
  | "RoylaleeShopify"
  | "SassysaucePolishShopify"
  | "StarrilyShopify"
  | "StellaChromaShopify"
  | "SweetAndSourLacquerShopify"
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

/**
 * Roll-up of job log lines dropped to keep `metrics.logs` bounded. A job log keeps the
 * first lines of the run and the most recent ones; everything in between is counted here.
 */
export interface IngestionLogOmission {
  /** Number of log lines omitted. */
  count: number;
  /** Omitted lines per level, so dropped warnings/errors are never silent. */
  byLevel: Partial<Record<IngestionLogLevel, number>>;
  /** Timestamps of the first and last omitted line. */
  firstTs?: string;
  lastTs?: string;
}

export interface IngestionLogEntry {
  ts: string;
  level: IngestionLogLevel;
  msg: string;
  data?: Record<string, unknown>;
  /** Present only on the single marker entry that stands in for omitted lines. */
  omitted?: IngestionLogOmission;
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
