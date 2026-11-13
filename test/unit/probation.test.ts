import { describe, expect, it } from 'vitest';
import { assertCanExtend, bucketFor, type Bucket } from '../../src/domain/probation.ts';
import { BusinessRuleError } from '../../src/errors.ts';

describe('bucketFor', () => {
  it.each<[number, Bucket]>([
    [-400, 'overdue'],
    [-1, 'overdue'],
    [0, 'dueWithin7Days'], // ends today: due, not overdue
    [7, 'dueWithin7Days'],
    [8, 'dueWithin30Days'],
    [30, 'dueWithin30Days'],
    [31, 'dueLater'],
    [365, 'dueLater'],
  ])('%i days until end -> %s', (days, bucket) => {
    expect(bucketFor(days)).toBe(bucket);
  });
});

describe('assertCanExtend', () => {
  it.each([
    [3, 3],
    [4, 2],
    [5, 1],
    [1, 3],
  ])('allows total %i + %i (reaches at most 6)', (total, months) => {
    expect(() => assertCanExtend(total, months)).not.toThrow();
  });

  it.each([
    [4, 3],
    [6, 1],
    [5, 2],
  ])('rejects total %i + %i (over 6)', (total, months) => {
    expect(() => assertCanExtend(total, months)).toThrow(BusinessRuleError);
  });

  it('reports the current total, the requested months and the maximum', () => {
    try {
      assertCanExtend(4, 3);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BusinessRuleError);
      const e = err as BusinessRuleError;
      expect(e.status).toBe(422);
      expect(e.code).toBe('MAX_PROBATION_EXCEEDED');
      expect(e.message).toBe(
        'Cannot extend by 3 month(s): current total is 4, which would make 7; the maximum is 6.',
      );
    }
  });
});
