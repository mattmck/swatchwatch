/**
 * Brand-store shade correction: a brand store's re-run repairs a shade an earlier run filed under
 * the wrong brand or name (a vendor spelling such as "CG", a raw title such as "ALPENGLOW" or
 * "Fleur Bleue - Quick Dry Nail Polish") once the source's vendor aliases and title parser are
 * fixed. Called by the materializer for a `brand`-kind record whose shade was found through the
 * product's own `shade_source_product` listing (lookup step 0), before any catalog write.
 *
 * Rules (`planBrandStoreCorrection` is the pure part):
 * - Nothing to do when the shade already has the record's brand and exactly its clean name.
 * - Never touched (skipped, logged): a shade that is not `active`/`excluded`, merged, in a product
 *   line, a user's (`created_by_user_id`) or review-approved shade, or admin-edited (admin
 *   category or finishes, promoted vendor hex) — the guards of the MakeupAPI dedupe
 *   (`lib/makeupapi-dedupe.ts`); and a shade another brand-kind source also lists (that store has
 *   its own say on the shade). Retailer and feed listings never block.
 * - Same brand and the names differ only in case: renamed in place.
 * - Otherwise the target brand's same-name shades (name compared with whitespace collapsed and
 *   case folded; `active`/`excluded`, unmerged, not in a product line) decide, the way a fresh
 *   run of the record would have found its shade (`findExistingShadeForRecord` steps 1–2):
 *   none → the shade moves to the record's brand and takes the clean name; exactly one exact
 *   identity match (legacy `finish` + `collection`), else exactly one adoptable retailer shade
 *   (`catalog_authority = 'retailer'`, no legacy finish or collection, no brand listing, finishes
 *   fit) → the shade is merged into it through `mergeShadeInto` (`sourceKind: "catalog"`:
 *   inventory, mani log, events, listings and learned barcodes follow; the target's catalog data
 *   is not changed by the merge, and the materializer then writes the record onto the target, so
 *   a retailer shade is taken over as decision D26 describes). Several matches, a match that is
 *   excluded or listed by another brand store, a category mismatch with a brand-store target, or
 *   same-name shades that are no identity match (a re-release, a seeded shade with another
 *   finish) → skipped and logged, never a second same-name shade.
 * - The old name (and the raw store title) stay as aliases when they differ from the new name
 *   other than by case.
 * - Every move, rename and merge writes an `admin_audit_event` (`shade.catalog_correct` /
 *   `shade.catalog_merge`) for the job's admin in the same transaction; the materializer logs one
 *   job-log line per corrected or skipped shade and counts them in the job metrics.
 * A second run finds the shade already correct (or the listing on the survivor) and changes
 * nothing.
 */
import type { PoolClient } from "pg";
import { isBrandSourceSql } from "./source-settings";
import { mergeShadeInto, type MergeShadeOptions, type MergeShadeOutcome } from "./shade-review";

export type BrandStoreCorrectionSkipReason =
  /** A user's, review-approved or admin-edited shade, or one not active/excluded, merged or in a product line. */
  | "protected"
  /** Another brand-kind source lists the shade too. */
  | "other_brand_source"
  /** Several same-name shades of the target brand fit the record. */
  | "ambiguous_target"
  /** The one fitting shade is `excluded` (a merge needs an active survivor). */
  | "target_not_active"
  /** The one fitting shade is listed by another brand-kind source. */
  | "target_other_brand_source"
  /** The one fitting shade is a brand-store shade of another product category. */
  | "category_mismatch"
  /** Same-name shades exist under the target brand but none is the record's identity (an admin decides). */
  | "same_name_not_identity";

/** The shade the record's listing points at, as the correction reads it. */
export interface CorrectionShade {
  shadeId: number;
  brandId: number;
  brand: string;
  name: string;
  status: string;
  mergedIntoShadeId: number | null;
  productLineId: number | null;
  productCategory: string;
  /** `created_by_user_id IS NOT NULL OR review_status = 'approved'`. */
  userShade: boolean;
  /** Admin category or finishes, or a promoted (manual label) vendor hex. */
  adminEdit: boolean;
  /** A brand-kind source other than the record's lists the shade. */
  otherBrandListing: boolean;
}

