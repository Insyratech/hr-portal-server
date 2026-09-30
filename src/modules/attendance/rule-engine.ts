import { isWorkingDate, parseIsoDate } from '../leave/day-count';
import { effectiveGraceMinutes } from './punch-clock';
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
 * Single attendance formula used on Excel import and read.
 * Weekly off: personal week pattern if set, otherwise weekdays missing from org workingDays.
 * MISSING_PUNCH is a status only; HR chooses LOP (no auto half-day).
 * Approved permission minutes credit flexible duration shortfalls and fixed late/early exits.
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
    permissionApplied: false,
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

  if (!isWorkingDate(input.isoDate, input.workingDays, input.holidayDates, input.weekPattern)) {
    return { ...empty, status: 'WEEK_OFF' };
  }

  if (!input.shift) {
    return { ...empty, status: 'NO_SHIFT' };
  }

  if (input.actualIn && !input.actualOut) {
    return {
      ...empty,
      ...(input.shift.flexible
        ? { scheduledIn: null, scheduledOut: null }
        : scheduledBounds(input.isoDate, input.shift)),
      status: 'MISSING_PUNCH',
    };
  }

  if (!input.actualIn && !input.actualOut) {
    return {
      ...empty,
      ...(input.shift.flexible
        ? { scheduledIn: null, scheduledOut: null }
        : scheduledBounds(input.isoDate, input.shift)),
      status: 'ABSENT',
    };
  }

  if (!input.actualIn || !input.actualOut) {
    return {
      ...empty,
      ...(input.shift.flexible
        ? { scheduledIn: null, scheduledOut: null }
        : scheduledBounds(input.isoDate, input.shift)),
      status: 'MISSING_PUNCH',
    };
  }

  const workedMinutes = minutesBetween(input.actualIn, input.actualOut);
  const halfThreshold = Math.floor(input.shift.minimumDurationMinutes / 2);
  const permissionMinutes = Math.max(0, input.permissionMinutes ?? 0);
  const grace = effectiveGraceMinutes(input.shift.gracePeriodMinutes);
  const overtimeMinutes = Math.max(0, workedMinutes - input.shift.minimumDurationMinutes);

  if (input.shift.flexible) {
    const presentAt = Math.max(halfThreshold, input.shift.minimumDurationMinutes - grace);
    const shortfall = Math.max(0, presentAt - workedMinutes);
    const credited = workedMinutes + permissionMinutes;
    const permissionApplied = shortfall > 0 && permissionMinutes >= shortfall;
    let status: DeriveAttendanceResult['status'] = 'PRESENT';
    if (credited >= presentAt) {
      status = 'PRESENT';
    } else if (credited >= halfThreshold) {
      status = 'HALF_DAY';
    } else {
      status = 'ABSENT';
    }
    return {
      status,
      workedMinutes,
      lateMinutes: 0,
      /** Duration shortfall vs required−grace — used so END/any permission can clear LOP. */
      earlyExitMinutes: shortfall,
      overtimeMinutes,
      scheduledIn: null,
      scheduledOut: null,
      permissionApplied,
    };
  }

  const { scheduledIn, scheduledOut } = scheduledBounds(input.isoDate, input.shift);

  const graceEnd = new Date(scheduledIn.getTime() + grace * 60_000);
  let lateMinutes = Math.max(0, minutesBetween(graceEnd, input.actualIn));
  const earlyCutoff = new Date(scheduledOut.getTime() - input.shift.earlyExitThresholdMinutes * 60_000);
  let earlyExitMinutes =
    input.actualOut.getTime() < earlyCutoff.getTime()
      ? minutesBetween(input.actualOut, scheduledOut)
      : 0;

  const lateCovered = lateMinutes > 0 && permissionMinutes >= lateMinutes;
  const earlyCovered = earlyExitMinutes > 0 && permissionMinutes >= earlyExitMinutes;
  if (lateCovered) lateMinutes = 0;
  if (earlyCovered) earlyExitMinutes = 0;
  const permissionApplied = lateCovered || earlyCovered;

  const presentAt = Math.max(halfThreshold, input.shift.minimumDurationMinutes - grace);
  const credited = workedMinutes + (permissionApplied ? permissionMinutes : 0);

  let status: DeriveAttendanceResult['status'] = 'PRESENT';

  if (credited < halfThreshold) {
    status = 'ABSENT';
  } else if (credited < presentAt || earlyExitMinutes > 0) {
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
    permissionApplied,
  };
}
