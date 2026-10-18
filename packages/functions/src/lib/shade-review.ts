import type { PoolClient } from "pg";
import { normalizeHexColor, type PolishStatus, type ShadeReviewApproveRequest } from "swatchwatch-shared";
import { canonicalizeFinish, type FinishCatalog } from "./finishes";
import { recomputeWearStats } from "./manicure";

/**
 * Admin review of `user_submitted` shades (#45): approve, merge into an active shade, reject.
 *
 * The handlers live in `functions/admin-shade-review.ts`; the transactional pieces live here so
 * they can be unit-tested against a fake `PoolClient`.
 *
 * Retired (merged) shades keep `status = 'user_submitted'` so every existing visibility check
 * keeps them private, and carry `review_status = 'merged'` + `merged_into_shade_id`.
 */

/** HTTP-mappable failure raised inside a review transaction (rolls the transaction back). */
export class ShadeReviewError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ShadeReviewError";
  }
}

// ---------------------------------------------------------------------------
// Generic inventory combine (duplicate rows when a user already holds the target)
// ---------------------------------------------------------------------------

/** One column of `user_inventory_item`, read from the catalog at merge time. */
export interface InventoryColumnMeta {
  name: string;
  isArray: boolean;
  isGenerated: boolean;
  isIdentity: boolean;
}

/** Quote a SQL identifier (names come from pg_catalog, never from request input). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Key/ownership columns the combine step never assigns. */
const INVENTORY_KEY_COLUMNS = new Set(["inventory_item_id", "user_id", "shade_id"]);

/**
 * Inventory status precedence when two rows are combined, highest first (decision D7, #316):
 * a merge never quietly turns a polish someone owns into a wishlist item.
 */
export const INVENTORY_STATUS_MERGE_PRIORITY: readonly PolishStatus[] = ["owned", "destash", "wishlist", "archived"];

/**
 * SQL expression that combines one column of a user's existing target row (`t`) with the same
 * column of their source row (`s`), or null when the column must not be assigned.
 *
 * `idx_user_inventory_unique_shade` / `uq_user_inventory_shade` allow ONE row per
 * (user_id, shade_id), so "keep both" is impossible; rows are combined:
 * - `quantity`: summed
 * - `purchase_date`, `created_at`: earliest (LEAST ignores NULLs)
 * - `notes`: concatenated with a blank line (deduplicated when equal; empty sides dropped)
 * - `updated_at`: now()
 * - `status`: the higher status wins, per `INVENTORY_STATUS_MERGE_PRIORITY` (D7, #316)
 * - array columns (e.g. `tags`): ordered union, target values first
 * - every other column, including columns added after this code was written: the target row's
 *   value wins, NULLs are filled from the source
 */
export function inventoryCombineExpression(column: InventoryColumnMeta): string | null {
  if (column.isGenerated || column.isIdentity || INVENTORY_KEY_COLUMNS.has(column.name)) {
    return null;
  }
  const col = quoteIdent(column.name);
  const t = `t.${col}`;
  const s = `s.${col}`;
  switch (column.name) {
    case "quantity":
      return `COALESCE(${t}, 0) + COALESCE(${s}, 0)`;
    case "purchase_date":
    case "created_at":
      return `LEAST(${t}, ${s})`;
    case "updated_at":
      return "now()";
    case "status":
      return (
        "CASE " +
        INVENTORY_STATUS_MERGE_PRIORITY.map((status) => `WHEN '${status}' IN (${t}, ${s}) THEN '${status}' `).join("") +
        `ELSE COALESCE(${t}, ${s}) END`
      );
    case "notes":
      return (
        `CASE WHEN NULLIF(btrim(${t}), '') IS NULL THEN ${s} ` +
        `WHEN NULLIF(btrim(${s}), '') IS NULL OR btrim(${t}) = btrim(${s}) THEN ${t} ` +
        `ELSE ${t} || E'\\n\\n' || ${s} END`
      );
    default:
      break;
  }
  if (column.isArray) {
    return (
      `CASE WHEN ${t} IS NULL THEN ${s} WHEN ${s} IS NULL THEN ${t} ` +
      `ELSE ARRAY(SELECT u.v FROM unnest(${t} || ${s}) WITH ORDINALITY AS u(v, ord) ` +
      `GROUP BY u.v ORDER BY min(u.ord)) END`
    );
  }
  return `COALESCE(${t}, ${s})`;
}

