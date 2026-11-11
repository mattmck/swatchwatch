import type { ConnectorProtocol, IngestionJobStatus } from "./ingestion";
import type { AdminAuditEvent } from "./user";

export const SOURCE_PERMISSION_STATUSES = [
  "not_needed",
  "not_asked",
  "asked",
  "granted",
  "declined",
] as const;
export type SourcePermissionStatus = (typeof SOURCE_PERMISSION_STATUSES)[number];

export const SOURCE_PERMISSION_CHANNELS = ["email", "dm", "form", "phone", "other"] as const;
export type SourcePermissionChannel = (typeof SOURCE_PERMISSION_CHANNELS)[number];

/** A store's OK (or lack of it) for automated access, recorded by an admin. Dates are YYYY-MM-DD. */
export interface SourcePermission {
  status: SourcePermissionStatus;
  askedAt?: string;
  decidedAt?: string;
  grantedBy?: string;
  channel?: SourcePermissionChannel;
  summary?: string;
  imagesGranted?: boolean;
  recordedByUserId?: number;
  recordedAt?: string;
}

export type AdminSourceKind = "brand" | "retailer" | "feed";

export interface AdminSourceLastJob {
  jobId: string;
  status: IngestionJobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  recordsProcessed: number | null;
}

export interface AdminSourceListItem {
  dataSourceId: number;
  name: string;
  displayName: string;
  baseUrl: string | null;
  kind: AdminSourceKind;
  connector: ConnectorProtocol;
  fetchable: boolean;
  /** False for open-data sources (MakeupAPI, OpenBeautyFacts): fetchable, but no store permission applies. */
  needsStoreOk: boolean;
  enabled: boolean;
  permission: SourcePermission;
  /** True when `permission` was read from `metadata.permission`, false when derived from older fields. */
  permissionStored: boolean;
  /** Enabled although the permission status is not an OK. */
  onWithoutOk: boolean;
  imagesPermitted: boolean;
  currency: string | null;
  termsScrapingClause: boolean | null;
  termsCheckedAt: string | null;
  lastJob: AdminSourceLastJob | null;
  liveListings: number;
  shades: number;
}

export interface AdminSourceListResponse {
  sources: AdminSourceListItem[];
}

export interface AdminSourceDetailResponse {
  source: AdminSourceListItem;
  notes: string | null;
  history: AdminAuditEvent[];
}

export type AdminSourcePermissionRequest =
  | { action: "asked"; askedAt: string }
  | {
      action: "granted";
      decidedAt: string;
      grantedBy: string;
      channel: SourcePermissionChannel;
      summary: string;
      imagesGranted: boolean;
    }
  | { action: "declined"; decidedAt: string; channel: SourcePermissionChannel; summary?: string }
  | { action: "not_needed"; checkedAt: string; summary?: string }
  | { action: "images"; imagesGranted: boolean };

export interface AdminSourceEnabledRequest {
  enabled: boolean;
  /** Needed to turn a source on while its permission status is not an OK. */
  override?: boolean;
}

export const BRAND_PLATFORMS = [
  "shopify",
  "woocommerce",
  "bigcartel",
  "custom",
  "feed",
  "none",
  "unknown",
] as const;
export type BrandPlatform = (typeof BRAND_PLATFORMS)[number];

export const BRAND_BLOCKER_PRESETS = [
  "Custom site (Laravel), no products feed",
  "WooCommerce behind Cloudflare, which answers 403 to automated requests",
  "No official store; carried by Beyond Polish and Sleek Nail",
] as const;

export interface BrandIngestProfile {
  websiteUrl: string | null;
  platform: BrandPlatform | null;
  blocker: string | null;
  notes: string | null;
  ownDataSourceId: number | null;
  updatedAt: string | null;
}

export interface AdminBrandSourceRef {
  dataSourceId: number;
  displayName: string;
  kind: AdminSourceKind;
  enabled: boolean;
  permissionStatus: SourcePermissionStatus;
  link: "explicit" | "metadata" | "name" | "listings";
}

export type BrandSupply = "own" | "retailer" | "both" | "none";

export interface AdminBrandListItem {
  brandId: number;
  name: string;
  colorShades: number;
  otherShades: number;
  ownStores: AdminBrandSourceRef[];
  retailers: AdminBrandSourceRef[];
  supply: BrandSupply;
  profile: BrandIngestProfile | null;
  latestIngestAt: string | null;
}

export interface AdminBrandListResponse {
  brands: AdminBrandListItem[];
}

/** Each field: a value sets it, null clears it, a missing key keeps it. */
export interface AdminBrandProfileRequest {
  websiteUrl?: string | null;
  platform?: BrandPlatform | null;
  blocker?: string | null;
  notes?: string | null;
  ownDataSourceId?: number | null;
}

export interface AdminBrandCreateRequest {
  name: string;
  profile?: AdminBrandProfileRequest;
}

export interface AdminBrandCreateResponse {
  brand: AdminBrandListItem;
}
