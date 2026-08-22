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

export function weekdayCode(date: Date): string {
  return WEEKDAYS[date.getUTCDay()];
}

export function isWorkingDate(
  isoDate: string,
  workingDays: string[],
  holidayDates: string[],
): boolean {
  if (holidayDates.includes(isoDate)) {
    return false;
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
}): number {
  if (input.duration === 'half') {
    return isWorkingDate(input.startDate, input.workingDays, input.holidayDates) ? 0.5 : 0;
  }

  let quantity = 0;
  for (const isoDate of eachIsoDate(input.startDate, input.endDate)) {
    if (isWorkingDate(isoDate, input.workingDays, input.holidayDates)) {
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
