import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { isValidIsoDate } from '../domain/calendar.ts';
import {
  DEFAULT_WITHIN_DAYS,
  MAX_EXTENSION_MONTHS,
  MAX_PROBATION_MONTHS,
  MAX_WITHIN_DAYS,
  MIN_EXTENSION_MONTHS,
  MIN_PROBATION_MONTHS,
} from '../domain/probation.ts';
import { NotFoundError } from '../errors.ts';
import { getContext } from '../tenant.ts';
import {
  confirmEmployee,
  createEmployee,
  extendProbation,
  getAuditEvents,
  getEmployee,
  listProbations,
} from './service.ts';

// HTTP only: validate input with Zod, call the service, choose the status code.
// A ZodError thrown here becomes 400 VALIDATION_ERROR in the error handler.

// Free text, trimmed. PostgreSQL can't store the NUL character in text columns, so it is
// rejected here as a 400 instead of failing in the database as a 500.
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !s.includes('\u0000'), 'Must not contain NUL characters');

const createEmployeeBody = z.strictObject({
  name: text(200),
  joinDate: z.string().refine(isValidIsoDate, 'Must be a real calendar date as YYYY-MM-DD'),
  probationMonths: z.int().min(MIN_PROBATION_MONTHS).max(MAX_PROBATION_MONTHS),
});

// Query strings are always strings: require plain digits first, so "" or "1.5" can't
// slip through as 0 or 1. A repeated ?withinDays=1&withinDays=2 arrives as an array -> 400.
const listProbationsQuery = z.object({
  withinDays: z
    .string()
    .regex(/^\d+$/, 'Must be a whole number of days')
    .transform(Number)
    .pipe(z.int().min(0).max(MAX_WITHIN_DAYS))
    .default(DEFAULT_WITHIN_DAYS),
});

// No body expected. `.optional()` because Express 5 leaves req.body undefined when no
// body is sent; strictObject still rejects any field, e.g. { "force": true }.
const confirmBody = z.strictObject({}).optional();

const extensionBody = z.strictObject({
  months: z.int().min(MIN_EXTENSION_MONTHS).max(MAX_EXTENSION_MONTHS),
  reason: text(500),
});

// A malformed id can't match any employee, so it gets the same 404 as "not found".
function parseEmployeeId(raw: string): string {
  const id = z.guid().safeParse(raw);
  if (!id.success) throw new NotFoundError();
  return id.data;
}

export function employeeRoutes({ pool, clock }: AppDeps): Router {
  const router = Router();

  router.post('/employees', async (req, res) => {
    const input = createEmployeeBody.parse(req.body);
    const employee = await createEmployee(pool, getContext(res), input);
    res.status(201).location(`/employees/${employee.id}`).json(employee);
  });

  router.get('/probations', async (req, res) => {
    const { withinDays } = listProbationsQuery.parse(req.query);
    res.json(await listProbations(pool, getContext(res), clock.today(), withinDays));
  });

  router.get('/employees/:id', async (req, res) => {
    const employee = await getEmployee(pool, getContext(res), parseEmployeeId(req.params.id));
    res.json(employee);
  });

  router.post('/employees/:id/confirmation', async (req, res) => {
    const id = parseEmployeeId(req.params.id);
    confirmBody.parse(req.body);
    res.json(await confirmEmployee(pool, getContext(res), id));
  });

  router.post('/employees/:id/extensions', async (req, res) => {
    const id = parseEmployeeId(req.params.id);
    const input = extensionBody.parse(req.body);
    res.status(201).json(await extendProbation(pool, getContext(res), id, input));
  });

  router.get('/employees/:id/audit-events', async (req, res) => {
    res.json(await getAuditEvents(pool, getContext(res), parseEmployeeId(req.params.id)));
  });

  return router;
}
