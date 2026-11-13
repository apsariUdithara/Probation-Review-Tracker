import { BusinessRuleError } from '../errors.ts';

// Changing a limit here also needs a new migration for the matching CHECK constraint.
export const MIN_PROBATION_MONTHS = 1;
export const MAX_PROBATION_MONTHS = 6;
export const MIN_EXTENSION_MONTHS = 1;
export const MAX_EXTENSION_MONTHS = 3;

export const DEFAULT_WITHIN_DAYS = 30;
export const MAX_WITHIN_DAYS = 365;

export type Bucket = 'overdue' | 'dueWithin7Days' | 'dueWithin30Days' | 'dueLater';

// Which group a probation belongs in. Ends today (0) is due, not overdue.
export function bucketFor(daysUntilEnd: number): Bucket {
  if (daysUntilEnd < 0) return 'overdue';
  if (daysUntilEnd <= 7) return 'dueWithin7Days';
  if (daysUntilEnd <= 30) return 'dueWithin30Days';
  return 'dueLater';
}

// Exactly MAX_PROBATION_MONTHS is allowed; anything above is rejected before any write.
export function assertCanExtend(currentTotal: number, months: number): void {
  if (currentTotal + months > MAX_PROBATION_MONTHS) {
    throw new BusinessRuleError(
      `Cannot extend by ${months} month(s): current total is ${currentTotal}, ` +
        `which would make ${currentTotal + months}; the maximum is ${MAX_PROBATION_MONTHS}.`,
    );
  }
}
