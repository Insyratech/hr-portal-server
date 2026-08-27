import { addUtcDays, formatIsoDate, parseIsoDate, weekdayCode } from '../leave/day-count';

function isoMonday(isoDate: string): Date {
  const date = parseIsoDate(isoDate);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  return addUtcDays(date, offset);
}

function boundsFromMonday(monday: Date, workingDays: string[]): { start: string; end: string } {
  const inWeek: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const iso = formatIsoDate(addUtcDays(monday, i));
    if (workingDays.includes(weekdayCode(parseIsoDate(iso)))) {
      inWeek.push(iso);
    }
  }
  if (inWeek.length === 0) {
    return { start: formatIsoDate(monday), end: formatIsoDate(addUtcDays(monday, 4)) };
  }
  return { start: inWeek[0], end: inWeek[inWeek.length - 1] };
}

export function datesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let cursor = parseIsoDate(start);
  const last = parseIsoDate(end);
  while (cursor.getTime() <= last.getTime()) {
    dates.push(formatIsoDate(cursor));
    cursor = addUtcDays(cursor, 1);
  }
  return dates;
}

/** Working days in the Mon–Sun block that contains isoDate. Does not snap to next week. */
export function calendarWeek(isoDate: string, workingDays: string[]): { start: string; end: string } {
  return boundsFromMonday(isoMonday(isoDate), workingDays);
}

/** Planning week for a date: org working days in the Mon–Sun block. After the last working day, snap to next week. */
export function weekBounds(isoDate: string, workingDays: string[]): { start: string; end: string } {
  let monday = isoMonday(isoDate);
  let bounds = boundsFromMonday(monday, workingDays);
  if (isoDate > bounds.end) {
    monday = addUtcDays(monday, 7);
    bounds = boundsFromMonday(monday, workingDays);
  }
  return bounds;
}

export function showWeekWrapUp(isoDate: string, calendar: { end: string }, planning: { start: string }): boolean {
  return isoDate === calendar.end || (isoDate > calendar.end && isoDate < planning.start);
}

export function nextWeekStart(weekEnd: string, workingDays: string[]): string {
  const after = formatIsoDate(addUtcDays(parseIsoDate(weekEnd), 1));
  return weekBounds(after, workingDays).start;
}
