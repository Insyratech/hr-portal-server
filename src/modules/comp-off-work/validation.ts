import {
  eachIsoDate,
  isWorkingDate,
  type WeekPattern,
} from '../leave/day-count';

export function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

export function sameCalendarMonth(a: string, b: string): boolean {
  return monthKey(a) === monthKey(b);
}

export function monthBounds(yearMonth: string): { start: string; end: string; label: string } {
  const [yearText, monthText] = yearMonth.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error('INVALID_MONTH');
  }
  const start = `${yearText}-${monthText}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${yearText}-${monthText}-${String(lastDay).padStart(2, '0')}`;
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return { start, end, label };
}

/** Working days inside a leave application that can be compensated. */
export function leaveWorkingDates(input: {
  startDate: string;
  endDate: string;
  duration: 'full' | 'half';
  workingDays: string[];
  holidayDates: string[];
  weekPatternForDate: (isoDate: string) => WeekPattern | null;
}): { leaveDate: string; quantity: number }[] {
  if (input.duration === 'half') {
    if (
      isWorkingDate(
        input.startDate,
        input.workingDays,
        input.holidayDates,
        input.weekPatternForDate(input.startDate),
      )
    ) {
      return [{ leaveDate: input.startDate, quantity: 0.5 }];
    }
    return [];
  }

  const days: { leaveDate: string; quantity: number }[] = [];
  for (const iso of eachIsoDate(input.startDate, input.endDate)) {
    if (isWorkingDate(iso, input.workingDays, input.holidayDates, input.weekPatternForDate(iso))) {
      days.push({ leaveDate: iso, quantity: 1 });
    }
  }
  return days;
}

export function assertWorkDateIsOff(input: {
  workDate: string;
  workingDays: string[];
  holidayDates: string[];
  weekPattern: WeekPattern | null;
}): void {
  if (isWorkingDate(input.workDate, input.workingDays, input.holidayDates, input.weekPattern)) {
    throw new Error('WORK_DATE_MUST_BE_OFF');
  }
}

export function canAdjustLeaveDate(leaveDate: string, today: string): boolean {
  return monthKey(leaveDate) === monthKey(today) && leaveDate <= today;
}
