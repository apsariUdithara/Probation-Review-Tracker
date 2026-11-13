import { beforeEach, describe, expect, it } from 'vitest';
import { api, countAuditEvents, createCompany, pool, resetDb } from '../helpers.ts';

let companyId: string;
let client: ReturnType<typeof api>;
beforeEach(async () => {
  await resetDb();
  companyId = await createCompany();
  client = api(companyId, 'hr@acme.test');
});

async function createEmployee(probationMonths = 3, joinDate = '2026-08-13'): Promise<string> {
  const res = await client.post('/employees', { name: 'Nimal Perera', joinDate, probationMonths });
  expect(res.status).toBe(201);
  return res.body.id;
}

const confirm = (id: string, body?: object) => client.post(`/employees/${id}/confirmation`, body);
const extend = (id: string, months: unknown, reason: unknown = 'Needs more time on payroll') =>
  client.post(`/employees/${id}/extensions`, { months, reason });

// Everything a rejected request must leave untouched.
async function snapshot(id: string) {
  const res = await client.get(`/employees/${id}`);
  return {
    total: res.body.totalProbationMonths,
    endDate: res.body.probationEndDate,
    status: res.body.status,
    extensions: res.body.extensions.length,
    auditEvents: await countAuditEvents(id),
  };
}

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

describe('POST /employees/:id/extensions', () => {
  it('extends: 201 with the updated employee and the extension record', async () => {
    const id = await createEmployee(3, '2026-01-15'); // ends 2026-04-15

    const res = await extend(id, 2, '  Needs more time on payroll  ');

    expect(res.status).toBe(201);
    expect(res.body.employee).toMatchObject({
      id,
      initialProbationMonths: 3,
      totalProbationMonths: 5,
      probationEndDate: '2026-06-15',
      status: 'on_probation',
    });
    expect(res.body.extension).toEqual({
      id: expect.any(String),
      months: 2,
      reason: 'Needs more time on payroll', // trimmed
      actor: 'hr@acme.test',
      previousEndDate: '2026-04-15',
      newEndDate: '2026-06-15',
      createdAt: expect.any(String),
    });

    // The history shows up on GET /employees/:id.
    const fetched = await client.get(`/employees/${id}`);
    expect(fetched.body.extensions).toEqual([res.body.extension]);
  });

  it('extension over the 6-month limit (required edge case): 422 and nothing changes', async () => {
    const id = await createEmployee(4, '2026-01-15'); // ends 2026-05-15
    expect((await extend(id, 2)).status).toBe(201); // total 6, ends 2026-07-15
    const before = await snapshot(id);

    const res = await extend(id, 1);

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: {
        code: 'MAX_PROBATION_EXCEEDED',
        message:
          'Cannot extend by 1 month(s): current total is 6, which would make 7; the maximum is 6.',
      },
    });
    const after = await snapshot(id);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ total: 6, endDate: '2026-07-15', extensions: 1 });
  });

  it('6 + 1 -> 422', async () => {
    const id = await createEmployee(6);
    expect((await extend(id, 1)).status).toBe(422);
  });

  it('3 + 3 reaches exactly 6 and is allowed', async () => {
    const id = await createEmployee(3);
    const res = await extend(id, 3);
    expect(res.status).toBe(201);
    expect(res.body.employee.totalProbationMonths).toBe(6);
  });

  it('end date is recomputed from the join date, never chained', async () => {
    const id = await createEmployee(3, '2025-11-30'); // ends 2026-02-28 (clamped)
    const res = await extend(id, 1);
    expect(res.body.extension).toMatchObject({
      previousEndDate: '2026-02-28',
      newEndDate: '2026-03-30', // 2025-11-30 + 4 months, not 2026-02-28 + 1 month
    });
  });

  it('extend after confirm -> 409 and no extension audit row', async () => {
    const id = await createEmployee();
    await confirm(id);
    const before = await snapshot(id);

    const res = await extend(id, 1);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CONFIRMED');
    expect(await snapshot(id)).toEqual(before);
    expect(await countAuditEvents(id, 'probation.extended')).toBe(0);
  });

  it.each<[string, unknown, unknown]>([
    ['months 0', 0, 'reason'],
    ['months 4', 4, 'reason'],
    ['months 1.5', 1.5, 'reason'],
    ['months "2" (no string coercion)', '2', 'reason'],
    ['missing reason', 1, undefined],
    ['blank reason', 1, '   '],
    ['reason of 501 characters', 1, 'a'.repeat(501)],
    ['reason containing a NUL character (regression: was a 500)', 1, 'x\u0000y'],
  ])('%s -> 400 and nothing changes', async (_case, months, reason) => {
    const id = await createEmployee();
    const before = await snapshot(id);
    const res = await client.post(`/employees/${id}/extensions`, { months, reason });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await snapshot(id)).toEqual(before);
  });

  it('extra body field -> 400', async () => {
    const id = await createEmployee();
    const res = await client.post(`/employees/${id}/extensions`, {
      months: 1,
      reason: 'ok',
      newTotal: 6,
    });
    expect(res.status).toBe(400);
  });

  it('accepts a reason of exactly 500 characters', async () => {
    const id = await createEmployee();
    expect((await extend(id, 1, 'a'.repeat(500))).status).toBe(201);
  });

  it('unknown id -> 404', async () => {
    const res = await extend('9b2f6a52-3c1e-4d7a-8f00-000000000000', 1);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EMPLOYEE_NOT_FOUND');
  });

  it('two +3 extensions sent together on an initial 3: one 201, one 422, total 6', async () => {
    const id = await createEmployee(3);

    const results = await Promise.all([extend(id, 3), extend(id, 3)]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    const after = await snapshot(id);
    expect(after.total).toBe(6);
    expect(after.extensions).toBe(1);
    expect(await countAuditEvents(id, 'probation.extended')).toBe(1);
  });
});

