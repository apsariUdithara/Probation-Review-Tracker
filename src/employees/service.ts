import type pg from 'pg';
import { withTransaction } from '../db.ts';
import { assertCanExtend, bucketFor, type Bucket } from '../domain/probation.ts';
import { ConflictError, NotFoundError } from '../errors.ts';
import type { RequestContext } from '../tenant.ts';
import {
  addProbationMonths,
  findEmployee,
  insertAuditEvent,
  insertEmployee,
  insertExtension,
  listAuditEvents,
  listExtensions,
  listOpenProbations,
  lockEmployee,
  markConfirmed,
  type AuditEvent,
  type Employee,
  type Extension,
  type OpenProbation,
} from './repository.ts';

// Use cases. Writes run in one transaction together with their audit row:
// both are saved or neither is. No req/res here.

export type NewEmployee = { name: string; joinDate: string; probationMonths: number };

export async function createEmployee(
  pool: pg.Pool,
  ctx: RequestContext,
  input: NewEmployee,
): Promise<Employee> {
  return withTransaction(pool, async (client) => {
    const employee = await insertEmployee(client, ctx.companyId, input);
    await insertAuditEvent(client, ctx.companyId, {
      employeeId: employee.id,
      action: 'employee.created',
      actor: ctx.actor,
      details: input,
    });
    return employee;
  });
}

// Concurrency-safe: the row lock makes a second simultaneous confirm wait, then see
// 'confirmed' and get 409. Any throw rolls back, so no audit row is written.
export async function confirmEmployee(
  pool: pg.Pool,
  ctx: RequestContext,
  id: string,
): Promise<Employee> {
  return withTransaction(pool, async (client) => {
    const current = await lockEmployee(client, ctx.companyId, id);
    if (!current) throw new NotFoundError();
    if (current.status === 'confirmed') throw new ConflictError();

    const confirmed = await markConfirmed(client, ctx.companyId, id, ctx.actor);
    await insertAuditEvent(client, ctx.companyId, {
      employeeId: id,
      action: 'probation.confirmed',
      actor: ctx.actor,
      details: {
        probationEndDate: current.probationEndDate,
        totalProbationMonths: current.totalProbationMonths,
      },
    });
    return confirmed;
  });
}

export type ExtensionRequest = { months: number; reason: string };

// Same lock-then-check pattern as confirm. The 6-month rule is checked BEFORE any write,
// and any throw rolls back: a rejected request leaves total, end date, extensions and
// audit log unchanged.
export async function extendProbation(
  pool: pg.Pool,
  ctx: RequestContext,
  id: string,
  input: ExtensionRequest,
): Promise<{ employee: Employee; extension: Extension }> {
  return withTransaction(pool, async (client) => {
    const current = await lockEmployee(client, ctx.companyId, id);
    if (!current) throw new NotFoundError();
    if (current.status === 'confirmed') throw new ConflictError();
    assertCanExtend(current.totalProbationMonths, input.months);

    const employee = await addProbationMonths(client, ctx.companyId, id, input.months);
    const extension = await insertExtension(client, ctx.companyId, {
      employeeId: id,
      months: input.months,
      reason: input.reason,
      actor: ctx.actor,
      previousEndDate: current.probationEndDate,
      newEndDate: employee.probationEndDate,
    });
    await insertAuditEvent(client, ctx.companyId, {
      employeeId: id,
      action: 'probation.extended',
      actor: ctx.actor,
      details: {
        months: input.months,
        reason: input.reason,
        previousEndDate: current.probationEndDate,
        newEndDate: employee.probationEndDate,
        newTotal: employee.totalProbationMonths,
      },
    });
    return { employee, extension };
  });
}

// The employee check comes first, so another company's employee is a 404, never an empty list.
export async function getAuditEvents(
  pool: pg.Pool,
  ctx: RequestContext,
  id: string,
): Promise<{ items: AuditEvent[] }> {
  const employee = await findEmployee(pool, ctx.companyId, id);
  if (!employee) throw new NotFoundError();
  return { items: await listAuditEvents(pool, ctx.companyId, id) };
}

export type ProbationList = {
  asOf: string;
  withinDays: number;
  counts: Record<Bucket, number>;
} & Record<Bucket, OpenProbation[]>;

// Groups the rows by urgency. SQL already sorted them, and pushing in order keeps that sort.
export async function listProbations(
  pool: pg.Pool,
  ctx: RequestContext,
  today: string,
  withinDays: number,
): Promise<ProbationList> {
  const rows = await listOpenProbations(pool, ctx.companyId, today, withinDays);
  const groups: Record<Bucket, OpenProbation[]> = {
    overdue: [],
    dueWithin7Days: [],
    dueWithin30Days: [],
    dueLater: [],
  };
  for (const row of rows) groups[bucketFor(row.daysUntilEnd)].push(row);

  return {
    asOf: today,
    withinDays,
    counts: {
      overdue: groups.overdue.length,
      dueWithin7Days: groups.dueWithin7Days.length,
      dueWithin30Days: groups.dueWithin30Days.length,
      dueLater: groups.dueLater.length,
    },
    ...groups,
  };
}

export async function getEmployee(
  pool: pg.Pool,
  ctx: RequestContext,
  id: string,
): Promise<Employee & { extensions: Extension[] }> {
  const employee = await findEmployee(pool, ctx.companyId, id);
  if (!employee) throw new NotFoundError();
  const extensions = await listExtensions(pool, ctx.companyId, id);
  return { ...employee, extensions };
}
