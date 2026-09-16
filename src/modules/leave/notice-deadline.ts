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

export function noticeClockForShift(shift: LeaveNoticeShift | null | undefined): string {
  if (!shift) return UNASSIGNED_LEAVE_NOTICE_CLOCK;
  if (shift.flexible) return FLEXIBLE_LEAVE_NOTICE_CLOCK;
  const stored = normalizeClockHhmm(shift.startTime);
  if (!stored || stored === FLEXIBLE_SHIFT_START) return UNASSIGNED_LEAVE_NOTICE_CLOCK;
  return stored;
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
  const shiftPart = input.shift?.flexible
    ? `${input.shift.name} (${formatClock12Hour(clock)} typical start)`
    : input.shift
      ? `${input.shift.name} (${formatClock12Hour(clock)})`
      : `shift start (${formatClock12Hour(clock)})`;
  return `This leave requires ${duration} notice before your ${shiftPart}. Apply by ${formatNoticeDeadlineLabel(deadline)}.`;
}
