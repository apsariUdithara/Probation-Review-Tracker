# Probation Review Tracker: Implementation Plan

> Status: plan only. No application code yet. Each phase ends with a commit and a set of passing tests. Do not start a phase until the previous phase's "Tests that must pass" are green.
>
> **Architecture frozen.** Change it only if implementation reveals a concrete technical problem.
>
> **Submission:** public GitHub link to careers@hiremira.ai by Fri 13 Nov 2026, at the latest **Sat 14 Nov 2026, 11:59 PM Sri Lanka time**. Full scope is planned: nothing is cut.

## 1. Project overview

### 1.1 Objectives

Build a small backend service that helps an HR team track employees on probation. It must be:

- **Correct:** dates, limits and states are always right, including month ends, 29 February, and two people clicking at the same time.
- **Isolated:** one company can never see or change another company's employees.
- **Auditable:** every confirmation and extension records who, what and when, written atomically with the change.
- **Explainable:** every line can be explained in the live interview, so the code is plain with no "magic".

### 1.2 Requirements coverage

| # | Assignment requirement | How it is met | Proven by |
|---|---|---|---|
| R1 | Add an employee with name, company, join date, probation length in months | `POST /employees` (the company comes from the caller's context, see A1) | `employees.test.ts`, `dates.test.ts` |
| R2 | List probations ending within N days, grouped overdue / due ≤ 7 days / due ≤ 30 days | `GET /probations?withinDays=N` | `probations.test.ts` |
| R3 | Confirm an employee; cannot be confirmed twice | `POST /employees/:id/confirmation`, row lock, 409 | `lifecycle.test.ts` |
| R4 | Extend 1–3 months with a reason; total ≤ 6 months | `POST /employees/:id/extensions`, rule + DB CHECK | `lifecycle.test.ts` |
| R5 | Audit trail of every confirmation and extension: who, what, when | `audit_events`, written in the same transaction; `GET /employees/:id/audit-events` | `lifecycle.test.ts` |
| R6 | Company data separate, with a test proving it | Company filter on every query, composite FKs, 404 for other companies | `isolation.test.ts` |
| R7 | Tests: ends today, 29 Feb join, extension over 6 months | Named tests (see §7.3) | `probations.test.ts`, `dates.test.ts`, `lifecycle.test.ts` |
| R8 | README: run, design decisions, next steps, AI usage | `README.md` | Phase 9 |
| R9 | Node.js + TypeScript, PostgreSQL with migrations | node-pg-migrate SQL migrations | Phase 1 |
| Opt | React page | Planned (Phase 11) | Manual check |

### 1.3 Technology stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node.js 24** (installed: v24.18.0) | Runs `.ts` files directly ("type stripping": it deletes the type annotations and runs the rest), so there is no build step. |
| Type checking | **`tsc --noEmit`** | Node strips types but doesn't check them. This command checks them without producing files. |
| HTTP | **Express 5** | Widely known and small. v5 sends errors from `async` handlers to the error middleware automatically. |
| Database | **PostgreSQL 17** in Docker | Required. Docker gives everyone the same version with one command. |
| DB access | **`pg` + hand-written, parameterised SQL** | **Fixed decision.** Constraints, transactions, row locks and tenant filters stay visible and under direct control. |
| Migrations | **node-pg-migrate v9**, SQL files | Versioned, up/down, Postgres-specific. One runner script is used everywhere. |
| Validation | **Zod 4** | One schema gives a runtime check plus a TypeScript type. |
| Tests | **Vitest + supertest**, real Postgres test DB | Vitest runs TypeScript with no setup. supertest calls the app without opening a port. |
| Config | Node `--env-file-if-exists=.env` in every npm script | One mechanism everywhere: no dotenv and no Vite `loadEnv`. Built into Node 22.9+. If `.env` is missing (CI) it does nothing, and variables already set in the environment take precedence over the file. |

**Deliberately not used:** ORMs (Prisma/Drizzle/TypeORM), NestJS, DI containers, auth libraries, Redis, an app Dockerfile.

### 1.4 Assumptions

No clarification email is sent: every default below is implemented as written. All assumptions go in the README's Assumptions section. A1–A3 (marked ✉) are the ones the brief leaves most open, so the README explains the reasoning for each.

| # | Question | Default implemented | Email? |
|---|---|---|---|
| A1 | How does the API know the caller's company? The brief has no login. | **Demonstration header `X-Company-Id`**. Not authentication (see §5.7). | ✉ |
| A2 | Is the end date the anniversary, or the day before it? | Anniversary: 2026-01-15 + 3 months → 2026-04-15 | ✉ |
| A3 | Maximum N? Are overdue probations always shown? | N is a whole number 0–365, default 30. Overdue is always included. Rows 31..N days away go in a fourth `dueLater` group (see §5.3). | ✉ |
| A4 | Who is "who" in the audit trail? | **Demonstration header `X-Actor-Id`**: self-reported, not verified | |
| A5 | Can a confirmed employee be extended? | No → 409 | |
| A6 | Can an employee be confirmed early, or after the end date? | Yes, both | |
| A7 | Can an overdue probation be extended? | Yes | |
| A8 | Is a future join date allowed? | Yes | |
| A9 | Are confirmed employees listed? | No. The list shows pending reviews only. | |
| A10 | Initial probation range | Whole number 1–6 months | |
| A11 | Which timezone defines "today"? | Asia/Colombo (`APP_TIMEZONE`) | |
| A12 | Are duplicate names allowed? | Yes. Employees are identified by id. | |

## 2. System architecture

### 2.1 Layered monolith with a pure domain module

```
HTTP request (+ X-Company-Id, X-Actor-Id demo headers)
   │
   ▼
┌───────────────────────────────────────────────┐
│ Express app (app.ts)                          │
│  1. express.json()        parse body          │
│  2. tenant middleware     company + actor     │
│  3. router (routes.ts)    Zod validation      │
└───────────────┬───────────────────────────────┘
                ▼
┌───────────────────────────────────────────────┐
│ Service (service.ts)                          │
│  transaction, business rules, audit row       │
│        uses ──► Domain (domain/probation.ts)  │
│                 pure functions, no DB/HTTP    │
└───────────────┬───────────────────────────────┘
                ▼
┌───────────────────────────────────────────────┐
│ Repository (repository.ts)                    │
│  SQL only; every employee query has company_id│
└───────────────┬───────────────────────────────┘
                ▼
     PostgreSQL (constraints = last line of defence)

Any thrown error ──► error middleware (errors.ts) ──► JSON error body
```

### 2.2 Request flow

1. The client sends a request with the two demo headers.
2. **Tenant middleware** validates the headers and checks the company exists. It stores `{ companyId, actor }` in `res.locals.ctx`. Otherwise it returns 401.
3. The **route** validates params, query and body with Zod, then calls the **service** with `ctx`, `today` (from the injected clock) and the validated input.
4. The **service** runs the use case. Writes happen inside `withTransaction`. It calls **repository** (SQL) and **domain** (rules) functions.
5. The route sends the JSON response. Errors go to the single **error middleware**.

### 2.3 Responsibilities

| Layer | File(s) | Does | Must NOT |
|---|---|---|---|
| Entry | `src/server.ts` | config → pool → `createApp` → `listen` | contain logic |
| App factory | `src/app.ts` | `createApp({ pool, clock })` wires middleware and routes | open a port |
| Middleware | `src/tenant.ts`, `src/errors.ts` | identify caller; map errors to responses | contain business rules |
| Routes | `src/employees/routes.ts` | Zod validation, status codes | run SQL |
| Service | `src/employees/service.ts` | use cases, transactions, audit | touch `req`/`res` |
| Domain | `src/domain/probation.ts` | pure rules and constants | import Express/`pg` |
| Repository | `src/employees/repository.ts` | parameterised SQL scoped by `company_id` | decide rules |
| Infra | `src/db.ts`, `src/clock.ts`, `src/config.ts` | pool, `withTransaction`, today, env | |

### 2.4 Why this fits

- **Small:** **six endpoints**, one feature folder, about 10 source files.
- **Testable:** pure domain functions get unit tests. `createApp({ pool, clock })` lets tests inject the test DB and a fixed date.
- **Easy to change live:**
  - "Cap = 9 months" → one constant plus one new migration.
  - "Add a fail outcome" → one migration (status value), one route and one service function.
- **Defence in depth:** if TypeScript has a bug, the Postgres constraints still reject bad data.

## 3. Database design

### 3.1 Relationships

```
companies 1 ──── * employees 1 ──── * probation_extensions
                      │
                      └──── * audit_events
```

`probation_extensions` and `audit_events` reference employees with a **composite foreign key** `(company_id, employee_id) → employees(company_id, id)`. A child row must therefore carry the *same* company as its employee, and the database rejects a cross-company link even if the application code is wrong.

Type choices:

- `uuid` ids from `gen_random_uuid()` are unguessable.
- `date` holds calendar facts. It has no time of day, so timezone shifts can't affect it.
- `timestamptz` holds instants.
- `text` + CHECK is used instead of `varchar(n)`/enums because it is easier to change later.
- `ON DELETE RESTRICT` on every FK, and no delete endpoints, so the audit trail can't be wiped by cascade.

### 3.2 `companies` (tenants; seeded only, no API)

| Column | Type | Constraints / purpose |
|---|---|---|
| `id` | uuid | **PK**, default `gen_random_uuid()`. Sent as `X-Company-Id`. |
| `name` | text | NOT NULL, CHECK `length(trim(name)) > 0` |
| `created_at` | timestamptz | NOT NULL, default `now()` |

### 3.3 `employees` (current probation state)

| Column | Type | Constraints / purpose |
|---|---|---|
| `id` | uuid | **PK**, default `gen_random_uuid()` |
| `company_id` | uuid | NOT NULL, **FK → companies(id)** RESTRICT |
| `name` | text | NOT NULL, CHECK trimmed length 1–200 |
| `join_date` | date | NOT NULL |
| `initial_probation_months` | smallint | NOT NULL, CHECK 1–6 |
| `total_probation_months` | smallint | NOT NULL, CHECK `BETWEEN 1 AND 6`, CHECK `>= initial_probation_months`. **The database guarantee of the 6-month rule.** |
| `probation_end_date` | date | **GENERATED ALWAYS AS `(join_date + make_interval(months => total_probation_months))::date` STORED**. Always consistent, never chained, indexable. |
| `status` | text | NOT NULL, default `'on_probation'`, CHECK in (`on_probation`, `confirmed`) |
| `confirmed_at` | timestamptz | NULL until confirmed |
| `confirmed_by` | text | NULL until confirmed; CHECK `confirmed_by IS NULL OR length(trim(confirmed_by)) BETWEEN 1 AND 100` (same rule as `X-Actor-Id` and the `actor` columns) |
| `created_at` | timestamptz | NOT NULL, default `now()` |

Table constraints:

- `UNIQUE (company_id, id)`: the target for the composite FKs. `id` is already unique; this just exposes the pair.
- **Confirmation consistency CHECK:** either `status = 'on_probation'` with `confirmed_at` and `confirmed_by` both NULL, **or** `status = 'confirmed'` with both NOT NULL. Written as two explicit branches joined by OR, so half-filled states are impossible.

Why the total lives on the row: a CHECK can only see its own row, so storing the running total lets one CHECK enforce "≤ 6".

**Generated column check (Phase 1, first task):** Postgres only allows immutable expressions in generated columns. `date + interval` uses timestamp-without-time-zone arithmetic and `make_interval` is immutable, so this is expected to work but **has not been verified**. Before going further, verify all three behaviours directly in the database:

1. Join 2024-02-29 with total 3 → end date 2024-05-29.
2. Join 2025-08-31 with total 6 → 2026-02-28 (month-end clamp).
3. **An UPDATE recomputes from `join_date`.** Join 2025-11-30 with total 3 → 2026-02-28. Then `UPDATE … SET total_probation_months = 4` → it must be **2026-03-30**, not 2026-03-28 (which is what adding one month to the old end date would give).

If the generated column is accepted and all three pass, **keep it**. Do not move date calculation into application code just to avoid this check. **Fallback (only if Postgres rejects the expression):** a plain `probation_end_date date NOT NULL` column plus a CHECK that it equals the same expression. The repository then sets it in the INSERT and the extend UPDATE, and the CHECK still guarantees correctness.

### 3.4 `probation_extensions` (business history)

| Column | Type | Constraints / purpose |
|---|---|---|
| `id` | uuid | **PK** |
| `company_id`, `employee_id` | uuid | NOT NULL; **FK (company_id, employee_id) → employees(company_id, id)** RESTRICT |
| `months` | smallint | NOT NULL, CHECK 1–3 |
| `reason` | text | NOT NULL, CHECK trimmed length 1–500 |
| `actor` | text | NOT NULL, CHECK trimmed length 1–100 |
| `previous_end_date` | date | NOT NULL |
| `new_end_date` | date | NOT NULL, CHECK `new_end_date > previous_end_date` |
| `created_at` | timestamptz | NOT NULL, default `now()` |

### 3.5 `audit_events` (append-only log: who, what, when)

| Column | Type | Constraints / purpose |
|---|---|---|
| `id` | bigint | **PK**, `GENERATED ALWAYS AS IDENTITY` (gives a natural order) |
| `company_id`, `employee_id` | uuid | NOT NULL; **composite FK** as above |
| `action` | text | NOT NULL, CHECK in (`employee.created`, `probation.confirmed`, `probation.extended`): **what** |
| `actor` | text | NOT NULL, CHECK trimmed length 1–100: **who** |
| `details` | jsonb | NOT NULL, default `'{}'`, e.g. `{months, reason, previousEndDate, newEndDate}` |
| `occurred_at` | timestamptz | NOT NULL, default `now()`: **when** |

**Append-only by design:** the repository has only `insertAuditEvent` and `listAuditEvents`, and no code path updates or deletes audit rows. A DB trigger and `REVOKE UPDATE, DELETE` are listed as next steps. They are left out because they add a PL/pgSQL concept without changing any required behaviour, and a superuser could bypass them anyway.

### 3.6 Indexes

| Index | Why |
|---|---|
| PKs, `UNIQUE (company_id, id)` | Automatic |
| `employees (company_id, probation_end_date) WHERE status = 'on_probation'` | Matches the list query exactly. "Partial" means confirmed rows are left out. |
| `probation_extensions (company_id, employee_id)` | FK columns aren't indexed automatically |
| `audit_events (company_id, employee_id, id)` | History endpoint, in order |
| **UNIQUE** `audit_events (employee_id) WHERE action = 'probation.confirmed'` | **DB backstop:** at most one confirmation event per employee, ever |

### 3.7 Migrations: one source of truth

- Schema lives **only** in `migrations/` (SQL files with `-- Up Migration` / `-- Down Migration` sections). First file: `<timestamp>_init.sql`.
- **One runner:** `scripts/migrate.ts` calls node-pg-migrate's programmatic `runner` with `direction: 'up' | 'down'` and the DB URL. It is used by:
  - `npm run migrate` / `npm run migrate:down` (dev DB from `DATABASE_URL`)
  - `test/global-setup.ts` (test DB from `TEST_DATABASE_URL`)
  - CI (same `npm` script)
- Never edit a migration that has already run. Changes go in a new file.
- **Phase 1 verification:** confirm that node-pg-migrate v9 runs `.sql` migrations via the programmatic runner. **Fallback:** a `.ts` migration file whose up/down call `pgm.sql(...)` with the same hand-written SQL. That still gives one source of truth and still uses plain SQL.

## 4. API design

### 4.1 Common rules

- JSON in/out. Dates are `YYYY-MM-DD`; timestamps are ISO-8601.
- **Demonstration headers (NOT authentication), required on every endpoint:**
  - `X-Company-Id`: must be a UUID of an existing company
  - `X-Actor-Id`: trimmed, 1–100 characters
  - Missing, invalid or unknown → **401 `UNAUTHENTICATED`**
  - These headers can be spoofed by anyone. They exist only so the demo can act as different companies and users. See §5.7.
- `:id` must be a UUID. If it isn't, the response is **404 `EMPLOYEE_NOT_FOUND`**, the same as "doesn't exist / other company".
- JSON bodies are **strict**: unknown fields (e.g. `companyId`) → 400. The company never comes from the body.
- Error body: `{ "error": { "code": "...", "message": "...", "details": [ { "path": "joinDate", "message": "..." } ] } }` (`details` only for validation errors).
- **Unknown routes** → 404 `NOT_FOUND` in the same JSON shape (a catch-all after the router), never Express's default HTML page. The catch-all is mounted after the tenant middleware, so an unknown route without headers still gets 401 first.
- **Express 5 sets `req.body` to `undefined`** (not `{}`) when a request has no body or no `Content-Type: application/json`. Body schemas must account for this (see endpoint 4).

| Status | Code(s) | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON` | Request is malformed |
| 401 | `UNAUTHENTICATED` | Demo headers missing, invalid or unknown |
| 404 | `EMPLOYEE_NOT_FOUND` | Doesn't exist **or belongs to another company** |
| 404 | `NOT_FOUND` | Unknown route |
| 409 | `ALREADY_CONFIRMED` | Current state forbids the action |
| 422 | `MAX_PROBATION_EXCEEDED` | Valid input, but the 6-month rule says no |
| 422 | `CONSTRAINT_VIOLATION` | Backstop: a DB CHECK rejected the write (should be unreachable) |
| 500 | `INTERNAL_ERROR` | Unexpected; generic message, details in the log |

### 4.2 Employee object

`{ id, companyId, name, joinDate, initialProbationMonths, totalProbationMonths, probationEndDate, status, confirmedAt, confirmedBy, createdAt }`

`companyId` is included so the response visibly shows the company the employee was recorded under (the brief's "add an employee with … company"). It always equals the caller's `X-Company-Id`.

### 4.3 The six endpoints

**1. `POST /employees`: add employee (R1)**

- Body: `{ "name": "Nimal Perera", "joinDate": "2024-02-29", "probationMonths": 3 }`
- Validation:
  - `name`: string, trimmed, 1–200 characters
  - `joinDate`: passes `isValidIsoDate` (Zod `.refine`, see §5.8). It must match `^\d{4}-\d{2}-\d{2}$`, have a year ≥ 1 (year 0000 doesn't exist), a month from 1 to 12, and a day that exists in that month (leap-year rule). So 2025-02-29 is rejected and 2024-02-29 is accepted.
  - `probationMonths`: integer 1–6 (no string coercion)
- **201** + employee + `Location: /employees/{id}`. Errors: 400, 401.
- Transaction: INSERT employee, INSERT `employee.created` audit row.

**2. `GET /employees/:id`: one employee + extension history**

- **200** `{ ...employee, extensions: [ { id, months, reason, actor, previousEndDate, newEndDate, createdAt } ] }`, oldest first. Errors: 401, 404.

**3. `GET /probations?withinDays=N`: grouped list (R2)**

- `withinDays`: optional. If present it must be a single digit string representing 0–365. Default 30. An empty value, `-1`, `366`, `abc`, `1.5` or a repeated parameter (`?withinDays=1&withinDays=2`, which Express parses as an array) → 400.
- **200**:

```
{
  "asOf": "2026-11-13",
  "withinDays": 30,
  "counts": { "overdue": 1, "dueWithin7Days": 2, "dueWithin30Days": 0, "dueLater": 0 },
  "overdue":         [ { "id": "...", "name": "...", "joinDate": "...", "probationEndDate": "...", "totalProbationMonths": 3, "daysUntilEnd": -4 } ],
  "dueWithin7Days":  [ ... ],
  "dueWithin30Days": [ ],
  "dueLater":        [ ]
}
```

- All four arrays are always present (`dueLater` is empty whenever N ≤ 30). Each is sorted by `probationEndDate`, then `name`, then `id`. Errors: 400, 401.

**4. `POST /employees/:id/confirmation`: confirm (R3)**

- No body is expected. A missing body or `{}` is accepted. A JSON body containing any field → 400 `VALIDATION_ERROR`. This is the same strict-body rule as every other endpoint, implemented as `z.strictObject({}).optional()`. The `.optional()` matters: in Express 5 a POST with no body leaves `req.body` as `undefined`, and without it a plain confirm would return 400.
- **200** + updated employee. Errors: 401, 404, **409 `ALREADY_CONFIRMED`**.
- Transaction: lock, check, UPDATE, INSERT `probation.confirmed` audit row.

**5. `POST /employees/:id/extensions`: extend (R4)**

- Body: `{ "months": 2, "reason": "Needs more time on the payroll module" }`. `months` is an integer 1–3; `reason` is a trimmed string of 1–500 characters.
- **201** `{ "employee": {...}, "extension": {...} }`. Errors: 400, 401, 404, **409 `ALREADY_CONFIRMED`**, **422 `MAX_PROBATION_EXCEEDED`** (the message states the current total, the requested months and the maximum of 6).
- Transaction: lock, check, UPDATE total, INSERT extension, INSERT `probation.extended` audit row. **A rejected request writes nothing.**

**6. `GET /employees/:id/audit-events`: audit trail (R5)**

- **200** `{ "items": [ { id, action, actor, details, occurredAt } ] }`, oldest first. `id` is a **string**: `pg` returns `bigint` as a string to avoid precision loss. This is kept as-is and documented, not converted. **404** if the employee is not in the caller's company (checked first, so the response is never an empty 200). Errors: 401, 404.

### 4.4 SQL inventory: every statement and its company scope

| Repository function | Statement | Company scope |
|---|---|---|
| `findCompany(id)` (tenant middleware) | SELECT companies by id | It *is* the tenant lookup. The only unscoped query. |
| `insertEmployee(companyId, …)` | INSERT employees | `company_id = ctx.companyId` |
| `findEmployee(companyId, id)` | SELECT employees | `WHERE id = $1 AND company_id = $2` |
| `lockEmployee(client, companyId, id)` | SELECT … FOR UPDATE | `WHERE id = $1 AND company_id = $2` |
| `markConfirmed(client, companyId, id, actor)` | UPDATE employees | `WHERE id AND company_id AND status = 'on_probation'`; expects 1 row |
| `addProbationMonths(client, companyId, id, months)` | UPDATE employees … RETURNING | `WHERE id AND company_id AND status = 'on_probation'`; expects 1 row |
| `insertExtension(client, companyId, …)` | INSERT probation_extensions | `company_id` from ctx + composite FK |
| `listExtensions(companyId, employeeId)` | SELECT probation_extensions | `WHERE company_id AND employee_id` |
| `insertAuditEvent(client, companyId, …)` | INSERT audit_events | `company_id` from ctx + composite FK |
| `listAuditEvents(companyId, employeeId)` | SELECT audit_events | `WHERE company_id AND employee_id` |
| `listOpenProbations(companyId, today, withinDays)` | SELECT employees | `WHERE company_id AND status = 'on_probation' AND probation_end_date <= $today::date + $n::int` (explicit casts so Postgres can infer the parameter types) |

Rule for code review: **every function except `findCompany` takes `companyId` as its first data argument**, and every WHERE or INSERT uses it.

## 5. Business logic

### 5.1 Employee creation

Validate → in one transaction INSERT the employee (`initial = total = probationMonths`; the end date is generated by Postgres) → INSERT the `employee.created` audit row → return the row.

### 5.2 End-date calculation

- **Formula:** `probation_end_date = join_date + total_probation_months` calendar months. It is computed **by Postgres only**, as a generated column.
- **Month-end clamping:** if the day doesn't exist in the target month, Postgres uses the last day of that month. 2025-08-31 + 6 → 2026-02-28; 2023-08-31 + 6 → 2024-02-29.
- **No chaining, by construction:** the column is always recomputed from `join_date` and the current total. (30 Nov + 4 = 30 Mar. Chaining 30 Nov + 3, then + 1, would wrongly give 28 Mar.)
- **No JS month arithmetic.** `Date.setMonth` overflows: 31 Jan + 1 → 2 Mar.
- **Dates stay strings in Node:** `pg.types.setTypeParser(1082, v => v)`. Without it, `pg` builds a local-midnight JS `Date`, which shows as the previous day in UTC for Sri Lanka (UTC+05:30).
- **29 Feb join:** 1–6 month probations never clamp (2024-02-29 + 3 → 2024-05-29, + 6 → 2024-08-29). The test proves there is no rollover or off-by-one and that `joinDate` round-trips unchanged.

### 5.3 "Today", the N window and buckets

- **Today** = the calendar date in `APP_TIMEZONE` (Asia/Colombo), from `clock.today()`. Implemented as `todayIn(timeZone, now = new Date())`, which calls `Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)`, picks the `year`, `month` and `day` parts, and assembles `YYYY-MM-DD` explicitly. This avoids depending on how a particular locale formats dates. It is passed to SQL as a parameter. **Never use `CURRENT_DATE`**: it depends on the DB server's timezone and can't be controlled in tests.
- SQL returns `days_until_end = probation_end_date - $today::date`. A date minus a date gives an integer number of days.
- **Window:** `probation_end_date <= $today::date + $withinDays::int`, with no lower bound.
  - So **overdue probations are always included**: an unconfirmed probation past its end date still needs action, however old it is.
  - N controls only how far into the future the list looks.
- **Buckets** (pure `bucketFor(daysUntilEnd)`):

| `daysUntilEnd` | Bucket | Note |
|---|---|---|
| < 0 | `overdue` | |
| 0–7 | `dueWithin7Days` | **Ends today = 0 → due, not overdue** |
| 8–30 | `dueWithin30Days` | |
| 31+ | `dueLater` | Only possible when N > 30 |

- **Why N is 0–365 with a `dueLater` group (documented assumption A3):** the brief defines three groups, the largest being "within 30 days", but doesn't limit N.
  - Rejecting `withinDays=60` with a 400 would look like a bug to a reviewer.
  - Mislabelling 31–60 days as "within 30 days" would be wrong.
  - So rows beyond 30 days go in a fourth, clearly named `dueLater` group. Every returned row belongs to exactly one bucket.
  - 365 is an upper bound that stops nonsense values; one year ahead covers any 1–6 month probation plus extensions.
  - Small N simply narrows the list. For example, N = 5 returns overdue + days 0–5, so `dueWithin30Days` and `dueLater` are empty.
  - N = 0 returns overdue + ending today.

### 5.4 Confirmation (concurrency-safe)

`withTransaction`:

1. `lockEmployee` (`SELECT … WHERE id AND company_id FOR UPDATE`). The row is now locked until COMMIT/ROLLBACK.
2. No row → throw NotFound (404).
3. `status = 'confirmed'` → throw Conflict (409).
4. `markConfirmed`: UPDATE … `WHERE … AND status = 'on_probation'`. Assert it changed exactly 1 row, as a second safety net.
5. `insertAuditEvent('probation.confirmed')`.
6. COMMIT.

Two simultaneous confirms under Postgres's default READ COMMITTED:

- The second request's `FOR UPDATE` waits for the first to commit.
- It then reads the **new** row version, sees `confirmed`, and throws 409.

Any thrown error → ROLLBACK, so **no audit row is written**. The partial UNIQUE index makes a second `probation.confirmed` event impossible even if this logic were broken.

### 5.5 Extension and the 6-month rule

`withTransaction`:

1. `lockEmployee`. No row → 404. Confirmed → 409.
2. `assertCanExtend(currentTotal, months)` (pure). `currentTotal + months > MAX_PROBATION_MONTHS (6)` → throw BusinessRule (422 `MAX_PROBATION_EXCEEDED`).
3. `addProbationMonths`: `SET total_probation_months = total_probation_months + $months … RETURNING probation_end_date`. The generated column recomputes the date from `join_date`.
4. `insertExtension(previous_end_date from step 1, new_end_date from step 3)`.
5. `insertAuditEvent('probation.extended', { months, reason, previousEndDate, newEndDate, newTotal })`.
6. COMMIT.

- **Exactly 6 is allowed** (3+3, 4+1+1).
- Concurrent +3/+3 on an initial 3: the second waits, then sees a total of 6 → 422.
- Any rejection happens **before any write** and the transaction rolls back, so the total, end date, extensions and audit log are all unchanged.
- DB backstop: `CHECK total ≤ 6` (→ 422 `CONSTRAINT_VIOLATION` if ever reached).

### 5.6 Audit trail

- Written by the service **inside the same transaction** as the change, so both are saved or neither is.
- **Who** = `actor` (the demo header), **what** = `action` + `details`, **when** = `occurred_at`.
- Events: `probation.confirmed` and `probation.extended` (required), plus `employee.created`.
- Rejected requests (400/404/409/422) never write audit rows. Tests assert the count is unchanged.
- `probation_extensions` vs `audit_events`: extensions hold typed, constrained business data; the audit log is a uniform who/what/when history ("state versus log").

### 5.7 Company data isolation

1. **Application:**
   - `companyId` comes only from the tenant middleware, never from the URL or the body.
   - Every employee query is scoped (§4.4).
   - Another company's employee → **404, not 403**, so its existence isn't revealed.
2. **Database:** composite FKs make cross-company child rows impossible.
3. **Tests:** every employee endpoint is checked from the other company (§7).

**Demonstration headers, not authentication.**

- `X-Company-Id` and `X-Actor-Id` are trusted as sent, so any client can claim any company or name. They model "the caller's company and identity are already known".
- In production these would come from a verified identity: a session or JWT claim, or an API key mapped to a company and user. That would replace only `src/tenant.ts`.
- The audit "who" is therefore self-reported in this demo.
- Postgres Row-Level Security is a further next step.

### 5.8 Validation and security basics

- Parameterised SQL only (`$1, $2`), never string concatenation, which prevents SQL injection.
- Zod schemas are strict. Body strings are trimmed. Numbers are not coerced from strings in JSON bodies.
- **Calendar dates are validated without JavaScript `Date`.** `src/domain/calendar.ts` has three functions: `isLeapYear` (divisible by 4, except century years unless divisible by 400), `daysInMonth` and `isValidIsoDate`. `Date`/`Date.UTC` would bring two problems: years 0–99 are reinterpreted as 1900–1999, and parsing involves timezones. Plain integer checks avoid both and are easy to unit-test.
- Query parameter `withinDays`: a digit-string check first, then a number in the 0–365 range. This avoids `""` becoming 0.
- `express.json()` default 100 kb limit. Malformed JSON → 400 `INVALID_JSON`.
- 500 responses never include stack traces, SQL text, constraint names or any other database detail. Those go to the server log only (§5.9).
- `.env` is git-ignored. Only made-up data.

### 5.9 Error mapping (single middleware)

| Source | Response |
|---|---|
| `ZodError` | 400 `VALIDATION_ERROR` with `details` |
| Body-parser JSON syntax error | 400 `INVALID_JSON` |
| No route matched (catch-all) | 404 `NOT_FOUND` |
| `UnauthenticatedError` | 401 |
| `NotFoundError` | 404 `EMPLOYEE_NOT_FOUND` |
| `ConflictError` | 409 `ALREADY_CONFIRMED` |
| `BusinessRuleError` | 422 `MAX_PROBATION_EXCEEDED` |
| Postgres `23514` (check violation) | 422 `CONSTRAINT_VIOLATION` (backstop) |
| Postgres `22007`/`22008` (bad date) | 400 `VALIDATION_ERROR` (backstop) |
| Anything else | 500 `INTERNAL_ERROR`, logged |

**Logging:** for every 500, and for the two Postgres backstop mappings, the server logs the request method and path, the error message, and, if it is a Postgres error, its `code`, `constraint` and `table`. The client only ever receives the generic body. The mapping stays deliberately small: only JSON syntax errors, 23514 and 22007/22008 are special-cased, and every other database error is a 500.

## 6. Edge cases

### 6.1 Required by the assignment

| Case | Expected |
|---|---|
| Probation **ends today** | `dueWithin7Days`, `daysUntilEnd = 0`, not overdue |
| Join date **29 February** (2024-02-29, 3 months) | End 2024-05-29; `joinDate` returned as exactly `"2024-02-29"` |
| Extension **over 6 months** | 422 `MAX_PROBATION_EXCEEDED`; total, end date, extensions and audit unchanged |
| One company **cannot see** another's employees | 404 on every employee endpoint; absent from the other company's list |
| **Confirm twice** | 409; exactly one `probation.confirmed` audit row |

### 6.2 Additional cases

| Category | Case | Expected |
|---|---|---|
| Dates | Ended yesterday | overdue, −1 |
| Dates | Ends in 7 / 8 / 30 / 31 days (N = 30) | due7 / due30 / due30 / not listed |
| Window | Ends in 31 / 60 / 61 days (N = 60) | dueLater / dueLater / not listed |
| Window | N = 365 | 200; N = 366 → 400 |
| Dates | Overdue by 400 days | Still listed as overdue |
| Dates | Clamp: 2025-08-31 + 6 | 2026-02-28 |
| Dates | Leap clamp: 2023-08-31 + 6 | 2024-02-29 |
| Dates | No chaining: 2025-11-30, 3 months, +1 | 2026-03-30 |
| Dates | Invalid: 2025-02-29, 2026-13-01, 2026-04-31, "13/11/2026" | 400 naming `joinDate` |
| Dates | Future join date | 201 |
| Dates | Leap rule: 2000-02-29 valid, 2100-02-29 invalid, 1900-02-29 invalid | 201 / 400 / 400 |
| Dates | Year 0000 (0000-01-01) | 400 |
| Clock | 2026-11-12T19:00Z in Colombo | "2026-11-13" |
| Validation | `probationMonths` 0, 7, 2.5, "3" | 400 |
| Validation | Extension `months` 0, 4; reason missing / blank / 501 characters | 400 |
| Validation | Name blank or 201 characters | 400 |
| Validation | Extra body field `companyId` | 400 |
| Validation | Confirm with body `{ "force": true }` | 400 |
| Validation | Malformed JSON | 400 `INVALID_JSON` |
| Validation | `withinDays` empty, −1, 366, abc, 1.5, repeated; omitted | 400; omitted → 30 |
| Validation | Confirm with no body at all | 200 (Express 5 `req.body` is `undefined`) |
| Routing | Unknown route, e.g. `GET /nope` with valid headers | 404 `NOT_FOUND` JSON |
| Response | Employee object | Includes `companyId` equal to the caller's company |
| Window | N = 0 | overdue + ending today only |
| Limits | 6 + 1 | 422 |
| Limits | 3 + 3 | 201, total 6 |
| Limits | 4 + 2, then + 1 | 201, then 422 |
| State | Extend after confirm | 409, no audit row |
| State | Confirmed employee in list | Excluded |
| Concurrency | Concurrent-request test: two confirms sent together | {200, 409}, one audit row |
| Concurrency | Concurrent-request test: two +3 extensions sent together on an initial 3 | {201, 422}, total 6 |
| Tenancy | Missing / non-UUID / unknown `X-Company-Id`; missing `X-Actor-Id` | 401 |
| Tenancy | Non-UUID `:id` | 404 |
| Audit | Any rejected request | Audit count unchanged |

## 7. Testing strategy

### 7.1 Setup

- **Vitest + supertest** calling `createApp({ pool: testPool, clock: fixedClock('2026-11-13') })`.
- **Real Postgres** database `probation_test` (created by the Docker init script). No in-memory fakes, because they don't model dates and locks faithfully.
- **Env:** the `test` script runs Vitest under `node --env-file-if-exists=.env`, the same mechanism as every other script, and Vitest's workers inherit it. `vitest.config.ts` does **not** load env itself. It only sets:
  - `globalSetup: test/global-setup.ts`
  - `fileParallelism: false`
- `test/global-setup.ts`:
  - **refuses to run unless the DB name ends in `_test`**
  - then runs `scripts/migrate.ts` up, the same code as dev and CI
- `test/helpers.ts`:
  - `resetDb()` (`TRUNCATE audit_events, probation_extensions, employees, companies RESTART IDENTITY CASCADE`, called in `beforeEach`)
  - `createCompany(name)`
  - `api(companyId, actor = 'hr@test')` (supertest with both headers)
  - `countAuditEvents(employeeId)`
  - the shared test pool, closed in `afterAll` so Vitest exits

### 7.2 Layers

| Layer | File | Covers | DB? |
|---|---|---|---|
| Unit | `test/unit/probation.test.ts` | `bucketFor` (−1, 0, 7, 8, 30, 31); `assertCanExtend` (3+3 ok, 4+3 / 6+1 throw) | No |
| Unit | `test/unit/calendar.test.ts` | `isLeapYear` (1900 no, 2000 yes, 2024 yes, 2100 no); `daysInMonth`; `isValidIsoDate` (malformed strings, month 13, 04-31, 02-29 in leap and non-leap years, year 0000) | No |
| Unit | `test/unit/clock.test.ts` | `todayIn('Asia/Colombo', 2026-11-12T19:00Z)` → `2026-11-13` | No |
| Database | `test/integration/schema.test.ts` | Direct SQL: CHECK rejects total 7, months 4, half-confirmed row, blank `confirmed_by`; composite FK rejects a cross-company extension/audit row; generated end date for 2024-02-29+3, 2025-08-31+6, 2023-08-31+6; UPDATE total 3→4 on join 2025-11-30 gives 2026-03-30; partial unique index rejects a 2nd confirmation event | Yes |
| Dates (API) | `test/integration/dates.test.ts` | 29 Feb, clamp, no chaining, invalid dates, round-trip | Yes |
| Create/get | `test/integration/employees.test.ts` | 201 + Location, response shape, validation 400s, 404s | Yes |
| List | `test/integration/probations.test.ts` | **Ends today**, boundaries, old overdue, N = 0, default N, N = 60 `dueLater`, N = 365/366, `withinDays` 400s, confirmed excluded, sort order | Yes |
| Lifecycle | `test/integration/lifecycle.test.ts` | Confirm, **confirm twice**, extend, exactly 6, **over 6** with no side effects, extend after confirm, audit contents, concurrency | Yes |
| Isolation | `test/integration/isolation.test.ts` | 401 header cases; cross-company 404 on all employee endpoints; list exclusion; no side effects | Yes |

### 7.3 How the required behaviours are proven

- **Ends today:** clock 2026-11-13. Create a join of 2026-08-13 with 3 months. Assert it appears in `dueWithin7Days` with `daysUntilEnd: 0` and **is absent from `overdue`**. Neighbour: a join of 2026-08-12 → `overdue`.
- **29 February:** POST with `joinDate: "2024-02-29"`, 3 months → `probationEndDate: "2024-05-29"` and `joinDate: "2024-02-29"` exactly. Then GET it and assert the same values, which proves the DATE parser round-trip.
- **Over 6 months:** initial 4 → +2 (201, total 6) → +1. Assert 422 `MAX_PROBATION_EXCEEDED`. Then assert via GET that the total is still 6, the end date is unchanged, the extension count is 1, and the audit count is unchanged.
- **Confirm twice:** 200 then 409. `countAuditEvents` shows exactly 1 `probation.confirmed`.
- **Isolation:**
  - A creates E.
  - As B, `it.each` over [GET E, POST confirmation, POST extensions (valid body), GET audit-events] → all 404 `EMPLOYEE_NOT_FOUND`.
  - B's `/probations` doesn't contain E.
  - Then, as A: E is still `on_probation`, its total is unchanged, and the audit count is unchanged.
- **Sequential behaviour (required):** confirm, then confirm again → 200 then 409 (covered above). This is what "cannot be confirmed twice" means.
- **Concurrent-request integration test:** `Promise.all` of two confirms (and of two +3 extensions). Assert that exactly one succeeds, then check the final DB state and the audit count. *What it is and isn't:* it checks the invariant under concurrent requests, but it **doesn't prove the two requests actually overlapped**. The guarantee comes from the row lock (§5.4), with the partial unique index as an extra safeguard.
- **Deterministic concurrency test (planned, Phase 6):**
  1. A separate test client runs `BEGIN` and `SELECT … FOR UPDATE` on the employee, which locks the row.
  2. Send the API confirm, but don't await it yet.
  3. Poll `pg_stat_activity` on the test DB until a backend shows `wait_event_type = 'Lock'`, with a short timeout. This proves the API request has actually reached the row lock and is waiting on it.
  4. Only then does the test client mark the employee confirmed and `COMMIT`.
  5. The API request resolves 409, and no second audit row exists.
  This proves the waiting behaviour that the `Promise.all` test cannot.

### 7.4 Commands

`npm test` (everything; Docker running) · `npm run test:unit` (no DB) · `npm run typecheck`

## 8. Folder structure

```
Probation-Review-Tracker/
├── .gitignore               node_modules/, .env, research_notes/, reports/
├── .env.example             DATABASE_URL, TEST_DATABASE_URL, PORT, APP_TIMEZONE
├── .nvmrc                   24
├── README.md
├── package.json             "type": "module"; scripts
├── tsconfig.json            strict, noEmit, type-stripping compatible
├── vitest.config.ts
├── docker-compose.yml       postgres:17, healthcheck, named volume
├── docker/init-test-db.sql  CREATE DATABASE probation_test
├── docs/IMPLEMENTATION_PLAN.md   (public, linked from the README)
├── migrations/<timestamp>_init.sql      the ONLY schema definition
├── scripts/
│   ├── migrate.ts           the ONLY migration runner (dev, tests, CI)
│   └── seed.ts              made-up data, dates relative to today
├── src/
│   ├── server.ts  app.ts  config.ts  db.ts  clock.ts  errors.ts  tenant.ts
│   ├── domain/probation.ts  pure rules + constants
│   ├── domain/calendar.ts   pure date validation (leap years, month lengths)
│   └── employees/routes.ts  service.ts  repository.ts
└── test/
    ├── global-setup.ts  helpers.ts
    ├── unit/            probation.test.ts, calendar.test.ts, clock.test.ts
    └── integration/     schema, dates, employees, probations, lifecycle, isolation
