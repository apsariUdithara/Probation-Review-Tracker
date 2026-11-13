// Calendar-date validation with plain integers. No JavaScript Date: it reinterprets
// years 0-99 as 1900-1999 and its parsing depends on the timezone.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Divisible by 4, except century years, unless also divisible by 400.
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// True for a real calendar date written as YYYY-MM-DD (year 0001 or later).
export function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}
