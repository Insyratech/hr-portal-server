import { isWorkingDate, parseIsoDate, weekdayCode } from '../leave/day-count';
import type { DeriveAttendanceInput, DeriveAttendanceResult, ShiftDefinition } from './types';

function parseTimeParts(time: string): { hours: number; minutes: number } {
  const [hours, minutes] = time.split(':').map(Number);
  return { hours: hours ?? 0, minutes: minutes ?? 0 };
}

export function combineDateAndTime(isoDate: string, time: string): Date {
  const base = parseIsoDate(isoDate);
  const { hours, minutes } = parseTimeParts(time);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hours, minutes, 0, 0));
}

export function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60_000));
}

export function scheduledBounds(isoDate: string, shift: ShiftDefinition): { scheduledIn: Date; scheduledOut: Date } {
  return {
    scheduledIn: combineDateAndTime(isoDate, shift.startTime),
    scheduledOut: combineDateAndTime(isoDate, shift.endTime),
  };
}

/**
 * Single attendance formula used on punch-out, correction approve, and read.
 * Do not duplicate this logic elsewhere.
 */
export function deriveAttendance(input: DeriveAttendanceInput): DeriveAttendanceResult {
  const empty: DeriveAttendanceResult = {
    status: 'ABSENT',
    workedMinutes: null,
    lateMinutes: 0,
    earlyExitMinutes: 0,
    overtimeMinutes: 0,
    scheduledIn: null,
    scheduledOut: null,
  };

  if (input.onApprovedLeave) {
    const bounds = input.shift ? scheduledBounds(input.isoDate, input.shift) : null;
    return {
      ...empty,
      status: 'LEAVE',
      scheduledIn: bounds?.scheduledIn ?? null,
      scheduledOut: bounds?.scheduledOut ?? null,
    };
  }

  if (input.holidayDates.includes(input.isoDate)) {
    return { ...empty, status: 'HOLIDAY' };
  }

  if (!input.workingDays.includes(weekdayCode(parseIsoDate(input.isoDate)))) {
    return { ...empty, status: 'WEEK_OFF' };
  }

  // Defensive: holidays already covered; keep isWorkingDate aligned with leave module.
  if (!isWorkingDate(input.isoDate, input.workingDays, input.holidayDates)) {
    return { ...empty, status: 'WEEK_OFF' };
  }

  if (!input.shift) {
    return empty;
  }

  const { scheduledIn, scheduledOut } = scheduledBounds(input.isoDate, input.shift);
  const base = {
    ...empty,
    scheduledIn,
    scheduledOut,
  };

  if (input.actualIn && !input.actualOut) {
    return { ...base, status: 'MISSING_PUNCH' };
  }

  if (!input.actualIn && !input.actualOut) {
    return { ...base, status: 'ABSENT' };
  }

  if (!input.actualIn || !input.actualOut) {
    return { ...base, status: 'MISSING_PUNCH' };
  }

  const workedMinutes = minutesBetween(input.actualIn, input.actualOut);
  const graceEnd = new Date(scheduledIn.getTime() + input.shift.gracePeriodMinutes * 60_000);
  const lateMinutes = Math.max(0, minutesBetween(graceEnd, input.actualIn));
  const earlyCutoff = new Date(scheduledOut.getTime() - input.shift.earlyExitThresholdMinutes * 60_000);
  const earlyExitMinutes =
    input.actualOut.getTime() < earlyCutoff.getTime()
      ? minutesBetween(input.actualOut, scheduledOut)
      : 0;
  const overtimeMinutes = Math.max(0, workedMinutes - input.shift.minimumDurationMinutes);
  const halfThreshold = Math.floor(input.shift.minimumDurationMinutes / 2);

  let status: DeriveAttendanceResult['status'] = 'PRESENT';

  if (input.shift.flexible) {
    if (workedMinutes >= input.shift.minimumDurationMinutes) {
      status = 'PRESENT';
    } else if (workedMinutes >= halfThreshold) {
      status = 'HALF_DAY';
    } else {
      status = 'ABSENT';
    }
  } else if (workedMinutes < halfThreshold) {
    status = 'ABSENT';
  } else if (workedMinutes < input.shift.minimumDurationMinutes || earlyExitMinutes > 0) {
    status = 'HALF_DAY';
  } else if (lateMinutes > 0) {
    status =
      input.shift.lateThresholdMinutes > 0 && lateMinutes >= input.shift.lateThresholdMinutes
        ? 'HALF_DAY'
        : 'LATE';
  } else {
    status = 'PRESENT';
  }

  return {
    status,
    workedMinutes,
    lateMinutes,
    earlyExitMinutes,
    overtimeMinutes,
    scheduledIn,
    scheduledOut,
  };
}