```

| Folder | Responsibility |
|---|---|
| `migrations/` | The single source of truth for the schema |
| `scripts/` | CLI tasks (migrate, seed), not loaded by the server |
| `src/domain/` | Dependency-free business rules |
| `src/employees/` | The feature: HTTP → service → SQL |
| `test/unit/` | Fast, no DB |
| `test/integration/` | Through HTTP or SQL against the real test DB |
| `docker/` | Postgres first-start scripts |
| `docs/` | Planning documents |

## 9. Implementation phases

**Priority key:** **MUST** = required by the brief or for correctness · **planned** = not required by the brief, but in scope. Every phase is done.

### Phase 0: Setup (MUST, 30–45 min)

- **Objective:** a working TypeScript + Vitest skeleton.
- **Tasks:**
  1. `docs/` is public: the plan is committed and linked from the README.
  2. Confirm `.gitignore`.
  3. `npm init`; set `"type": "module"` and `"engines"`.
  4. Install express, pg, zod, plus dev deps: typescript, @types/node, @types/express, @types/pg, vitest, supertest, @types/supertest, node-pg-migrate@9. Check versions with `npm view`.
  5. `tsconfig.json`: strict, noEmit, module/moduleResolution `nodenext`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly`.
  6. Scripts. Every one that needs config loads `.env` the same way:
     - `dev` = `node --env-file-if-exists=.env --watch src/server.ts`
     - `start` = `node --env-file-if-exists=.env src/server.ts`
     - `typecheck` = `tsc --noEmit`
     - `test` = `node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run`
     - `test:unit` = the same command, followed by `test/unit`
     - `migrate` / `migrate:down` = `node --env-file-if-exists=.env scripts/migrate.ts up|down`
     - `seed` = `node --env-file-if-exists=.env scripts/seed.ts`
  7. `.nvmrc`, `.env.example`, a placeholder unit test.
