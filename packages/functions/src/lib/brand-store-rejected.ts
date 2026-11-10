/**
 * Retire the shades a brand store's gate no longer accepts (`POST
 * /api/shades-admin/brand-store-rejected/backfill`, `npm run backfill:brand-store-rejected`).
 *
 * A brand store's store filter can tighten after a first run (Le Mini Macaron's gel and LED lines
 * while `includeGel` is off, the Flowery care items on the China Glaze store). The materializer
 * never sees those products again: the connector's gate drops them before materialization, and a
 * run may be partial (recent days, page cap, a continuation), so a product missing from a run is
 * no evidence. What is exact is the stored product: every listing keeps its `external_product`
 * raw payload, so this job re-runs the source's current gate (`gateShopifyProduct` with the
 * source's `data_source.metadata` settings) on it.
 *
 * Rules (`planBrandStoreRejected` is the pure part), one keyset batch of shades at a time:
 * - A candidate is an `active`, unmerged shade with at least one listing from a brand-kind source
 *   (optionally only the named `sources`).
 * - It is retired only when *every* listing is a product of a brand-kind Shopify store whose gate
 *   now rejects the stored payload. A retailer or feed listing, a listing of a source whose gate
 *   cannot be re-run here (another protocol, no stored payload, an unreadable `metadata.kind`), or
 *   one product still accepted keeps the shade (`partial` / `unsupported` are reported).
 * - A user's or review-approved shade, or an admin-edited one (admin category or finishes,
 *   promoted vendor hex), is kept and listed; a shade somebody holds is kept and listed (`held`),
 *   like the product-category backfill's held accessories.
 * - Retiring sets `status = 'excluded'` (re-checked in the UPDATE: still active, still unheld) and
 *   writes a `shade_category_change` row (`action = 'exclude'`, `source = 'backfill'`, the admin,
 *   one `runId` per batch, the rejected products in `after`) so it can be undone. Listings, aliases
 *   and the `external_product` rows stay, so a later gate change (e.g. `includeGel` on) finds the
 *   same shade again through its listing.
 * - Brands of the batch that have no active shade left are reported; brands are never deleted
 *   (the codebase has no brand deletion).
 * A dry run (the default) reads and plans only. Idempotent: a retired shade is no longer active.
 */
import { randomUUID } from "node:crypto";
import { gateShopifyProduct, type ShopifyProduct } from "./connectors/shopify-generic";
import { protocolOfName } from "./connectors/registry";
import { isBrandSourceSql, readSourceSettings, sourceKindFromMetadata } from "./source-settings";

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;
const MAX_SOURCES = 50;

export interface RejectedListingInput {
  externalProductId: number;
  externalId: string;
  dataSource: string;
  metadata: unknown;
  /** `external_product.raw_json` (the store's product payload). */
  raw: unknown;
}

export interface RejectedShadeInput {
  shadeId: number;
  brandId: number;
  brand: string;
  name: string;
  /** `created_by_user_id IS NOT NULL OR review_status = 'approved'`. */
  userShade: boolean;
  /** Admin category or finishes, or a promoted vendor hex. */
  adminEdit: boolean;
  holders: number;
  listings: RejectedListingInput[];
}

export type ListingVerdict = "rejected" | "accepted" | "not_brand_source" | "unsupported";

export interface RejectedProductRef {
  dataSource: string;
  externalId: string;
  externalProductId: number;
}

export interface RejectedShadeRef {
  shadeId: number;
  brandId: number;
  brand: string;
  name: string;
  products: RejectedProductRef[];
}

export interface BrandStoreRejectedPlan {
  retire: RejectedShadeRef[];
  held: Array<RejectedShadeRef & { holders: number }>;
  protectedShades: Array<RejectedShadeRef & { reasons: string[] }>;
  /** Some listings rejected, at least one still accepted (or kept by a retailer / feed). */
  partial: Array<RejectedShadeRef & { keptBy: string[] }>;
  /** Every listing rejected or unsupported, at least one unsupported (cannot be decided here). */
  unsupported: Array<RejectedShadeRef & { sources: string[] }>;
}

