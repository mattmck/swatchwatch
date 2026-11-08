/**
 * Per-source ingestion settings, read once per job from `data_source.metadata`.
 *
 * - `kind` (`metadata.sourceKind`): `brand` (the brand's own store, the default), `reseller`
 *   (a multi-brand store listing shades the brand stores already created) or `feed` (a product
 *   feed). Reseller and feed records adopt the brand's existing shade and only fill empty data;
 *   their buy links rank after a brand store's (`buy-link.ts`).
 * - `imagesPermitted`: whether the source's images may be stored (and run through AI hex
 *   detection). Defaults to true for a brand source only; a reseller must have said yes.
 * - `includeGel`, `vendorAliases` (keys lower-cased), `brand` (for records that carry no vendor)
 *   and `maxPages` are read by the connectors; so are the connector keys `feedUrl`,
 *   `feedAuthEnv`, `sitemapUrl`, `productUrlPrefixes` and `subdomain`, passed through as-is.
 * - `currency`: the raw `metadata.currency` (connectors validate it with `normalizeCurrencyCode`).
 */

export const SOURCE_KINDS = ["brand", "reseller", "feed"] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SourceSettings {
  kind: SourceKind;
  imagesPermitted: boolean;
  includeGel: boolean;
  vendorAliases: Record<string, string>;
  currency: string | null;
  brand: string | null;
  maxPages: number | null;
  feedUrl: string | null;
  feedAuthEnv: string | null;
  sitemapUrl: string | null;
  productUrlPrefixes: string[];
  subdomain: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `metadata.sourceKind`, trimmed and lower-cased; a missing (or empty) value is a brand source. An
 * explicitly unknown value throws, failing the job: a typo must never silently grant a reseller
 * brand-style image storage and catalog overwrites.
 */
export function readSourceKind(value: unknown, sourceName?: string): SourceKind {
  if (value === undefined || value === null) return "brand";
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : null;
  if (normalized === "") return "brand";
  if (normalized !== null && (SOURCE_KINDS as readonly string[]).includes(normalized)) {
    return normalized as SourceKind;
  }
  const shown = typeof value === "string" ? value : JSON.stringify(value);
  throw new Error(`Unknown sourceKind "${shown}"${sourceName ? ` on data_source ${sourceName}` : ""}`);
}

function readVendorAliases(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const aliases: Record<string, string> = {};
  for (const [vendor, brand] of Object.entries(value)) {
    const key = vendor.trim().toLowerCase();
    const target = nonEmptyString(brand);
    if (key && target) aliases[key] = target;
  }
  return aliases;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = nonEmptyString(item);
    return text ? [text] : [];
  });
}

/**
 * Parses `data_source.metadata` into the settings a job runs with (defaults for anything missing).
 * Throws on an unknown `sourceKind` (`readSourceKind`); `sourceName` names the source in the error.
 */
export function readSourceSettings(metadata: unknown, sourceName?: string): SourceSettings {
  const meta = isRecord(metadata) ? metadata : {};
  const kind = readSourceKind(meta.sourceKind, sourceName);
  const maxPages = meta.maxPages;
  return {
    kind,
    imagesPermitted: typeof meta.imagesPermitted === "boolean" ? meta.imagesPermitted : kind === "brand",
    includeGel: meta.includeGel === true,
    vendorAliases: readVendorAliases(meta.vendorAliases),
    currency: nonEmptyString(meta.currency),
    brand: nonEmptyString(meta.brand),
    maxPages: typeof maxPages === "number" && Number.isInteger(maxPages) && maxPages > 0 ? maxPages : null,
    feedUrl: nonEmptyString(meta.feedUrl),
    feedAuthEnv: nonEmptyString(meta.feedAuthEnv),
    sitemapUrl: nonEmptyString(meta.sitemapUrl),
    productUrlPrefixes: readStringList(meta.productUrlPrefixes),
    subdomain: nonEmptyString(meta.subdomain),
  };
}
