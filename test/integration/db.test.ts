import { expect, it, vi } from 'vitest';
import { createPool } from '../../src/db.ts';
import { pool as adminPool } from '../helpers.ts';

// Regression: an idle connection dropped by the database used to emit an unhandled 'error'
// event on the pool, which crashed the whole process.
it('survives losing an idle connection and keeps working', async () => {
  const pool = createPool(process.env.TEST_DATABASE_URL!);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    // After this query the client goes back to the pool and sits idle.
    const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

    // Kill that connection from the database side, as a restart would.
    await adminPool.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);

    await vi.waitFor(() =>
      expect(logged).toHaveBeenCalledWith('Idle database connection lost:', expect.any(String)),
    );
    const after = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(after.rows[0]!.ok).toBe(1);
  } finally {
    logged.mockRestore();
    await pool.end();
  }
});
