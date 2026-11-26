import type { HttpResponseInit } from "@azure/functions";
import { getDataSourceByName, type DataSourceRecord } from "./ingestion-repo";

type GuardRow = Pick<DataSourceRecord, "enabled" | "metadata">;

export type DataSourceLookup = (name: string) => Promise<GuardRow | null>;

/**
 * The reason a source is known-blocked (`data_source.metadata.blocked`: a reason such as
 * "robots" or "cloudflare", or `true`), else null. A blocked source is never run, enabled or not.
 */
export function sourceBlockedReason(row: Pick<DataSourceRecord, "metadata"> | null | undefined): string | null {
  const blocked = row?.metadata?.blocked;
  if (typeof blocked === "string") return blocked.trim() || null;
  return blocked === true ? "blocked" : null;
}

/**
 * Refuses a run for a source whose `data_source` row exists and is known-blocked
 * (`metadata.blocked`, 409 `source_blocked`) or disabled (pending approval or switched off, 409
 * `source_disabled`). A missing row passes: Shopify sources are auto-provisioned, others fail later.
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
export function refuseIfDisabled(source: string, row: GuardRow | null): HttpResponseInit | null {
  const blockedReason = sourceBlockedReason(row);
  if (blockedReason) {
    return {
      status: 409,
      jsonBody: {
        error: "source_blocked",
        message: `${source} is known-blocked (${blockedReason}); remove metadata.blocked only once the store allows access`,
      },
    };
  }
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

/** Names of the rows that are known-blocked (`metadata.blocked`), for the bulk run's all-or-nothing check. */
export function partitionBlockedSources(
  rows: ReadonlyArray<{ name: string; metadata?: Record<string, unknown> | null } | null>
): string[] {
  return rows.filter((row) => row !== null && sourceBlockedReason(row) !== null).map((row) => row!.name);
}
