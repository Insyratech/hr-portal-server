import { describe, expect, it } from 'vitest';
import { nextWeekStart, calendarWeek, showWeekWrapUp, weekBounds } from './week-bounds';

const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

describe('weekBounds', () => {
  it('uses Monday–Friday for a mid-week date', () => {
    expect(weekBounds('2026-08-25', weekdays)).toEqual({ start: '2026-08-24', end: '2026-08-28' });
  });

  it('snaps Sunday to the following Monday–Friday', () => {
    expect(weekBounds('2026-08-23', weekdays)).toEqual({ start: '2026-08-24', end: '2026-08-28' });
  });

  it('keeps Friday in the week that is ending', () => {
    expect(weekBounds('2026-08-21', weekdays)).toEqual({ start: '2026-08-17', end: '2026-08-21' });
  });

  it('extends through Saturday when Saturday is a working day', () => {
    expect(weekBounds('2026-08-25', [...weekdays, 'SAT'])).toEqual({ start: '2026-08-24', end: '2026-08-29' });
  });

  it('finds the next planning week after Friday', () => {
    expect(nextWeekStart('2026-08-28', weekdays)).toBe('2026-08-31');
  });
});

describe('calendarWeek wrap-up', () => {
  it('keeps Sunday in the week that just finished', () => {
    expect(calendarWeek('2026-08-23', weekdays)).toEqual({ start: '2026-08-17', end: '2026-08-21' });
  });

  it('shows the Friday summary on the last working day and the weekend after', () => {
    const calendar = { end: '2026-08-21' };
    const planning = { start: '2026-08-24' };
    expect(showWeekWrapUp('2026-08-21', calendar, planning)).toBe(true);
    expect(showWeekWrapUp('2026-08-22', calendar, planning)).toBe(true);
    expect(showWeekWrapUp('2026-08-23', calendar, planning)).toBe(true);
    expect(showWeekWrapUp('2026-08-24', calendar, planning)).toBe(false);
  });
});
