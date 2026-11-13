import type { ErrorRequestHandler, RequestHandler } from 'express';
import { DatabaseError } from 'pg';
import { ZodError } from 'zod';
import { AppError } from './errors.ts';

type ErrorBody = {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
};

function body(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

// Server log only. The client never sees SQL, constraint names or stack traces.
function logError(req: Parameters<ErrorRequestHandler>[1], err: unknown): void {
  const pgInfo =
    err instanceof DatabaseError
      ? { code: err.code, constraint: err.constraint, table: err.table }
      : undefined;
  console.error(`${req.method} ${req.originalUrl}:`, err instanceof Error ? err.message : err, pgInfo ?? '');
  if (!(err instanceof DatabaseError) && err instanceof Error) console.error(err.stack);
}

// Mounted after every route: anything unmatched gets the same JSON error shape.
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(body('NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

// The single place where errors become HTTP responses (4 arguments = Express error middleware).
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    res.status(err.status).json(body(err.code, err.message));
    return;
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details } });
    return;
  }

  // express.json() errors carry `type` and a 4xx `status`.
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json(body('INVALID_JSON', 'Request body is not valid JSON'));
    return;
  }
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500 && err.expose) {
    res.status(err.status).json(body('INVALID_REQUEST', err.message));
    return;
  }

  // Database backstops: should be unreachable because validation runs first.
  if (err instanceof DatabaseError && err.code === '23514') {
    logError(req, err);
    res.status(422).json(body('CONSTRAINT_VIOLATION', 'The change violates a data rule'));
    return;
  }
  if (err instanceof DatabaseError && (err.code === '22007' || err.code === '22008')) {
    logError(req, err);
    res.status(400).json(body('VALIDATION_ERROR', 'Invalid date'));
    return;
  }

  logError(req, err);
  res.status(500).json(body('INTERNAL_ERROR', 'Something went wrong'));
};
