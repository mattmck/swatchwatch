import {
  BRAND_PLATFORMS,
  classifyBrandSupply,
  deriveSourcePermission,
  sourceDisplayName,
  type AdminBrandListItem,
  type AdminBrandProfileRequest,
  type AdminBrandSourceRef,
  type BrandIngestProfile,
  type BrandPlatform,
} from "swatchwatch-shared";
import { isFetchableSource } from "./sources-admin";
import { sourceKindFromMetadata } from "./source-settings";

const MAX_URL_LENGTH = 500;
const MAX_TEXT_LENGTH = 1000;

export function normalizeBrandName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWebsiteUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/** Each key: a value sets it, `null` clears it, a missing key keeps it. */
export function parseBrandProfileRequest(
  body: unknown
): { ok: true; value: AdminBrandProfileRequest } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "Request body must be an object" };
  const value: AdminBrandProfileRequest = {};

  if ("websiteUrl" in body) {
    if (body.websiteUrl === null) value.websiteUrl = null;
    else if (typeof body.websiteUrl === "string") {
      const url = parseWebsiteUrl(body.websiteUrl);
      if (!url) return { ok: false, error: "websiteUrl must be an absolute http(s) URL without credentials (max 500 characters)" };
      value.websiteUrl = url;
    } else return { ok: false, error: "websiteUrl must be a string or null" };
  }

  if ("platform" in body) {
    if (body.platform === null) value.platform = null;
    else if (typeof body.platform === "string" && (BRAND_PLATFORMS as readonly string[]).includes(body.platform)) {
      value.platform = body.platform as BrandPlatform;
    } else return { ok: false, error: `platform must be one of ${BRAND_PLATFORMS.join(", ")} or null` };
  }

  for (const key of ["blocker", "notes"] as const) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === null) value[key] = null;
    else if (typeof raw === "string") {
      const text = raw.trim();
      if (text.length > MAX_TEXT_LENGTH) return { ok: false, error: `${key} must be at most ${MAX_TEXT_LENGTH} characters` };
      value[key] = text.length > 0 ? text : null;
    } else return { ok: false, error: `${key} must be a string or null` };
  }

  if ("ownDataSourceId" in body) {
    const id = body.ownDataSourceId;
    if (id === null) value.ownDataSourceId = null;
    else if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) value.ownDataSourceId = id;
    else return { ok: false, error: "ownDataSourceId must be a positive integer or null" };
  }

  return { ok: true, value };
}

export interface BrandRow {
  brandId: number | string;
  name: string;
  aliases: string[] | null;
  colorShades: number | string | null;
  otherShades: number | string | null;
  latestIngestAt: string | null;
  hasProfile: boolean;
  websiteUrl: string | null;
  platform: string | null;
  blocker: string | null;
  notes: string | null;
  ownDataSourceId: number | string | null;
  profileUpdatedAt: string | null;
}

export interface SourceRow {
  dataSourceId: number | string;
  name: string;
  enabled: boolean;
  metadata: Record<string, unknown> | null;
}

export interface BrandSourceLinkRow {
  brandId: number | string;
  dataSourceId: number | string;
}

/** Name matching used for `metadata.brand`: trimmed, whitespace collapsed, lower-cased. */
function matchKey(value: string): string {
  return normalizeBrandName(value).toLowerCase();
}

const LINK_STRENGTH: Record<AdminBrandSourceRef["link"], number> = { explicit: 0, metadata: 1, listings: 2 };