- **Files:** `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.nvmrc`, `.env.example`, `test/unit/placeholder.test.ts`
- **Concepts:** ES modules; type-stripping rules (no `enum`, `.ts` import extensions, `import type`); why `tsc --noEmit` is separate.
- **Must pass:** `npm run typecheck`, `npm run test:unit`. `git status` doesn't list `research_notes/` or `reports/`.
- **Commit:** `chore: scaffold TypeScript, Vitest and npm scripts` (it also adds `.gitignore`)

### Phase 1: Database and migrations (MUST, 60–75 min)

- **Objective:** Postgres in Docker with the full schema, via a single migration path.
- **Tasks:**
  1. `docker-compose.yml` (postgres:17, port 5432, healthcheck, volume, init script) and `docker/init-test-db.sql`. Compose hardcodes made-up, local-only dev credentials, so it doesn't depend on `.env`. `.env` holds only `DATABASE_URL`, `TEST_DATABASE_URL`, `PORT` and `APP_TIMEZONE`.
  2. `.env` from `.env.example`.
  3. `scripts/migrate.ts`. Pass `migrationsTable: 'pgmigrations'` (a required runner option), `dir: 'migrations'`, `direction`, `databaseUrl`, and `count: 1` for down. **Verify first:** a throwaway `.sql` migration runs up/down through the programmatic runner. If not, switch to the `.ts` + `pgm.sql()` fallback (§3.7).
  4. Init migration: tables, constraints, generated column, indexes; plus the down section. **Verify** the generated column is accepted; if not, use the fallback (§3.3).
  5. (The seed script moves to the end of Phase 2, because it needs `src/clock.ts`.)
