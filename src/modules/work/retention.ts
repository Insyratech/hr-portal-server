import { addUtcDays, formatIsoDate, parseIsoDate } from '../leave/day-count';

export const RETENTION_DAY_OPTIONS = [90, 180, 365] as const;
export type RetentionDays = (typeof RETENTION_DAY_OPTIONS)[number];

export function isRetentionDays(value: number): value is RetentionDays {
  return (RETENTION_DAY_OPTIONS as readonly number[]).includes(value);
}

/** Rolling cutoff: today minus retention days. Not a calendar-month wipe. */
export function retentionCutoffDate(today: string, retentionDays: number): string {
  return formatIsoDate(addUtcDays(parseIsoDate(today), -retentionDays));
}

export function isEligibleForPurge(anchorDate: string, cutoffDate: string): boolean {
  return anchorDate <= cutoffDate;
}

export function canPurgeAfterNotice(noticeAtIsoDate: string, today: string, notifyDaysBefore: number): boolean {
  const readyOn = formatIsoDate(addUtcDays(parseIsoDate(noticeAtIsoDate), notifyDaysBefore));
  return today >= readyOn;
}

/** Ascending, de-duplicated list of valid 0–23 reminder hours. */
export function normalizeReminderHours(hours: (number | null | undefined)[]): number[] {
  const valid = hours.filter(
    (hour): hour is number => Number.isInteger(hour) && (hour as number) >= 0 && (hour as number) <= 23,
  );
  return [...new Set(valid)].sort((a, b) => a - b);
}

/**
 * Index of the reminder slot due at `hour` — the latest configured hour at or before it.
 *
 * Catch-up by design: a runner that misses the exact hour still sends on its next tick, and the
 * reminder log keeps every slot to a single mail per person per day.
 */
export function dueReminderSlot(hour: number, hours: number[]): number | null {
  let due: number | null = null;
  for (let index = 0; index < hours.length; index += 1) {
    if (hours[index] <= hour) due = index;
  }
  return due;
}
