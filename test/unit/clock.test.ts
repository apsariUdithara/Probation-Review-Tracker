import { expect, it } from 'vitest';
import { fixedClock, todayIn } from '../../src/clock.ts';

// Asia/Colombo is UTC+05:30, so the date changes at 18:30 UTC.
it.each([
  ['2026-11-12T18:29:59Z', '2026-11-12'],
  ['2026-11-12T18:30:00Z', '2026-11-13'],
  ['2026-11-12T19:00:00Z', '2026-11-13'],
  ['2026-12-31T18:30:00Z', '2027-01-01'], // year rolls over in Colombo first
])('%s in Asia/Colombo is %s', (instant, expected) => {
  expect(todayIn('Asia/Colombo', new Date(instant))).toBe(expected);
});

it('uses the given timezone, not the machine timezone', () => {
  expect(todayIn('UTC', new Date('2026-11-12T19:00:00Z'))).toBe('2026-11-12');
});

it('fixedClock always returns the same date', () => {
  expect(fixedClock('2026-11-13').today()).toBe('2026-11-13');
});
