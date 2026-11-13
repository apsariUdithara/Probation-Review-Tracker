import type pg from 'pg';
import { withTransaction } from '../db.ts';
import { NotFoundError } from '../errors.ts';
import type { RequestContext } from '../tenant.ts';
import {
  findEmployee,
  insertAuditEvent,
  insertEmployee,
  listExtensions,
  type Employee,
  type Extension,
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
