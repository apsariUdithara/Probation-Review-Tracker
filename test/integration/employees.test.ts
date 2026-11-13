import { beforeEach, describe, expect, it } from 'vitest';
import { api, countAuditEvents, createCompany, pool, resetDb } from '../helpers.ts';

let companyId: string;
let client: ReturnType<typeof api>;
beforeEach(async () => {
  await resetDb();
  companyId = await createCompany();
  client = api(companyId, 'hr@acme.test');
});

const VALID = { name: 'Nimal Perera', joinDate: '2026-01-15', probationMonths: 3 };

async function employeeCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM employees');
  return rows[0]!.n;
}

describe('POST /employees', () => {
  it('creates an employee: 201, Location header and full shape', async () => {
    const res = await client.post('/employees', VALID);

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/employees/${res.body.id}`);
    expect(res.body).toEqual({
      id: expect.any(String),
      companyId, // the company comes from X-Company-Id, never from the body
      name: 'Nimal Perera',
      joinDate: '2026-01-15',
      initialProbationMonths: 3,
      totalProbationMonths: 3,
      probationEndDate: '2026-04-15', // anniversary (assumption A2)
      status: 'on_probation',
      confirmedAt: null,
      confirmedBy: null,
      createdAt: expect.any(String),
    });
  });

  it('writes an employee.created audit event in the same transaction', async () => {
    const res = await client.post('/employees', VALID);
    const { rows } = await pool.query(
      'SELECT company_id, action, actor, details FROM audit_events WHERE employee_id = $1',
      [res.body.id],
    );
    expect(rows).toEqual([
      { company_id: companyId, action: 'employee.created', actor: 'hr@acme.test', details: VALID },
    ]);
  });

  it('trims the name', async () => {
    const res = await client.post('/employees', { ...VALID, name: '  Kasun Silva  ' });
    expect(res.body.name).toBe('Kasun Silva');
  });

  it.each<[string, unknown]>([
    ['probationMonths 0', { ...VALID, probationMonths: 0 }],
    ['probationMonths 7', { ...VALID, probationMonths: 7 }],
    ['probationMonths 2.5', { ...VALID, probationMonths: 2.5 }],
    ['probationMonths "3" (no string coercion)', { ...VALID, probationMonths: '3' }],
    ['blank name', { ...VALID, name: '   ' }],
    ['name of 201 characters', { ...VALID, name: 'a'.repeat(201) }],
    ['missing name', { joinDate: VALID.joinDate, probationMonths: 3 }],
    ['extra field companyId', { ...VALID, companyId: '11111111-1111-4111-8111-111111111111' }],
    ['array body', [VALID]],
    ['name containing a NUL character (regression: was a 500)', { ...VALID, name: 'Ann\u0000a' }],
  ])('%s -> 400 and nothing written', async (_case, body) => {
    const res = await client.post('/employees', body as object);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await employeeCount()).toBe(0);
  });

  it('names the field and the reason when a NUL character is rejected', async () => {
    const res = await client.post('/employees', { ...VALID, name: 'Ann\u0000a' });
    expect(res.body.error.details).toEqual([{ path: 'name', message: 'Must not contain NUL characters' }]);
  });

  it('accepts a name of exactly 200 characters', async () => {
    const res = await client.post('/employees', { ...VALID, name: 'a'.repeat(200) });
    expect(res.status).toBe(201);
  });

  it('missing body -> 400', async () => {
    const res = await client.post('/employees');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /employees/:id', () => {
  it('returns the employee with an empty extension history', async () => {
    const created = await client.post('/employees', VALID);
    const res = await client.get(`/employees/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...created.body, extensions: [] });
  });

  it('unknown id -> 404 EMPLOYEE_NOT_FOUND', async () => {
    const res = await client.get('/employees/9b2f6a52-3c1e-4d7a-8f00-000000000000');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found' } });
  });

  it('non-UUID id -> 404, not 400 or 500', async () => {
    const res = await client.get('/employees/not-a-uuid');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EMPLOYEE_NOT_FOUND');
  });

  it('does not write audit events on reads', async () => {
    const created = await client.post('/employees', VALID);
    await client.get(`/employees/${created.body.id}`);
    expect(await countAuditEvents(created.body.id)).toBe(1);
  });
});
