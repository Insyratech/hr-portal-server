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

/** Late when submitted at or after Sunday 18:00 IST (deadline day evening). */
export function isWeeklyPptLate(now: Date, weekStart: string): boolean {
  const sunday = sundayOfPptWeek(weekStart);
  const clock = zonedClock(now, WORK_TIMEZONE);
  if (clock.isoDate > sunday) return true;
  if (clock.isoDate < sunday) return false;
  return clock.hour >= 18;
}

/** Sunday 18:00 IST gate used by reminder jobs. */
export function isPastWeeklyPptReminderGate(now: Date, weekStart: string): boolean {
  return isWeeklyPptLate(now, weekStart);
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

export const WEEKLY_PPT_MAX_BYTES = 1024 * 1024;
export const WEEKLY_PPT_MAX_UPLOADS = 2;
export const WEEKLY_PPT_BUCKET = 'weekly-work-updates';

export const WEEKLY_PPT_MIME = new Set([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/octet-stream',
]);