- **Files:** `docker-compose.yml`, `docker/init-test-db.sql`, `.env.example`, `migrations/*_init.sql`, `scripts/migrate.ts`
- **Concepts:** containers/volumes/healthchecks (the init script runs only on the first volume creation; reset with `docker compose down -v`); migrations up/down; PK/FK/UNIQUE/CHECK; composite FK; generated columns and immutability; partial indexes.
- **Must pass (manual):** compose is healthy; migrate up → down → up succeeds. In `docker compose exec db psql`:
  - setting a total of 7 is rejected
  - the three generated-column checks from §3.3 all pass: 2024-02-29+3 → 2024-05-29; 2025-08-31+6 → 2026-02-28; UPDATE total 3→4 on join 2025-11-30 → 2026-03-30
- **Commit:** `feat(db): initial schema, constraints and indexes`

### Phase 2: Domain rules, calendar, clock and seed (MUST, 40–55 min)

- **Objective:** the rules exist as tested pure functions.
- **Tasks:**
  - `src/domain/probation.ts`: `MAX_PROBATION_MONTHS`, `MIN_/MAX_EXTENSION_MONTHS`, `MAX_WITHIN_DAYS = 365`, `Bucket` union (`overdue | dueWithin7Days | dueWithin30Days | dueLater`), `bucketFor`, `assertCanExtend`
  - `src/domain/calendar.ts`: `isLeapYear`, `daysInMonth`, `isValidIsoDate`. Integer checks only, no `Date` (§5.8).
  - `src/clock.ts`: `Clock`, `todayIn(timeZone, now?)` built from `formatToParts()` (§5.3), `systemClock(timeZone)`
  - error classes in `src/errors.ts`
  - unit tests; delete the placeholder
  - `scripts/seed.ts` (moved here from Phase 1):
    - two made-up companies
    - employees covering overdue, ends today, due in 5 days, due in 20 days, a 29 Feb joiner, and one confirmed
    - **today comes from `todayIn(APP_TIMEZONE)`**, the same clock as the app. Join dates are computed in SQL from that `$today` parameter, never from `CURRENT_DATE` or local JS dates.
    - month clamping means "N months before" isn't always exactly reversible, so near the 29th–31st a demo row can be a day off. That's fine for demo data, and tests never use the seed.
    - prints the company ids
