/**
 * Collection export (issue #264): the caller's inventory rows as CSV or a versioned JSON
 * envelope. Served by `GET /api/polishes/export` (dispatched from the `polishes-list` route).
 *
 * Rows are read with keyset pagination (`EXPORT_PAGE_SIZE` per query, ordered by brand, shade
 * name, inventory id) so a large collection never loads as one result set; each page is
 * serialized and dropped before the next one is read. The SQL is always scoped by
 * `ui.user_id = $1` (the authenticated caller), never by a client-supplied id.
 */
import {
  COLLECTION_EXPORT_VERSION,
  POLISH_CSV_COLUMNS,
  POLISH_CSV_LIST_SEPARATOR,
  collectionExportFilename,
  isCollectionExportFormat,
  resolveDisplayHex,
  resolvePolishFinishes,
  type CollectionExport,
  type CollectionExportFormat,
  type CollectionExportItem,
  type PolishCsvColumnKey,
  type PolishStatus,
} from "swatchwatch-shared";
import { CSV_UTF8_BOM, encodeCsvRecord } from "./csv";

/** Rows per keyset page. */
export const EXPORT_PAGE_SIZE = 500;

/** Thrown for an invalid export request; the handler answers 400 with `message`. */
export class CollectionExportRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectionExportRequestError";
  }
}

/**
 * `?format=` → export format. Absent/blank → `csv`; case-insensitive.
 * @throws CollectionExportRequestError for any other value.
 */
export function parseExportFormat(param: string | null | undefined): CollectionExportFormat {
  const normalized = (param ?? "").trim().toLowerCase();
  if (!normalized) return "csv";
  if (!isCollectionExportFormat(normalized)) {
    throw new CollectionExportRequestError('format must be "csv" or "json"');
  }
  return normalized;
}

const UTC_TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * One keyset page of the caller's inventory. Dates and timestamps are formatted in SQL so
 * node-postgres never turns a DATE into a local-midnight `Date` (which shifts the day).
 *
 * Params: `$1` caller user id, `$2` status filter (`text[]`, NULL = every status), `$3`/`$4`/`$5`
 * the previous page's last (brand, name, inventory id) or NULL for the first page, `$6` limit.
 * A row with no shade (SKU-only, written by capture) falls back to the SKU's shade/brand/name.
 */
export const COLLECTION_EXPORT_SQL = `
  SELECT
    ui.inventory_item_id::text                                       AS "inventoryItemId",
    COALESCE(s.shade_id, k.shade_id)::text                            AS "shadeId",
    COALESCE(b.name_canonical, '')                                    AS brand,
    COALESCE(s.shade_name_canonical, k.product_name, '')              AS name,
    NULLIF(s.color_name, '')                                          AS color,
    s.finish                                                          AS "legacyFinish",
    COALESCE(s.finishes, ARRAY[]::text[])                             AS finishes,
    NULLIF(s.collection, '')                                          AS collection,
    ui.quantity,
    ui.status,
    (ui.status = 'owned' AND ui.tried_at IS NULL)                     AS "isUntried",
    to_char(ui.tried_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP})         AS "triedAt",
    to_char(ui.last_worn_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP})     AS "lastWornAt",
    ui.wear_count                                                     AS "wearCount",
    ui.purchase_price::float8                                         AS "purchasePrice",
    ui.purchase_currency                                              AS "purchaseCurrency",
    to_char(ui.purchase_date, 'YYYY-MM-DD')                           AS "purchaseDate",
    to_char(ui.expiration_date, 'YYYY-MM-DD')                         AS "expirationDate",
    ui.size_display                                                   AS size,
    ui.rating,
    ui.notes,
    COALESCE(ui.tags, ARRAY[]::text[])                                AS tags,
    s.vendor_hex                                                      AS "vendorHex",
    s.detected_hex                                                    AS "detectedHex",
    s.name_hex                                                        AS "nameHex",
    to_char(ui.created_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP})       AS "createdAt",
    to_char(ui.updated_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP})       AS "updatedAt"
  FROM user_inventory_item ui
  LEFT JOIN sku k ON k.sku_id = ui.sku_id
  LEFT JOIN shade s ON s.shade_id = COALESCE(ui.shade_id, k.shade_id)
  LEFT JOIN brand b ON b.brand_id = COALESCE(s.brand_id, k.brand_id)
  WHERE ui.user_id = $1
    AND ($2::text[] IS NULL OR ui.status = ANY($2::text[]))
    AND (
      $5::bigint IS NULL
      OR (COALESCE(b.name_canonical, ''), COALESCE(s.shade_name_canonical, k.product_name, ''), ui.inventory_item_id)
         > ($3::text, $4::text, $5::bigint)
    )
  ORDER BY COALESCE(b.name_canonical, ''), COALESCE(s.shade_name_canonical, k.product_name, ''), ui.inventory_item_id
  LIMIT $6`;

