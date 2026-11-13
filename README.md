# Probation Review Tracker

[![CI](https://github.com/apsariUdithara/Probation-Review-Tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/apsariUdithara/Probation-Review-Tracker/actions/workflows/ci.yml)

A backend service that helps an HR team track employees on probation: add employees, see whose probation is overdue or ending soon, confirm employees and extend probations. Every confirmation and extension is recorded in an audit trail, and each company only ever sees its own employees.

**Stack:** Node.js 24 · TypeScript · Express 5 · PostgreSQL 17 · node-pg-migrate · Zod · Vitest

## Contents

- [Features](#features)
- [Getting started](#getting-started)
- [API](#api)
- [Architecture](#architecture)
- [Design decisions](#design-decisions)
- [Assumptions](#assumptions)
- [Security](#security)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Future improvements](#future-improvements)
- [How I used AI tools](#how-i-used-ai-tools)
- [Time spent](#time-spent)

## Features

| Requirement | Endpoint | Proven by |
|---|---|---|
| Add an employee (name, company, join date, probation months) | `POST /employees` | `employees.test.ts`, `dates.test.ts` |
| List probations ending within N days, grouped by urgency | `GET /probations?withinDays=N` | `probations.test.ts` |
| Confirm an employee, never twice | `POST /employees/:id/confirmation` | `lifecycle.test.ts` |
| Extend by 1–3 months with a reason, total ≤ 6 months | `POST /employees/:id/extensions` | `lifecycle.test.ts` |
| Audit trail of every confirmation and extension (who, what, when) | `GET /employees/:id/audit-events` | `lifecycle.test.ts` |
| Each company's data kept separate | every endpoint | `isolation.test.ts` |
| PostgreSQL with migrations | `migrations/` | `npm run migrate` |
| Optional React page showing the list | `web/` | builds in CI |

## Getting started

**Prerequisites:** Node.js 24 (see `.nvmrc`) and Docker.

```sh
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
docker compose up -d --wait   # PostgreSQL 17, plus a separate probation_test database
npm ci
npm run migrate               # create the schema
npm run seed                  # made-up demo data; prints two company ids
npm run dev                   # API on http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm test` | All 160 tests (Docker must be running) |
| `npm run test:unit` | Unit tests only, no database needed |
| `npm run typecheck` | Type-check with `tsc` (Node runs `.ts` files directly, so there is no build step) |
| `npm run diagrams` | Regenerate the architecture diagrams |

**Optional web page.** With the API running, start it in a second terminal and open http://localhost:5173:

```sh
npm ci --prefix web
npm run dev --prefix web
```

It shows the grouped list for either seeded company. It is read-only.

**Troubleshooting**

- *Port 5432 in use:* stop the other PostgreSQL, or change the port in `docker-compose.yml` and `.env`.
- *`probation_test` missing:* it is only created on the first start. Recreate it with `docker compose down -v && docker compose up -d --wait`.

## API

Every request needs two headers. They stand in for a login and are **not** authentication (see [Security](#security)).

| Header | Value |
|---|---|
| `X-Company-Id` | id of an existing company (printed by `npm run seed`) |
| `X-Actor-Id` | who is making the request (1–100 characters); recorded in the audit trail |

| Endpoint | Purpose | Body | Success |
|---|---|---|---|
| `POST /employees` | Add an employee | `{ name, joinDate, probationMonths }` (1–6) | 201 |
| `GET /employees/:id` | Employee and extension history | | 200 |
| `GET /probations?withinDays=N` | Grouped list (N: 0–365, default 30) | | 200 |
| `POST /employees/:id/confirmation` | Confirm | none | 200 |
| `POST /employees/:id/extensions` | Extend | `{ months, reason }` (1–3 months) | 201 |
| `GET /employees/:id/audit-events` | Audit trail, oldest first | | 200 |

Dates are `YYYY-MM-DD`. Unknown body fields are rejected.

**Example** (using a seeded company):

```sh
curl -s -H 'X-Company-Id: 11111111-1111-4111-8111-111111111111' -H 'X-Actor-Id: hr@acme.example' \
  'localhost:3000/probations?withinDays=60'
```

**List groups.** `daysUntilEnd` is the number of days from today to the end date. All four groups are always present, sorted by end date, then name.

| `daysUntilEnd` | Group |
|---|---|
| below 0 | `overdue` (always listed) |
| 0–7 | `dueWithin7Days` (ending today is due, not overdue) |
| 8–30 | `dueWithin30Days` |
| 31–N | `dueLater` (only when N > 30) |

**Errors** all have the shape `{ "error": { "code", "message", "details"? } }`.

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` / `INVALID_JSON` | Invalid input, e.g. the date `2025-02-29` |
| 401 | `UNAUTHENTICATED` | Headers missing or company unknown |
| 404 | `EMPLOYEE_NOT_FOUND` | No such employee, or it belongs to another company |
| 404 | `NOT_FOUND` | Unknown route |
| 409 | `ALREADY_CONFIRMED` | Confirming or extending a confirmed employee |
| 422 | `MAX_PROBATION_EXCEEDED` | The extension would take the total over 6 months |
| 422 | `CONSTRAINT_VIOLATION` | A database rule rejected the write (a safety net; should not happen) |
| 500 | `INTERNAL_ERROR` | Unexpected; details are logged, never returned |

## Architecture

The diagrams are generated from [`scripts/gen-diagrams.ts`](scripts/gen-diagrams.ts).

**System overview.** All business logic lives in the API; the web page only displays data.

![An HR user uses the optional React web page; curl and the tests call the API directly. Both send JSON to the Probation API (Node.js, Express), which stores data in PostgreSQL.](docs/diagrams/system-overview.svg)

**API layers.** Each layer has one job. Business rules are kept in a separate domain module with no database code, so they can be unit-tested.

![Middleware (tenant.ts) reads company and user, routes (routes.ts) validate with Zod, the service (service.ts) applies rules and transactions, the repository (repository.ts) runs SQL scoped by company_id. The service uses pure rules in domain/probation.ts. Any error goes to error-handler.ts.](docs/diagrams/api-layers.svg)

**Where each response comes from.** Each status code sits under the step that produces it. All errors leave through one error handler.

![Stages express.json, tenantMiddleware, routes, service, PostgreSQL. Success 200 or 201 comes from the routes. Errors: 400 INVALID_JSON and 413; 401 UNAUTHENTICATED; 400 VALIDATION_ERROR and 404 for a malformed id; 404 EMPLOYEE_NOT_FOUND, 409 ALREADY_CONFIRMED, 422 MAX_PROBATION_EXCEEDED; 422 CONSTRAINT_VIOLATION and 500. All go through errorHandler.](docs/diagrams/error-map.svg)

**Data model.** The database enforces the limits as well, and calculates the end date itself.

![Entity-relationship diagram: companies to employees one to many; employees to probation_extensions and audit_events one to many through the composite foreign key (company_id, employee_id). CHECK 1 to 6 on total months, CHECK 1 to 3 on extension months, generated end date.](docs/diagrams/data-model.svg)

**Company isolation.** Enforced twice: by the query filter in the API, and by the foreign key in the database.

![A request with X-Company-Id A gets WHERE company_id = A on every query, so only Company A employees are returned and Company B ones give 404. In the database the composite foreign key blocks cross-company rows.](docs/diagrams/company-isolation.svg)

**Employee lifecycle.** Overdue and due-soon are not states; they are calculated from the end date when the list is requested.

![State diagram: add employee starts On probation; extend loops while the total is at most 6 months, over 6 gives 422; confirm moves to Confirmed; confirming or extending again gives 409.](docs/diagrams/employee-lifecycle.svg)

**Add an employee.** The employee and its audit record are saved in one transaction.

![Sequence diagram: validate with Zod; if valid, BEGIN, insertEmployee, insertAuditEvent, COMMIT, 201 Created; if invalid, 400 VALIDATION_ERROR.](docs/diagrams/sequence-add-employee.svg)

**Confirm an employee.** The row is locked first, so an employee can only be confirmed once.

![Sequence diagram: BEGIN and lockEmployee; if on probation, markConfirmed, insertAuditEvent, COMMIT, 200; if already confirmed, ROLLBACK and 409; if not found, ROLLBACK and 404.](docs/diagrams/sequence-confirm.svg)

**Extend a probation.** An extension over 6 months is rejected before anything is written.

![Sequence diagram: BEGIN and lockEmployee; if on probation and within 6 months, addProbationMonths, insertExtension, insertAuditEvent, COMMIT, 201; if over 6 months, ROLLBACK and 422; if confirmed or not found, ROLLBACK and 409 or 404.](docs/diagrams/sequence-extend.svg)

**Two confirms at the same time.** The second request waits for the lock, then finds the employee already confirmed. Extensions are protected the same way.

![Sequence diagram: request A locks the row with SELECT FOR UPDATE, request B waits; A updates, writes the audit event and commits, returning 200; B re-reads the row as confirmed, rolls back and returns 409.](docs/diagrams/sequence-concurrent-confirm.svg)

**How the list is grouped.** "Today" is the date in Asia/Colombo, whatever timezone the server runs in.

![Day axis of days until end: below 0 Overdue, 0 to 7 Due in 7 days, 8 to 30 Due in 30 days, 31 to N Due later.](docs/diagrams/list-grouping.svg)

## Design decisions

**Plain SQL with `pg`, no ORM.**
- *Why:* the design relies on PostgreSQL features: a generated column, CHECK constraints, composite foreign keys, a partial unique index and row locks. Plain SQL keeps the migration as the single description of the schema.
- *Alternatives:* Prisma can't describe CHECK constraints or generated columns in its schema, needs raw queries for row locks, and returns dates as JavaScript `Date` objects. Drizzle could express almost all of it; with only 11 queries I chose fewer dependencies. Drizzle would be my first choice if the schema grew.

**PostgreSQL calculates the end date.**
- *Why:* a generated column (`join_date + total months`) is always recalculated from the join date, so extensions never chain: 2025-11-30 + 3 months, extended by 1, ends on 2026-03-30, not 03-28. Month ends are clamped correctly: 2025-08-31 + 6 months → 2026-02-28.
- *Alternative:* JavaScript `Date.setMonth`, which overflows: 31 January + 1 month gives early March.

**Dates stay as `YYYY-MM-DD` strings.**
- *Why:* converting a date to a JavaScript `Date` can shift it by a day across time zones. Input dates are checked with plain integer rules, so `2025-02-29` and `2026-04-31` are rejected.

**"Today" comes from an injected clock (Asia/Colombo).**
- *Why:* it is passed into SQL as a parameter, never `CURRENT_DATE`, so the result doesn't depend on the database server's timezone, and tests can fix the date.

**Row lock and audit record in one transaction.**
- *Why:* confirm and extend lock the employee row first (`SELECT … FOR UPDATE`). A second simultaneous request waits, then sees the updated row and is rejected. Any error rolls back everything, so a rejected request leaves no trace.
- *Safety nets:* the update only applies to employees still on probation, and a unique index allows at most one confirmation event per employee.

**The database enforces the rules too.**
- *Why:* CHECK constraints (total 1–6, extension 1–3, valid status) and composite foreign keys reject bad or cross-company data even if the application had a bug.

**404, not 403, for another company's employee.**
- *Why:* the response is identical to "does not exist", so a caller can't learn which ids are in use.

**A fourth `dueLater` group.**
- *Why:* the brief does not cap N. Rejecting `withinDays=60` would look like a bug, and labelling a row 45 days away "within 30 days" would be wrong.

**Status codes.** 400 means malformed input, 409 means the current state forbids the action, and 422 means the input is valid but a business rule says no.

## Assumptions

The brief leaves these open; each is easy to change.

| Question | Assumption |
|---|---|
| How does the API know the caller's company? | The `X-Company-Id` header (a stand-in for a login) |
| Who is "who" in the audit trail? | The `X-Actor-Id` header (self-reported) |
| Is the end date the anniversary or the day before? | The anniversary: 2026-01-15 + 3 months → 2026-04-15 |
| Range of N? Are overdue probations shown? | N is 0–365, default 30; overdue probations are always shown |
| Initial probation length? | 1–6 whole months |
| Can a confirmed employee be extended? | No (409) |
| Can someone be confirmed early or late? | Yes |
| Can an overdue probation be extended? | Yes |
| Are future join dates allowed? | Yes |
| Are confirmed employees in the list? | No; the list shows pending reviews only |
| Which timezone defines "today"? | Asia/Colombo (`APP_TIMEZONE`) |
| Are duplicate names allowed? | Yes; employees are identified by id |

## Security

- **The demo headers are not authentication.** Any client can claim any company or user. In production they would come from a verified identity (session, JWT or API key); only [`src/tenant.ts`](src/tenant.ts) would change.
- All SQL is parameterised.
- Request bodies are validated strictly, with a 100 kb limit.
- Error responses never include SQL, constraint names or stack traces.
- `.env` is git-ignored, and all data is made up.

## Testing

160 tests. Unit tests cover the pure rules. Integration tests call the API (supertest) or run SQL against a **real PostgreSQL** test database, with the clock fixed at 2026-11-13. The test setup refuses to run unless the database name ends in `_test`.

**Required edge cases**

| Case | Test file | Expected result |
|---|---|---|
| Probation ends today | `probations.test.ts` | In `dueWithin7Days` with `daysUntilEnd: 0`, not overdue |
| Join date of 29 February | `dates.test.ts` | 2024-02-29 + 3 months → 2024-05-29; the join date comes back unchanged |
| Extension over 6 months | `lifecycle.test.ts` | 422, and the total, end date, history and audit trail are unchanged |
| One company can't see another's employees | `isolation.test.ts` | 404 on every endpoint, absent from the list, nothing changed |

Also covered: confirming twice (409), two simultaneous confirms or extensions, month-end and leap-year dates, all validation errors, and the database constraints themselves.

## Project structure

```
migrations/        database schema (SQL)
scripts/           migrate.ts, seed.ts, gen-diagrams.ts
src/
  server.ts        entry point
  app.ts           wires middleware and routes
  tenant.ts        reads the company and user headers
  error-handler.ts turns errors into JSON responses
  domain/          pure business rules and date validation
  employees/       routes.ts → service.ts → repository.ts
test/unit/         tests without a database
test/integration/  tests against the test database
web/               optional React page
docs/              implementation plan and diagrams
```

The full reasoning behind each decision is in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Future improvements

- Real authentication (JWT or API keys) with roles such as HR and manager
- PostgreSQL row-level security as a second isolation layer
- Make the audit log tamper-proof with a trigger and `REVOKE UPDATE, DELETE`
- A timezone per company instead of one `APP_TIMEZONE`
- A "fail probation" outcome
- Pagination for the list and the audit trail
- An OpenAPI spec and standard problem-details errors (RFC 9457)
- Reminders by email or Slack when a probation is due within 7 days
- Structured logging with request ids

## How I used AI tools

<!-- TODO (author): write this section yourself. -->

## Time spent

<!-- TODO (author): fill in. -->