- **Files:** `src/domain/probation.ts`, `src/domain/calendar.ts`, `src/clock.ts`, `src/errors.ts`, `test/unit/probation.test.ts`, `test/unit/calendar.test.ts`, `test/unit/clock.test.ts`, `scripts/seed.ts`
- **Concepts:** pure functions; `it.each` tables; string-literal unions instead of enums; why the clock is injected; the leap-year rule.
- **Must pass:**
  - unit tests with Docker stopped
  - with Docker running, `npm run seed` loads and prints the company ids
- **Commit:** `feat(domain): probation rules, calendar validation, clock and seed data`

### Phase 3: App skeleton and test harness (MUST, 60–75 min)

- **Objective:** the server runs, demo headers are enforced, errors come back as JSON, and the integration harness works.
- **Tasks:**
  - `config.ts` (Zod env)
  - `db.ts` (Pool, `setTypeParser(1082)`, `withTransaction`: one checked-out client, BEGIN/COMMIT/ROLLBACK, `release` in `finally`)
  - error middleware (§5.9)
  - JSON 404 catch-all for unknown routes (§4.1)
  - `tenant.ts`, `app.ts`, `server.ts`
  - `test/global-setup.ts` (with the `_test` guard), `test/helpers.ts`, `vitest.config.ts`
  - `schema.test.ts`, plus the 401 cases in `isolation.test.ts`
  - **Keep the harness lean:** build only what the next phases need (`resetDb`, `createCompany`, `api()`). Don't perfect the test infrastructure before the features exist.
