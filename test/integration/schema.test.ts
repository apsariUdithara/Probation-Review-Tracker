import { beforeEach, describe, expect, it } from 'vitest';
import { createCompany, pool, resetDb } from '../helpers.ts';

// The database's own guarantees, tested with direct SQL (no app code involved).

async function insertEmployee(companyId: string, joinDate: string, months: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO employees (company_id, name, join_date, initial_probation_months, total_probation_months)
     VALUES ($1, 'Test Employee', $2, $3, $3) RETURNING id`,
    [companyId, joinDate, months],
  );
  return rows[0]!.id;
}

async function endDate(employeeId: string): Promise<string> {
  const { rows } = await pool.query<{ probation_end_date: string }>(
    'SELECT probation_end_date FROM employees WHERE id = $1',
    [employeeId],
  );
  return rows[0]!.probation_end_date;
}

let companyId: string;
beforeEach(async () => {
  await resetDb();
  companyId = await createCompany();
});

describe('generated probation_end_date', () => {
  it.each([
    ['2024-02-29', 3, '2024-05-29'], // 29 Feb join, no clamping needed
    ['2025-08-31', 6, '2026-02-28'], // month-end clamp
    ['2023-08-31', 6, '2024-02-29'], // clamp into a leap February
  ])('%s + %i months -> %s', async (joinDate, months, expected) => {
    const id = await insertEmployee(companyId, joinDate, months);
    expect(await endDate(id)).toBe(expected);
  });

  it('recomputes from join_date on UPDATE (no chaining)', async () => {
    const id = await insertEmployee(companyId, '2025-11-30', 3);
    expect(await endDate(id)).toBe('2026-02-28');
    await pool.query('UPDATE employees SET total_probation_months = 4 WHERE id = $1', [id]);
    expect(await endDate(id)).toBe('2026-03-30'); // not 2026-03-28
  });
});

describe('CHECK constraints', () => {
  it('rejects a total over 6 months', async () => {
    const id = await insertEmployee(companyId, '2026-01-15', 6);
    await expect(
      pool.query('UPDATE employees SET total_probation_months = 7 WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'employees_total_probation_months_check' });
  });

  it('rejects a half-confirmed row', async () => {
    const id = await insertEmployee(companyId, '2026-01-15', 3);
    await expect(
      pool.query(`UPDATE employees SET status = 'confirmed' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'employees_confirmation_consistent' });
  });

  it('rejects a blank confirmed_by', async () => {
    const id = await insertEmployee(companyId, '2026-01-15', 3);
    await expect(
      pool.query(
        `UPDATE employees SET status = 'confirmed', confirmed_at = now(), confirmed_by = '   ' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'employees_confirmed_by_check' });
  });

  it('rejects an extension of 4 months', async () => {
    const id = await insertEmployee(companyId, '2026-01-15', 1);
    await expect(
      pool.query(
        `INSERT INTO probation_extensions (company_id, employee_id, months, reason, actor, previous_end_date, new_end_date)
         VALUES ($1, $2, 4, 'reason', 'hr', '2026-02-15', '2026-06-15')`,
        [companyId, id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'probation_extensions_months_check' });
  });
});

describe('composite foreign keys (company isolation in the database)', () => {
  it('rejects an extension whose company differs from its employee', async () => {
    const otherCompany = await createCompany('Other');
    const id = await insertEmployee(companyId, '2026-01-15', 3);
    await expect(
      pool.query(
        `INSERT INTO probation_extensions (company_id, employee_id, months, reason, actor, previous_end_date, new_end_date)
         VALUES ($1, $2, 1, 'reason', 'hr', '2026-04-15', '2026-05-15')`,
        [otherCompany, id],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'probation_extensions_employee_fkey' });
  });

  it('rejects an audit event whose company differs from its employee', async () => {
    const otherCompany = await createCompany('Other');
    const id = await insertEmployee(companyId, '2026-01-15', 3);
    await expect(
      pool.query(
        `INSERT INTO audit_events (company_id, employee_id, action, actor) VALUES ($1, $2, 'employee.created', 'hr')`,
        [otherCompany, id],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'audit_events_employee_fkey' });
  });
});

describe('one confirmation event per employee', () => {
  it('rejects a second probation.confirmed audit event', async () => {
    const id = await insertEmployee(companyId, '2026-01-15', 3);
    const insert = () =>
      pool.query(
        `INSERT INTO audit_events (company_id, employee_id, action, actor) VALUES ($1, $2, 'probation.confirmed', 'hr')`,
        [companyId, id],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({
      code: '23505',
      constraint: 'audit_events_one_confirmation_idx',
    });
  });
});
