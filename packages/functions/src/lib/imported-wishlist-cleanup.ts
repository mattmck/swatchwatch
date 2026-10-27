/**
 * Imported-wishlist cleanup. Until 2026-10 ingestion added every shade it materialized to the
 * wishlist of the admin who ran the job (`quantity = 0`, `status = 'wishlist'`, note
 * "Imported from <source> external_id=…", tag `imported`). Ingestion now writes catalog rows only;
 * this removes the rows it left behind.
 *
 * A row is removed only while it is exactly what ingestion wrote and nobody has used it since:
 * still `wishlist` with quantity 0, the ingestion note (a note the user wrote is never replaced by
 * ingestion, so any edit keeps the row), the `imported` tag, no rating / price / purchase date /
 * tried / worn data, and no inventory event, nail photo or mani-log entry for that shade. Rows of
 * every user are scanned (in practice only admins who ran ingestion have them).
 *
 * A dry run (the default) reports what a write would remove. Keyset-paginated over
 * `inventory_item_id`; idempotent.
 */

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 2000;

export interface ImportedWishlistCleanupOptions {
  afterInventoryItemId: number;
  limit: number;
  dryRun: boolean;
}

export interface ImportedWishlistCleanupReport {
  dryRun: boolean;
  /** Rows matching the rule in this batch. */
  scanned: number;
  /** Rows deleted (0 in a dry run). */
  removed: number;
  /** Matching rows per user id. */
  byUser: Record<string, number>;
  /** Matching rows per source, read from the import note. */
  bySource: Record<string, number>;
  /** Pass as `afterInventoryItemId` for the next batch; null when the scan is finished. */
  nextAfterInventoryItemId: number | null;
}

interface QueryClient {
  query<R extends Record<string, any> = any>(sql: string, params?: any[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface ImportedWishlistCleanupDb {
  query: QueryClient["query"];
  transaction<T>(callback: (client: QueryClient) => Promise<T>): Promise<T>;
}

/** The untouched-ingestion-row rule; `ui` is the `user_inventory_item` alias. */
export const IMPORTED_WISHLIST_ROW_SQL = `
  ui.status = 'wishlist'
  AND ui.quantity = 0
  AND ui.notes LIKE 'Imported from % external_id=%'
  AND ui.tags @> ARRAY['imported']::text[]
  AND ui.rating IS NULL
  AND ui.purchase_price IS NULL
  AND ui.purchase_date IS NULL
  AND ui.tried_at IS NULL
  AND ui.last_worn_at IS NULL
  AND ui.wear_count = 0
  AND NOT EXISTS (SELECT 1 FROM inventory_event ie WHERE ie.inventory_item_id = ui.inventory_item_id)
  AND NOT EXISTS (SELECT 1 FROM inventory_nail_photo np WHERE np.inventory_item_id = ui.inventory_item_id)
  AND NOT EXISTS (
    SELECT 1 FROM manicure_polish mp JOIN manicure m ON m.manicure_id = mp.manicure_id
    WHERE m.user_id = ui.user_id AND mp.shade_id = ui.shade_id
  )`;

export function parseImportedWishlistCleanupBody(raw: unknown): ImportedWishlistCleanupOptions | string {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const afterInventoryItemId = body.afterInventoryItemId ?? 0;
  const limit = body.limit ?? DEFAULT_BATCH_SIZE;
  const dryRun = body.dryRun ?? true;
  if (typeof afterInventoryItemId !== "number" || !Number.isSafeInteger(afterInventoryItemId) || afterInventoryItemId < 0) {
    return "afterInventoryItemId must be a non-negative integer";
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    return `limit must be an integer between 1 and ${MAX_BATCH_SIZE}`;
  }
  if (typeof dryRun !== "boolean") return "dryRun must be a boolean";
  return { afterInventoryItemId, limit, dryRun };
}

/** "Imported from MakeupAPI external_id=12" → "MakeupAPI". */
export function importNoteSource(note: string | null): string {
  const match = /^Imported from (.+?) external_id=/.exec(note ?? "");
  return match ? match[1] : "unknown";
}

export interface ImportedWishlistCleanupResult {
  report: ImportedWishlistCleanupReport;
  /** Users whose rows were deleted, with the shades (for cache invalidation). */
  affected: Map<number, number[]>;
}

export async function runImportedWishlistCleanupBatch(
  db: ImportedWishlistCleanupDb,
  options: ImportedWishlistCleanupOptions
): Promise<ImportedWishlistCleanupResult> {
  const candidates = await db.query<{ inventoryItemId: string; userId: string; shadeId: string | null; notes: string | null }>(
    `SELECT ui.inventory_item_id::text AS "inventoryItemId",
            ui.user_id::text AS "userId",
            ui.shade_id::text AS "shadeId",
            ui.notes
     FROM user_inventory_item ui
     WHERE ui.inventory_item_id > $1
       AND ${IMPORTED_WISHLIST_ROW_SQL}
     ORDER BY ui.inventory_item_id
     LIMIT $2`,
    [options.afterInventoryItemId, options.limit]
  );
  const rows = candidates.rows;

  const report: ImportedWishlistCleanupReport = {
    dryRun: options.dryRun,
    scanned: rows.length,
    removed: 0,
    byUser: {},
    bySource: {},
    nextAfterInventoryItemId: rows.length === options.limit ? Number(rows[rows.length - 1].inventoryItemId) : null,
  };
  for (const row of rows) {
    report.byUser[row.userId] = (report.byUser[row.userId] ?? 0) + 1;
    const source = importNoteSource(row.notes);
    report.bySource[source] = (report.bySource[source] ?? 0) + 1;
  }

  const affected = new Map<number, number[]>();
  if (options.dryRun || rows.length === 0) return { report, affected };

  // Re-check the rule at delete time, so a row the user touched since the scan is kept.
  const deleted = await db.transaction((client) =>
    client.query<{ userId: string; shadeId: string | null }>(
      `DELETE FROM user_inventory_item ui
       WHERE ui.inventory_item_id = ANY($1::bigint[])
         AND ${IMPORTED_WISHLIST_ROW_SQL}
       RETURNING ui.user_id::text AS "userId", ui.shade_id::text AS "shadeId"`,
      [rows.map((row) => row.inventoryItemId)]
    )
  );
  report.removed = deleted.rows.length;
  for (const row of deleted.rows) {
    const userId = Number(row.userId);
    const shades = affected.get(userId) ?? [];
    if (row.shadeId !== null) shades.push(Number(row.shadeId));
    affected.set(userId, shades);
  }
  return { report, affected };
}
