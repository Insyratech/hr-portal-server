/** Company work clocks use Asia/Kolkata (IST). Cron should hit jobs near these local hours. */

export const WORK_TIMEZONE = 'Asia/Kolkata';

/** Monday priority reminder local hour (16:00 IST). */
export const MONDAY_PRIORITY_REMINDER_HOUR = 16;

/** Default daily update reminder hours (IST). */
export const DEFAULT_DAILY_REMINDER_HOUR = 20;
export const DEFAULT_SECOND_DAILY_REMINDER_HOUR = 22;

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
