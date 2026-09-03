import {
  isLeaveStartWithinBookingWindow,
  latestBookableLeaveStartDate,
  leaveTooFarInAdvanceMessage,
  utcToday,
} from '../leave/booking-window';
import { addUtcDays, formatIsoDate, parseIsoDate } from '../leave/day-count';

export function earliestShiftChangeStartDate(now: Date): string {
  return formatIsoDate(addUtcDays(utcToday(now), 1));
}

export function validateShiftChangeDates(input: {
  startDate: string;
  endDate: string;
  now: Date;
}): { ok: true } | { ok: false; message: string } {
  const start = parseIsoDate(input.startDate);
  const end = parseIsoDate(input.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return { ok: false, message: 'Shift change dates are invalid.' };
  }

  const earliest = parseIsoDate(earliestShiftChangeStartDate(input.now));
  if (start.getTime() < earliest.getTime()) {
    return {
      ok: false,
      message: 'Shift changes must be requested at least 1 day in advance. Pick a future date starting tomorrow.',
    };
  }

  if (!isLeaveStartWithinBookingWindow(input.startDate, input.now)) {
    return { ok: false, message: leaveTooFarInAdvanceMessage(input.now).replace(/^Leave/, 'Shift changes') };
  }

  const latest = parseIsoDate(latestBookableLeaveStartDate(input.now));
  if (end.getTime() > latest.getTime()) {
    const formatted = new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(latest);
    return {
      ok: false,
      message: `The shift change end date cannot be after ${formatted} (1 month in advance).`,
    };
  }

  return { ok: true };
}
