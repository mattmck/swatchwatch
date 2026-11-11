import type { IngestionJobRunRequest } from "../types/ingestion";
import {
  SOURCE_PERMISSION_CHANNELS,
  SOURCE_PERMISSION_STATUSES,
  type BrandSupply,
  type SourcePermission,
  type SourcePermissionChannel,
  type SourcePermissionStatus,
} from "../types/sources-admin";

/** The Admin Jobs bulk "full-catalog pull" defaults, used by the Sources tab Run action. */
export const SOURCE_RUN_DEFAULTS: Omit<IngestionJobRunRequest, "source"> = {
  exhaustive: true,
  materializeToInventory: true,
  detectHexFromImage: true,
  overwriteDetectedHex: false,
};

export function isPermissionOk(status: SourcePermissionStatus): boolean {
  return status === "granted" || status === "not_needed";
}

export function classifyBrandSupply(ownStores: number, retailers: number): BrandSupply {
  if (ownStores > 0 && retailers > 0) return "both";
  if (ownStores > 0) return "own";
  if (retailers > 0) return "retailer";
  return "none";
}

/** "HypnoticPolishShopify" -> "Hypnotic Polish". */
export function sourceDisplayName(name: string): string {
  const stripped = name.replace(/(Shopify|WooCommerce|BigCartel|Sitemap|Feed)$/, "");
  const base = stripped.length > 0 ? stripped : name;
  return base.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A stored `metadata.permission` is accepted only as an object with a known status; unknown keys and wrong types are dropped. */
function readStoredPermission(value: unknown): SourcePermission | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (!(SOURCE_PERMISSION_STATUSES as readonly unknown[]).includes(status)) return null;
  const permission: SourcePermission = { status: status as SourcePermissionStatus };
  const askedAt = str(value.askedAt);
  if (askedAt !== undefined) permission.askedAt = askedAt;
  const decidedAt = str(value.decidedAt);
  if (decidedAt !== undefined) permission.decidedAt = decidedAt;
  const grantedBy = str(value.grantedBy);
  if (grantedBy !== undefined) permission.grantedBy = grantedBy;
  if ((SOURCE_PERMISSION_CHANNELS as readonly unknown[]).includes(value.channel)) {
    permission.channel = value.channel as SourcePermissionChannel;
  }
  const summary = str(value.summary);
  if (summary !== undefined) permission.summary = summary;
  if (typeof value.imagesGranted === "boolean") permission.imagesGranted = value.imagesGranted;
  if (typeof value.recordedByUserId === "number") permission.recordedByUserId = value.recordedByUserId;
  const recordedAt = str(value.recordedAt);
  if (recordedAt !== undefined) permission.recordedAt = recordedAt;
  return permission;
}

/**
 * The permission of a data source: the stored `metadata.permission` when valid, else derived from the older
 * fields (written permission, terms clause, pending approval). A source that cannot be fetched needs none.
 */
export function deriveSourcePermission(input: {
  metadata: Record<string, unknown> | null;
  enabled: boolean;
  fetchable: boolean;
}): { permission: SourcePermission; stored: boolean } {
  if (!input.fetchable) return { permission: { status: "not_needed" }, stored: false };
  const metadata = input.metadata ?? {};

  const stored = readStoredPermission(metadata.permission);
  if (stored) return { permission: stored, stored: true };

  const verification = isRecord(metadata.verification) ? metadata.verification : {};
  const written = verification.writtenPermission;
  if (typeof written === "string" && written.trim() !== "") {
    return {
      permission: {
        status: "granted",
        summary: written,
        imagesGranted: typeof metadata.imagesPermitted === "boolean" ? metadata.imagesPermitted : true,
      },
      stored: false,
    };
  }
  if (verification.termsScrapingClause === false) {
    return { permission: { status: "not_needed" }, stored: false };
  }
  return { permission: { status: "not_asked" }, stored: false };
}
