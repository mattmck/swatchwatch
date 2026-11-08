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
 *
 * Crawl checkpoints (`loadCheckpoint` / `saveCheckpoint`, the sitemap connector) are different:
 * a crawl that needs many invocations must never restart from zero, so the cache is `durable`
 * only when blob storage is configured and a preflight write of a probe blob
 * (`<snapshot name>.preflight`, never the checkpoint itself) succeeded at creation, a checkpoint
 * that exists but cannot be read throws, and every save is fenced on the ETag the caller read
 * (`If-Match`, or `If-None-Match: *` for the first one).
 */
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import {
  readBlobByName,
  readBlobFromStorageUrl,
  uploadBytesToBlob,
  uploadBytesToBlobConditional,
} from "./blob-storage";
import { ConnectorCheckpointSupersededError, type ConnectorCatalogCache } from "./connectors/types";

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

function resolveCatalogContainer(): string | null {
  return asNonEmpty(process.env.CONNECTOR_RAW_CONTAINER) ?? asNonEmpty(process.env.RAW_SNAPSHOT_CONTAINER);
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
  const snapshotBlobName = `catalog-cache/${params.source}/${params.jobId}.json.gz`;
  const checkpointBlobName = `catalog-cache/${params.source}/${params.jobId}.checkpoint.json.gz`;

  // Durability preflight, started at creation: write a probe blob next to the snapshot (never the
  // checkpoint, so a continuation recreating the cache cannot clobber saved progress).
  let durable = false;
  const storage = (() => {
    const containerName = resolveCatalogContainer();
    const connectionString = asNonEmpty(process.env.AZURE_STORAGE_CONNECTION);
    return containerName && connectionString ? { containerName, connectionString } : null;
  })();
  const preflight: Promise<void> = storage
    ? uploadBytesToBlob({
        connectionString: storage.connectionString,
        containerName: storage.containerName,
        blobName: `${snapshotBlobName}.preflight`,
        bytes: Buffer.from(JSON.stringify({ jobId: params.jobId, checkedAt: new Date().toISOString() }), "utf-8"),
        contentType: "application/json",
      }).then(
        () => {
          durable = true;
        },
        (error: unknown) => {
          log("warn", `${LOG_PREFIX} Preflight write failed; crawl checkpoints are not durable`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      )
    : Promise.resolve();

  const readCheckpoint = async (): Promise<{ value: unknown; etag: string | null; json: string } | null> => {
    if (!storage) return null;
    const blob = await readBlobByName({ ...storage, blobName: checkpointBlobName });
    if (!blob) return null;
    const json = (await gunzipAsync(blob.bytes)).toString("utf-8");
    return { value: JSON.parse(json) as unknown, etag: blob.etag, json };
  };

  return {
    get durable() {
      return durable;
    },

    async loadCheckpoint() {
      await preflight;
      if (!durable) return null;
      const current = await readCheckpoint();
      return current ? { value: current.value, etag: current.etag } : null;
    },

    async saveCheckpoint(value, etag) {
      await preflight;
      if (!durable || !storage) {
        throw new Error("Catalog checkpoint storage is not durable (CONNECTOR_RAW_CONTAINER)");
      }
      const json = JSON.stringify(value);
      const bytes = (await gzipAsync(Buffer.from(json, "utf-8"))) as Buffer;
      const result = await uploadBytesToBlobConditional({
        ...storage,
        blobName: checkpointBlobName,
        bytes,
        contentType: "application/gzip",
        ...(etag ? { ifMatch: etag } : { ifNoneMatch: "*" as const }),
        // The preflight already created the container.
        skipContainerEnsure: true,
      });
      if (result.written) return;
      // A PUT retried after a lost success response fails its own condition: the write landed
      // when the stored checkpoint is byte-for-byte the one just sent.
      const current = await readCheckpoint();
      if (current && current.json === json) return;
      throw new ConnectorCheckpointSupersededError();
    },

    async load() {
      if (memo) {
        return memo;
      }
      if (!snapshot) {
        return null;
      }

      const containerName = resolveCatalogContainer();
      if (!containerName) {
        return null;
      }

      try {
        // Snapshots live in the connector raw container, not the default image allowlist.
        const blob = await readBlobFromStorageUrl(snapshot.url, { allowedContainers: [containerName] });
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

      const containerName = resolveCatalogContainer();
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
          blobName: snapshotBlobName,
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
