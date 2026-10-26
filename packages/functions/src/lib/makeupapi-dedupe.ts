/**
 * MakeupAPI catalog cleanup: merge the duplicate shades the MakeupAPI connector created and
 * delete the MakeupAPI-only shades nobody uses.
 *
 * MakeupAPI is frozen 2015 data (dead well.ca / dior.com / cloudfront product and image URLs,
 * scraped hexes). Its materializer used to key a shade on brand + color name + `collection =
 * product name`, so Dior's sibling-color products produced one copy per product, and it also
 * duplicated brands that have their own store source (Orly's "Monroe's Red (40052)" next to the
 * OrlyShopify "Monroe's Red").
 *
 * Rules (one brand at a time; `planMakeupApiMerges` is the pure part):
 * - A *MakeupAPI-only* shade is an unmerged, active or excluded shade whose vendor listings
 *   (`shade_source_product`) are all MakeupAPI products and whose `collection` is the name of one
 *   of them (how the materializer made it), so a seed or store shade that gained a MakeupAPI
 *   listing from a merge never counts as one.
 * - Names are compared by `makeupApiNameKey`: whitespace collapsed, case folded and a trailing
 *   product code such as "(40052)" removed; descriptive parentheses ("(Purple Pearl)") stay.
 * - When exactly one active shade of the brand that is not MakeupAPI-only has the key (a store or
 *   seed shade), every MakeupAPI-only shade with the key merges into it; several such shades →
 *   the group is skipped as ambiguous.
 * - Otherwise MakeupAPI-only copies merge into one survivor: the active copy with the most
 *   holders, then the lowest id.
 * - A group whose shades have different product categories is skipped.
 * - Merges go through `mergeShadeInto` (`sourceKind: "catalog"`): inventory (higher status
 *   kept), mani log, events, aliases, SKUs, swatches, every vendor listing and learned barcodes
 *   move; the survivor's name, finishes and hexes never change.
 * - Then every MakeupAPI-only shade (and every copy merged in this batch) that nothing else
 *   references is deleted: no inventory, mani log, events, learned barcodes, labels or any other
 *   row of a table with a foreign key to `shade` (discovered from `pg_constraint` each run), and
 *   no admin edit (admin category or finishes, promoted vendor hex). Aliases, vendor listings and
 *   the category change log go with it; the `external_product` rows stay.
 * - Every merge and delete writes an `admin_audit_event` (`shade.catalog_merge` /
 *   `shade.catalog_delete`, the deleted row as JSON) in the same transaction.
 * A dry run (the default) runs the same statements and rolls them back, so its report is exact.
 * Keyset-paginated over `brand_id`; idempotent.
 */
import type { PoolClient } from "pg";
import { mergeShadeInto } from "./shade-review";

export const MAKEUPAPI_SOURCE_NAME = "MakeupAPI";

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 100;

/** Tables whose rows go with a deleted shade; any other reference keeps the shade. */
const DELETED_WITH_SHADE = new Set(["shade_alias", "shade_source_product", "shade_category_change"]);

const MERGE_NOTE = "MakeupAPI dedupe";

/** Catalog name key: whitespace collapsed, case folded, a trailing "(40052)"-style code removed. */
export function makeupApiNameKey(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*\(\s*[A-Za-z]?\d{2,6}\s*\)$/, "")
    .trim()
    .toLowerCase();
}

export interface DedupeShadeRow {
  shadeId: number;
  brandId: number;
  brand: string;
  name: string;
  status: string;
  productCategory: string;
  /** Every vendor listing is a MakeupAPI product. */
  makeupApiOnly: boolean;
  /** Distinct users with an inventory row for the shade. */
  holders: number;
}

export type MakeupApiMergeReason = "store_shade" | "makeupapi_copy";

export interface PlannedMakeupApiMerge {
  brand: string;
  key: string;
  sourceShadeId: number;
  sourceName: string;
  targetShadeId: number;
  targetName: string;
  reason: MakeupApiMergeReason;
}

export type MakeupApiSkipReason = "ambiguous_store_shades" | "category_mismatch" | "no_active_survivor";

export interface SkippedMakeupApiGroup {
  brand: string;
  key: string;
  shadeIds: number[];
  reason: MakeupApiSkipReason;
}

