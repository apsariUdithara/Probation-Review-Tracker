import { describe, expect, it } from 'vitest';
import { daysInMonth, isLeapYear, isValidIsoDate } from '../../src/domain/calendar.ts';

describe('isLeapYear', () => {
  it.each([
    [1900, false], // century, not divisible by 400
    [2000, true], // divisible by 400
    [2023, false],
    [2024, true],
    [2100, false],
  ])('%i -> %s', (year, expected) => {
    expect(isLeapYear(year)).toBe(expected);
  });
});

describe('daysInMonth', () => {
  it.each([
    [2024, 2, 29],
    [2025, 2, 28],
    [2026, 4, 30],
    [2026, 1, 31],
    [2026, 12, 31],
  ])('%i-%i has %i days', (year, month, days) => {
    expect(daysInMonth(year, month)).toBe(days);
  });
});

describe('isValidIsoDate', () => {
  it.each(['2024-02-29', '2000-02-29', '2026-01-31', '2026-12-31', '0001-01-01'])(
    'accepts %s',
    (value) => {
      expect(isValidIsoDate(value)).toBe(true);
    },
  );

  it.each([
    '2025-02-29', // not a leap year
    '2100-02-29', // century, not a leap year
    '1900-02-29',
    '2026-04-31', // April has 30 days
    '2026-13-01', // month 13
    '2026-00-10', // month 0
    '2026-01-00', // day 0
    '0000-01-01', // year 0000 does not exist
    '13/11/2026', // wrong format
    '2026-1-5', // missing zero padding
    '2026-01-01T00:00:00Z', // not a plain date
    ' 2026-01-01',
    '',
  ])('rejects %j', (value) => {
    expect(isValidIsoDate(value)).toBe(false);
  });
});