/** A same-name shade of the record's brand. */
export interface CorrectionCandidate {
  shadeId: number;
  name: string;
  status: string;
  finish: string | null;
  collection: string | null;
  catalogAuthority: string;
  productCategory: string;
  /** Any brand-kind source lists it (step 2 of the lookup never adopts such a shade). */
  brandListed: boolean;
  /** A brand-kind source other than the record's lists it. */
  otherBrandListing: boolean;
  /** `finishesFitRecord(record finishes, candidate finishes)`. */
  finishesFit: boolean;
}

export interface CorrectionRecord {
  brandId: number;
  brand: string;
  /** The clean name from the store's title parser. */
  name: string;
  finish: string | null;
  collection: string | null;
}

export type BrandStoreCorrectionPlan =
  | { action: "none" }
  | { action: "skip"; reason: BrandStoreCorrectionSkipReason; candidateShadeIds: number[] }
  | { action: "move"; brandChanged: boolean; renamed: boolean }
  | { action: "merge"; targetShadeId: number; targetName: string; via: "identity" | "retailer" };

/** Name key for same-name comparisons: whitespace collapsed, case folded. */
export function correctionNameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** True when the shade may be corrected by ingestion at all. */
export function isCorrectableShade(shade: CorrectionShade): boolean {
  return (
    (shade.status === "active" || shade.status === "excluded") &&
    shade.mergedIntoShadeId === null &&
    shade.productLineId === null &&
    !shade.userShade &&
    !shade.adminEdit
  );
}

/**
 * Pure planner. `candidates` are the target brand's same-name shades other than the shade itself
 * (only read when the brand or the case-folded name changes).
 */
export function planBrandStoreCorrection(
  shade: CorrectionShade,
  record: CorrectionRecord,
  candidates: readonly CorrectionCandidate[]
): BrandStoreCorrectionPlan {
  const brandChanged = shade.brandId !== record.brandId;
  const renamed = shade.name !== record.name;
  if (!brandChanged && !renamed) return { action: "none" };
  if (!isCorrectableShade(shade)) return { action: "skip", reason: "protected", candidateShadeIds: [] };
  if (shade.otherBrandListing) return { action: "skip", reason: "other_brand_source", candidateShadeIds: [] };
  // A case-only rename inside the brand cannot create a second same-name shade.
  if (!brandChanged && correctionNameKey(shade.name) === correctionNameKey(record.name)) {
    return { action: "move", brandChanged: false, renamed: true };
  }

  const others = candidates.filter((candidate) => candidate.shadeId !== shade.shadeId);
  if (others.length === 0) return { action: "move", brandChanged, renamed };
  const candidateShadeIds = others.map((candidate) => candidate.shadeId).sort((a, b) => a - b);

  const exact = others.filter(
    (candidate) =>
      (candidate.finish ?? "") === (record.finish ?? "") && (candidate.collection ?? "") === (record.collection ?? "")
  );
  let pick: CorrectionCandidate;
  let via: "identity" | "retailer";
  if (exact.length > 1) return { action: "skip", reason: "ambiguous_target", candidateShadeIds };
  if (exact.length === 1) {
    pick = exact[0];
    via = "identity";
  } else {
    const adoptable = others.filter(
      (candidate) =>
        candidate.catalogAuthority === "retailer" &&
        candidate.finish === null &&
        candidate.collection === null &&
        !candidate.brandListed &&
        candidate.finishesFit
    );
    if (adoptable.length > 1) return { action: "skip", reason: "ambiguous_target", candidateShadeIds };
    if (adoptable.length === 0) return { action: "skip", reason: "same_name_not_identity", candidateShadeIds };
    pick = adoptable[0];
    via = "retailer";
  }

  if (pick.status !== "active") return { action: "skip", reason: "target_not_active", candidateShadeIds };
  if (pick.otherBrandListing) return { action: "skip", reason: "target_other_brand_source", candidateShadeIds };
  // A retailer shade is taken over (the brand rewrites its category); a brand-store one must agree.
  if (pick.catalogAuthority !== "retailer" && pick.productCategory !== shade.productCategory) {
    return { action: "skip", reason: "category_mismatch", candidateShadeIds };
  }
  return { action: "merge", targetShadeId: pick.shadeId, targetName: pick.name, via };
}

