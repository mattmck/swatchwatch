/**
 * Per-job cache of a connector's raw catalog download.
 *
 * Shopify connectors download the whole store catalog on every pull, so an exhaustive job
 * re-downloaded it once per page and again on every continuation invocation. This cache
 * keeps the first download in memory for the rest of the invocation and, when blob storage
 * is configured, as a gzipped snapshot that later continuations of the same job reuse.
 * Reusing one snapshot also keeps page boundaries stable across invocations.
 *
 * Every blob failure degrades to a fresh download; caching never fails a job.
 */
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { readBlobFromStorageUrl, uploadBytesToBlob } from "./blob-storage";
import type { ConnectorCatalogCache } from "./connectors/types";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const LOG_PREFIX = "[catalog-cache]";

/** Key in `ingestion_job.metrics_json` recording where the job's catalog snapshot lives. */
export const CATALOG_SNAPSHOT_METRICS_KEY = "catalogSnapshot";

export interface CatalogSnapshotInfo {
  url: string;
  productCount: number;
  savedAt: string;
}

function asNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** Read the snapshot pointer a previous invocation stored on the job row. */
export function readCatalogSnapshotFromMetrics(
  metrics: Record<string, unknown> | undefined | null
): CatalogSnapshotInfo | null {
  const value = metrics?.[CATALOG_SNAPSHOT_METRICS_KEY];
  if (!value || typeof value !== "object") {
    return null;
  }
  const { url, productCount, savedAt } = value as Record<string, unknown>;
  if (typeof url !== "string" || typeof productCount !== "number" || typeof savedAt !== "string") {
    return null;
  }
  return { url, productCount, savedAt };
}

export function createIngestionCatalogCache(params: {
  jobId: number;
  source: string;
  /** Snapshot saved by an earlier invocation of this job, if any. */
  snapshot: CatalogSnapshotInfo | null;
  /** Called after a new snapshot is uploaded so the worker can record it on the job row. */
  onSnapshotSaved?: (snapshot: CatalogSnapshotInfo) => void;
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
}): ConnectorCatalogCache {
  let memo: unknown[] | null = null;
  let snapshot = params.snapshot;
  const log = params.log ?? (() => {});

  return {
    async load() {
      if (memo) {
        return memo;
      }
      if (!snapshot) {
        return null;
      }

      try {
        const blob = await readBlobFromStorageUrl(snapshot.url);
        const parsed: unknown = JSON.parse((await gunzipAsync(blob.bytes)).toString("utf-8"));
        if (!Array.isArray(parsed)) {
          throw new Error("snapshot is not an array");
        }
        memo = parsed;
        log("info", `${LOG_PREFIX} Reusing catalog snapshot (${parsed.length} products)`, {
          url: snapshot.url,
          savedAt: snapshot.savedAt,
        });
        return memo;
      } catch (error) {
        log("warn", `${LOG_PREFIX} Catalog snapshot unreadable; downloading a fresh catalog`, {
          url: snapshot.url,
          error: error instanceof Error ? error.message : String(error),
        });
        snapshot = null;
        return null;
      }
    },

    async save(products) {
      memo = products;

      const containerName =
        asNonEmpty(process.env.CONNECTOR_RAW_CONTAINER) ??
        asNonEmpty(process.env.RAW_SNAPSHOT_CONTAINER);
      const connectionString = asNonEmpty(process.env.AZURE_STORAGE_CONNECTION);
      if (!containerName || !connectionString) {
        return;
      }

      try {
        const bytes = (await gzipAsync(Buffer.from(JSON.stringify(products), "utf-8"))) as Buffer;
        // Stored as an opaque gzip file (no Content-Encoding) so reads get the raw bytes back.
        const url = await uploadBytesToBlob({
          connectionString,
          containerName,
          blobName: `catalog-cache/${params.source}/${params.jobId}.json.gz`,
          bytes,
          contentType: "application/gzip",
        });
        snapshot = { url, productCount: products.length, savedAt: new Date().toISOString() };
        params.onSnapshotSaved?.(snapshot);
        log("info", `${LOG_PREFIX} Saved catalog snapshot (${products.length} products)`, { url });
      } catch (error) {
        log("warn", `${LOG_PREFIX} Failed to save catalog snapshot; continuations will re-download`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
