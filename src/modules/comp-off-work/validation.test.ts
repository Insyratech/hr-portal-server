import { describe, expect, it } from 'vitest';
import {
  assertWorkDateIsOff,
  leaveWorkingDates,
  monthBounds,
  sameCalendarMonth,
} from './validation';

describe('comp-off validation', () => {
  it('requires same calendar month', () => {
    expect(sameCalendarMonth('2026-10-05', '2026-10-31')).toBe(true);
    expect(sameCalendarMonth('2026-10-05', '2026-11-01')).toBe(false);
  });

  it('builds month bounds', () => {
    expect(monthBounds('2026-10')).toEqual({
      start: '2026-10-01',
      end: '2026-10-31',
      label: 'October 2026',
    });
  });

  it('lists working days inside a multi-day leave', () => {
    const days = leaveWorkingDates({
      startDate: '2026-10-05',
      endDate: '2026-10-08',
      duration: 'full',
      workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
      holidayDates: ['2026-10-07'],
      weekPatternForDate: () => null,
    });
    expect(days.map((day) => day.leaveDate)).toEqual(['2026-10-05', '2026-10-06', '2026-10-08']);
    expect(days.every((day) => day.quantity === 1)).toBe(true);
  });

  it('uses half-day quantity for half duration', () => {
    expect(
      leaveWorkingDates({
        startDate: '2026-10-06',
        endDate: '2026-10-06',
        duration: 'half',
        workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        holidayDates: [],
        weekPatternForDate: () => null,
      }),
    ).toEqual([{ leaveDate: '2026-10-06', quantity: 0.5 }]);
  });

  it('rejects a normal working day as work date', () => {
    expect(() =>
      assertWorkDateIsOff({
        workDate: '2026-10-06',
        workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        holidayDates: [],
        weekPattern: null,
      }),
    ).toThrow('WORK_DATE_MUST_BE_OFF');
  });

  it('allows holiday and week-off work dates', () => {
    expect(() =>
      assertWorkDateIsOff({
        workDate: '2026-10-07',
        workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        holidayDates: ['2026-10-07'],
        weekPattern: null,
      }),
    ).not.toThrow();

    expect(() =>
      assertWorkDateIsOff({
        workDate: '2026-10-11',
        workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        holidayDates: [],
        weekPattern: 'SUNDAY_OFF',
      }),
    ).not.toThrow();
  });
});