/** A row of `COLLECTION_EXPORT_SQL`. */
export interface CollectionExportDbRow {
  inventoryItemId: string;
  shadeId: string | null;
  brand: string;
  name: string;
  color: string | null;
  legacyFinish: string | null;
  finishes: string[] | null;
  collection: string | null;
  quantity: number | null;
  status: PolishStatus;
  isUntried: boolean | null;
  triedAt: string | null;
  lastWornAt: string | null;
  wearCount: number | null;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
  purchaseDate: string | null;
  expirationDate: string | null;
  size: string | null;
  rating: number | null;
  notes: string | null;
  tags: string[] | null;
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExportQueryFn = (
  text: string,
  params: unknown[]
) => Promise<{ rows: CollectionExportDbRow[] }>;

/** Map a DB row to the shared export item. */
export function toCollectionExportItem(row: CollectionExportDbRow): CollectionExportItem {
  return {
    inventoryItemId: row.inventoryItemId,
    shadeId: row.shadeId ?? "",
    brand: row.brand,
    name: row.name,
    color: row.color ?? null,
    finishes: resolvePolishFinishes({ finish: row.legacyFinish, finishes: row.finishes }),
    collection: row.collection ?? null,
    quantity: row.quantity ?? null,
    status: row.status,
    isUntried: row.isUntried === true,
    triedAt: row.triedAt ?? null,
    lastWornAt: row.lastWornAt ?? null,
    wearCount: row.wearCount ?? 0,
    purchasePrice: row.purchasePrice ?? null,
    purchaseCurrency: row.purchaseCurrency ?? null,
    purchaseDate: row.purchaseDate ?? null,
    expirationDate: row.expirationDate ?? null,
    size: row.size ?? null,
    rating: row.rating ?? null,
    notes: row.notes ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    vendorHex: row.vendorHex ?? undefined,
    detectedHex: row.detectedHex ?? undefined,
    nameHex: row.nameHex ?? undefined,
    displayHex:
      resolveDisplayHex({
        vendorHex: row.vendorHex ?? undefined,
        detectedHex: row.detectedHex ?? undefined,
        nameHex: row.nameHex ?? undefined,
      }) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** ISO timestamp/date → `YYYY-MM-DD`. */
function dateOnly(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

function numberCell(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/** Cell value per CSV column. A `Record` so a new column in shared fails to compile until mapped here. */
const CSV_CELL: Readonly<Record<PolishCsvColumnKey, (item: CollectionExportItem) => string>> = {
  brand: (item) => item.brand,
  name: (item) => item.name,
  finishes: (item) => (item.finishes ?? []).join(POLISH_CSV_LIST_SEPARATOR),
  quantity: (item) => numberCell(item.quantity),
  status: (item) => item.status,
  triedAt: (item) => dateOnly(item.triedAt),
  purchasePrice: (item) =>
    typeof item.purchasePrice === "number" && Number.isFinite(item.purchasePrice)
      ? item.purchasePrice.toFixed(2)
      : "",
  purchaseCurrency: (item) => item.purchaseCurrency ?? "",
  purchaseDate: (item) => dateOnly(item.purchaseDate),
  notes: (item) => item.notes ?? "",
  displayHex: (item) => item.displayHex ?? "",
  collection: (item) => item.collection ?? "",
  rating: (item) => numberCell(item.rating),
  tags: (item) => item.tags.join(POLISH_CSV_LIST_SEPARATOR),
  size: (item) => item.size ?? "",
  expirationDate: (item) => dateOnly(item.expirationDate),
  lastWornAt: (item) => dateOnly(item.lastWornAt),
  wearCount: (item) => numberCell(item.wearCount),
  shadeId: (item) => item.shadeId,
  inventoryItemId: (item) => item.inventoryItemId,
  createdAt: (item) => item.createdAt,
  updatedAt: (item) => item.updatedAt,
};

/** The item's cells in `POLISH_CSV_COLUMNS` order (unescaped). */
export function collectionCsvCells(item: CollectionExportItem): string[] {
  return POLISH_CSV_COLUMNS.map((column) => CSV_CELL[column.key](item));
}

/** BOM + header record. */
export function collectionCsvHeader(): string {
  return CSV_UTF8_BOM + encodeCsvRecord(POLISH_CSV_COLUMNS.map((column) => column.header));
}

/** One encoded CSV record for an item. */
export function collectionCsvRecord(item: CollectionExportItem): string {
  return encodeCsvRecord(collectionCsvCells(item));
}

/**
 * Yield the caller's inventory one keyset page at a time (every status unless `statusFilter`
 * is non-empty).
 */
export async function* iterateCollectionExportPages(
  queryFn: ExportQueryFn,
  userId: number,
  statusFilter: readonly PolishStatus[],
  pageSize: number = EXPORT_PAGE_SIZE
): AsyncGenerator<CollectionExportItem[]> {
  const limit = Math.max(1, Math.floor(pageSize));
  let cursor: { brand: string; name: string; id: string } | null = null;
  for (;;) {
    const result: { rows: CollectionExportDbRow[] } = await queryFn(COLLECTION_EXPORT_SQL, [
      userId,
      statusFilter.length > 0 ? [...statusFilter] : null,
      cursor?.brand ?? null,
      cursor?.name ?? null,
      cursor?.id ?? null,
      limit,
    ]);
    const rows = result.rows;
    if (rows.length === 0) return;
    yield rows.map(toCollectionExportItem);
    if (rows.length < limit) return;
    const last = rows[rows.length - 1];
    cursor = { brand: last.brand, name: last.name, id: last.inventoryItemId };
  }
}

export interface BuiltCollectionExport {
  body: string;
  contentType: string;
  filename: string;
  itemCount: number;
}

/** Build the whole export file for the caller. */
export async function buildCollectionExport(options: {
  queryFn: ExportQueryFn;
  userId: number;
  format: CollectionExportFormat;
  statusFilter: readonly PolishStatus[];
  now?: Date;
  pageSize?: number;
}): Promise<BuiltCollectionExport> {
  const now = options.now ?? new Date();
  const pages = iterateCollectionExportPages(
    options.queryFn,
    options.userId,
    options.statusFilter,
    options.pageSize
  );
  const filename = collectionExportFilename(options.format, now);

  if (options.format === "csv") {
    const chunks: string[] = [collectionCsvHeader()];
    let itemCount = 0;
    for await (const page of pages) {
      chunks.push(page.map(collectionCsvRecord).join(""));
      itemCount += page.length;
    }
    return { body: chunks.join(""), contentType: "text/csv; charset=utf-8", filename, itemCount };
  }

  const items: CollectionExportItem[] = [];
  for await (const page of pages) items.push(...page);
  const envelope: CollectionExport = {
    version: COLLECTION_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    statusFilter: options.statusFilter.length > 0 ? [...options.statusFilter] : null,
    itemCount: items.length,
    items,
  };
  return {
    body: JSON.stringify(envelope, null, 2),
    contentType: "application/json; charset=utf-8",
    filename,
    itemCount: items.length,
  };
}
