import pg from 'pg';

// Return DATE columns as the raw 'YYYY-MM-DD' string. The default builds a local-midnight
// JS Date, which shows as the previous day in UTC for Sri Lanka (UTC+05:30).
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

// Repository functions accept either: the pool for single reads, a client inside a transaction.
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

// Runs `fn` inside BEGIN/COMMIT on ONE checked-out client (a transaction lives on a single
// connection). Any thrown error rolls everything back and is rethrown.
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let brokenConnection = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      brokenConnection = true; // don't return a broken connection to the pool
    }
    throw err;
  } finally {
    client.release(brokenConnection);
  }
}
