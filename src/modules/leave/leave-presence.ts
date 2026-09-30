import { addUtcDays, formatIsoDate, parseIsoDate } from './day-count';

/** How far back “past leave” looks from the as-of date (calendar days). */
export const PRESENCE_PAST_DAYS = 90;

export function resolvePresenceAsOf(asOf: string | undefined, todayIso: string): string {
  if (!asOf) return todayIso;
  const trimmed = asOf.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return todayIso;
  return trimmed;
}

export function presencePastFrom(asOf: string): string {
  return formatIsoDate(addUtcDays(parseIsoDate(asOf), -PRESENCE_PAST_DAYS));
}

function dateKey(value: string): string {
  return value.slice(0, 10);
}

export type PresenceDateRow = {
  startDate: string;
  endDate: string;
  status: string;
};

export function splitPresenceApplications<T extends PresenceDateRow>(
  rows: T[],
  asOf: string,
): { onLeave: T[]; upcoming: T[]; past: T[] } {
  const approved = rows.filter((row) => row.status === 'APPROVED');
  const onLeave = approved
    .filter((row) => dateKey(row.startDate) <= asOf && dateKey(row.endDate) >= asOf)
    .sort((a, b) => dateKey(a.startDate).localeCompare(dateKey(b.startDate)));
  const upcoming = approved
    .filter((row) => dateKey(row.startDate) > asOf)
    .sort((a, b) => dateKey(a.startDate).localeCompare(dateKey(b.startDate)));
  const past = approved
    .filter((row) => dateKey(row.endDate) < asOf)
    .sort((a, b) => dateKey(b.endDate).localeCompare(dateKey(a.endDate)));
  return { onLeave, upcoming, past };
}