export function planMakeupApiMerges(rows: readonly DedupeShadeRow[]): {
  merges: PlannedMakeupApiMerge[];
  skipped: SkippedMakeupApiGroup[];
} {
  const groups = new Map<string, DedupeShadeRow[]>();
  for (const row of rows) {
    const key = makeupApiNameKey(row.name);
    if (!key) continue;
    const groupKey = `${row.brandId}\u0000${key}`;
    const group = groups.get(groupKey) ?? [];
    group.push(row);
    groups.set(groupKey, group);
  }

  const merges: PlannedMakeupApiMerge[] = [];
  const skipped: SkippedMakeupApiGroup[] = [];
  for (const group of groups.values()) {
    const key = makeupApiNameKey(group[0].name);
    const brand = group[0].brand;
    const makeup = group
      .filter((row) => row.makeupApiOnly && (row.status === "active" || row.status === "excluded"))
      .sort((a, b) => a.shadeId - b.shadeId);
    const others = group.filter((row) => !row.makeupApiOnly && row.status === "active");
    if (makeup.length === 0 || (others.length === 0 && makeup.length < 2)) continue;

    const skip = (reason: MakeupApiSkipReason) =>
      skipped.push({ brand, key, shadeIds: [...others, ...makeup].map((row) => row.shadeId).sort((a, b) => a - b), reason });

    if (others.length > 1) {
      skip("ambiguous_store_shades");
      continue;
    }

    let target: DedupeShadeRow;
    let reason: MakeupApiMergeReason;
    if (others.length === 1) {
      target = others[0];
      reason = "store_shade";
    } else {
      const survivor = makeup
        .filter((row) => row.status === "active")
        .sort((a, b) => b.holders - a.holders || a.shadeId - b.shadeId)[0];
      if (!survivor) {
        skip("no_active_survivor");
        continue;
      }
      target = survivor;
      reason = "makeupapi_copy";
    }

    const sources = makeup.filter((row) => row.shadeId !== target.shadeId);
    if (sources.some((row) => row.productCategory !== target.productCategory)) {
      skip("category_mismatch");
      continue;
    }
    for (const source of sources) {
      merges.push({
        brand,
        key,
        sourceShadeId: source.shadeId,
        sourceName: source.name,
        targetShadeId: target.shadeId,
        targetName: target.name,
        reason,
      });
    }
  }
  merges.sort((a, b) => a.targetShadeId - b.targetShadeId || a.sourceShadeId - b.sourceShadeId);
  skipped.sort((a, b) => a.shadeIds[0] - b.shadeIds[0]);
  return { merges, skipped };
}

/**
 * Shades that can be deleted: candidates with no blocking reference, minus any shade a kept
 * shade still points at through `merged_into_shade_id` (repeated until nothing changes).
 */
export function resolveDeletableShades(
  candidateIds: readonly number[],
  blockers: ReadonlyMap<number, readonly string[]>,
  mergedInto: ReadonlyArray<{ shadeId: number; mergedIntoShadeId: number }>
): { deletable: number[]; kept: Map<number, string[]> } {
  const kept = new Map<number, string[]>();
  const deletable = new Set<number>();
  for (const id of candidateIds) {
    const reasons = blockers.get(id);
    if (reasons && reasons.length > 0) kept.set(id, [...reasons]);
    else deletable.add(id);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const link of mergedInto) {
      if (deletable.has(link.mergedIntoShadeId) && !deletable.has(link.shadeId)) {
        deletable.delete(link.mergedIntoShadeId);
        kept.set(link.mergedIntoShadeId, [...(kept.get(link.mergedIntoShadeId) ?? []), `merged shade ${link.shadeId}`]);
        changed = true;
      }
    }
  }
  return { deletable: [...deletable].sort((a, b) => a - b), kept };
}

export interface MakeupApiDedupeOptions {
  afterBrandId: number;
  limit: number;
  dryRun: boolean;
  adminUserId: number;
}

export interface MakeupApiDedupeShadeRef {
  shadeId: number;
  brand: string;
  name: string;
}

