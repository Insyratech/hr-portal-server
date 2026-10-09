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

/**
 * Tue–Mon calendar week for weekly / JC PPT (Monday = meeting / last day).
 * Not the org Mon–Sun planning week used for priorities.
 */
export function pptWeekBounds(isoDate: string): { start: string; end: string } {
  const date = parseIsoDate(isoDate);
  const day = date.getUTCDay(); // 0 Sun … 6 Sat; Tuesday = 2
  const daysSinceTuesday = (day - 2 + 7) % 7;
  const tuesday = addUtcDays(date, -daysSinceTuesday);
  return {
    start: formatIsoDate(tuesday),
    end: formatIsoDate(addUtcDays(tuesday, 6)),
  };
}

/** Saturday of the Tue–Mon PPT week (upload window opens this day at 14:00 IST). */
export function saturdayOfPptWeek(weekStart: string): string {
  return formatIsoDate(addUtcDays(parseIsoDate(weekStart), 4));
}

/** Sunday of the Tue–Mon PPT week (upload deadline day 23:59 IST). */
export function sundayOfPptWeek(weekStart: string): string {
  return formatIsoDate(addUtcDays(parseIsoDate(weekStart), 5));
}

/** Monday = last day / meeting day of the Tue–Mon PPT week. */
export function mondayOfPptWeek(weekStart: string): string {
  return formatIsoDate(addUtcDays(parseIsoDate(weekStart), 6));
}

/**
 * Sunday reminder hours (IST) for a missing weekly PPT: 6 pm, 8 pm, 10 pm.
 * Unchanged — still fire on Sunday before the 23:59 deadline.
 */
export const WEEKLY_PPT_REMINDER_HOURS = [18, 20, 22] as const;

/** Sunday hour (IST) from which the CSO status digest may go out. */
export const WEEKLY_PPT_CSO_DIGEST_HOUR = 22;

/** Sunday hour (IST) from which a submission counts as last-hour rather than on time. */
export const WEEKLY_PPT_LAST_HOUR = 23;

/** Saturday hour (IST) when the upload window opens. */
export const WEEKLY_PPT_WINDOW_OPEN_HOUR = 14;

/**
 * How a weekly PPT submission is tagged.
 * `on_time` Sat 14:00–Sun 22:59 IST, `last_hour` Sun 23:00–23:59 IST,
 * `late` outside the Sat–Sun window (e.g. Monday) into the same Tue–Mon week.
 */
export type WeeklyPptTiming = 'on_time' | 'last_hour' | 'late';

export type WeeklyPptWindowState = 'before' | 'open' | 'after';

/** Whether `now` falls in Sat 14:00 IST → Sun 23:59 IST for the given PPT week. */
export function weeklyPptUploadWindowState(now: Date, weekStart: string): WeeklyPptWindowState {
  const saturday = saturdayOfPptWeek(weekStart);
  const sunday = sundayOfPptWeek(weekStart);
  const clock = zonedClock(now, WORK_TIMEZONE);
  if (clock.isoDate < saturday) return 'before';
  if (clock.isoDate > sunday) return 'after';
  if (clock.isoDate === saturday && clock.hour < WEEKLY_PPT_WINDOW_OPEN_HOUR) return 'before';
  return 'open';
}

export function isWithinWeeklyPptUploadWindow(now: Date, weekStart: string): boolean {
  return weeklyPptUploadWindowState(now, weekStart) === 'open';
}

export function weeklyPptTiming(now: Date, weekStart: string): WeeklyPptTiming {
  const sunday = sundayOfPptWeek(weekStart);
  const clock = zonedClock(now, WORK_TIMEZONE);
  const window = weeklyPptUploadWindowState(now, weekStart);
  if (window !== 'open') return 'late';
  if (clock.isoDate < sunday) return 'on_time';
  // Sunday inside the open window
  return clock.hour >= WEEKLY_PPT_LAST_HOUR ? 'last_hour' : 'on_time';
}

/** The stored `late` flag: only submissions outside the Sat–Sun window. */
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
export const WEEKLY_PPT_MAX_UPLOADS = 10;
export const WEEKLY_PPT_BUCKET = 'weekly-work-updates';

export const WEEKLY_PPT_MIME = new Set([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/octet-stream',
]);