/**
 * UPDATE that folds each source-shade inventory row (`$1`) into the same user's target-shade
 * row (`$2`). Returns one row per combined pair so the caller can re-point references and
 * delete the source rows.
 */
export function buildInventoryCombineSql(columns: InventoryColumnMeta[]): string {
  const assignments = columns
    .map((column) => {
      const expression = inventoryCombineExpression(column);
      return expression ? `${quoteIdent(column.name)} = ${expression}` : null;
    })
    .filter((assignment): assignment is string => assignment !== null);
  if (assignments.length === 0) {
    assignments.push("shade_id = t.shade_id");
  }
  return `UPDATE user_inventory_item AS t
     SET ${assignments.join(",\n         ")}
     FROM user_inventory_item AS s
     WHERE s.shade_id = $1
       AND t.shade_id = $2
       AND t.user_id = s.user_id
     RETURNING t.inventory_item_id::text AS "targetItemId",
               s.inventory_item_id::text AS "sourceItemId",
               t.user_id::text AS "userId"`;
}

/** Columns of `user_inventory_item` as the unqualified name resolves (same as the DML below). */
export async function loadInventoryColumns(client: PoolClient): Promise<InventoryColumnMeta[]> {
  const result = await client.query<InventoryColumnMeta>(
    `SELECT a.attname AS name,
            (ty.typcategory = 'A') AS "isArray",
            (a.attgenerated <> '') AS "isGenerated",
            (a.attidentity <> '') AS "isIdentity"
     FROM pg_attribute a
     JOIN pg_type ty ON ty.oid = a.atttypid
     WHERE a.attrelid = 'user_inventory_item'::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum`
  );
  return result.rows;
}

