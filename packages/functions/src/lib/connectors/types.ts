// Auto-generated from docs/seed_data_sources.sql
// Do not edit manually - run "node scripts/generate-connector-types.mjs" to regenerate
import type { SupportedConnectorSource } from "./generated-types";
import { SUPPORTED_SOURCES } from "./generated-types";

export type { SupportedConnectorSource };
export { SUPPORTED_SOURCES };

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
