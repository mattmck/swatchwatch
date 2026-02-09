import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

let pool: Pool | null = null;

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
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
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
  return pool.query<T>(text, params);
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
