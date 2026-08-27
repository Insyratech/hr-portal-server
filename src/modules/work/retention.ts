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

export function matchingReminderSlot(
  hour: number,
  primaryHour: number,
  secondHour: number | null,
): 'primary' | 'second' | null {
  if (hour === primaryHour) return 'primary';
  if (secondHour != null && hour === secondHour && secondHour !== primaryHour) return 'second';
  return null;
}
