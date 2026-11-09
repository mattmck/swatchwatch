/**
 * Per-source ingestion settings and source-kind rules, read once per job from
 * `data_source.metadata`.
 *
 * - `kind` (`metadata.kind`): absent = `brand` (the brand's own store, the authority for its
 *   shades), `retailer` (a multi-brand store such as Polish Pickup listing shades the brand stores
 *   already created) or `feed` (a product feed). Retailer and feed listings adopt the brand's
 *   existing shade and only fill empty data (`planListingWrites`); a shade one of them creates
 *   gets `shade.catalog_authority = 'retailer'` until a brand store takes it over. Their buy links
 *   rank after a brand store's (`buy-link.ts`).
 * - `imagesPermitted`: whether the source's images may be stored (and run through AI hex
 *   detection). Defaults to true for a brand source only; a retailer or feed must have said yes.
 * - `includeGel`, `vendorAliases` (keys lower-cased), `brand` (for records that carry no vendor)
 *   and `maxPages` are read by the connectors; so are the connector keys `feedUrl`,
 *   `feedAuthEnv`, `sitemapUrl`, `productUrlPrefixes` and `subdomain`, passed through as-is.
 * - `currency`: the raw `metadata.currency` (connectors validate it with `normalizeCurrencyCode`).
 */

export const SOURCE_KINDS = ["brand", "retailer", "feed"] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

/** `shade.catalog_authority`: who the shade's catalog data belongs to. */
export type CatalogAuthority = "brand_store" | "retailer";

/** The authority a shade created by a source of this kind gets. */
export function catalogAuthorityForKind(kind: SourceKind): CatalogAuthority {
  return kind === "brand" ? "brand_store" : "retailer";
}

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

function normalizeKindValue(value: unknown): SourceKind | "missing" | null {
  if (value === undefined || value === null) return "missing";
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return "missing";
  return (SOURCE_KINDS as readonly string[]).includes(normalized) ? (normalized as SourceKind) : null;
}

/**
 * A `metadata.kind` value, trimmed and lower-cased; a missing (or empty) value is a brand source.
 * An explicitly unknown value throws, failing the job: a typo must never silently grant a
 * retailer brand-style image storage and catalog overwrites.
 */
export function readSourceKind(value: unknown, sourceName?: string): SourceKind {
  const kind = normalizeKindValue(value);
  if (kind === "missing") return "brand";
  if (kind !== null) return kind;
  const shown = typeof value === "string" ? value : JSON.stringify(value);
  throw new Error(
    `Unknown source kind "${shown}" in data_source.metadata.kind${sourceName ? ` of ${sourceName}` : ""}`
  );
}

/**
 * The kind of a source from its whole `data_source.metadata`, for read paths that must not fail
 * (buy-link selection): like `readSourceKind`, but an unknown value counts as a brand source.
 * Ingestion jobs use `readSourceSettings` / `readSourceKind`, which throw on an unknown kind.
 */
export function sourceKindFromMetadata(metadata: unknown): SourceKind {
  const kind = normalizeKindValue(isRecord(metadata) ? metadata.kind : undefined);
  return kind === null || kind === "missing" ? "brand" : kind;
}

/**
 * `<metadataSql> ->> 'kind'` as SQL, normalized like `sourceKindFromMetadata` (trimmed,
 * lower-cased, missing = `brand`). `metadataSql` is a `data_source.metadata` column expression.
 */
export function sourceKindSql(metadataSql: string): string {
  return `COALESCE(NULLIF(lower(btrim(${metadataSql} ->> 'kind')), ''), 'brand')`;
}

/**
 * Preference rank of a source kind wherever several sources describe one shade (buy links,
 * description text): brand store 0, feed 1, retailer 2. Lower is preferred.
 */
export const SOURCE_KIND_RANK: Readonly<Record<SourceKind, number>> = { brand: 0, feed: 1, retailer: 2 };

/** `SOURCE_KIND_RANK` of a kind value; an unknown or missing kind ranks as a brand store. */
export function sourceKindRank(kind: string | null | undefined): number {
  const normalized = normalizeKindValue(kind);
  return normalized === null || normalized === "missing" ? SOURCE_KIND_RANK.brand : SOURCE_KIND_RANK[normalized];
}

