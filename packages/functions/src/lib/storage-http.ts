/**
 * Connection pool for Azure Blob Storage REST calls (lib/blob-storage).
 *
 * Node's global fetch shares one undici dispatcher with no per-origin connection cap, so a busy
 * ingestion worker (several jobs × 4 products × original PUT + variant HEADs/PUTs) opened 100–200
 * sockets to the one storage IP at once. On the Consumption plan that exhausts the outbound SNAT
 * ports per destination and new connects time out (`UND_ERR_CONNECT_TIMEOUT`). Storage requests
 * therefore go through a dedicated keep-alive Agent capped at `BLOB_STORAGE_MAX_CONNECTIONS`
 * sockets per origin; extra requests wait in the Agent's queue instead of opening new sockets.
 * Source image downloads (vendor CDNs) keep using the global dispatcher.
 *
 * Requests use the `undici` package's own `fetch` with its own Agent rather than Node's global
 * fetch: an Agent from the npm package only works as the global fetch's `dispatcher` when both are
 * the same undici major, and Node 22 (prod) bundles undici 6 while Node 24 (CI) bundles undici 7.
 */
import { Agent, fetch as undiciFetch } from "undici";

export const BLOB_STORAGE_HTTP_DEFAULTS = {
  maxConnections: 16,
  minConnections: 1,
  maxConnectionsLimit: 128,
  /** Idle sockets are closed well before Azure's 4-minute outbound idle timeout drops them. */
  keepAliveTimeoutMs: 30_000,
  connectTimeoutMs: 10_000,
} as const;

/** `BLOB_STORAGE_MAX_CONNECTIONS`: sockets per storage origin (default 16, clamped 1–128). */
export function resolveBlobStorageMaxConnections(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BLOB_STORAGE_MAX_CONNECTIONS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return BLOB_STORAGE_HTTP_DEFAULTS.maxConnections;
  return Math.min(
    BLOB_STORAGE_HTTP_DEFAULTS.maxConnectionsLimit,
    Math.max(BLOB_STORAGE_HTTP_DEFAULTS.minConnections, Math.floor(parsed))
  );
}

/**
 * Retry settings for storage requests (`fetchWithRetry`). Mutable only so unit tests can drop the
 * backoff to 0; production code never changes it.
 */
export const blobStorageRetry: { attempts: number; baseDelayMs: number } = {
  attempts: 3,
  baseDelayMs: 500,
};

/**
 * How storage requests are sent: `fetch(url, init)` with `init.dispatcher` set to the pooled Agent.
 * Defaults to undici's fetch; unit tests point it at their `global.fetch` stub (no network).
 */
export const blobStorageTransport: {
  fetch: (url: string, init: RequestInit & { dispatcher: Agent }) => Promise<Response>;
} = {
  fetch: (url, init) =>
    undiciFetch(url, init as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>,
};

let dispatcher: Agent | null = null;

/**
 * The shared storage Agent (created on first use). `requestTimeoutMs` bounds the wait for response
 * headers and between body chunks once a socket is assigned, so time spent queued for a socket is
 * not counted against a request.
 */
export function getBlobStorageDispatcher(requestTimeoutMs: number): Agent {
  if (!dispatcher) {
    dispatcher = new Agent({
      connections: resolveBlobStorageMaxConnections(),
      keepAliveTimeout: BLOB_STORAGE_HTTP_DEFAULTS.keepAliveTimeoutMs,
      headersTimeout: requestTimeoutMs,
      bodyTimeout: requestTimeoutMs,
      connect: { timeout: BLOB_STORAGE_HTTP_DEFAULTS.connectTimeoutMs },
    });
  }
  return dispatcher;
}

/** Tests: drop the cached Agent so the next request re-reads the env. */
export async function resetBlobStorageDispatcherForTests(): Promise<void> {
  const current = dispatcher;
  dispatcher = null;
  await current?.close().catch(() => undefined);
}
