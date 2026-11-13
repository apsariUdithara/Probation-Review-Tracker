import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, app, countAuditEvents, createCompany, resetDb } from '../helpers.ts';

let companyId: string;
beforeEach(async () => {
  await resetDb();
  companyId = await createCompany();
});

describe('demo headers', () => {
  const UNKNOWN_COMPANY = '9b2f6a52-3c1e-4d7a-8f00-000000000000';

  it.each<[string, Record<string, string>]>([
    ['missing X-Company-Id', { 'X-Actor-Id': 'hr@test' }],
    ['non-UUID X-Company-Id', { 'X-Company-Id': 'acme', 'X-Actor-Id': 'hr@test' }],
    ['unknown X-Company-Id', { 'X-Company-Id': UNKNOWN_COMPANY, 'X-Actor-Id': 'hr@test' }],
  ])('%s -> 401', async (_case, headers) => {
    const res = await request(app).get('/probations').set(headers);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'X-Company-Id must be the id of an existing company' },
    });
  });

  it.each<[string, string | undefined]>([
    ['missing X-Actor-Id', undefined],
    ['blank X-Actor-Id', '   '],
    ['X-Actor-Id over 100 characters', 'a'.repeat(101)],
  ])('%s -> 401', async (_case, actor) => {
    const req = request(app).get('/probations').set('X-Company-Id', companyId);
    const res = await (actor === undefined ? req : req.set('X-Actor-Id', actor));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('company data isolation (required)', () => {
  let companyA: ReturnType<typeof api>;
  let companyB: ReturnType<typeof api>;
  let employeeId: string; // belongs to company A

  const NOT_FOUND = { error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found' } };

  beforeEach(async () => {
    companyA = api(companyId, 'hr@a.test');
    companyB = api(await createCompany('Company B'), 'hr@b.test');

    // 3 months + 1-month extension: ends 2026-12-16, 33 days after the fixed today,
    // so it is in company A's dueLater group with withinDays=365.
    const created = await companyA.post('/employees', {
      name: 'Employee Of A',
      joinDate: '2026-08-16',
      probationMonths: 3,
    });
    employeeId = created.body.id;
    await companyA.post(`/employees/${employeeId}/extensions`, { months: 1, reason: 'Training' });
  });

  const asB: [string, () => ReturnType<ReturnType<typeof api>['get']>][] = [
    ['GET /employees/:id', () => companyB.get(`/employees/${employeeId}`)],
    ['POST /employees/:id/confirmation', () => companyB.post(`/employees/${employeeId}/confirmation`)],
    [
      'POST /employees/:id/extensions',
      () => companyB.post(`/employees/${employeeId}/extensions`, { months: 1, reason: 'Valid reason' }),
    ],
    ['GET /employees/:id/audit-events', () => companyB.get(`/employees/${employeeId}/audit-events`)],
  ];

  it.each(asB)("company B gets 404 for company A's employee: %s", async (_endpoint, call) => {
    const res = await call();
    expect(res.status).toBe(404);
    // Identical to a non-existent id, so B can't even learn that the employee exists.
    expect(res.body).toEqual(NOT_FOUND);
  });

  it("company A's employee is absent from company B's list", async () => {
    const res = await companyB.get('/probations?withinDays=365');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ overdue: 0, dueWithin7Days: 0, dueWithin30Days: 0, dueLater: 0 });

    // Sanity check: the same employee IS visible to company A.
    const own = await companyA.get('/probations?withinDays=365');
    expect(own.body.dueLater.map((e: { id: string }) => e.id)).toEqual([employeeId]);
  });

  it("company B's attempts leave company A's employee completely unchanged", async () => {
    const before = await companyA.get(`/employees/${employeeId}`);
    const auditBefore = await countAuditEvents(employeeId);

    for (const [, call] of asB) await call();

    const after = await companyA.get(`/employees/${employeeId}`);
    expect(after.body).toEqual(before.body); // status, total, end date, extensions
    expect(after.body.status).toBe('on_probation');
    expect(after.body.totalProbationMonths).toBe(4);
    expect(await countAuditEvents(employeeId)).toBe(auditBefore);
  });

  it('isolation works in both directions', async () => {
    const created = await companyB.post('/employees', {
      name: 'Employee Of B',
      joinDate: '2026-08-16',
      probationMonths: 3,
    });
    expect((await companyA.get(`/employees/${created.body.id}`)).status).toBe(404);
    expect((await companyB.get(`/employees/${created.body.id}`)).status).toBe(200);
  });

  it('the company cannot be chosen through the request body', async () => {
    const res = await companyB.post('/employees', {
      name: 'Sneaky',
      joinDate: '2026-08-16',
      probationMonths: 3,
      companyId, // company A's id
    });
    expect(res.status).toBe(400);
    const list = await companyA.get('/probations?withinDays=365');
    expect(list.body.dueLater.map((e: { id: string }) => e.id)).toEqual([employeeId]); // only A's own
  });
});