export interface MakeupApiDedupeReport {
  dryRun: boolean;
  scannedBrands: number;
  /** MakeupAPI-only shades in the scanned brands. */
  makeupApiShades: number;
  merged: number;
  mergedIntoStoreShades: number;
  deleted: number;
  /** Inventory rows re-pointed or combined by the merges. */
  inventoryRowsMoved: number;
  merges: PlannedMakeupApiMerge[];
  skippedGroups: SkippedMakeupApiGroup[];
  deletedShades: MakeupApiDedupeShadeRef[];
  /** MakeupAPI-only shades that stay, with what keeps them. */
  keptShades: Array<MakeupApiDedupeShadeRef & { reasons: string[] }>;
  /** Pass as `afterBrandId` for the next batch; null when the scan is finished. */
  nextAfterBrandId: number | null;
}

interface QueryClient {
  query<R extends Record<string, any> = any>(sql: string, params?: any[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface MakeupApiDedupeDb {
  query: QueryClient["query"];
  transaction<T>(callback: (client: QueryClient) => Promise<T>): Promise<T>;
}

export function parseMakeupApiDedupeBody(
  raw: unknown
): Omit<MakeupApiDedupeOptions, "adminUserId"> | string {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const afterBrandId = body.afterBrandId ?? 0;
  const limit = body.limit ?? DEFAULT_BATCH_SIZE;
  const dryRun = body.dryRun ?? true;
  if (typeof afterBrandId !== "number" || !Number.isSafeInteger(afterBrandId) || afterBrandId < 0) {
    return "afterBrandId must be a non-negative integer";
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    return `limit must be an integer between 1 and ${MAX_BATCH_SIZE}`;
  }
  if (typeof dryRun !== "boolean") {
    return "dryRun must be a boolean";
  }
  return { afterBrandId, limit, dryRun };
}

class DryRunRollback extends Error {
  constructor(readonly report: MakeupApiDedupeReport) {
    super("MakeupAPI dedupe dry run (rolled back)");
  }
}

/**
 * SQL predicate: shade `s` was made by MakeupAPI and no other source lists it ($1 = MakeupAPI
 * ids). The materializer always sets `collection` to the MakeupAPI product name and never changes
 * it, which tells a MakeupAPI shade from a seed or store shade that only gained a MakeupAPI listing
 * from a merge (that one must never be deleted on a later run).
 */
const MAKEUPAPI_ONLY_SQL = `EXISTS (
         SELECT 1 FROM shade_source_product ssp
         JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
         WHERE ssp.shade_id = s.shade_id
           AND ep.data_source_id = ANY($1::bigint[])
           AND lower(btrim(regexp_replace(s.collection, '\\s+', ' ', 'g')))
             = lower(btrim(regexp_replace(ep.normalized_json ->> 'name', '\\s+', ' ', 'g')))
       )
       AND NOT EXISTS (
         SELECT 1 FROM shade_source_product ssp
         JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
         WHERE ssp.shade_id = s.shade_id AND NOT (ep.data_source_id = ANY($1::bigint[]))
       )`;

export async function runMakeupApiDedupeBatch(
  db: MakeupApiDedupeDb,
  options: MakeupApiDedupeOptions
): Promise<MakeupApiDedupeReport & { changedShadeIds: number[] }> {
  const report: MakeupApiDedupeReport = {
    dryRun: options.dryRun,
    scannedBrands: 0,
    makeupApiShades: 0,
    merged: 0,
    mergedIntoStoreShades: 0,
    deleted: 0,
    inventoryRowsMoved: 0,
    merges: [],
    skippedGroups: [],
    deletedShades: [],
    keptShades: [],
    nextAfterBrandId: null,
  };

  const sources = await db.query<{ dataSourceId: string }>(
    `SELECT data_source_id::text AS "dataSourceId" FROM data_source WHERE name = $1`,
    [MAKEUPAPI_SOURCE_NAME]
  );
  const sourceIds = sources.rows.map((row) => row.dataSourceId);
  if (sourceIds.length === 0) return { ...report, changedShadeIds: [] };

  const brands = await db.query<{ brandId: string }>(
    `SELECT DISTINCT s.brand_id::text AS "brandId"
     FROM shade s
     JOIN shade_source_product ssp ON ssp.shade_id = s.shade_id
     JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
     WHERE ep.data_source_id = ANY($1::bigint[])
       AND s.brand_id > $2
     ORDER BY 1
     LIMIT $3`,
    [sourceIds, options.afterBrandId, options.limit]
  );
  const brandIds = brands.rows.map((row) => Number(row.brandId)).sort((a, b) => a - b);
  report.scannedBrands = brandIds.length;
  report.nextAfterBrandId = brandIds.length === options.limit ? brandIds[brandIds.length - 1] : null;
  if (brandIds.length === 0) return { ...report, changedShadeIds: [] };

  const apply = async (client: QueryClient) => {
    const shades = await client.query<{
      shadeId: string;
      brandId: string;
      brand: string;
      name: string;
      status: string;
      productCategory: string;
      makeupApiOnly: boolean;
      holders: string | number;
    }>(
      `SELECT s.shade_id::text AS "shadeId",
              s.brand_id::text AS "brandId",
              b.name_canonical AS brand,
              s.shade_name_canonical AS name,
              s.status,
              s.product_category AS "productCategory",
              (${MAKEUPAPI_ONLY_SQL}) AS "makeupApiOnly",
              (SELECT count(DISTINCT ui.user_id) FROM user_inventory_item ui WHERE ui.shade_id = s.shade_id) AS holders
       FROM shade s
       JOIN brand b ON b.brand_id = s.brand_id
       WHERE s.brand_id = ANY($2::bigint[])
         AND s.merged_into_shade_id IS NULL
         AND s.status IN ('active', 'excluded')
       ORDER BY s.shade_id`,
      [sourceIds, brandIds]
    );
    const rows: DedupeShadeRow[] = shades.rows.map((row) => ({
      shadeId: Number(row.shadeId),
      brandId: Number(row.brandId),
      brand: row.brand,
      name: row.name,
      status: row.status,
      productCategory: row.productCategory,
      makeupApiOnly: row.makeupApiOnly === true,
      holders: Number(row.holders),
    }));
    const byId = new Map(rows.map((row) => [row.shadeId, row]));
    report.makeupApiShades = rows.filter((row) => row.makeupApiOnly).length;

    const plan = planMakeupApiMerges(rows);
    report.merges = plan.merges;
    report.skippedGroups = plan.skipped;
    const changed = new Set<number>();

    for (const merge of plan.merges) {
      const outcome = await mergeShadeInto(client as unknown as PoolClient, {
        sourceShadeId: merge.sourceShadeId,
        targetShadeId: merge.targetShadeId,
        adminUserId: options.adminUserId,
        sourceKind: "catalog",
        note: `${MERGE_NOTE}: ${merge.reason}`,
      });
      await client.query(
        `INSERT INTO admin_audit_event (actor_user_id, target_user_id, action, changes, note)
         VALUES ($1, NULL, 'shade.catalog_merge', $2::jsonb, $3)`,
        [
          options.adminUserId,
          JSON.stringify({
            sourceShadeId: merge.sourceShadeId,
            targetShadeId: merge.targetShadeId,
            sourceName: merge.sourceName,
            targetName: merge.targetName,
            reason: merge.reason,
            movedInventoryRows: outcome.movedInventoryRows,
            combinedInventoryRows: outcome.combinedInventoryRows,
            movedSourceProductRows: outcome.movedSourceProductRows,
          }),
          MERGE_NOTE,
        ]
      );
      report.merged += 1;
      if (merge.reason === "store_shade") report.mergedIntoStoreShades += 1;
      report.inventoryRowsMoved += outcome.movedInventoryRows + outcome.combinedInventoryRows;
      changed.add(merge.sourceShadeId);
      changed.add(merge.targetShadeId);
    }

    // Delete what nothing uses: every MakeupAPI-only shade still standing plus the copies merged above.
    const mergedAway = new Set(plan.merges.map((merge) => merge.sourceShadeId));
    const candidateIds = rows
      .filter((row) => row.makeupApiOnly || mergedAway.has(row.shadeId))
      .map((row) => row.shadeId);
    const blockers = await loadDeleteBlockers(client, candidateIds);
    const mergedInto = await client.query<{ shadeId: string; mergedIntoShadeId: string }>(
      `SELECT shade_id::text AS "shadeId", merged_into_shade_id::text AS "mergedIntoShadeId"
       FROM shade
       WHERE merged_into_shade_id = ANY($1::bigint[])`,
      [candidateIds]
    );
    const { deletable, kept } = resolveDeletableShades(
      candidateIds,
      blockers,
      mergedInto.rows.map((row) => ({ shadeId: Number(row.shadeId), mergedIntoShadeId: Number(row.mergedIntoShadeId) }))
    );

    if (deletable.length > 0) {
      await client.query(
        `INSERT INTO admin_audit_event (actor_user_id, target_user_id, action, changes, note)
         SELECT $1, NULL, 'shade.catalog_delete',
                jsonb_build_object(
                  'shadeId', s.shade_id,
                  'shade', to_jsonb(s.*),
                  'aliases', COALESCE((SELECT jsonb_agg(sa.alias ORDER BY sa.alias) FROM shade_alias sa WHERE sa.shade_id = s.shade_id), '[]'::jsonb),
                  'externalProductIds', COALESCE((SELECT jsonb_agg(ssp.external_product_id ORDER BY ssp.external_product_id) FROM shade_source_product ssp WHERE ssp.shade_id = s.shade_id), '[]'::jsonb)
                ),
                $3
         FROM shade s
         WHERE s.shade_id = ANY($2::bigint[])`,
        [options.adminUserId, deletable, MERGE_NOTE]
      );
      await client.query(`DELETE FROM shade_alias WHERE shade_id = ANY($1::bigint[])`, [deletable]);
      const deleted = await client.query(`DELETE FROM shade WHERE shade_id = ANY($1::bigint[])`, [deletable]);
      report.deleted = deleted.rowCount ?? deletable.length;
      for (const id of deletable) changed.add(id);
    }

    const ref = (id: number): MakeupApiDedupeShadeRef => ({
      shadeId: id,
      brand: byId.get(id)?.brand ?? "",
      name: byId.get(id)?.name ?? "",
    });
    report.deletedShades = deletable.map(ref);
    report.keptShades = [...kept.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, reasons]) => ({ ...ref(id), reasons }));
    return [...changed].sort((a, b) => a - b);
  };

  if (!options.dryRun) {
    const changedShadeIds = await db.transaction(apply);
    return { ...report, changedShadeIds };
  }
  try {
    await db.transaction(async (client) => {
      await apply(client);
      throw new DryRunRollback(report);
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return { ...error.report, changedShadeIds: [] };
    throw error;
  }
  return { ...report, changedShadeIds: [] };
}

/**
 * Why each candidate must stay: users' inventory, mani log, events, learned barcodes, labels, or
 * any other table with a foreign key to `shade` (read from `pg_constraint`, so a new table is
 * covered without code changes), plus admin edits on the shade itself.
 */
async function loadDeleteBlockers(client: QueryClient, shadeIds: number[]): Promise<Map<number, string[]>> {
  const blockers = new Map<number, string[]>();
  if (shadeIds.length === 0) return blockers;
  const add = (id: number, reason: string) => {
    const reasons = blockers.get(id) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    blockers.set(id, reasons);
  };

  // regclass::text and quote_ident() return already-quoted identifiers.
  const references = await client.query<{ tableName: string; columnName: string; plainTable: string }>(
    `SELECT c.conrelid::regclass::text AS "tableName",
            quote_ident(a.attname) AS "columnName",
            cl.relname AS "plainTable"
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     JOIN pg_class cl ON cl.oid = c.conrelid
     WHERE c.contype = 'f'
       AND c.confrelid = 'shade'::regclass
       AND cardinality(c.conkey) = 1
     ORDER BY 1, 2`
  );
  for (const reference of references.rows) {
    // merged_into_shade_id is resolved by resolveDeletableShades; the cascading catalog tables go with the shade.
    if (reference.plainTable === "shade" || DELETED_WITH_SHADE.has(reference.plainTable)) continue;
    if (reference.plainTable.endsWith("_backup")) continue;
    const used = await client.query<{ shadeId: string }>(
      `SELECT DISTINCT ${reference.columnName}::text AS "shadeId"
       FROM ${reference.tableName}
       WHERE ${reference.columnName} = ANY($1::bigint[])`,
      [shadeIds]
    );
    for (const row of used.rows) add(Number(row.shadeId), reference.plainTable);
  }

  const edited = await client.query<{ shadeId: string }>(
    `SELECT shade_id::text AS "shadeId"
     FROM shade
     WHERE shade_id = ANY($1::bigint[])
       AND (product_category_source = 'admin' OR finishes_source = 'admin' OR vendor_hex_source = 'manual_label')`,
    [shadeIds]
  );
  for (const row of edited.rows) add(Number(row.shadeId), "admin edit");
  return blockers;
}
