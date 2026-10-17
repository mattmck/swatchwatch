/**
 * Collection export (issue #264): `GET /api/polishes/export?format=csv|json`.
 *
 * The CSV column list (`POLISH_CSV_COLUMNS`) is the contract shared with the CSV import (#263):
 * every column with an `importField` uses a header the importer recognizes as a strong synonym
 * for that field, so an exported sheet re-imports without a manual column mapping. Export-only
 * columns (`importField: null`) use headers the importer does not map, and are ignored on import.
 */
import type { FinishName, Polish } from "./polish";
import type { PolishStatus } from "./inventory";

/** Version of the JSON envelope. Bump when a field is removed or changes meaning. */
export const COLLECTION_EXPORT_VERSION = 1 as const;

export const COLLECTION_EXPORT_FORMATS = ["csv", "json"] as const;
export type CollectionExportFormat = (typeof COLLECTION_EXPORT_FORMATS)[number];

export function isCollectionExportFormat(value: unknown): value is CollectionExportFormat {
  return typeof value === "string" && (COLLECTION_EXPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * One inventory row of the export. A subset of `Polish` limited to what the user owns or
 * entered, plus `displayHex`. Image URLs are deliberately left out: they are short-lived
 * signed capabilities and would be dead links in a saved file.
 */
export interface CollectionExportItem
  extends Pick<
    Polish,
    | "shadeId"
    | "brand"
    | "name"
    | "finishes"
    | "status"
    | "isUntried"
    | "triedAt"
    | "lastWornAt"
    | "wearCount"
    | "purchasePrice"
    | "purchaseCurrency"
    | "vendorHex"
    | "detectedHex"
    | "nameHex"
    | "createdAt"
    | "updatedAt"
  > {
  /** `user_inventory_item` id. Always present in an export (every item is an inventory row). */
  inventoryItemId: string;
  /** Color name/description from the catalog (`Polish.color`); null when unknown. */
  color: string | null;
  finishes: FinishName[];
  status: PolishStatus;
  quantity: number | null;
  collection: string | null;
  size: string | null;
  /** `YYYY-MM-DD` (a calendar date, no time zone). */
  purchaseDate: string | null;
  /** `YYYY-MM-DD` (a calendar date, no time zone). */
  expirationDate: string | null;
  rating: number | null;
  notes: string | null;
  tags: string[];
  /** Best hex for display (vendor > detected > name, see `resolveDisplayHex`). */
  displayHex: string | null;
}

/** JSON export envelope (`format=json`). */
export interface CollectionExport {
  version: typeof COLLECTION_EXPORT_VERSION;
  /** ISO-8601 UTC time the export was produced. */
  exportedAt: string;
  /** Status filter applied (`?status=`), or null when every status was exported. */
  statusFilter: PolishStatus[] | null;
  itemCount: number;
  items: CollectionExportItem[];
}

/**
 * Import field a CSV column round-trips to. Mirrors the CSV importer's field names (#263):
 * `brand`, `name`, `finish`, `quantity`, `price`, `currency`, `purchaseDate`, `status`, `tried`,
 * `notes`.
 */
export type PolishCsvImportField =
  | "brand"
  | "name"
  | "finish"
  | "quantity"
  | "price"
  | "currency"
  | "purchaseDate"
  | "status"
  | "tried"
  | "notes";

export interface PolishCsvColumn {
  /** Stable key (used by the serializer; never shown to users). */
  readonly key: string;
  /** Header cell written to the CSV. */
  readonly header: string;
  /** Import field this column feeds, or null for export-only columns. */
  readonly importField: PolishCsvImportField | null;
}

/**
 * CSV columns, in file order. Round-trip columns come first, export-only extras after.
 *
 * Cell formats: dates are `YYYY-MM-DD` (UTC for timestamps), `Purchase price` is a plain
 * decimal with two places (no currency symbol, the code is in `Currency`), `Finishes` and `Tags`
 * are joined with `POLISH_CSV_LIST_SEPARATOR`, `Status` is a `PolishStatus` value. Empty cell =
 * no value.
 */
export const POLISH_CSV_COLUMNS = [
  { key: "brand", header: "Brand", importField: "brand" },
  { key: "name", header: "Shade name", importField: "name" },
  { key: "finishes", header: "Finishes", importField: "finish" },
  { key: "quantity", header: "Quantity", importField: "quantity" },
  { key: "status", header: "Status", importField: "status" },
  { key: "triedAt", header: "Date tried", importField: "tried" },
  { key: "purchasePrice", header: "Purchase price", importField: "price" },
  { key: "purchaseCurrency", header: "Currency", importField: "currency" },
  { key: "purchaseDate", header: "Purchase date", importField: "purchaseDate" },
  { key: "notes", header: "Notes", importField: "notes" },
  // Export-only extras (ignored by the importer).
  { key: "displayHex", header: "Display hex", importField: null },
  { key: "collection", header: "Collection", importField: null },
  { key: "rating", header: "Rating", importField: null },
  { key: "tags", header: "Tags", importField: null },
  { key: "size", header: "Size", importField: null },
  { key: "expirationDate", header: "Expiration date", importField: null },
  { key: "lastWornAt", header: "Last worn", importField: null },
  { key: "wearCount", header: "Wear count", importField: null },
  { key: "shadeId", header: "Shade ID", importField: null },
  { key: "inventoryItemId", header: "Item ID", importField: null },
  { key: "createdAt", header: "Created at", importField: null },
  { key: "updatedAt", header: "Updated at", importField: null },
] as const satisfies readonly PolishCsvColumn[];

export type PolishCsvColumnKey = (typeof POLISH_CSV_COLUMNS)[number]["key"];

/** Header row, in file order. */
export const POLISH_CSV_HEADERS: readonly string[] = POLISH_CSV_COLUMNS.map((column) => column.header);

/** Separator for multi-value cells (`Finishes`, `Tags`). The importer splits finishes on `,`. */
export const POLISH_CSV_LIST_SEPARATOR = ", ";

/** `swatchwatch-collection-YYYY-MM-DD.<format>` for the given time (UTC date). */
export function collectionExportFilename(format: CollectionExportFormat, at: Date = new Date()): string {
  return `swatchwatch-collection-${at.toISOString().slice(0, 10)}.${format}`;
}