- **Concepts:** middleware order; `res.locals`; 4-argument error middleware; pool vs client; why a transaction needs one client; DI by passing arguments.
- **Must pass:** schema tests (CHECKs including the half-confirmed row, composite FK, generated dates, unique confirmation index); 401 tests; unknown route → 404 `NOT_FOUND` JSON; unit tests; `npm run dev` starts.
- **Commit:** `feat: app skeleton, demo-header tenant middleware, errors, test harness`

### Phase 4: Create and view employees (MUST, 45–60 min)

- **Objective:** R1, with correct dates.
- **Tasks:**
  - Zod create schema (date regex + real-date check)
  - repository `insertEmployee`, `findEmployee`, `listExtensions`, `insertAuditEvent`
  - service `createEmployee` (transaction + `employee.created`), `getEmployee`
  - routes; mount the router
- **Files:** `src/employees/*.ts`, `src/app.ts`, `test/integration/dates.test.ts`, `employees.test.ts`
- **Concepts:** parameterised queries; snake_case → camelCase mapping; month clamping; dates as strings; 201 + Location.
- **Must pass:** the **29 Feb** test; clamp and leap-clamp; invalid dates → 400; create validation; response includes `companyId`; unknown or non-UUID id → 404.
- **Commit:** `feat: create and fetch employees`

