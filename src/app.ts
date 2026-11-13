import express, { type Express } from 'express';
import type pg from 'pg';
import type { Clock } from './clock.ts';
import { errorHandler, notFoundHandler } from './error-handler.ts';
import { tenantMiddleware } from './tenant.ts';

export type AppDeps = { pool: pg.Pool; clock: Clock };

// Builds the app without opening a port, so tests can inject a test DB and a fixed date.
// `clock` is used from Phase 4, when the routes are mounted.
export function createApp({ pool }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(express.json()); // 1. parse body (100 kb default limit)
  app.use(tenantMiddleware(pool)); // 2. identify company + actor
  // 3. routes are mounted here from Phase 4

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
