import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { isUserMediaStorageUrl, storageUrlBlobName, userMediaContainer } from "./blob-storage";

/**
 * Orphaned private media sweep (#319, decision D9).
 *
 * Owner-scoped `image_asset` rows (`owner_type = 'user'`) and their blobs in USER_MEDIA_CONTAINER
 * are left behind when the row that referenced them is cascade-deleted outside the API (an
 * `app_user` delete, or an admin shade merge removing a user's duplicate inventory row). The
 * timer in `functions/orphan-media-sweep.ts` calls `sweepOrphanedUserMedia` to delete them.
 *
 * Safety rules:
 * - "Referenced" means any foreign key into `image_asset`, discovered from `pg_constraint` on every
 *   run, so a table added later is respected without touching this file (deleting a still-
 *   referenced asset would cascade into, or null out, that table's rows).
 * - Only `owner_type = 'user'` rows older than the grace period (by `captured_at`; rows with no
 *   `captured_at` are never swept), so uploads still in progress are never touched.
 * - Only blobs in USER_MEDIA_CONTAINER whose path starts with the row's `owner_id/`. Anything else
 *   (catalog `v2` imagery, `inline://` capture frames, other containers) is skipped, and the row
 *   is kept.
 * - A blob URL shared with any other `image_asset` row is never deleted.
 * - Each asset is locked (`FOR UPDATE SKIP LOCKED`) and re-checked before deleting, so a reference
 *   added since the scan (which needs a key-share lock on the row) either wins or waits.
 * - The blob is deleted before the row: a failed row delete is retried on the next run (the blob
 *   is then a 404, counted as `blobMissing`), while the reverse order could leak a blob forever.
 */

export const DEFAULT_ORPHAN_MEDIA_SWEEP_SCHEDULE = "0 17 3 * * *";

export const ORPHAN_MEDIA_SWEEP_LIMITS = {
  graceSeconds: { fallback: 86_400, min: 3_600, max: 2_592_000 },
  batchSize: { fallback: 100, min: 1, max: 1_000 },
  maxPerRun: { fallback: 2_000, min: 1, max: 20_000 },
} as const;

export interface OrphanMediaSweepConfig {
  /** Minimum age (by `captured_at`) before an unreferenced asset may be deleted. */
  graceSeconds: number;
  /** Candidates fetched per scan query. */
  batchSize: number;
  /** Most candidates examined in one run (bounds the timer's run time). */
  maxPerRun: number;
}

function clampIntEnv(
  value: string | undefined,
  limits: { fallback: number; min: number; max: number }
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return limits.fallback;
  return Math.min(limits.max, Math.max(limits.min, parsed));
}

/** Sweep NCRONTAB schedule from `ORPHAN_MEDIA_SWEEP_SCHEDULE` (default daily at 03:17 UTC). */
export function orphanMediaSweepSchedule(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORPHAN_MEDIA_SWEEP_SCHEDULE?.trim() || DEFAULT_ORPHAN_MEDIA_SWEEP_SCHEDULE;
}

export function getOrphanMediaSweepConfig(env: NodeJS.ProcessEnv = process.env): OrphanMediaSweepConfig {
  return {
    graceSeconds: clampIntEnv(env.ORPHAN_MEDIA_SWEEP_GRACE_SECONDS, ORPHAN_MEDIA_SWEEP_LIMITS.graceSeconds),
    batchSize: clampIntEnv(env.ORPHAN_MEDIA_SWEEP_BATCH_SIZE, ORPHAN_MEDIA_SWEEP_LIMITS.batchSize),
    maxPerRun: clampIntEnv(env.ORPHAN_MEDIA_SWEEP_MAX_PER_RUN, ORPHAN_MEDIA_SWEEP_LIMITS.maxPerRun),
  };
}

type Queryable = {
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
};

/** One single-column foreign key into `image_asset(image_id)`. */
export interface ImageAssetReference {
  schema: string;
  table: string;
  column: string;
}

export class OrphanMediaSweepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrphanMediaSweepError";
  }
}

/**
 * Every foreign key into `image_asset`, from the catalog. Fails closed (throws) when a key is
 * multi-column or does not target `image_id`, since the reference check below could not cover it.
 */
