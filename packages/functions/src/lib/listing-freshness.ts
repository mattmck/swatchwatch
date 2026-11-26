/**
 * Listing freshness: after a complete store catalog fetch, `external_product` rows of that
 * source that are no longer in the catalog get `missing_since` (they stop being buy links);
 * rows that are in it are live again. An incomplete or empty fetch changes nothing, so a
 * truncated download can never retire listings.
 */
import type { PoolClient } from "pg";

export interface ConnectorCatalogIds {
  /** Every product id in the fetched catalog, before any filter. */
  externalIds: string[];
  /** True only when the fetch reached the end of the store's catalog. */
  complete: boolean;
}

export interface ListingFreshnessResult {
  marked: number;
  cleared: number;
  skipped: boolean;
}

export async function markExternalProductsMissing(
  client: Pick<PoolClient, "query">,
  dataSourceId: number,
  catalog: ConnectorCatalogIds
): Promise<ListingFreshnessResult> {
  if (!catalog.complete || catalog.externalIds.length === 0) {
    return { marked: 0, cleared: 0, skipped: true };
  }

  const marked = await client.query(
    `UPDATE external_product
     SET missing_since = COALESCE(missing_since, now())
     WHERE data_source_id = $1
       AND external_id IS NOT NULL
       AND external_id NOT IN (SELECT unnest($2::text[]))`,
    [dataSourceId, catalog.externalIds]
  );
  const cleared = await client.query(
    `UPDATE external_product
     SET missing_since = NULL
     WHERE data_source_id = $1
       AND external_id = ANY($2::text[])
       AND missing_since IS NOT NULL`,
    [dataSourceId, catalog.externalIds]
  );

  return { marked: marked.rowCount ?? 0, cleared: cleared.rowCount ?? 0, skipped: false };
}
