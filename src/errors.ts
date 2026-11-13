// Errors the application throws on purpose. Each one carries its HTTP status and
// stable error code, so the error middleware (Phase 3) can map it in one place.
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message: string) {
    super(401, 'UNAUTHENTICATED', message);
  }
}

// Used for "does not exist" AND "belongs to another company", so existence is never revealed.
export class NotFoundError extends AppError {
  constructor(message = 'Employee not found') {
    super(404, 'EMPLOYEE_NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Employee is already confirmed') {
    super(409, 'ALREADY_CONFIRMED', message);
  }
}

export class BusinessRuleError extends AppError {
  constructor(message: string) {
    super(422, 'MAX_PROBATION_EXCEEDED', message);
  }
}
