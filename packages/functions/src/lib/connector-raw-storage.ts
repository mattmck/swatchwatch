/**
 * Persists raw connector page payloads to blob storage for reprocessing and model training.
 * Graceful no-op when CONNECTOR_RAW_CONTAINER is not set or storage is unavailable.
 */
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { uploadBytesToBlob } from "./blob-storage";
import { query } from "./db";

const gzipAsync = promisify(gzip);
const LOG_PREFIX = "[connector-raw]";

function asNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function zeroPad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function datePart(d: Date): string {
  return `${d.getUTCFullYear()}-${zeroPad(d.getUTCMonth() + 1, 2)}-${zeroPad(d.getUTCDate(), 2)}`;
}

/**
 * Gzip-compress and upload a raw connector page payload to blob storage,
 * then write a connector_raw_snapshots row.
 *
 * Graceful no-op when CONNECTOR_RAW_CONTAINER is not configured or on any error.
 */
export async function saveConnectorRawSnapshot(params: {
  jobId: number;
  source: string;
  page: number;
  records: unknown[];
  metadata: Record<string, unknown>;
  capturedAt?: Date;
}): Promise<void> {
  const containerName = asNonEmpty(process.env.CONNECTOR_RAW_CONTAINER);
  if (!containerName) {
    return;
  }

  const connectionString = asNonEmpty(process.env.AZURE_STORAGE_CONNECTION);
  if (!connectionString) {
    console.warn(`${LOG_PREFIX} AZURE_STORAGE_CONNECTION not configured — skipping raw snapshot`);
    return;
  }

  const capturedAt = params.capturedAt ?? new Date();
  const blobPath = `${params.source}/${datePart(capturedAt)}/${params.jobId}/page-${zeroPad(params.page, 4)}.json.gz`;

  try {
    const payload = JSON.stringify({
      records: params.records,
      metadata: params.metadata,
    });
    const compressed = await gzipAsync(Buffer.from(payload, "utf-8"));

    await uploadBytesToBlob({
      connectionString,
      containerName,
      blobName: blobPath,
      bytes: compressed as Buffer,
      contentType: "application/gzip",
    });

    await query(
      `INSERT INTO connector_raw_snapshots (job_id, source, page, blob_path, record_count, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [params.jobId, params.source, params.page, blobPath, params.records.length, capturedAt.toISOString()]
    );

    console.log(
      `${LOG_PREFIX} Saved raw snapshot: job=${params.jobId} source=${params.source} page=${params.page} records=${params.records.length} path=${blobPath}`
    );
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Failed to save raw snapshot for job=${params.jobId} source=${params.source} page=${params.page}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