/** The current gate's verdict on one stored listing. */
export function judgeListing(listing: RejectedListingInput): ListingVerdict {
  if (sourceKindFromMetadata(listing.metadata) !== "brand") return "not_brand_source";
  if (protocolOfName(listing.dataSource) !== "Shopify") return "unsupported";
  if (!listing.raw || typeof listing.raw !== "object" || Array.isArray(listing.raw)) return "unsupported";
  let settings;
  try {
    settings = readSourceSettings(listing.metadata, listing.dataSource);
  } catch {
    return "unsupported";
  }
  return gateShopifyProduct(listing.raw as ShopifyProduct, listing.dataSource, settings).accept ? "accepted" : "rejected";
}

/** Pure planner over loaded shades. */
export function planBrandStoreRejected(
  shades: readonly RejectedShadeInput[],
  judge: (listing: RejectedListingInput) => ListingVerdict = judgeListing
): BrandStoreRejectedPlan {
  const plan: BrandStoreRejectedPlan = { retire: [], held: [], protectedShades: [], partial: [], unsupported: [] };
  for (const shade of shades) {
    if (shade.listings.length === 0) continue;
    const verdicts = shade.listings.map((listing) => ({ listing, verdict: judge(listing) }));
    const rejected = verdicts.filter((entry) => entry.verdict === "rejected");
    if (rejected.length === 0) continue;
    const ref: RejectedShadeRef = {
      shadeId: shade.shadeId,
      brandId: shade.brandId,
      brand: shade.brand,
      name: shade.name,
      products: rejected.map(({ listing }) => ({
        dataSource: listing.dataSource,
        externalId: listing.externalId,
        externalProductId: listing.externalProductId,
      })),
    };
    const keeping = verdicts.filter((entry) => entry.verdict === "accepted" || entry.verdict === "not_brand_source");
    if (keeping.length > 0) {
      plan.partial.push({ ...ref, keptBy: [...new Set(keeping.map((entry) => entry.listing.dataSource))].sort() });
      continue;
    }
    const unsupported = verdicts.filter((entry) => entry.verdict === "unsupported");
    if (unsupported.length > 0) {
      plan.unsupported.push({ ...ref, sources: [...new Set(unsupported.map((entry) => entry.listing.dataSource))].sort() });
      continue;
    }
    const reasons = [
      ...(shade.userShade ? ["user or approved shade"] : []),
      ...(shade.adminEdit ? ["admin edit"] : []),
    ];
    if (reasons.length > 0) {
      plan.protectedShades.push({ ...ref, reasons });
    } else if (shade.holders > 0) {
      plan.held.push({ ...ref, holders: shade.holders });
    } else {
      plan.retire.push(ref);
    }
  }
  return plan;
}

export interface BrandStoreRejectedOptions {
  afterShadeId: number;
  limit: number;
  dryRun: boolean;
  /** Only shades listed by these data sources (null = every brand-kind source). */
  sources: string[] | null;
  adminUserId: number;
}

export interface BrandWithoutActiveShades {
  brandId: number;
  brand: string;
  /** Shades of the brand in any status (excluded and merged rows stay). */
  shades: number;
}

export interface BrandStoreRejectedReport extends BrandStoreRejectedPlan {
  dryRun: boolean;
  runId: string | null;
  scannedShades: number;
  /** Shades retired by this batch (planned ones in a dry run). */
  retired: number;
  /** Brands of the batch's shades left without an active shade. */
  brandsWithoutActiveShades: BrandWithoutActiveShades[];
  /** Pass as `afterShadeId` for the next batch; null when the scan is finished. */
  nextAfterShadeId: number | null;
}