describe('GET /employees/:id/audit-events', () => {
  it('lists who, what and when for every change, oldest first', async () => {
    const id = await createEmployee(3, '2026-01-15');
    await extend(id, 1, 'Needs more time');
    await api(companyId, 'manager@acme.test').post(`/employees/${id}/confirmation`);

    const res = await client.get(`/employees/${id}/audit-events`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        id: expect.any(String),
        action: 'employee.created',
        actor: 'hr@acme.test',
        details: { name: 'Nimal Perera', joinDate: '2026-01-15', probationMonths: 3 },
        occurredAt: expect.any(String),
      },
      {
        id: expect.any(String),
        action: 'probation.extended',
        actor: 'hr@acme.test',
        details: {
          months: 1,
          reason: 'Needs more time',
          previousEndDate: '2026-04-15',
          newEndDate: '2026-05-15',
          newTotal: 4,
        },
        occurredAt: expect.any(String),
      },
      {
        id: expect.any(String),
        action: 'probation.confirmed',
        actor: 'manager@acme.test', // "who" is the actor of each request
        details: { probationEndDate: '2026-05-15', totalProbationMonths: 4 },
        occurredAt: expect.any(String),
      },
    ]);
    const ids = res.body.items.map((e: { id: string }) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('rejected requests never write audit rows', async () => {
    const id = await createEmployee(6);
    await extend(id, 1); // 422 over the limit
    await extend(id, 0); // 400 invalid
    await confirm(id, { force: true }); // 400 invalid
    await confirm(id); // 200
    await confirm(id); // 409 already confirmed
    await extend(id, 1); // 409 confirmed
    const res = await client.get(`/employees/${id}/audit-events`);
    expect(res.body.items.map((e: { action: string }) => e.action)).toEqual([
      'employee.created',
      'probation.confirmed',
    ]);
  });

  it('unknown employee -> 404, not an empty list', async () => {
    const res = await client.get('/employees/9b2f6a52-3c1e-4d7a-8f00-000000000000/audit-events');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EMPLOYEE_NOT_FOUND');
  });
});
