/**
 * Barcode backfill (#21, #325): build catalog `barcode` rows for products ingested before
 * ingestion started writing them. Each stored connector product (`external_product`) with a
 * GTIN or variant barcodes is linked to the shade it was materialized into
 * (`shade_source_product`), through the same `upsertShadeBarcodes` ingestion uses
 * (`barcode.source = 'backfill'`).
 *
 * Rules:
 * - A product linked to exactly one shade gets its barcodes; a product linked to several
 *   shades (MakeupAPI-style: one product, many color variants) is reported as ambiguous and
 *   skipped, since its GTIN cannot be attributed to one shade.
 * - First shade wins: a GTIN another shade already owns stays there and is reported.
 * - A dry run (the default) runs the exact same statements in one transaction and rolls it
 *   back, so its report is what a write would do.
 * Keyset-paginated over `external_product_id`; idempotent.
 */
import { collectProductGtins, upsertShadeBarcodes } from "./barcodes";

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;

export interface BarcodeBackfillOptions {
  afterExternalProductId: number;
  limit: number;
  dryRun: boolean;
}

export interface BarcodeBackfillConflict {
  externalProductId: number;
  shadeId: number;
  gtin: string;
  existingShadeId: number;
}

export interface BarcodeBackfillReport {
  dryRun: boolean;
  scannedProducts: number;
  /** Products with at least one valid GTIN. */
  productsWithGtins: number;
  /** Valid GTINs found across scanned products (product GTIN + variant barcodes, deduped per product). */
  gtinsFound: number;
  /** `barcode` rows written (or that a write would add, in a dry run). */
  inserted: number;
  alreadyLinked: number;
  /** Shades that had no barcode and gain at least one. */
  shadesGainingBarcode: number;
  conflicts: BarcodeBackfillConflict[];
  ambiguousProducts: Array<{ externalProductId: number; shadeIds: number[] }>;
  /** Barcodes written although their check digit is wrong (kept, not rejected). */
  invalidCheckDigit: Array<{ externalProductId: number; shadeId: number; gtin: string }>;
  /** Pass as `afterExternalProductId` for the next batch; null when the scan is finished. */
  nextAfterExternalProductId: number | null;
}

interface QueryClient {
  query<R extends Record<string, any> = any>(sql: string, params?: any[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface BarcodeBackfillDb {
  query: QueryClient["query"];
  transaction<T>(callback: (client: QueryClient) => Promise<T>): Promise<T>;
}

export function parseBarcodeBackfillBody(raw: unknown): BarcodeBackfillOptions | string {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const afterExternalProductId = body.afterExternalProductId ?? 0;
  const limit = body.limit ?? DEFAULT_BATCH_SIZE;
  const dryRun = body.dryRun ?? true;
  if (
    typeof afterExternalProductId !== "number" ||
    !Number.isSafeInteger(afterExternalProductId) ||
    afterExternalProductId < 0
  ) {
    return "afterExternalProductId must be a non-negative integer";
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    return `limit must be an integer between 1 and ${MAX_BATCH_SIZE}`;
  }
  if (typeof dryRun !== "boolean") {
    return "dryRun must be a boolean";
  }
  return { afterExternalProductId, limit, dryRun };
}

class DryRunRollback extends Error {
  constructor(readonly report: BarcodeBackfillReport) {
    super("barcode backfill dry run (rolled back)");
  }
}

export async function runBarcodeBackfillBatch(
  db: BarcodeBackfillDb,
  options: BarcodeBackfillOptions
): Promise<BarcodeBackfillReport> {
  const products = await db.query<{
    externalProductId: string;
    externalId: string | null;
    gtin: string | null;
    variants: unknown;
    shadeIds: string[];
  }>(
    `SELECT
       ep.external_product_id::text AS "externalProductId",
       ep.external_id AS "externalId",
       ep.gtin,
       ep.normalized_json -> 'variants' AS variants,
       array_agg(ssp.shade_id::text ORDER BY ssp.shade_id) AS "shadeIds"
     FROM external_product ep
     JOIN shade_source_product ssp ON ssp.external_product_id = ep.external_product_id
     WHERE ep.external_product_id > $1
       AND (
         ep.gtin IS NOT NULL
         OR jsonb_path_exists(ep.normalized_json, '$.variants[*].barcode ? (@.type() == "string")')
       )
     GROUP BY ep.external_product_id
     ORDER BY ep.external_product_id
     LIMIT $2`,
    [options.afterExternalProductId, options.limit]
  );

  const rows = products.rows;
  const report: BarcodeBackfillReport = {
    dryRun: options.dryRun,
    scannedProducts: rows.length,
    productsWithGtins: 0,
    gtinsFound: 0,
    inserted: 0,
    alreadyLinked: 0,
    shadesGainingBarcode: 0,
    conflicts: [],
    ambiguousProducts: [],
    invalidCheckDigit: [],
    nextAfterExternalProductId:
      rows.length === options.limit ? Number(rows[rows.length - 1].externalProductId) : null,
  };
  if (rows.length === 0) return report;

  const apply = async (client: QueryClient) => {
    const gainedShades = new Set<number>();
    for (const row of rows) {
      const externalProductId = Number(row.externalProductId);
      const gtins = collectProductGtins({ gtin: row.gtin, normalized: { variants: row.variants } });
      if (gtins.length === 0) continue;
      report.productsWithGtins += 1;
      report.gtinsFound += gtins.length;

      const shadeIds = row.shadeIds.map(Number);
      if (shadeIds.length !== 1) {
        report.ambiguousProducts.push({ externalProductId, shadeIds });
        continue;
      }
      const [shadeId] = shadeIds;
      const before = await client.query<{ hasBarcode: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM barcode b JOIN sku s ON s.sku_id = b.sku_id WHERE s.shade_id = $1
         ) AS "hasBarcode"`,
        [shadeId]
      );
      const result = await upsertShadeBarcodes(client, {
        shadeId,
        gtins,
        source: "backfill",
        externalProductId,
      });
      report.inserted += result.inserted;
      report.alreadyLinked += result.alreadyLinked;
      if (result.inserted > 0 && !before.rows[0]?.hasBarcode) gainedShades.add(shadeId);
      for (const gtin of result.invalidCheckDigit) {
        report.invalidCheckDigit.push({ externalProductId, shadeId, gtin });
      }
      for (const conflict of result.conflicts) {
        report.conflicts.push({ externalProductId, shadeId, ...conflict });
      }
    }
    report.shadesGainingBarcode = gainedShades.size;
  };

  if (!options.dryRun) {
    await db.transaction(apply);
    return report;
  }
  try {
    await db.transaction(async (client) => {
      await apply(client);
      throw new DryRunRollback(report);
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return report;
}