export function buildBrandList(rows: {
  brands: BrandRow[];
  sources: SourceRow[];
  links: BrandSourceLinkRow[];
}): AdminBrandListItem[] {
  const sourcesById = new Map<number, SourceRow>();
  const brandKindSources: SourceRow[] = [];
  for (const source of rows.sources) {
    sourcesById.set(Number(source.dataSourceId), source);
    if (sourceKindFromMetadata(source.metadata ?? {}) === "brand") brandKindSources.push(source);
  }

  const linksByBrand = new Map<number, Set<number>>();
  for (const link of rows.links) {
    const brandId = Number(link.brandId);
    let set = linksByBrand.get(brandId);
    if (!set) linksByBrand.set(brandId, (set = new Set()));
    set.add(Number(link.dataSourceId));
  }

  const toRef = (source: SourceRow, link: AdminBrandSourceRef["link"]): AdminBrandSourceRef => {
    const metadata = source.metadata ?? {};
    return {
      dataSourceId: Number(source.dataSourceId),
      displayName: sourceDisplayName(source.name),
      kind: sourceKindFromMetadata(metadata),
      enabled: source.enabled,
      permissionStatus: deriveSourcePermission({
        metadata,
        enabled: source.enabled,
        fetchable: isFetchableSource(source.name),
      }).permission.status,
      link,
    };
  };

  return rows.brands.map((row) => {
    const brandId = Number(row.brandId);
    const ownDataSourceId = row.ownDataSourceId === null ? null : Number(row.ownDataSourceId);
    const names = new Set([matchKey(row.name), ...(row.aliases ?? []).map(matchKey)]);
    const listed = linksByBrand.get(brandId) ?? new Set<number>();

    const own = new Map<number, AdminBrandSourceRef>();
    const addOwn = (source: SourceRow, link: AdminBrandSourceRef["link"]) => {
      const id = Number(source.dataSourceId);
      const existing = own.get(id);
      if (!existing || LINK_STRENGTH[link] < LINK_STRENGTH[existing.link]) own.set(id, toRef(source, link));
    };

    if (ownDataSourceId !== null) {
      const source = sourcesById.get(ownDataSourceId);
      if (source) addOwn(source, "explicit");
    }
    for (const source of brandKindSources) {
      const metadataBrand = (source.metadata ?? {}).brand;
      if (typeof metadataBrand === "string" && names.has(matchKey(metadataBrand))) addOwn(source, "metadata");
      if (listed.has(Number(source.dataSourceId))) addOwn(source, "listings");
    }

    const retailers: AdminBrandSourceRef[] = [];
    for (const id of listed) {
      const source = sourcesById.get(id);
      if (!source || own.has(id)) continue;
      if (sourceKindFromMetadata(source.metadata ?? {}) === "brand") continue;
      retailers.push(toRef(source, "listings"));
    }
    retailers.sort((a, b) => a.displayName.localeCompare(b.displayName));

    const ownStores = [...own.values()].sort(
      (a, b) => LINK_STRENGTH[a.link] - LINK_STRENGTH[b.link] || a.displayName.localeCompare(b.displayName)
    );

    const profile: BrandIngestProfile | null = row.hasProfile
      ? {
          websiteUrl: row.websiteUrl,
          platform: row.platform as BrandPlatform | null,
          blocker: row.blocker,
          notes: row.notes,
          ownDataSourceId,
          updatedAt: row.profileUpdatedAt,
        }
      : null;

    return {
      brandId,
      name: row.name,
      colorShades: Number(row.colorShades ?? 0),
      otherShades: Number(row.otherShades ?? 0),
      ownStores,
      retailers,
      supply: classifyBrandSupply(ownStores.length, retailers.length),
      profile,
      latestIngestAt: row.latestIngestAt,
    };
  });
}

/** Brands with catalog shade counts, aliases and the ingest profile; one brand when `byId`. */
export function brandsAdminBrandsSql(byId: boolean): string {
  return `SELECT b.brand_id AS "brandId",
       b.name_canonical AS name,
       COALESCE((SELECT array_agg(ba.alias) FROM brand_alias ba WHERE ba.brand_id = b.brand_id), '{}') AS aliases,
       (SELECT count(*) FROM shade s
         WHERE s.brand_id = b.brand_id AND s.status = 'active' AND s.merged_into_shade_id IS NULL
           AND s.product_category = 'color') AS "colorShades",
       (SELECT count(*) FROM shade s
         WHERE s.brand_id = b.brand_id AND s.status = 'active' AND s.merged_into_shade_id IS NULL
           AND s.product_category <> 'color') AS "otherShades",
       (SELECT max(ssp.last_seen_at)::text
          FROM shade s
          JOIN shade_source_product ssp ON ssp.shade_id = s.shade_id
         WHERE s.brand_id = b.brand_id AND s.status = 'active' AND s.merged_into_shade_id IS NULL) AS "latestIngestAt",
       (bip.brand_id IS NOT NULL) AS "hasProfile",
       bip.website_url AS "websiteUrl",
       bip.platform,
       bip.blocker,
       bip.notes,
       bip.own_data_source_id AS "ownDataSourceId",
       bip.updated_at::text AS "profileUpdatedAt"
     FROM brand b
     LEFT JOIN brand_ingest_profile bip ON bip.brand_id = b.brand_id
     ${byId ? "WHERE b.brand_id = $1" : ""}
     ORDER BY b.name_canonical ASC`;
}

export const BRANDS_ADMIN_SOURCES_SQL = `SELECT data_source_id AS "dataSourceId", name, enabled, metadata
     FROM data_source
     ORDER BY name ASC`;

/** Distinct (brand, source) pairs with a live listing on one of the brand's catalog shades. */
export function brandsAdminLinksSql(byId: boolean): string {
  return `SELECT DISTINCT s.brand_id AS "brandId", ep.data_source_id AS "dataSourceId"
     FROM shade s
     JOIN shade_source_product ssp ON ssp.shade_id = s.shade_id
     JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
     WHERE s.status = 'active' AND s.merged_into_shade_id IS NULL
       AND ep.missing_since IS NULL
       ${byId ? "AND s.brand_id = $1" : ""}`;
}

export const BRAND_DUPLICATE_SQL = `SELECT b.brand_id AS "brandId"
     FROM brand b
     WHERE lower(b.name_canonical) = lower($1)
     UNION
     SELECT ba.brand_id AS "brandId"
     FROM brand_alias ba
     WHERE lower(ba.alias) = lower($1)
     LIMIT 1`;

export const PROFILE_FIELDS = ["websiteUrl", "platform", "blocker", "notes", "ownDataSourceId"] as const;
