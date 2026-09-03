import { addUtcDays, formatIsoDate, parseIsoDate } from '../leave/day-count';

/** Day before a new assignment starts — used to close prior open rows. */
export function dayBefore(isoDate: string): string {
  return formatIsoDate(addUtcDays(parseIsoDate(isoDate), -1));
}

/**
 * When a shift assignment starts on `effectiveFrom`, compute the end date for another
 * open row that began on `rowEffectiveFrom`. Never returns a date before `rowEffectiveFrom`.
 */
export function closeDateForOpenRow(effectiveFrom: string, rowEffectiveFrom: string): string {
  if (rowEffectiveFrom < effectiveFrom) {
    return dayBefore(effectiveFrom);
  }
  return rowEffectiveFrom;
}

export type OpenAssignmentRow = { id: string; effective_from: string };

/** Rows that should be closed before activating an assignment on `effectiveFrom`. */
export function rowsToClose(
  openRows: OpenAssignmentRow[],
  effectiveFrom: string,
  keepId?: string,
): { id: string; effectiveTo: string }[] {
  const targetFrom = effectiveFrom.slice(0, 10);
  const closes: { id: string; effectiveTo: string }[] = [];
  for (const row of openRows) {
    if (keepId && row.id === keepId) continue;
    const rowFrom = String(row.effective_from).slice(0, 10);
    closes.push({
      id: row.id,
      effectiveTo: closeDateForOpenRow(targetFrom, rowFrom),
    });
  }
  return closes;
}