### Phase 5: Grouped list (MUST, 45–60 min)

- **Objective:** R2.
- **Tasks:**
  - `withinDays` schema
  - `listOpenProbations` (returns `days_until_end`)
  - service grouping via `bucketFor`, plus counts and sorting
  - `GET /probations` route
- **Files:** `src/employees/*.ts`, `test/integration/probations.test.ts`
- **Concepts:** date − date = integer and date + integer = date in SQL; query strings are strings; partial index matching (keep `status = 'on_probation'` written literally).
- **Must pass:** **ends today**; yesterday; 7/8/30/31; old overdue; N = 0; default; N = 60 → `dueLater`; N = 365 ok / 366 → 400; `withinDays` 400s; confirmed excluded; sort.
- **Commit:** `feat: list probations grouped by urgency`

### Phase 6: Confirm (MUST, 30–45 min)

- **Objective:** R3, concurrency-safe and audited.
- **Tasks:** `lockEmployee`, `markConfirmed` (with the status guard and a 1-row check); `confirmEmployee` service; route with `z.strictObject({}).optional()` body schema; deterministic lock test (§7.3).
- **Concepts:** transactions; `SELECT … FOR UPDATE`; READ COMMITTED re-read after waiting; 409 vs 422.
- **Must pass:** confirm 200 with `confirmedAt`/`confirmedBy`; confirm with no body → 200; **confirm twice** → 409 with one audit row; concurrent-request test {200, 409}; deterministic lock test from §7.3.
- **Commit:** `feat: confirm probation with row lock and audit event`