/** `SOURCE_KIND_RANK` as a SQL expression over a `data_source.metadata` expression (ascending = preferred first). */
export function sourceKindRankSql(metadataSql: string): string {
  return `CASE ${sourceKindSql(metadataSql)} WHEN 'retailer' THEN ${SOURCE_KIND_RANK.retailer} WHEN 'feed' THEN ${SOURCE_KIND_RANK.feed} ELSE ${SOURCE_KIND_RANK.brand} END`;
}

/** SQL condition: the metadata expression belongs to a brand source (not a retailer or feed). */
export function isBrandSourceSql(metadataSql: string): string {
  return `${sourceKindSql(metadataSql)} NOT IN ('retailer', 'feed')`;
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
 * Throws on an unknown `kind` (`readSourceKind`); `sourceName` names the source in the error.
 */
export function readSourceSettings(metadata: unknown, sourceName?: string): SourceSettings {
  const meta = isRecord(metadata) ? metadata : {};
  const kind = readSourceKind(meta.kind, sourceName);
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

export interface ListingWritePlanInput {
  sourceKind: SourceKind;
  /** This listing created the shade row. */
  shadeCreated: boolean;
  /** `shade.catalog_authority` before this listing (ignored when `shadeCreated`). */
  shadeAuthority: CatalogAuthority;
  /**
   * The shade's newest product image belongs to another source (`shadeHasForeignProductImage` in
   * ingestion-repo). Read for a retailer or feed source only.
   */
  shadeHasForeignProductImage: boolean;
  shadeHasDetectedHex: boolean;
}

export interface ListingWritePlan {
  /** Apply the connector's rule product category. */
  writeCategory: boolean;
  /** Link this listing's images as swatches (and prune its stale gallery). */
  linkGallery: boolean;
  /** Run AI hex detection for this listing. */
  runDetection: boolean;
  /** A brand store replaces what a retailer wrote: finishes, colors, retailer swatches. */
  takeOver: boolean;
  /**
   * Fill-only adoption: finishes are written only when the shade has none and the product
   * category is never changed (a retailer or feed on a shade a brand store owns).
   */
  fillOnly: boolean;
  /** New `shade.catalog_authority`, or null to leave it. */
  setAuthority: CatalogAuthority | null;
}

/**
 * Which catalog fields a listing may write: the one write-rule implementation for every source
 * kind. A brand store always writes, and takes over a shade a retailer or feed created. A
 * retailer or feed never replaces a detected hex (it detects only for a shade without one) and
 * never replaces another source's product image (it links images only to a shade with no product
 * image, or whose product image it supplied itself); on a shade a brand store owns it is strictly
 * fill-only, on a shade a retailer or feed created it otherwise writes like an owner (category,
 * finish merge).
 */
export function planListingWrites(input: ListingWritePlanInput): ListingWritePlan {
  if (input.shadeCreated) {
    return {
      writeCategory: true,
      linkGallery: true,
      runDetection: true,
      takeOver: false,
      fillOnly: false,
      setAuthority: catalogAuthorityForKind(input.sourceKind),
    };
  }
  if (input.sourceKind === "brand") {
    const takeOver = input.shadeAuthority === "retailer";
    return {
      writeCategory: true,
      linkGallery: true,
      runDetection: true,
      takeOver,
      fillOnly: false,
      setAuthority: takeOver ? "brand_store" : null,
    };
  }
  const ownsShade = input.shadeAuthority === "retailer";
  return {
    writeCategory: ownsShade,
    linkGallery: !input.shadeHasForeignProductImage,
    runDetection: !input.shadeHasDetectedHex,
    takeOver: false,
    fillOnly: !ownsShade,
    setAuthority: null,
  };
}

/**
 * Finishes to store. A fill-only listing (`restrictedRetailer`) fills finishes only when the
 * shade has none; a takeover replaces a non-admin list with the brand's own resolution
 * (`fromEmpty`); otherwise the ingested finishes merge into the current list (`merged`).
 */
export function planIngestedFinishes<T>(input: {
  current: T[];
  adminSet: boolean;
  takeOver: boolean;
  restrictedRetailer: boolean;
  /** Result of applying the ingested finishes to an empty list (null = none resolved). */
  fromEmpty: T[] | null;
  /** Result of merging the ingested finishes into the current list. */
  merged: T[];
}): T[] {
  if (input.adminSet) return input.current;
  if (input.takeOver) return input.fromEmpty ?? input.current;
  if (input.restrictedRetailer) {
    return input.current.length > 0 ? input.current : input.fromEmpty ?? input.current;
  }
  return input.merged;
}
