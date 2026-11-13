import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, createCompany, resetDb } from '../helpers.ts';

// Cross-company 404 tests on every employee endpoint are added in Phase 8.

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
