import { beforeEach, describe, expect, it } from 'vitest';
import { api, createCompany, pool, resetDb, TODAY } from '../helpers.ts';

// The fixed clock says today is 2026-11-13 (see helpers.ts).

let client: ReturnType<typeof api>;
beforeEach(async () => {
  await resetDb();
  client = api(await createCompany());
});

async function createEmployee(name: string, joinDate: string, probationMonths = 3): Promise<string> {
  const res = await client.post('/employees', { name, joinDate, probationMonths });
  expect(res.status).toBe(201);
  return res.body.id;
}

// Creates a 3-month probation that ends `days` days from TODAY. The join date is worked out
// in SQL; the tests assert daysUntilEnd, so a month-clamping slip would be caught.
async function employeeEndingIn(days: number, name = `Ends in ${days}`): Promise<string> {
  const { rows } = await pool.query<{ join_date: string }>(
    `SELECT (($1::date + $2::int) - interval '3 months')::date AS join_date`,
    [TODAY, days],
  );
  return createEmployee(name, rows[0]!.join_date);
}

const list = (query = '') => client.get(`/probations${query}`);
const daysIn = (items: { daysUntilEnd: number }[]) => items.map((i) => i.daysUntilEnd);

describe('probation that ends today (required edge case)', () => {
  it('is due within 7 days with daysUntilEnd 0, not overdue', async () => {
    const id = await createEmployee('Ends Today', '2026-08-13'); // + 3 months = 2026-11-13
    await createEmployee('Ended Yesterday', '2026-08-12'); // + 3 months = 2026-11-12

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.dueWithin7Days).toEqual([
      {
        id,
        name: 'Ends Today',
        joinDate: '2026-08-13',
        probationEndDate: '2026-11-13',
        totalProbationMonths: 3,
        daysUntilEnd: 0,
      },
    ]);
    expect(res.body.overdue.map((e: { name: string }) => e.name)).toEqual(['Ended Yesterday']);
    expect(res.body.overdue[0].daysUntilEnd).toBe(-1);
  });
});

describe('buckets and window', () => {
  it('default N = 30: 7 -> due7, 8 and 30 -> due30, 31 not listed', async () => {
    for (const days of [7, 8, 30, 31]) await employeeEndingIn(days);

    const res = await list();

    expect(res.body.asOf).toBe(TODAY);
    expect(res.body.withinDays).toBe(30);
    expect(daysIn(res.body.dueWithin7Days)).toEqual([7]);
    expect(daysIn(res.body.dueWithin30Days)).toEqual([8, 30]);
    expect(res.body.dueLater).toEqual([]);
    expect(res.body.counts).toEqual({ overdue: 0, dueWithin7Days: 1, dueWithin30Days: 2, dueLater: 0 });
  });

  it('always lists overdue probations, however old', async () => {
    await createEmployee('Very Overdue', '2025-06-01'); // ended 2025-09-01
    const res = await list('?withinDays=0');
    expect(res.body.overdue).toHaveLength(1);
    expect(res.body.overdue[0].daysUntilEnd).toBeLessThan(-400);
  });

  it('N = 0: overdue and ending today only', async () => {
    for (const days of [-1, 0, 1]) await employeeEndingIn(days);
    const res = await list('?withinDays=0');
    expect(daysIn(res.body.overdue)).toEqual([-1]);
    expect(daysIn(res.body.dueWithin7Days)).toEqual([0]);
    expect(res.body.counts).toEqual({ overdue: 1, dueWithin7Days: 1, dueWithin30Days: 0, dueLater: 0 });
  });

  it('N = 5 narrows the list', async () => {
    for (const days of [5, 6, 20]) await employeeEndingIn(days);
    const res = await list('?withinDays=5');
    expect(daysIn(res.body.dueWithin7Days)).toEqual([5]);
    expect(res.body.dueWithin30Days).toEqual([]);
  });

  it('N = 60: 31 and 60 -> dueLater, 61 not listed', async () => {
    for (const days of [31, 60, 61]) await employeeEndingIn(days);
    const res = await list('?withinDays=60');
    expect(res.body.withinDays).toBe(60);
    expect(daysIn(res.body.dueLater)).toEqual([31, 60]);
  });

  it('N = 365 is the maximum', async () => {
    const res = await list('?withinDays=365');
    expect(res.status).toBe(200);
  });

  it('returns all four groups even when empty', async () => {
    const res = await list();
    expect(res.body).toEqual({
      asOf: TODAY,
      withinDays: 30,
      counts: { overdue: 0, dueWithin7Days: 0, dueWithin30Days: 0, dueLater: 0 },
      overdue: [],
      dueWithin7Days: [],
      dueWithin30Days: [],
      dueLater: [],
    });
  });
});

describe('what is listed', () => {
  it('excludes confirmed employees', async () => {
    const id = await employeeEndingIn(3);
    await pool.query(
      `UPDATE employees SET status = 'confirmed', confirmed_at = now(), confirmed_by = 'hr' WHERE id = $1`,
      [id],
    );
    const res = await list();
    expect(res.body.dueWithin7Days).toEqual([]);
  });

  it('sorts by end date, then name, then id', async () => {
    await employeeEndingIn(5, 'Zara');
    await employeeEndingIn(2, 'Yasas');
    await employeeEndingIn(5, 'Amal');
    const res = await list();
    expect(res.body.dueWithin7Days.map((e: { name: string }) => e.name)).toEqual([
      'Yasas',
      'Amal',
      'Zara',
    ]);
  });

  it("does not include another company's employees", async () => {
    await employeeEndingIn(3);
    const other = api(await createCompany('Other'));
    const res = await other.get('/probations');
    expect(res.body.counts).toEqual({ overdue: 0, dueWithin7Days: 0, dueWithin30Days: 0, dueLater: 0 });
  });
});

describe('withinDays validation', () => {
  it.each(['', '-1', '366', 'abc', '1.5', '1e2', ' 5'])('withinDays=%j -> 400', async (value) => {
    const res = await list(`?withinDays=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].path).toBe('withinDays');
  });

  it('repeated withinDays -> 400', async () => {
    const res = await list('?withinDays=1&withinDays=2');
    expect(res.status).toBe(400);
  });
});