interface QueryClient {
  query<R extends Record<string, any> = any>(sql: string, params?: any[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export interface BrandStoreRejectedDb {
  query: QueryClient["query"];
  transaction<T>(callback: (client: QueryClient) => Promise<T>): Promise<T>;
}

export function parseBrandStoreRejectedBody(raw: unknown): Omit<BrandStoreRejectedOptions, "adminUserId"> | string {
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const afterShadeId = body.afterShadeId ?? 0;
  const limit = body.limit ?? DEFAULT_BATCH_SIZE;
  const dryRun = body.dryRun ?? true;
  if (typeof afterShadeId !== "number" || !Number.isSafeInteger(afterShadeId) || afterShadeId < 0) {
    return "afterShadeId must be a non-negative integer";
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    return `limit must be an integer between 1 and ${MAX_BATCH_SIZE}`;
  }
  if (typeof dryRun !== "boolean") {
    return "dryRun must be a boolean";
  }
  let sources: string[] | null = null;
  if (body.sources !== undefined && body.sources !== null) {
    if (
      !Array.isArray(body.sources) ||
      body.sources.length > MAX_SOURCES ||
      !body.sources.every((name) => typeof name === "string" && name.trim().length > 0)
    ) {
      return `sources must be up to ${MAX_SOURCES} data_source names`;
    }
    sources = body.sources.length > 0 ? [...new Set((body.sources as string[]).map((name) => name.trim()))] : null;
  }
  return { afterShadeId, limit, dryRun, sources };
}

const LOAD_SQL = `
  SELECT s.shade_id::text AS "shadeId",
         s.brand_id::text AS "brandId",
         b.name_canonical AS brand,
         s.shade_name_canonical AS name,
         (s.created_by_user_id IS NOT NULL OR s.review_status = 'approved') AS "userShade",
         (s.product_category_source = 'admin' OR s.finishes_source = 'admin' OR s.vendor_hex_source = 'manual_label') IS TRUE AS "adminEdit",
         (SELECT count(DISTINCT ui.user_id) FROM user_inventory_item ui WHERE ui.shade_id = s.shade_id) AS holders,
         COALESCE((
           SELECT json_agg(json_build_object(
             'externalProductId', ep.external_product_id,
             'externalId', ep.external_id,
             'dataSource', ds.name,
             'metadata', ds.metadata,
             'raw', ep.raw_json
           ) ORDER BY ep.external_product_id)
           FROM shade_source_product ssp
           JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
           JOIN data_source ds ON ds.data_source_id = ep.data_source_id
           WHERE ssp.shade_id = s.shade_id
         ), '[]'::json) AS listings
  FROM shade s
  JOIN brand b ON b.brand_id = s.brand_id
  WHERE s.shade_id > $1
    AND s.status = 'active'
    AND s.merged_into_shade_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM shade_source_product fssp
      JOIN external_product fep ON fep.external_product_id = fssp.external_product_id
      JOIN data_source fds ON fds.data_source_id = fep.data_source_id
      WHERE fssp.shade_id = s.shade_id
        AND ${isBrandSourceSql("fds.metadata")}
        AND ($3::text[] IS NULL OR fds.name = ANY($3::text[]))
    )
  ORDER BY s.shade_id
  LIMIT $2`;

function toRows(rows: Record<string, any>[]): RejectedShadeInput[] {
  return rows.map((row) => ({
    shadeId: Number(row.shadeId),
    brandId: Number(row.brandId),
    brand: String(row.brand ?? ""),
    name: String(row.name ?? ""),
    userShade: row.userShade === true,
    adminEdit: row.adminEdit === true,
    holders: Number(row.holders ?? 0),
    listings: (Array.isArray(row.listings) ? row.listings : []).map((listing: Record<string, unknown>) => ({
      externalProductId: Number(listing.externalProductId),
      externalId: String(listing.externalId ?? ""),
      dataSource: String(listing.dataSource ?? ""),
      metadata: listing.metadata ?? null,
      raw: listing.raw ?? null,
    })),
  }));
}

async function loadBrandActivity(
  client: QueryClient,
  brandIds: number[]
): Promise<Map<number, { brand: string; active: number; shades: number }>> {
  const out = new Map<number, { brand: string; active: number; shades: number }>();
  if (brandIds.length === 0) return out;
  const result = await client.query(
    `SELECT b.brand_id::text AS "brandId",
            b.name_canonical AS brand,
            count(s.shade_id) FILTER (WHERE s.status = 'active' AND s.merged_into_shade_id IS NULL) AS active,
            count(s.shade_id) AS shades
     FROM brand b
     LEFT JOIN shade s ON s.brand_id = b.brand_id
     WHERE b.brand_id = ANY($1::bigint[])
     GROUP BY b.brand_id, b.name_canonical
     ORDER BY b.brand_id`,
    [brandIds]
  );
  for (const row of result.rows) {
    out.set(Number(row.brandId), { brand: String(row.brand), active: Number(row.active), shades: Number(row.shades) });
  }
  return out;
}

export async function runBrandStoreRejectedBatch(
  db: BrandStoreRejectedDb,
  options: BrandStoreRejectedOptions
): Promise<BrandStoreRejectedReport & { changedShadeIds: number[] }> {
  const loaded = await db.query(LOAD_SQL, [options.afterShadeId, options.limit, options.sources]);
  const shades = toRows(loaded.rows);
  const plan = planBrandStoreRejected(shades);
  const report: BrandStoreRejectedReport = {
    dryRun: options.dryRun,
    runId: null,
    scannedShades: shades.length,
    retired: 0,
    ...plan,
    brandsWithoutActiveShades: [],
    nextAfterShadeId: shades.length === options.limit ? shades[shades.length - 1].shadeId : null,
  };
  const touchedBrands = [...new Set(plan.retire.map((shade) => shade.brandId))].sort((a, b) => a - b);

  if (options.dryRun) {
    report.retired = plan.retire.length;
    const activity = await loadBrandActivity(db, touchedBrands);
    for (const brandId of touchedBrands) {
      const entry = activity.get(brandId);
      const retiring = plan.retire.filter((shade) => shade.brandId === brandId).length;
      if (entry && entry.active - retiring <= 0) {
        report.brandsWithoutActiveShades.push({ brandId, brand: entry.brand, shades: entry.shades });
      }
    }
    return { ...report, changedShadeIds: [] };
  }

  const runId = randomUUID();
  report.runId = runId;
  const changed: number[] = [];
  await db.transaction(async (client) => {
    for (const shade of plan.retire) {
      const updated = await client.query(
        `UPDATE shade s
         SET status = 'excluded', updated_at = now()
         WHERE s.shade_id = $1
           AND s.status = 'active'
           AND s.merged_into_shade_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM user_inventory_item ui WHERE ui.shade_id = s.shade_id)`,
        [shade.shadeId]
      );
      if ((updated.rowCount ?? 0) === 0) continue;
      changed.push(shade.shadeId);
      await client.query(
        `INSERT INTO shade_category_change (shade_id, action, before, after, source, actor_user_id, backfill_run_id)
         VALUES ($1, 'exclude', '{"status":"active"}'::jsonb, $2::jsonb, 'backfill', $3, $4)`,
        [
          shade.shadeId,
          JSON.stringify({ status: "excluded", reason: "brand_store_rejected", products: shade.products }),
          options.adminUserId,
          runId,
        ]
      );
    }
    const activity = await loadBrandActivity(client, touchedBrands);
    for (const brandId of touchedBrands) {
      const entry = activity.get(brandId);
      if (entry && entry.active === 0) {
        report.brandsWithoutActiveShades.push({ brandId, brand: entry.brand, shades: entry.shades });
      }
    }
  });
  report.retired = changed.length;
  return { ...report, changedShadeIds: changed };
}