/** Single-column foreign keys that reference `user_inventory_item` (e.g. inventory_event). */
export async function loadInventoryReferences(
  client: PoolClient
): Promise<Array<{ tableName: string; columnName: string }>> {
  // regclass::text and quote_ident() return already-quoted identifiers.
  const result = await client.query<{ tableName: string; columnName: string }>(
    `SELECT c.conrelid::regclass::text AS "tableName",
            quote_ident(a.attname) AS "columnName"
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = 'user_inventory_item'::regclass
       AND cardinality(c.conkey) = 1
     ORDER BY 1, 2`
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Locking + state checks
// ---------------------------------------------------------------------------

export interface LockedShade {
  shadeId: number;
  brandId: number;
  productLineId: number | null;
  name: string;
  status: string;
  reviewStatus: string | null;
  mergedIntoShadeId: number | null;
}

/** Lock the given shades (FOR UPDATE, ascending id to avoid deadlocks) and return them by id. */
export async function lockShades(client: PoolClient, shadeIds: number[]): Promise<Map<number, LockedShade>> {
  const result = await client.query<{
    shadeId: string | number;
    brandId: string | number;
    productLineId: string | number | null;
    name: string;
    status: string;
    reviewStatus: string | null;
    mergedIntoShadeId: string | number | null;
  }>(
    `SELECT shade_id AS "shadeId",
            brand_id AS "brandId",
            product_line_id AS "productLineId",
            shade_name_canonical AS name,
            status,
            review_status AS "reviewStatus",
            merged_into_shade_id AS "mergedIntoShadeId"
     FROM shade
     WHERE shade_id = ANY($1::bigint[])
     ORDER BY shade_id
     FOR UPDATE`,
    [shadeIds]
  );
  const shades = new Map<number, LockedShade>();
  for (const row of result.rows) {
    const shadeId = Number(row.shadeId);
    shades.set(shadeId, {
      shadeId,
      brandId: Number(row.brandId),
      productLineId: row.productLineId === null ? null : Number(row.productLineId),
      name: row.name,
      status: row.status,
      reviewStatus: row.reviewStatus ?? null,
      mergedIntoShadeId: row.mergedIntoShadeId === null ? null : Number(row.mergedIntoShadeId),
    });
  }
  return shades;
}

/**
 * A shade can be approved / merged / rejected while it is `user_submitted` and not retired by
 * a previous merge. Rejected shades can be revisited (approved or merged later).
 */
export function assertReviewable(shade: LockedShade | undefined): LockedShade {
  if (!shade) {
    throw new ShadeReviewError(404, "Shade not found");
  }
  if (shade.status !== "user_submitted" || shade.reviewStatus === "merged" || shade.mergedIntoShadeId !== null) {
    throw new ShadeReviewError(409, "Shade is not awaiting review", {
      status: shade.status,
      reviewStatus: shade.reviewStatus,
    });
  }
  return shade;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export interface MergeShadeOptions {
  sourceShadeId: number;
  targetShadeId: number;
  adminUserId: number;
  /** Add the source name as an alias of the target when it differs (default true). */
  keepNameAsAlias?: boolean;
  note?: string | null;
}

export interface MergeShadeOutcome {
  sourceShadeId: number;
  targetShadeId: number;
  movedInventoryRows: number;
  combinedInventoryRows: number;
  /** Users whose inventory changed (for cache invalidation). */
  affectedUserIds: number[];
  copiedAliasRows: number;
  movedSkuRows: number;
  movedSwatchRows: number;
  reviewedAt: string;
}

/**
 * Merge a `user_submitted` shade into an existing active shade. Must run inside a transaction
 * (`transaction()` from lib/db): any failure rolls every step back.
 *
 * 1. Lock both shades; the source must be reviewable, the target an active, non-retired shade.
 * 2. Users holding BOTH shades: fold the source row into their target row (see
 *    `inventoryCombineExpression`; one row per user+shade is enforced by a unique index), move
 *    every row that references the source row (e.g. inventory_event) to the target row, then
 *    delete the source row.
 * 3. Every other inventory row is re-pointed to the target. Manicure polishes and inventory
 *    events of the source move to the target too, and wear stats are recomputed for the users
 *    involved.
 * 4. Aliases are copied (plus the submitted name, unless `keepNameAsAlias` is false); SKUs and
 *    catalog-sourced swatches (`image_asset.owner_type = 'source'`) move. User-owned swatch
 *    images stay on the retired row so private media never surfaces on a shared shade.
 *    Target catalog data (name, finishes, hexes) is never modified.
 * 5. The source is retired: `review_status = 'merged'`, `merged_into_shade_id`, audit columns.
 */
export async function mergeShadeInto(client: PoolClient, options: MergeShadeOptions): Promise<MergeShadeOutcome> {
  const { sourceShadeId, targetShadeId, adminUserId } = options;
  if (sourceShadeId === targetShadeId) {
    throw new ShadeReviewError(400, "A shade cannot be merged into itself");
  }

  const locked = await lockShades(client, [sourceShadeId, targetShadeId]);
  const source = assertReviewable(locked.get(sourceShadeId));
  const target = locked.get(targetShadeId);
  if (!target) {
    throw new ShadeReviewError(404, "Merge target shade not found");
  }
  if (target.status !== "active" || target.mergedIntoShadeId !== null) {
    throw new ShadeReviewError(409, "Merge target must be an active catalog shade", {
      targetStatus: target.status,
    });
  }

  // 2. Duplicates: the user already holds the target.
  const columns = await loadInventoryColumns(client);
  const combined = await client.query<{ targetItemId: string; sourceItemId: string; userId: string }>(
    buildInventoryCombineSql(columns),
    [sourceShadeId, targetShadeId]
  );
  const pairs = combined.rows;
  const affectedUsers = new Set<number>(pairs.map((row) => Number(row.userId)));

  if (pairs.length > 0) {
    const sourceItemIds = pairs.map((row) => row.sourceItemId);
    const targetItemIds = pairs.map((row) => row.targetItemId);
    for (const reference of await loadInventoryReferences(client)) {
      await client.query(
        `UPDATE ${reference.tableName} AS ref
         SET ${reference.columnName} = m.target_id
         FROM unnest($1::bigint[], $2::bigint[]) AS m(source_id, target_id)
         WHERE ref.${reference.columnName} = m.source_id`,
        [sourceItemIds, targetItemIds]
      );
    }
    await client.query(
      `DELETE FROM user_inventory_item
       WHERE inventory_item_id = ANY($1::bigint[])
         AND shade_id = $2`,
      [sourceItemIds, sourceShadeId]
    );
  }

  // 3. Everyone else: re-point to the target.
  const hasUpdatedAt = columns.some((column) => column.name === "updated_at" && !column.isGenerated);
  const moved = await client.query<{ userId: string }>(
    `UPDATE user_inventory_item
     SET shade_id = $2${hasUpdatedAt ? ", updated_at = now()" : ""}
     WHERE shade_id = $1
     RETURNING user_id::text AS "userId"`,
    [sourceShadeId, targetShadeId]
  );
  for (const row of moved.rows) affectedUsers.add(Number(row.userId));

  // 3b. The mani log (#269) and wear history (D8, #317) follow the shade. A manicure that already
  // lists the target in the same role keeps that row (uq_manicure_polish_shade_role), and a
  // manicure's `used` event for the target supersedes the source's.
  await client.query(
    `DELETE FROM manicure_polish AS s
     USING manicure_polish AS t
     WHERE s.shade_id = $1
       AND t.shade_id = $2
       AND t.manicure_id = s.manicure_id
       AND t.role = s.role`,
    [sourceShadeId, targetShadeId]
  );
  const movedWear = await client.query<{ userId: string }>(
    `UPDATE manicure_polish AS mp
     SET shade_id = $2
     FROM manicure m
     WHERE mp.shade_id = $1
       AND m.manicure_id = mp.manicure_id
     RETURNING m.user_id::text AS "userId"`,
    [sourceShadeId, targetShadeId]
  );
  await client.query(
    `DELETE FROM inventory_event AS s
     USING inventory_event AS t
     WHERE s.shade_id = $1
       AND t.shade_id = $2
       AND s.event_type = 'used'
       AND t.event_type = 'used'
       AND t.manicure_id = s.manicure_id
       AND t.user_id = s.user_id`,
    [sourceShadeId, targetShadeId]
  );
  await client.query(`UPDATE inventory_event SET shade_id = $2 WHERE shade_id = $1`, [sourceShadeId, targetShadeId]);

  // Wear stats are derived per (user, shade): recompute the target for everyone whose inventory or
  // mani log changed (a combined row's counts, or manicures of the source now counting for a
  // target the user already held).
  const wearUsers = new Set<number>([...affectedUsers, ...movedWear.rows.map((row) => Number(row.userId))]);
  for (const userId of [...wearUsers].sort((a, b) => a - b)) {
    const stats = await recomputeWearStats(client, userId, [targetShadeId]);
    if (stats.length > 0) affectedUsers.add(userId);
  }

  // 4. Aliases, SKUs, catalog swatches.
  const aliases = await client.query(
    `INSERT INTO shade_alias (shade_id, alias)
     SELECT $2, sa.alias
     FROM shade_alias sa
     WHERE sa.shade_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM shade_alias existing
         WHERE existing.shade_id = $2 AND lower(existing.alias) = lower(sa.alias)
       )
     ON CONFLICT (shade_id, alias) DO NOTHING`,
    [sourceShadeId, targetShadeId]
  );
  let copiedAliasRows = aliases.rowCount ?? 0;

  const submittedName = source.name.trim();
  if (
    options.keepNameAsAlias !== false &&
    submittedName &&
    submittedName.toLowerCase() !== target.name.trim().toLowerCase()
  ) {
    const nameAlias = await client.query(
      `INSERT INTO shade_alias (shade_id, alias)
       SELECT $1, $2::text
       WHERE NOT EXISTS (
         SELECT 1 FROM shade_alias existing
         WHERE existing.shade_id = $1 AND lower(existing.alias) = lower($2::text)
       )
       ON CONFLICT (shade_id, alias) DO NOTHING`,
      [targetShadeId, submittedName]
    );
    copiedAliasRows += nameAlias.rowCount ?? 0;
  }

  const skus = await client.query(
    `UPDATE sku
     SET shade_id = $2, brand_id = $3, product_line_id = $4
     WHERE shade_id = $1`,
    [sourceShadeId, targetShadeId, target.brandId, target.productLineId]
  );

  const swatches = await client.query(
    `UPDATE swatch AS sw
     SET shade_id = $2
     FROM image_asset ia
     WHERE sw.shade_id = $1
       AND ia.image_id = sw.image_id_original
       AND ia.owner_type = 'source'`,
    [sourceShadeId, targetShadeId]
  );

  // 5. Retire the source (stays user_submitted → private everywhere).
  const retired = await client.query<{ reviewedAt: string | Date }>(
    `UPDATE shade
     SET review_status = 'merged',
         merged_into_shade_id = $2,
         reviewed_by_user_id = $3,
         reviewed_at = now(),
         review_note = $4,
         updated_at = now()
     WHERE shade_id = $1
     RETURNING reviewed_at AS "reviewedAt"`,
    [sourceShadeId, targetShadeId, adminUserId, options.note ?? null]
  );

  return {
    sourceShadeId,
    targetShadeId,
    movedInventoryRows: moved.rowCount ?? moved.rows.length,
    combinedInventoryRows: pairs.length,
    affectedUserIds: [...affectedUsers].sort((a, b) => a - b),
    copiedAliasRows,
    movedSkuRows: skus.rowCount ?? 0,
    movedSwatchRows: swatches.rowCount ?? 0,
    reviewedAt: toIsoString(retired.rows[0]?.reviewedAt),
  };
}

// ---------------------------------------------------------------------------
// Approve edits
// ---------------------------------------------------------------------------

export const MAX_SHADE_TEXT_LENGTH = 200;
export const MAX_REVIEW_NOTE_LENGTH = 1000;

/** Validated approve edits: `undefined` = keep the submitted value, `null` = clear it. */
export interface ApproveEdits {
  brand?: string;
  name?: string;
  finishes?: string[];
  collection?: string | null;
  colorName?: string | null;
  vendorHex?: string | null;
  nameHex?: string | null;
  note: string | null;
}

function parseRequiredText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new ShadeReviewError(400, `${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_SHADE_TEXT_LENGTH) {
    throw new ShadeReviewError(400, `${field} must be at most ${MAX_SHADE_TEXT_LENGTH} characters`);
  }
  return trimmed;
}

function parseNullableText(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ShadeReviewError(400, `${field} must be a string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_SHADE_TEXT_LENGTH) {
    throw new ShadeReviewError(400, `${field} must be at most ${MAX_SHADE_TEXT_LENGTH} characters`);
  }
  return trimmed || null;
}

function parseNullableHex(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const normalized = typeof value === "string" ? normalizeHexColor(value) : null;
  if (!normalized) {
    throw new ShadeReviewError(400, `${field} must be a #RRGGBB hex color or null`);
  }
  return normalized;
}

/** Optional free-text audit note (trimmed, length-capped). */
export function parseReviewNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ShadeReviewError(400, "note must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_REVIEW_NOTE_LENGTH) {
    throw new ShadeReviewError(400, `note must be at most ${MAX_REVIEW_NOTE_LENGTH} characters`);
  }
  return trimmed || null;
}

/**
 * Validate the optional edits of an approve request. Finishes must all resolve to valid finish
 * names in `catalog` (admin-managed finish types + aliases); unknown values are rejected rather
 * than silently dropped.
 */
export function parseApproveEdits(body: unknown, catalog: FinishCatalog): ApproveEdits {
  if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body))) {
    throw new ShadeReviewError(400, "Request body must be a JSON object");
  }
  const input = (body ?? {}) as Partial<Record<keyof ShadeReviewApproveRequest, unknown>>;

  let finishes: string[] | undefined;
  if (input.finishes !== undefined) {
    if (!Array.isArray(input.finishes)) {
      throw new ShadeReviewError(400, "finishes must be an array of finish names");
    }
    finishes = [];
    const unknown: string[] = [];
    for (const value of input.finishes) {
      const canonical = canonicalizeFinish(value, catalog);
      if (!canonical) {
        unknown.push(String(value));
      } else if (!finishes.includes(canonical)) {
        finishes.push(canonical);
      }
    }
    if (unknown.length > 0) {
      throw new ShadeReviewError(400, `Unknown finishes: ${unknown.join(", ")}`, { unknownFinishes: unknown });
    }
  }

  return {
    brand: parseRequiredText(input.brand, "brand"),
    name: parseRequiredText(input.name, "name"),
    finishes,
    collection: parseNullableText(input.collection, "collection"),
    colorName: parseNullableText(input.colorName, "colorName"),
    vendorHex: parseNullableHex(input.vendorHex, "vendorHex"),
    nameHex: parseNullableHex(input.nameHex, "nameHex"),
    note: parseReviewNote(input.note),
  };
}

