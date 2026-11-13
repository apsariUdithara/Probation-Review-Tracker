// "Today" as a YYYY-MM-DD calendar date. Injected into the app so tests can fix the date.
export type Clock = { today(): string };

// The calendar date in `timeZone` at instant `now`. Built from formatToParts so the
// result never depends on how a locale happens to format dates.
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: 'year' | 'month' | 'day') => parts.find((p) => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function systemClock(timeZone: string): Clock {
  return { today: () => todayIn(timeZone) };
}

export function fixedClock(date: string): Clock {
  return { today: () => date };
}
