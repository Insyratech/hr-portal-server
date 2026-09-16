import {
  WORK_TIMEZONE,
  formatClock12Hour,
  instantFromWorkClock,
  normalizeClockHhmm,
  zonedClock,
} from '../work/ist-clock';
import { FLEXIBLE_SHIFT_START } from '../attendance/support';
import type { LeaveNoticeShift, NoticeUnit } from './types';

/**
 * Flexible shifts store 00:00–23:59. Notice uses the earliest typical start
 * from the shifts UI copy (employees may start at 8, 9, 10, or later).
 */
export const FLEXIBLE_LEAVE_NOTICE_CLOCK = '08:00';

/** When no shift is assigned, treat the working day as starting at 09:00 IST. */
export const UNASSIGNED_LEAVE_NOTICE_CLOCK = '09:00';

export function noticeHoursValue(notice: { value: number; unit: NoticeUnit }): number {
  return notice.unit === 'days' ? notice.value * 24 : notice.value;
}

function clockToMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

function addHoursHhmm(hhmm: string, hours: number): string {
  const total = (clockToMinutes(hhmm) + hours * 60) % (24 * 60);
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * A 12-hour time saved as AM (01:30–22:00, 510m required) is an afternoon start.
 * Overnight windows (09:00–06:00) keep the stored start.
 */
export function resolvedFixedShiftStart(shift: LeaveNoticeShift): string | null {
  const start = normalizeClockHhmm(shift.startTime);
  if (!start) return null;
  const end = shift.endTime ? normalizeClockHhmm(shift.endTime) : null;
  const required = shift.minimumDurationMinutes ?? 0;
  if (end && required > 0) {
    const startMin = clockToMinutes(start);
    const endMin = clockToMinutes(end);
    if (startMin < endMin) {
      const afternoon = addHoursHhmm(start, 12);
      const afternoonMin = clockToMinutes(afternoon);
      if (afternoonMin < endMin) {
        const asStored = endMin - startMin;
        const asAfternoon = endMin - afternoonMin;
        if (Math.abs(asAfternoon - required) < Math.abs(asStored - required)) {
          return afternoon;
        }
      }
    }
  }
  if (start === FLEXIBLE_SHIFT_START) return null;
  return start;
}

export function noticeClockForShift(shift: LeaveNoticeShift | null | undefined): string {
  if (!shift) return UNASSIGNED_LEAVE_NOTICE_CLOCK;
  if (shift.flexible) return FLEXIBLE_LEAVE_NOTICE_CLOCK;
  return resolvedFixedShiftStart(shift) ?? UNASSIGNED_LEAVE_NOTICE_CLOCK;
}

export function leaveNoticeDeadline(input: {
  startDate: string;
  noticeHours: number;
  shift?: LeaveNoticeShift | null;
}): Date {
  const clock = noticeClockForShift(input.shift);
  const shiftStart = instantFromWorkClock(input.startDate, clock);
  return new Date(shiftStart.getTime() - input.noticeHours * 3_600_000);
}

export function leaveNoticeMet(input: {
  startDate: string;
  now: Date;
  noticeHours: number;
  shift?: LeaveNoticeShift | null;
}): boolean {
  if (input.noticeHours <= 0) return true;
  const deadline = leaveNoticeDeadline(input);
  if (Number.isNaN(deadline.getTime())) return true;
  return input.now.getTime() <= deadline.getTime();
}

function formatNoticeDuration(value: number, unit: NoticeUnit): string {
  const singular = unit === 'hours' ? 'hour' : 'day';
  const plural = unit === 'hours' ? 'hours' : 'days';
  return `${value} ${value === 1 ? singular : plural}`;
}

function formatIstDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: WORK_TIMEZONE,
  }).format(instant);
}

function formatNoticeDeadlineLabel(deadline: Date): string {
  const clock = zonedClock(deadline, WORK_TIMEZONE);
  return `${formatClock12Hour(`${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`)} on ${formatIstDate(deadline)}`;
}

function shiftStartPhrase(shift: LeaveNoticeShift | null | undefined, clock: string): string {
  const clockLabel = formatClock12Hour(clock);
  if (shift?.flexible) return `${shift.name} (${clockLabel} typical start)`;
  if (shift) return `${shift.name} (${clockLabel})`;
  return `shift (${clockLabel})`;
}

export function noticePeriodNotMetMessage(input: {
  noticePeriod: { value: number; unit: NoticeUnit };
  startDate: string;
  shift?: LeaveNoticeShift | null;
}): string {
  const duration = formatNoticeDuration(input.noticePeriod.value, input.noticePeriod.unit);
  const clock = noticeClockForShift(input.shift);
  const deadline = leaveNoticeDeadline({
    startDate: input.startDate,
    noticeHours: noticeHoursValue(input.noticePeriod),
    shift: input.shift,
  });
  return `This leave must be applied at least ${duration} before your ${shiftStartPhrase(input.shift, clock)} starts. You can apply until ${formatNoticeDeadlineLabel(deadline)}.`;
}
