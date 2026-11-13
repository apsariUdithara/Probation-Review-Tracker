import request, { type Test } from 'supertest';
import { afterAll } from 'vitest';
import { createApp } from '../src/app.ts';
import { fixedClock } from '../src/clock.ts';
import { createPool } from '../src/db.ts';

// Every integration test runs as if today were this date in Asia/Colombo.
export const TODAY = '2026-11-13';

export const pool = createPool(process.env.TEST_DATABASE_URL!);
export const app = createApp({ pool, clock: fixedClock(TODAY) });

// Each test file gets its own pool; close it so Vitest can exit.
afterAll(() => pool.end());

export async function resetDb(): Promise<void> {
  await pool.query(
    'TRUNCATE audit_events, probation_extensions, employees, companies RESTART IDENTITY CASCADE',
  );
}

export async function createCompany(name = 'Test Company'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO companies (name) VALUES ($1) RETURNING id',
    [name],
  );
  return rows[0]!.id;
}

// supertest client that sends both demo headers on every request.
export function api(companyId: string, actor = 'hr@test') {
  const withHeaders = (t: Test) => t.set('X-Company-Id', companyId).set('X-Actor-Id', actor);
  return {
    get: (path: string) => withHeaders(request(app).get(path)),
    post: (path: string, body?: object) => {
      const t = withHeaders(request(app).post(path));
      return body === undefined ? t : t.send(body);
    },
  };
}

export async function countAuditEvents(employeeId: string, action?: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events
     WHERE employee_id = $1 AND ($2::text IS NULL OR action = $2)`,
    [employeeId, action ?? null],
  );
  return rows[0]!.n;
}