### Phase 7: Extend and audit history (MUST, 60–75 min)

- **Objective:** R4 + R5.
- **Tasks:**
  - extension schema
  - `addProbationMonths`, `insertExtension`, `listAuditEvents`
  - `extendProbation` service (§5.5)
  - `getAuditEvents` service (404 check first)
  - both routes
- **Concepts:** generated columns recompute from the join date; DB CHECK as a backstop; JSONB details; rollback means no trace.
- **Must pass:** **over 6** → 422 with no side effects; 6 + 1; 3 + 3; no chaining; extend after confirm → 409 with no audit row; validation 400s; audit history order and contents; concurrent-request test for extensions {201, 422}.
- **Commit:** `feat: extend probation with 6-month cap and audit history`

### Phase 8: Isolation proof (MUST, 30 min)

- **Objective:** R6 proven on every endpoint.
- **Tasks:** complete `isolation.test.ts` (§7.3). Review each repository function against §4.4.
- **Must pass:** `npm run typecheck && npm test`, all green.
- **Commit:** `test: prove company data isolation on every endpoint`

### Phase 9: README and final review (MUST, 45–60 min)

- **Objective:** a reviewer can clone, run and understand the project in 5 minutes.
- **Tasks:**
  - README (§10)
  - fresh clone into a temp folder, then follow the README word for word
  - read every file and confirm you can explain each line
- **Commit:** `docs: README with setup, design decisions, assumptions and next steps`

### Phase 10: CI (planned, 15–20 min)

- `.github/workflows/ci.yml`: ubuntu, `postgres:17` service + `pg_isready`, create `probation_test`, `npm ci`, typecheck, test.
- **Commit:** `ci: run typecheck and tests with Postgres`

### Phase 11: React page (planned, ~60 min)

- Vite + React in `web/`: four bucket lists (incl. `dueLater`), a `withinDays` input, a dev proxy to the API, and the demo headers set from a company selector.
- Add its run command to the README quick start.
- **Commit:** `feat(web): probation list page`

### Before submitting (15 min)

- Typecheck and tests green.
- Public repo has no `.env`, `research_notes/` or `reports/`.
- Rehearse live changes:
  - cap → 9 months: constant + a new migration changing the CHECK
  - "fail probation": new status value via migration + route + service
  - change a bucket boundary (e.g. "due within 14 days"): `bucketFor` + its tests
- Email the link to careers@hiremira.ai before **Sat 14 Nov, 11:59 PM Sri Lanka time**.

### Time estimate (realistic)

| Scope | Estimate |
|---|---|
| Phases 0–9 (incl. `dueLater` and the deterministic lock test) | **≈ 8–10 h** |
| + CI | +15–20 min |
| + React | +1 h |
| **Total** | **≈ 9.5–11.5 h** |

Full scope is planned; nothing is cut. Work the phases in order so the repo is always in a working, committed state. Push to GitHub after every phase, so a submittable version always exists before the deadline.

## 10. README plan

1. **Summary:** 2–3 lines.
2. **Requirements checklist:** requirement → endpoint → test file (from §1.2).
3. **Quick start** (PowerShell-friendly):
   - prerequisites: Node 24, Docker
   - in this order:
     1. copy `.env.example` to `.env`
     2. `docker compose up -d`
     3. `npm ci`
     4. `npm run migrate`
     5. `npm run seed`
     6. `npm run dev`
     7. `npm test`
   - React page: its run command (Phase 11)
   - troubleshooting: port 5432 busy; `docker compose down -v` to recreate the test DB
4. **API reference:** the six endpoints, status-code table, example `curl` calls with the demo headers.
5. **Design decisions**, each with the alternative considered:
   - `pg` + raw SQL (and why no ORM)
   - generated end date (clamping, no chaining)
   - DATE parser
   - injected Asia/Colombo clock
   - row lock + same-transaction audit
   - composite FKs and CHECKs
   - 404-not-403
   - N 0–365, the `dueLater` group and bucket rules
   - 400/401/404/409/422 policy
6. **Assumptions:** A1–A12, with the reasoning for A1–A3 spelled out.
7. **Security note:** the demo headers are not authentication, and the actor is self-reported.
8. **Testing:** layout, where each required edge case is tested, how to run.
9. **Next steps:**
   - real auth (JWT/API keys, roles)
   - RLS
   - audit table trigger + REVOKE
   - per-company timezone
   - fail-probation outcome
   - pagination
   - RFC 9457 errors
   - OpenAPI
   - reminders
   - structured logging
10. **AI usage:** written by the author personally (left as a placeholder in Phase 9).
11. **Time spent.**
