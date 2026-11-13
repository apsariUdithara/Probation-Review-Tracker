import { beforeEach, describe, expect, it } from 'vitest';
import { api, countAuditEvents, createCompany, pool, resetDb } from '../helpers.ts';

let client: ReturnType<typeof api>;
beforeEach(async () => {
  await resetDb();
  client = api(await createCompany(), 'hr@acme.test');
});

async function createEmployee(probationMonths = 3): Promise<string> {
  const res = await client.post('/employees', {
    name: 'Nimal Perera',
    joinDate: '2026-08-13',
    probationMonths,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

const confirm = (id: string, body?: object) => client.post(`/employees/${id}/confirmation`, body);

// Polls until some backend in the test database is blocked waiting on a lock.
async function waitForLockWait(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (rows[0]!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('No request reached the row lock in time');
}

describe('POST /employees/:id/confirmation', () => {
  it('confirms: 200 with confirmedAt and confirmedBy, plus one audit event', async () => {
    const id = await createEmployee();

    const res = await confirm(id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'confirmed', confirmedBy: 'hr@acme.test' });
    expect(Date.parse(res.body.confirmedAt)).not.toBeNaN();

    const { rows } = await pool.query(
      `SELECT actor, details FROM audit_events WHERE employee_id = $1 AND action = 'probation.confirmed'`,
      [id],
    );
    expect(rows).toEqual([
      { actor: 'hr@acme.test', details: { probationEndDate: '2026-11-13', totalProbationMonths: 3 } },
    ]);
  });

  it('accepts no body at all (Express 5 leaves req.body undefined)', async () => {
    const id = await createEmployee();
    expect((await confirm(id)).status).toBe(200);
  });

  it('accepts an empty JSON object', async () => {
    const id = await createEmployee();
    expect((await confirm(id, {})).status).toBe(200);
  });

  it('rejects any body field with 400 and changes nothing', async () => {
    const id = await createEmployee();
    const res = await confirm(id, { force: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((await client.get(`/employees/${id}`)).body.status).toBe('on_probation');
    expect(await countAuditEvents(id, 'probation.confirmed')).toBe(0);
  });

  it('cannot be confirmed twice: 200 then 409, exactly one confirmation event', async () => {
    const id = await createEmployee();

    const first = await confirm(id);
    const second = await confirm(id);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: { code: 'ALREADY_CONFIRMED', message: 'Employee is already confirmed' },
    });
    expect(await countAuditEvents(id, 'probation.confirmed')).toBe(1);
    // The second attempt must not overwrite who confirmed or when.
    const after = await client.get(`/employees/${id}`);
    expect(after.body.confirmedAt).toBe(first.body.confirmedAt);
  });

  it('unknown id -> 404', async () => {
    const res = await confirm('9b2f6a52-3c1e-4d7a-8f00-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EMPLOYEE_NOT_FOUND');
  });

  it('non-UUID id -> 404', async () => {
    expect((await confirm('abc')).status).toBe(404);
  });
});

describe('confirmation under concurrency', () => {
  // Checks the invariant under concurrent requests. It does NOT prove the two requests
  // overlapped; the deterministic test below proves the waiting behaviour.
  it('two confirms sent together: one 200, one 409, one audit event', async () => {
    const id = await createEmployee();

    const results = await Promise.all([confirm(id), confirm(id)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await countAuditEvents(id, 'probation.confirmed')).toBe(1);
  });

  it('a confirm blocked on the row lock re-reads the committed row and returns 409', async () => {
    const id = await createEmployee();
    const locker = await pool.connect();
    try {
      // 1. Another transaction locks the employee row.
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM employees WHERE id = $1 FOR UPDATE', [id]);

      // 2. Send the API confirm without awaiting it (.then() starts the request).
      const pending = confirm(id).then((res) => res);

      // 3. Prove the API request is now waiting on that lock.
      await waitForLockWait();

      // 4. The other transaction confirms and commits, releasing the lock.
      await locker.query(
        `UPDATE employees SET status = 'confirmed', confirmed_at = now(), confirmed_by = 'other-hr' WHERE id = $1`,
        [id],
      );
      await locker.query(
        `INSERT INTO audit_events (company_id, employee_id, action, actor)
         SELECT company_id, id, 'probation.confirmed', 'other-hr' FROM employees WHERE id = $1`,
        [id],
      );
      await locker.query('COMMIT');

      // 5. The API request wakes up, sees 'confirmed', and is rejected.
      const res = await pending;
      expect(res.status).toBe(409);
      expect(await countAuditEvents(id, 'probation.confirmed')).toBe(1);
      expect((await client.get(`/employees/${id}`)).body.confirmedBy).toBe('other-hr');
    } finally {
      await locker.query('ROLLBACK').catch(() => {}); // no-op after COMMIT; cleans up on failure
      locker.release();
    }
  });
});
