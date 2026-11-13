import pg from 'pg';
import { todayIn } from '../src/clock.ts';

// Made-up demo data for the dev database. Replaces everything already there.
// Dates are relative to "today" in APP_TIMEZONE, the same clock the app uses.

const ACME = '11111111-1111-4111-8111-111111111111';
const BETA = '22222222-2222-4222-8222-222222222222';

const COMPANIES = [
  { id: ACME, name: 'Acme Lanka (Pvt) Ltd' },
  { id: BETA, name: 'Beta Exports (Pvt) Ltd' },
];

type SeedEmployee = {
  companyId: string;
  name: string;
  months: number;
  endsInDays?: number; // join date is derived so the probation ends this many days from today
  joinDate?: string; // or a fixed join date
  confirmed?: boolean;
};

const EMPLOYEES: SeedEmployee[] = [
  { companyId: ACME, name: 'Nimal Perera', months: 3, endsInDays: -4 }, // overdue
  { companyId: ACME, name: 'Kasun Silva', months: 3, endsInDays: 0 }, // ends today
  { companyId: ACME, name: 'Dilani Fernando', months: 6, endsInDays: 5 }, // due within 7 days
  { companyId: ACME, name: 'Ruwan Jayawardena', months: 3, endsInDays: 20 }, // due within 30 days
  { companyId: ACME, name: 'Sachini Bandara', months: 6, endsInDays: 45 }, // due later
  { companyId: ACME, name: 'Tharindu Wickramasinghe', months: 3, endsInDays: 10, confirmed: true },
  { companyId: BETA, name: 'Ishara Gunasekara', months: 6, joinDate: '2024-02-29' }, // 29 Feb joiner, long overdue
  { companyId: BETA, name: 'Chamara Rathnayake', months: 3, endsInDays: 3 },
];

const ACTOR = 'seed-script';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}
const today = todayIn(process.env.APP_TIMEZONE ?? 'Asia/Colombo');

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(
    'TRUNCATE audit_events, probation_extensions, employees, companies RESTART IDENTITY CASCADE',
  );

  for (const c of COMPANIES) {
    await client.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [c.id, c.name]);
  }

  for (const e of EMPLOYEES) {
    // Month clamping means "N months before" is not always exactly reversible, so near
    // the 29th-31st a demo row can end a day off. Fine for demo data; tests never use it.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO employees (company_id, name, join_date, initial_probation_months, total_probation_months)
       VALUES ($1, $2,
               COALESCE($3::date, ($4::date + $5::int - make_interval(months => $6::int))::date),
               $6, $6)
       RETURNING id`,
      [e.companyId, e.name, e.joinDate ?? null, today, e.endsInDays ?? null, e.months],
    );
    const id = rows[0]!.id;
    await client.query(
      `INSERT INTO audit_events (company_id, employee_id, action, actor) VALUES ($1, $2, 'employee.created', $3)`,
      [e.companyId, id, ACTOR],
    );

    if (e.confirmed) {
      await client.query(
        `UPDATE employees SET status = 'confirmed', confirmed_at = now(), confirmed_by = $3
         WHERE id = $1 AND company_id = $2`,
        [id, e.companyId, ACTOR],
      );
      await client.query(
        `INSERT INTO audit_events (company_id, employee_id, action, actor) VALUES ($1, $2, 'probation.confirmed', $3)`,
        [e.companyId, id, ACTOR],
      );
    }
  }

  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}

console.log(`Seeded ${EMPLOYEES.length} employees (today = ${today}). Use these as X-Company-Id:`);
for (const c of COMPANIES) console.log(`  ${c.id}  ${c.name}`);
