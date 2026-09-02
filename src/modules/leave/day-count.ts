const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

export function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Adds calendar months in UTC, clamping the day when the target month is shorter. */
export function addUtcMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const result = new Date(Date.UTC(year, month + months, 1));
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export function weekdayCode(date: Date): string {
  return WEEKDAYS[date.getUTCDay()];
}

export const WEEK_PATTERNS = ['SUNDAY_OFF', 'WEEKEND_OFF', 'SECOND_FOURTH_SATURDAY'] as const;
export type WeekPattern = (typeof WEEK_PATTERNS)[number];

export function isWeekPattern(value: string): value is WeekPattern {
  return (WEEK_PATTERNS as readonly string[]).includes(value);
}

/** 1 = first Saturday of the month, 2 = second, and so on. */
export function saturdayOrdinalInMonth(isoDate: string): number {
  return Math.ceil(parseIsoDate(isoDate).getUTCDate() / 7);
}

export function isWeekOffByPattern(isoDate: string, pattern: WeekPattern): boolean {
  const code = weekdayCode(parseIsoDate(isoDate));
  if (pattern === 'SUNDAY_OFF') {
    return code === 'SUN';
  }
  if (pattern === 'WEEKEND_OFF') {
    return code === 'SAT' || code === 'SUN';
  }
  if (code === 'SUN') {
    return true;
  }
  if (code === 'SAT') {
    const ordinal = saturdayOrdinalInMonth(isoDate);
    return ordinal === 2 || ordinal === 4;
  }
  return false;
}

export type WorkWeekRecord = {
  employeeId: string;
  pattern: WeekPattern;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export function patternOnDate(rows: WorkWeekRecord[], employeeId: string, isoDate: string): WeekPattern | null {
  const current = rows
    .filter(
      (row) =>
        row.employeeId === employeeId &&
        row.effectiveFrom <= isoDate &&
        (!row.effectiveTo || row.effectiveTo >= isoDate),
    )
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
  return current?.pattern ?? null;
}

/** True when the date is a working day. Personal week pattern wins over org workingDays. */
export function isWorkingDate(
  isoDate: string,
  workingDays: string[],
  holidayDates: string[],
  weekPattern?: WeekPattern | null,
): boolean {
  if (holidayDates.includes(isoDate)) {
    return false;
  }
  if (weekPattern) {
    return !isWeekOffByPattern(isoDate, weekPattern);
  }
  return workingDays.includes(weekdayCode(parseIsoDate(isoDate)));
}

export function eachIsoDate(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let cursor = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(formatIsoDate(cursor));
    cursor = addUtcDays(cursor, 1);
  }
  return dates;
}

export function countLeaveQuantity(input: {
  startDate: string;
  endDate: string;
  duration: 'full' | 'half';
  workingDays: string[];
  holidayDates: string[];
  weekPatternForDate?: (isoDate: string) => WeekPattern | null;
}): number {
  const working = (isoDate: string) =>
    isWorkingDate(
      isoDate,
      input.workingDays,
      input.holidayDates,
      input.weekPatternForDate ? input.weekPatternForDate(isoDate) : null,
    );
  if (input.duration === 'half') {
    return working(input.startDate) ? 0.5 : 0;
  }

  let quantity = 0;
  for (const isoDate of eachIsoDate(input.startDate, input.endDate)) {
    if (working(isoDate)) {
      quantity += 1;
    }
  }
  return quantity;
}

export function serviceDays(joiningDate: string, now: Date): number {
  const start = parseIsoDate(joiningDate);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((today - start.getTime()) / 86_400_000));
}
