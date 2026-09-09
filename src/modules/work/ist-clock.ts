/** Company work clocks use Asia/Kolkata (IST). Cron should hit jobs near these local hours. */

export const WORK_TIMEZONE = 'Asia/Kolkata';

/** Monday priority reminder local hour (16:00 IST). */
export const MONDAY_PRIORITY_REMINDER_HOUR = 16;

/** Default daily update reminder hours (IST): 5 pm, 8 pm, 11 pm. */
export const DEFAULT_DAILY_REMINDER_HOUR = 17;
export const DEFAULT_SECOND_DAILY_REMINDER_HOUR = 20;
export const DEFAULT_THIRD_DAILY_REMINDER_HOUR = 23;

export type ZonedClock = {
  timeZone: string;
  isoDate: string;
  hour: number;
  minute: number;
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Calendar date + hour in a fixed IANA zone (not UTC).
 * Uses Intl so DST/offset rules stay correct if the zone ever changes.
 */
export function zonedClock(now: Date, timeZone: string = WORK_TIMEZONE): ZonedClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const year = Number(read('year'));
  const month = Number(read('month'));
  const day = Number(read('day'));
  const hour = Number(read('hour'));
  const minute = Number(read('minute'));

  return {
    timeZone,
    isoDate: `${year}-${pad2(month)}-${pad2(day)}`,
    hour,
    minute,
  };
}

export function formatIsoDateInZone(now: Date, timeZone: string = WORK_TIMEZONE): string {
  return zonedClock(now, timeZone).isoDate;
}

export function hourInZone(now: Date, timeZone: string = WORK_TIMEZONE): number {
  return zonedClock(now, timeZone).hour;
}

/** Human label for a 0–23 hour used in reminder copy, e.g. 17 → "5:00 pm". */
export function formatWorkHour(hour: number): string {
  const suffix = hour < 12 ? 'am' : 'pm';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:00 ${suffix}`;
}

/** Reminder-copy list of hours, e.g. [17, 20, 23] → "5:00 pm, 8:00 pm and 11:00 pm". */
export function formatWorkHourList(hours: number[]): string {
  const labels = hours.map(formatWorkHour);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
