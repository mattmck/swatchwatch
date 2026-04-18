import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

let pool: Pool | null = null;
const DEFAULT_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 15000;
const DEFAULT_QUERY_MAX_RETRIES = 2;
const DEFAULT_QUERY_RETRY_BASE_MS = 250;

function parseIntEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetrySafeQuery(text: string): boolean {
  return /^\s*select\b/i.test(text) || /^\s*update\s+ingestion_job\b/i.test(text);
}

function isRetryableConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("connection terminated due to connection timeout") ||
    message.includes("connect etimedout") ||
    message.includes("econnrefused") ||
    message.includes("could not connect") ||
    message.includes("timeout expired")
  );
}

/**
 * Get or create the Postgres connection pool.
 * Uses environment variables: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
 */
export function getPool(): Pool {
  if (!pool) {
    // Azure Flexible Server always requires SSL.
    // Enable SSL whenever PGHOST points to an Azure domain; skip for local dev.
    const isAzure = (process.env.PGHOST || "").includes(".postgres.database.azure.com");

    pool = new Pool({
      host: process.env.PGHOST,
      port: parseInt(process.env.PGPORT || "5432", 10),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: isAzure ? { rejectUnauthorized: false } : undefined,
      max: parseIntEnv(process.env.PG_POOL_MAX, DEFAULT_POOL_MAX, 1, 100),
      idleTimeoutMillis: parseIntEnv(
        process.env.PG_IDLE_TIMEOUT_MS,
        DEFAULT_IDLE_TIMEOUT_MS,
        1000,
        300000
      ),
      connectionTimeoutMillis: parseIntEnv(
        process.env.PG_CONNECTION_TIMEOUT_MS,
        DEFAULT_CONNECTION_TIMEOUT_MS,
        1000,
        120000
      ),
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    pool.on("error", (err) => {
      console.error("Unexpected error on idle client", err);
    });
  }

  return pool;
}

/**
 * Execute a query with parameters.
 * Automatically acquires and releases a client from the pool.
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const pool = getPool();
  const maxRetries = parseIntEnv(
    process.env.PG_QUERY_MAX_RETRIES,
    DEFAULT_QUERY_MAX_RETRIES,
    0,
    10
  );
  const retryBaseDelayMs = parseIntEnv(
    process.env.PG_QUERY_RETRY_BASE_MS,
    DEFAULT_QUERY_RETRY_BASE_MS,
    50,
    10000
  );
  const safeToRetry = isRetrySafeQuery(text);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await pool.query<T>(text, params);
    } catch (error) {
      lastError = error;
      const shouldRetry =
        safeToRetry &&
        attempt < maxRetries &&
        isRetryableConnectionError(error);

      if (!shouldRetry) {
        throw error;
      }

      const delayMs = retryBaseDelayMs * (attempt + 1);
      console.warn(
        `[db] retrying query after connection error (${attempt + 1}/${maxRetries}) in ${delayMs}ms`,
        {
          message: error instanceof Error ? error.message : String(error),
          queryType: text.trim().split(/\s+/)[0]?.toUpperCase() || "UNKNOWN",
        }
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Execute multiple queries in a transaction.
 * Automatically commits on success, rolls back on error.
 */
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Close the connection pool.
 * Call this during graceful shutdown.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
