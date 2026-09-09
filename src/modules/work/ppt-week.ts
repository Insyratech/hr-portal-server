import { addUtcDays, formatIsoDate, parseIsoDate } from '../leave/day-count';
import { zonedClock, WORK_TIMEZONE } from './ist-clock';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Mon–Sun calendar week for weekly PPT (not org working-day planning week). */
export function pptWeekBounds(isoDate: string): { start: string; end: string } {
  const date = parseIsoDate(isoDate);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  const monday = addUtcDays(date, offset);
  return {
    start: formatIsoDate(monday),
    end: formatIsoDate(addUtcDays(monday, 6)),
  };
}

/** @deprecated Prefer sundayOfPptWeek — PPT deadline day is Sunday. */
export function saturdayOfPptWeek(weekStart: string): string {
  return formatIsoDate(addUtcDays(parseIsoDate(weekStart), 5));
}

/** Sunday of the Mon–Sun PPT week (= week end). Deadline day for weekly wrap PPT. */
export function sundayOfPptWeek(weekStart: string): string {
  return formatIsoDate(addUtcDays(parseIsoDate(weekStart), 6));
}

/**
 * Sunday reminder hours (IST) for a missing weekly PPT: 6 pm, 8 pm, 10 pm.
 * Deliberately independent of the lateness threshold — these nudge before the 23:59 deadline.
 */
export const WEEKLY_PPT_REMINDER_HOURS = [18, 20, 22] as const;

/** Sunday hour (IST) from which the CSO status digest may go out. */
export const WEEKLY_PPT_CSO_DIGEST_HOUR = 22;

/** Sunday hour (IST) from which a submission counts as a last-hour submission rather than on time. */
export const WEEKLY_PPT_LAST_HOUR = 23;

/**
 * How a weekly PPT submission is tagged.
 * `on_time` up to Sunday 22:59 IST, `last_hour` Sunday 23:00–23:59 IST, `late` from Monday.
 */
export type WeeklyPptTiming = 'on_time' | 'last_hour' | 'late';

export function weeklyPptTiming(now: Date, weekStart: string): WeeklyPptTiming {
  const sunday = sundayOfPptWeek(weekStart);
  const clock = zonedClock(now, WORK_TIMEZONE);
  if (clock.isoDate > sunday) return 'late';
  if (clock.isoDate < sunday) return 'on_time';
  return clock.hour >= WEEKLY_PPT_LAST_HOUR ? 'last_hour' : 'on_time';
}

/** The stored `late` flag: only submissions after Sunday 23:59 IST count as late. */
export function isWeeklyPptLate(timing: WeeklyPptTiming): boolean {
  return timing === 'late';
}

/**
 * Timing of a stored row. Falls back to the `late` flag so rows written before the
 * submission_timing column existed still read correctly.
 */
export function readWeeklyPptTiming(row: {
  submission_timing?: string | null;
  late?: boolean | null;
}): WeeklyPptTiming {
  if (row.submission_timing === 'last_hour' || row.submission_timing === 'late') {
    return row.submission_timing;
  }
  if (row.submission_timing === 'on_time') return 'on_time';
  return row.late ? 'late' : 'on_time';
}

export function weeklyPptTimingLabel(timing: WeeklyPptTiming): string {
  switch (timing) {
    case 'late':
      return 'Late';
    case 'last_hour':
      return 'Last hour submission';
    default:
      return 'On time';
  }
}

export function sanitizePersonNameForFile(fullName: string): string {
  const cleaned = fullName
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return cleaned || 'Employee';
}

export function buildWeeklyPptSystemFileName(
  fullName: string,
  weekStart: string,
  weekEnd: string,
  extension: '.ppt' | '.pptx',
): string {
  const name = sanitizePersonNameForFile(fullName);
  const start = parseIsoDate(weekStart);
  const end = parseIsoDate(weekEnd);
  const month = MONTHS[start.getUTCMonth()];
  const d1 = String(start.getUTCDate()).padStart(2, '0');
  const d2 = String(end.getUTCDate()).padStart(2, '0');
  return `${name}_${month}_${d1}-${d2}${extension}`;
}

export function pptExtension(fileName: string): '.ppt' | '.pptx' | null {
  const lower = fileName.trim().toLowerCase();
  if (lower.endsWith('.pptx')) return '.pptx';
  if (lower.endsWith('.ppt')) return '.ppt';
  return null;
}

export const WEEKLY_PPT_MAX_BYTES = 15 * 1024 * 1024;
export const WEEKLY_PPT_MAX_UPLOADS = 2;
export const WEEKLY_PPT_BUCKET = 'weekly-work-updates';

export const WEEKLY_PPT_MIME = new Set([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/octet-stream',
]);
