import { beforeEach, describe, expect, it } from 'vitest';
import { api, createCompany, resetDb } from '../helpers.ts';

let client: ReturnType<typeof api>;
beforeEach(async () => {
  await resetDb();
  client = api(await createCompany());
});

const create = (joinDate: string, probationMonths = 3) =>
  client.post('/employees', { name: 'Date Test', joinDate, probationMonths });

describe('join date of 29 February (required edge case)', () => {
  it('2024-02-29 + 3 months ends 2024-05-29 and round-trips unchanged', async () => {
    const created = await create('2024-02-29', 3);
    expect(created.status).toBe(201);
    expect(created.body.joinDate).toBe('2024-02-29');
    expect(created.body.probationEndDate).toBe('2024-05-29');

    // Read back through GET: proves the DATE parser returns the exact stored string.
    const fetched = await client.get(`/employees/${created.body.id}`);
    expect(fetched.body.joinDate).toBe('2024-02-29');
    expect(fetched.body.probationEndDate).toBe('2024-05-29');
  });

  it('2024-02-29 + 6 months ends 2024-08-29', async () => {
    const res = await create('2024-02-29', 6);
    expect(res.body.probationEndDate).toBe('2024-08-29');
  });
});

describe('month-end clamping', () => {
  it.each([
    ['2025-08-31', 6, '2026-02-28'],
    ['2023-08-31', 6, '2024-02-29'], // leap February
    ['2026-01-31', 1, '2026-02-28'],
  ])('%s + %i months -> %s', async (joinDate, months, expected) => {
    const res = await create(joinDate, months);
    expect(res.status).toBe(201);
    expect(res.body.probationEndDate).toBe(expected);
  });
});

describe('date validation', () => {
  it.each(['2000-02-29', '2028-02-29'])('accepts leap day %s', async (joinDate) => {
    expect((await create(joinDate)).status).toBe(201);
  });

  it('accepts a future join date', async () => {
    expect((await create('2027-06-01')).status).toBe(201);
  });

  it.each([
    '2025-02-29', // not a leap year
    '2100-02-29', // century, not a leap year
    '1900-02-29',
    '2026-13-01',
    '2026-04-31',
    '0000-01-01',
    '13/11/2026',
    '2026-11-13T00:00:00Z',
  ])('rejects %s with 400 naming joinDate', async (joinDate) => {
    const res = await create(joinDate);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([
      { path: 'joinDate', message: 'Must be a real calendar date as YYYY-MM-DD' },
    ]);
  });
});