export async function loadImageAssetReferences(db: Queryable): Promise<ImageAssetReference[]> {
  const result = await db.query<{
    schema: string;
    table: string;
    columns: string[] | null;
    referencedColumns: string[] | null;
    constraintName: string;
  }>(
    `SELECT n.nspname AS "schema",
            cl.relname AS "table",
            c.conname AS "constraintName",
            ARRAY(SELECT a.attname::text
                  FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                  ORDER BY k.ord) AS "columns",
            ARRAY(SELECT a.attname::text
                  FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                  ORDER BY k.ord) AS "referencedColumns"
     FROM pg_constraint c
     JOIN pg_class cl ON cl.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE c.contype = 'f'
       AND c.confrelid = 'image_asset'::regclass
     ORDER BY n.nspname, cl.relname, c.conname`
  );

  return result.rows.map((row) => {
    const columns = row.columns ?? [];
    const referenced = row.referencedColumns ?? [];
    if (columns.length !== 1 || referenced.length !== 1 || referenced[0] !== "image_id") {
      throw new OrphanMediaSweepError(
        `Unsupported foreign key ${row.constraintName} on ${row.schema}.${row.table} into image_asset`
      );
    }
    return { schema: row.schema, table: row.table, column: columns[0] };
  });
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** `NOT EXISTS (...)` per reference against `ia.image_id`, ANDed; `TRUE` when there are none. */
export function buildUnreferencedSql(references: readonly ImageAssetReference[]): string {
  if (references.length === 0) return "TRUE";
  return references
    .map(
      (ref) =>
        `NOT EXISTS (SELECT 1 FROM ${quoteIdent(ref.schema)}.${quoteIdent(ref.table)} r ` +
        `WHERE r.${quoteIdent(ref.column)} = ia.image_id)`
    )
    .join("\n       AND ");
}

/**
 * Keyset page of unreferenced user assets past the grace period whose URL contains
 * `/<user-media container>/<owner_id>/`. Params: $1 grace seconds, $2 last image_id seen, $3 limit,
 * $4 pattern prefix from `userMediaUrlLikePrefix`. The ILIKE is only a prefilter, so rows that can
 * never be swept (catalog blobs, `inline://` capture frames, other owners' paths) are not rescanned
 * every run and cannot crowd out real orphans; `isSweepableUserMediaUrl` decides.
 */
export function buildCandidateSql(references: readonly ImageAssetReference[]): string {
  return `SELECT ia.image_id::text AS "imageId"
     FROM image_asset ia
     WHERE ia.owner_type = 'user'
       AND ia.captured_at IS NOT NULL
       AND ia.captured_at < now() - make_interval(secs => $1)
       AND ia.image_id > $2
       AND ia.storage_url ILIKE ($4 || ia.owner_id::text || '/%')
       AND ${buildUnreferencedSql(references)}
     ORDER BY ia.image_id
     LIMIT $3`;
}

/** `%/<container>/` with LIKE wildcards in the container name escaped (the SQL appends `<owner_id>/%`). */
export function userMediaUrlLikePrefix(container: string): string {
  return `%/${container.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/`;
}

/**
 * True when no other `image_asset` row uses `ia`'s blob or thumbnail URL (every upload path writes
 * a fresh UUID name today; this keeps a future dedupe/reuse path from losing a live photo's blob).
 */
const BLOB_NOT_SHARED_SQL = `NOT EXISTS (
           SELECT 1 FROM image_asset o
           WHERE o.image_id <> ia.image_id
             AND (o.storage_url IN (ia.storage_url, ia.thumb_url) OR o.thumb_url IN (ia.storage_url, ia.thumb_url))
         )`;

/**
 * True when `storageUrl` is a blob the sweep may delete for `ownerId`: in USER_MEDIA_CONTAINER and
 * under the owner's `{ownerId}/` prefix (every user-media upload path starts with it).
 */
export function isSweepableUserMediaUrl(storageUrl: unknown, ownerId: string | number): boolean {
  if (typeof storageUrl !== "string" || storageUrl.trim().length === 0) return false;
  if (!isUserMediaStorageUrl(storageUrl)) return false;
  const [owner, ...rest] = storageUrlBlobName(storageUrl).split("/");
  return owner === String(ownerId) && rest.length > 0;
}

export interface OrphanMediaSweepResult {
  /** Unreferenced candidates examined. */
  scanned: number;
  /** image_asset rows deleted (their blobs deleted or already gone). */
  deleted: number;
  /** Deleted rows whose blob was already missing (404). */
  blobMissing: number;
  /** Candidates whose blob or row delete failed; retried on the next run. */
  failed: number;
  /** Candidates left alone: not a user-media blob, locked, referenced again, or gone since the scan. */
  skipped: number;
  /** True when the run stopped at `maxPerRun` with candidates possibly left. */
  truncated: boolean;
}

export interface OrphanMediaSweepDeps {
  query: Queryable["query"];
  transaction<T>(callback: (client: Pick<PoolClient, "query">) => Promise<T>): Promise<T>;
  /** Deletes a user-media blob: true when deleted, false when it did not exist (404). */
  deleteBlob(storageUrl: string): Promise<boolean>;
  log?: (message: string) => void;
  warn?: (message: string, error: unknown) => void;
}

type CandidateOutcome = "deleted" | "blobMissing" | "failed" | "skipped";

async function sweepCandidate(
  deps: OrphanMediaSweepDeps,
  imageId: string,
  unreferencedSql: string,
  graceSeconds: number
): Promise<CandidateOutcome> {
  let blobDeleted = false;
  try {
    return await deps.transaction(async (client) => {
      const locked = await client.query<{ ownerId: string; storageUrl: string; thumbUrl: string | null }>(
        `SELECT ia.owner_id::text AS "ownerId", ia.storage_url AS "storageUrl", ia.thumb_url AS "thumbUrl"
         FROM image_asset ia
         WHERE ia.image_id = $1
           AND ia.owner_type = 'user'
           AND ia.captured_at IS NOT NULL
           AND ia.captured_at < now() - make_interval(secs => $2)
         FOR UPDATE SKIP LOCKED`,
        [imageId, graceSeconds]
      );
      const asset = locked.rows[0];
      if (!asset || !isSweepableUserMediaUrl(asset.storageUrl, asset.ownerId)) return "skipped";

      // Re-check in a new statement (new snapshot) now that the row lock blocks new references, and
      // make sure no other row shares the blob.
      const stillOrphan = await client.query<{ orphan: boolean }>(
        `SELECT (${unreferencedSql}) AND ${BLOB_NOT_SHARED_SQL} AS "orphan"
         FROM image_asset ia
         WHERE ia.image_id = $1`,
        [imageId]
      );
      if (stillOrphan.rows[0]?.orphan !== true) return "skipped";

      let missing = false;
      try {
        missing = !(await deps.deleteBlob(asset.storageUrl));
        blobDeleted = true;
        if (asset.thumbUrl && isSweepableUserMediaUrl(asset.thumbUrl, asset.ownerId)) {
          await deps.deleteBlob(asset.thumbUrl);
        }
      } catch (error) {
        deps.warn?.(`[orphan-media-sweep] Blob delete failed for image ${imageId}`, error);
        return "failed";
      }

      await client.query(
        `DELETE FROM image_asset
         WHERE image_id = $1
           AND owner_type = 'user'`,
        [imageId]
      );
      return missing ? "blobMissing" : "deleted";
    });
  } catch (error) {
    deps.warn?.(
      `[orphan-media-sweep] Row delete failed for image ${imageId}${blobDeleted ? " (blob already deleted; retried next run)" : ""}`,
      error
    );
    return "failed";
  }
}

/**
 * Delete unreferenced owner-scoped media past the grace period, oldest id first, up to
 * `config.maxPerRun` candidates. Per-asset failures are counted, never thrown; a failure to read
 * the catalog or scan candidates throws.
 */
export async function sweepOrphanedUserMedia(
  deps: OrphanMediaSweepDeps,
  config: OrphanMediaSweepConfig
): Promise<OrphanMediaSweepResult> {
  const references = await loadImageAssetReferences(deps);
  const unreferencedSql = buildUnreferencedSql(references);
  const candidateSql = buildCandidateSql(references);
  const urlPattern = userMediaUrlLikePrefix(userMediaContainer());

  const result: OrphanMediaSweepResult = {
    scanned: 0,
    deleted: 0,
    blobMissing: 0,
    failed: 0,
    skipped: 0,
    truncated: false,
  };

  let cursor = "0";
  while (result.scanned < config.maxPerRun) {
    const limit = Math.min(config.batchSize, config.maxPerRun - result.scanned);
    const page = await deps.query<{ imageId: string }>(candidateSql, [config.graceSeconds, cursor, limit, urlPattern]);
    if (page.rows.length === 0) break;

    for (const { imageId } of page.rows) {
      result.scanned += 1;
      const outcome = await sweepCandidate(deps, imageId, unreferencedSql, config.graceSeconds);
      if (outcome === "blobMissing") {
        result.deleted += 1;
        result.blobMissing += 1;
      } else {
        result[outcome] += 1;
      }
    }

    cursor = page.rows[page.rows.length - 1].imageId;
    if (page.rows.length < limit) break;
    if (result.scanned >= config.maxPerRun) result.truncated = true;
  }

  deps.log?.(
    `[orphan-media-sweep] scanned=${result.scanned} deleted=${result.deleted} blobMissing=${result.blobMissing} ` +
      `failed=${result.failed} skipped=${result.skipped} truncated=${result.truncated}`
  );
  return result;
}
