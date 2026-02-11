export type SupportedConnectorSource =
  | "OpenBeautyFacts"
  | "MakeupAPI"
  | "HoloTacoShopify";

export interface ConnectorPullOptions {
  searchTerm: string;
  page: number;
  pageSize: number;
  maxRecords: number;
  recentDays?: number;
}

export interface ConnectorProductRecord {
  externalId: string;
  gtin?: string | null;
  raw: Record<string, unknown>;
  normalized: Record<string, unknown>;
  etag?: string | null;
}

export interface ConnectorPullResult {
  source: SupportedConnectorSource;
  records: ConnectorProductRecord[];
  metadata: Record<string, unknown>;
}

export interface ProductConnector {
  source: SupportedConnectorSource;
  pullProducts(options: ConnectorPullOptions): Promise<ConnectorPullResult>;
}