export type BrandStoreCorrection =
  | { outcome: "unchanged" }
  | {
      outcome: "moved";
      shadeId: number;
      fromBrandId: number;
      fromBrand: string;
      toBrandId: number;
      toBrand: string;
      fromName: string;
      toName: string;
      brandChanged: boolean;
      renamed: boolean;
    }
  | {
      outcome: "merged";
      sourceShadeId: number;
      targetShadeId: number;
      fromBrand: string;
      toBrand: string;
      fromName: string;
      targetName: string;
      via: "identity" | "retailer";
      movedInventoryRows: number;
      combinedInventoryRows: number;
      /** Users whose inventory changed (polish caches to drop after commit). */
      affectedUserIds: number[];
    }
  | {
      outcome: "skipped";
      shadeId: number;
      reason: BrandStoreCorrectionSkipReason;
      fromBrand: string;
      toBrand: string;
      fromName: string;
      toName: string;
      candidateShadeIds: number[];
    };

export interface BrandStoreCorrectionArgs {
  shadeId: number;
  dataSourceId: number;
  sourceName?: string;
  externalId: string;
  record: CorrectionRecord;
  /** The product's raw store title when it differs from the clean name (kept as an alias). */
  rawTitle: string | null;
  /** The admin who queued the job: audit actor (no audit row when null). */
  actorUserId: number | null;
  /** `finishesFitRecord` of the record's finishes against a candidate's. */
  finishesFit: (candidateFinishes: readonly string[]) => boolean;
}

export interface BrandStoreCorrectionDeps {
  merge: (client: PoolClient, options: MergeShadeOptions) => Promise<MergeShadeOutcome>;
}

const AUDIT_NOTE = "Brand store correction";

type QueryClient = Pick<PoolClient, "query">;

