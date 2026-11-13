import type { RequestHandler, Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { UnauthenticatedError } from './errors.ts';

// DEMONSTRATION HEADERS, NOT AUTHENTICATION. Any client can send any value.
// In production this file is replaced by real identity (session/JWT/API key);
// nothing else changes, because everything downstream only reads the context.

export type RequestContext = { companyId: string; actor: string };

const companyIdSchema = z.guid(); // 8-4-4-4-12 hex, which is what a Postgres uuid accepts
const actorSchema = z.string().trim().min(1).max(100);

// The only query not scoped by company: it IS the tenant lookup.
async function companyExists(pool: pg.Pool, companyId: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM companies WHERE id = $1', [companyId]);
  return rowCount === 1;
}

export function tenantMiddleware(pool: pg.Pool): RequestHandler {
  return async (req, res, next) => {
    const companyId = companyIdSchema.safeParse(req.get('X-Company-Id'));
    if (!companyId.success || !(await companyExists(pool, companyId.data))) {
      throw new UnauthenticatedError('X-Company-Id must be the id of an existing company');
    }
    const actor = actorSchema.safeParse(req.get('X-Actor-Id'));
    if (!actor.success) {
      throw new UnauthenticatedError('X-Actor-Id must be 1-100 characters');
    }
    const ctx: RequestContext = { companyId: companyId.data, actor: actor.data };
    res.locals.ctx = ctx;
    next();
  };
}

// Typed access for routes; res.locals is untyped in Express.
export function getContext(res: Response): RequestContext {
  return res.locals.ctx as RequestContext;
}
