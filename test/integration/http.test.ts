import request from 'supertest';
import { beforeEach, expect, it } from 'vitest';
import { api, app, createCompany, resetDb } from '../helpers.ts';

// App-level behaviour that doesn't belong to one endpoint.

let companyId: string;
beforeEach(async () => {
  await resetDb();
  companyId = await createCompany();
});

it('unknown route -> 404 NOT_FOUND as JSON, not an HTML page', async () => {
  const res = await api(companyId).get('/no-such-route');
  expect(res.status).toBe(404);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'No route for GET /no-such-route' } });
});

it('malformed JSON -> 400 INVALID_JSON', async () => {
  const res = await request(app)
    .post('/employees')
    .set('X-Company-Id', companyId)
    .set('X-Actor-Id', 'hr@test')
    .set('Content-Type', 'application/json')
    .send('{"name": ');
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
});

it('does not advertise Express', async () => {
  const res = await api(companyId).get('/no-such-route');
  expect(res.headers['x-powered-by']).toBeUndefined();
});