export interface ApproveShadeOutcome {
  shadeId: number;
  reviewedAt: string;
  /** Inventory holders of the shade (for cache invalidation). */
  holderUserIds: number[];
}

/**
 * Approve a `user_submitted` shade: apply edits and promote it to `active`. Refuses (409) when
 * an active shade of the same brand already has the same name (case-insensitive) and primary
 * finish (`finishes[1]`, falling back to the legacy `finish`): that is a duplicate the admin
 * should merge instead. `shade.finish` (the legacy identity column) is never rewritten;
 * `finishes` is.
 */
export async function approveShade(
  client: PoolClient,
  shadeId: number,
  edits: ApproveEdits,
  adminUserId: number
): Promise<ApproveShadeOutcome> {
  const locked = await lockShades(client, [shadeId]);
  const shade = assertReviewable(locked.get(shadeId));

  let brandId = shade.brandId;
  if (edits.brand !== undefined) {
    await client.query(
      `INSERT INTO brand (name_canonical) VALUES ($1) ON CONFLICT (name_canonical) DO NOTHING`,
      [edits.brand]
    );
    const brand = await client.query<{ brandId: string | number }>(
      `SELECT brand_id AS "brandId" FROM brand WHERE name_canonical = $1`,
      [edits.brand]
    );
    brandId = Number(brand.rows[0].brandId);
  }
  const name = edits.name ?? shade.name;

  const duplicate = await client.query<{ shadeId: string }>(
    `SELECT s.shade_id::text AS "shadeId"
     FROM shade s
     WHERE s.status = 'active'
       AND s.shade_id <> $1
       AND s.brand_id = $2
       AND lower(s.shade_name_canonical) = lower($3)
       AND COALESCE(s.finishes[1], NULLIF(s.finish, ''), '') = COALESCE(
         $4::text,
         (SELECT COALESCE(own.finishes[1], NULLIF(own.finish, ''), '') FROM shade own WHERE own.shade_id = $1)
       )
     ORDER BY s.shade_id
     LIMIT 1`,
    [shadeId, brandId, name, edits.finishes ? (edits.finishes[0] ?? "") : null]
  );
  if (duplicate.rows.length > 0) {
    throw new ShadeReviewError(409, "An active shade with the same brand and name already exists; merge instead", {
      conflictShadeId: duplicate.rows[0].shadeId,
    });
  }

  const sets: string[] = [
    "status = 'active'",
    "review_status = 'approved'",
    "reviewed_by_user_id = $2",
    "reviewed_at = now()",
    "review_note = $3",
    "updated_at = now()",
  ];
  const params: unknown[] = [shadeId, adminUserId, edits.note];
  const set = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (brandId !== shade.brandId) set("brand_id", brandId);
  if (edits.name !== undefined) set("shade_name_canonical", edits.name);
  if (edits.finishes !== undefined) set("finishes", edits.finishes, "::text[]");
  if (edits.collection !== undefined) set("collection", edits.collection);
  if (edits.colorName !== undefined) set("color_name", edits.colorName);
  if (edits.vendorHex !== undefined) set("vendor_hex", edits.vendorHex);
  if (edits.nameHex !== undefined) set("name_hex", edits.nameHex);

  const updated = await client.query<{ reviewedAt: string | Date }>(
    `UPDATE shade SET ${sets.join(", ")} WHERE shade_id = $1 RETURNING reviewed_at AS "reviewedAt"`,
    params
  );
  const holders = await client.query<{ userId: string }>(
    `SELECT DISTINCT user_id::text AS "userId" FROM user_inventory_item WHERE shade_id = $1`,
    [shadeId]
  );
  return {
    shadeId,
    reviewedAt: toIsoString(updated.rows[0]?.reviewedAt),
    holderUserIds: holders.rows.map((row) => Number(row.userId)),
  };
}

/** Reject: the shade stays `user_submitted` (private to its submitter); nothing is deleted. */
export async function rejectShade(
  client: PoolClient,
  shadeId: number,
  adminUserId: number,
  note: string | null
): Promise<{ shadeId: number; reviewedAt: string }> {
  const locked = await lockShades(client, [shadeId]);
  assertReviewable(locked.get(shadeId));
  const updated = await client.query<{ reviewedAt: string | Date }>(
    `UPDATE shade
     SET review_status = 'rejected',
         reviewed_by_user_id = $2,
         reviewed_at = now(),
         review_note = $3,
         updated_at = now()
     WHERE shade_id = $1
     RETURNING reviewed_at AS "reviewedAt"`,
    [shadeId, adminUserId, note]
  );
  return { shadeId, reviewedAt: toIsoString(updated.rows[0]?.reviewedAt) };
}

function toIsoString(value: string | Date | undefined | null): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return new Date().toISOString();
}
