import type { HttpResponseInit } from "@azure/functions";
import { getDataSourceByName, type DataSourceRecord } from "./ingestion-repo";

export type DataSourceLookup = (name: string) => Promise<Pick<DataSourceRecord, "enabled"> | null>;

/**
 * Refuses a run for a source whose `data_source` row exists and is disabled (pending approval or
 * switched off). A missing row passes: Shopify sources are auto-provisioned, others fail later.
 */
export async function assertSourceEnabledForRun(
  source: string,
  lookup: DataSourceLookup = getDataSourceByName
): Promise<HttpResponseInit | null> {
  return refuseIfDisabled(source, await lookup(source));
}

/**
 * Same decision on a row already in hand. Handlers feed it the row `ensureDataSourceByName`
 * returned, so a pending Shopify source auto-provisioned disabled is refused too.
 */
export function refuseIfDisabled(
  source: string,
  row: Pick<DataSourceRecord, "enabled"> | null
): HttpResponseInit | null {
  if (row && row.enabled === false) {
    return {
      status: 409,
      jsonBody: {
        error: "source_disabled",
        message: `${source} is disabled (pending approval or switched off); enable it before running a job`,
      },
    };
  }
  return null;
}

/** Names of the rows that exist and are disabled (all-or-nothing check for bulk runs). */
export function partitionDisabledSources(
  rows: ReadonlyArray<{ name: string; enabled?: boolean } | null>
): string[] {
  const disabled: string[] = [];
  for (const row of rows) {
    if (row && row.enabled === false) disabled.push(row.name);
  }
  return disabled;
}
