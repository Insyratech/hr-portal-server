import { addUtcMonths, formatIsoDate, parseIsoDate } from './day-count';

/** Employees may not request leave with a start date more than this many calendar months ahead. */
export const LEAVE_MAX_ADVANCE_MONTHS = 1;

export function utcToday(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Latest leave start date an employee can request when applying on `now`. */
export function latestBookableLeaveStartDate(now: Date): string {
  return formatIsoDate(addUtcMonths(utcToday(now), LEAVE_MAX_ADVANCE_MONTHS));
}

export function isLeaveStartWithinBookingWindow(startDate: string, now: Date): boolean {
  const start = parseIsoDate(startDate);
  const latest = parseIsoDate(latestBookableLeaveStartDate(now));
  if (Number.isNaN(start.getTime())) {
    return false;
  }
  return start.getTime() <= latest.getTime();
}

export function leaveTooFarInAdvanceMessage(now: Date): string {
  const latest = latestBookableLeaveStartDate(now);
  const formatted = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parseIsoDate(latest));
  return `Leave can only be applied up to ${LEAVE_MAX_ADVANCE_MONTHS} month in advance. The latest start date you can request today is ${formatted}.`;
}