function toId(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

/** EXISTS over the shade's listings from brand-kind sources; `otherThanParam` excludes one source. */
function brandListingSql(shadeColumn: string, otherThanParam: string | null): string {
  return `EXISTS (
         SELECT 1
         FROM shade_source_product bssp
         JOIN external_product bep ON bep.external_product_id = bssp.external_product_id
         JOIN data_source bds ON bds.data_source_id = bep.data_source_id
         WHERE bssp.shade_id = ${shadeColumn}
           ${otherThanParam ? `AND bep.data_source_id <> ${otherThanParam}` : ""}
           AND ${isBrandSourceSql("bds.metadata")}
       )`;
}

async function loadCorrectionShade(
  client: QueryClient,
  shadeId: number,
  dataSourceId: number
): Promise<CorrectionShade | null> {
  const result = await client.query(
    `SELECT s.shade_id AS "shadeId",
            s.brand_id AS "brandId",
            b.name_canonical AS brand,
            s.shade_name_canonical AS name,
            s.status,
            s.merged_into_shade_id AS "mergedIntoShadeId",
            s.product_line_id AS "productLineId",
            s.product_category AS "productCategory",
            (s.created_by_user_id IS NOT NULL OR s.review_status = 'approved') AS "userShade",
            (s.product_category_source = 'admin' OR s.finishes_source = 'admin' OR s.vendor_hex_source = 'manual_label') IS TRUE AS "adminEdit",
            ${brandListingSql("s.shade_id", "$2")} AS "otherBrandListing"
     FROM shade s
     JOIN brand b ON b.brand_id = s.brand_id
     WHERE s.shade_id = $1
     FOR UPDATE OF s`,
    [shadeId, dataSourceId]
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    shadeId: Number(row.shadeId),
    brandId: Number(row.brandId),
    brand: String(row.brand ?? ""),
    name: String(row.name ?? ""),
    status: String(row.status ?? ""),
    mergedIntoShadeId: toId(row.mergedIntoShadeId),
    productLineId: toId(row.productLineId),
    productCategory: String(row.productCategory ?? "color"),
    userShade: row.userShade === true,
    adminEdit: row.adminEdit === true,
    otherBrandListing: row.otherBrandListing === true,
  };
}

async function loadCorrectionCandidates(
  client: QueryClient,
  args: { brandId: number; name: string; shadeId: number; dataSourceId: number },
  finishesFit: (candidateFinishes: readonly string[]) => boolean
): Promise<CorrectionCandidate[]> {
  const result = await client.query(
    `SELECT t.shade_id AS "shadeId",
            t.shade_name_canonical AS name,
            t.status,
            t.finish,
            t.collection,
            t.finishes,
            t.catalog_authority AS "catalogAuthority",
            t.product_category AS "productCategory",
            ${brandListingSql("t.shade_id", null)} AS "brandListed",
            ${brandListingSql("t.shade_id", "$4")} AS "otherBrandListing"
     FROM shade t
     WHERE t.brand_id = $1
       AND t.product_line_id IS NULL
       AND t.shade_id <> $3
       AND t.status IN ('active', 'excluded')
       AND t.merged_into_shade_id IS NULL
       AND lower(btrim(regexp_replace(t.shade_name_canonical, '\\s+', ' ', 'g'))) = lower(btrim(regexp_replace($2::text, '\\s+', ' ', 'g')))
     ORDER BY t.shade_id`,
    [args.brandId, args.name, args.shadeId, args.dataSourceId]
  );
  return (result.rows as Record<string, unknown>[]).map((row) => ({
    shadeId: Number(row.shadeId),
    name: String(row.name ?? ""),
    status: String(row.status ?? ""),
    finish: (row.finish as string | null) ?? null,
    collection: (row.collection as string | null) ?? null,
    catalogAuthority: String(row.catalogAuthority ?? "brand_store"),
    productCategory: String(row.productCategory ?? "color"),
    brandListed: row.brandListed === true,
    otherBrandListing: row.otherBrandListing === true,
    finishesFit: finishesFit(Array.isArray(row.finishes) ? (row.finishes as string[]) : []),
  }));
}

/** Aliases kept for a renamed shade: the old name and the raw title, unless equal to the new name ignoring case. */
export function correctionAliases(newName: string, oldNames: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>([correctionNameKey(newName)]);
  const out: string[] = [];
  for (const value of oldNames) {
    const alias = value?.trim();
    if (!alias) continue;
    const key = correctionNameKey(alias);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

/**
 * Corrects the shade the record's own listing points at (see the module comment). Runs inside the
 * record's transaction; a merge goes through `deps.merge` (default `mergeShadeInto`).
 */
export async function correctBrandStoreShade(
  client: PoolClient,
  args: BrandStoreCorrectionArgs,
  deps: BrandStoreCorrectionDeps = { merge: mergeShadeInto }
): Promise<BrandStoreCorrection> {
  const shade = await loadCorrectionShade(client, args.shadeId, args.dataSourceId);
  if (!shade) return { outcome: "unchanged" };
  const { record } = args;
  if (shade.brandId === record.brandId && shade.name === record.name) return { outcome: "unchanged" };

  const needsCandidates =
    isCorrectableShade(shade) &&
    !shade.otherBrandListing &&
    (shade.brandId !== record.brandId || correctionNameKey(shade.name) !== correctionNameKey(record.name));
  const candidates = needsCandidates
    ? await loadCorrectionCandidates(
        client,
        { brandId: record.brandId, name: record.name, shadeId: shade.shadeId, dataSourceId: args.dataSourceId },
        args.finishesFit
      )
    : [];
  const plan = planBrandStoreCorrection(shade, record, candidates);
  const base = { fromBrand: shade.brand, toBrand: record.brand, fromName: shade.name };

  if (plan.action === "none") return { outcome: "unchanged" };
  if (plan.action === "skip") {
    return {
      outcome: "skipped",
      shadeId: shade.shadeId,
      reason: plan.reason,
      ...base,
      toName: record.name,
      candidateShadeIds: plan.candidateShadeIds,
    };
  }

  const context = { dataSourceId: args.dataSourceId, dataSource: args.sourceName ?? null, externalId: args.externalId };
  if (plan.action === "move") {
    await client.query(
      `UPDATE shade
       SET brand_id = $2, shade_name_canonical = $3, updated_at = now()
       WHERE shade_id = $1`,
      [shade.shadeId, record.brandId, record.name]
    );
    if (plan.brandChanged) {
      // SKUs carry the brand too (mergeShadeInto re-points them the same way).
      await client.query(`UPDATE sku SET brand_id = $2 WHERE shade_id = $1`, [shade.shadeId, record.brandId]);
    }
    for (const alias of correctionAliases(record.name, [shade.name, args.rawTitle])) {
      await client.query(`INSERT INTO shade_alias (shade_id, alias) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        shade.shadeId,
        alias,
      ]);
    }
    await writeAudit(client, args.actorUserId, "shade.catalog_correct", {
      shadeId: shade.shadeId,
      brand: { from: { id: shade.brandId, name: shade.brand }, to: { id: record.brandId, name: record.brand } },
      name: { from: shade.name, to: record.name },
      ...context,
    });
    return {
      outcome: "moved",
      shadeId: shade.shadeId,
      fromBrandId: shade.brandId,
      toBrandId: record.brandId,
      ...base,
      toName: record.name,
      brandChanged: plan.brandChanged,
      renamed: plan.renamed,
    };
  }

  const outcome = await deps.merge(client, {
    sourceShadeId: shade.shadeId,
    targetShadeId: plan.targetShadeId,
    adminUserId: args.actorUserId,
    sourceKind: "catalog",
    note: `${AUDIT_NOTE}${args.sourceName ? ` (${args.sourceName})` : ""}`,
  });
  // The raw store title also names the survivor (the old name is copied by the merge).
  for (const alias of correctionAliases(plan.targetName, [shade.name, args.rawTitle]).filter(
    (value) => correctionNameKey(value) !== correctionNameKey(shade.name)
  )) {
    await client.query(`INSERT INTO shade_alias (shade_id, alias) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      plan.targetShadeId,
      alias,
    ]);
  }
  await writeAudit(client, args.actorUserId, "shade.catalog_merge", {
    sourceShadeId: shade.shadeId,
    targetShadeId: plan.targetShadeId,
    sourceName: shade.name,
    targetName: plan.targetName,
    fromBrand: { id: shade.brandId, name: shade.brand },
    toBrand: { id: record.brandId, name: record.brand },
    reason: `brand_store_correction_${plan.via}`,
    movedInventoryRows: outcome.movedInventoryRows,
    combinedInventoryRows: outcome.combinedInventoryRows,
    movedSourceProductRows: outcome.movedSourceProductRows,
    ...context,
  });
  return {
    outcome: "merged",
    sourceShadeId: shade.shadeId,
    targetShadeId: plan.targetShadeId,
    ...base,
    targetName: plan.targetName,
    via: plan.via,
    movedInventoryRows: outcome.movedInventoryRows,
    combinedInventoryRows: outcome.combinedInventoryRows,
    affectedUserIds: outcome.affectedUserIds,
  };
}

/**
 * One `admin_audit_event` for the job's admin. Inside a savepoint: a database whose migration
 * 20261110150000000 is not applied yet rejects `shade.catalog_correct`, and that must not undo the
 * record (the job log still has the line).
 */
async function writeAudit(
  client: QueryClient,
  actorUserId: number | null,
  action: "shade.catalog_correct" | "shade.catalog_merge",
  changes: Record<string, unknown>
): Promise<void> {
  if (actorUserId === null) return;
  await client.query("SAVEPOINT brand_store_correction_audit");
  try {
    await client.query(
      `INSERT INTO admin_audit_event (actor_user_id, target_user_id, action, changes, note)
       VALUES ($1, NULL, $2, $3::jsonb, $4)`,
      [actorUserId, action, JSON.stringify(changes), AUDIT_NOTE]
    );
    await client.query("RELEASE SAVEPOINT brand_store_correction_audit");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT brand_store_correction_audit");
    console.warn(
      `[brand-store-correction] audit row ${action} not written: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
