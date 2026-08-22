import { addUtcDays, formatIsoDate } from '../modules/leave/day-count';

/** Yesterday in UTC — used by the daily attendance finalization job. */
export function yesterdayIso(now = new Date()): string {
  return formatIsoDate(addUtcDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), -1));
}

/** Idempotent: skip write when stored status already matches the engine result. */
export function needsAttendanceFinalizationWrite(existingStatus: string | null, derivedStatus: string): boolean {
  if (!existingStatus) {
    return true;
  }
  return existingStatus !== derivedStatus;
}
