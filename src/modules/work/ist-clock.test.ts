import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_REMINDER_HOUR,
  DEFAULT_SECOND_DAILY_REMINDER_HOUR,
  MONDAY_PRIORITY_REMINDER_HOUR,
  WORK_TIMEZONE,
  formatIsoDateInZone,
  hourInZone,
  zonedClock,
} from './ist-clock';

describe('IST work clock', () => {
  it('uses Asia/Kolkata defaults for reminder hours', () => {
    expect(WORK_TIMEZONE).toBe('Asia/Kolkata');
    expect(MONDAY_PRIORITY_REMINDER_HOUR).toBe(16);
    expect(DEFAULT_DAILY_REMINDER_HOUR).toBe(20);
    expect(DEFAULT_SECOND_DAILY_REMINDER_HOUR).toBe(22);
  });

  it('reads the calendar date in IST, not UTC, near midnight', () => {
    // 2026-08-26 23:30 IST = 2026-08-26 18:00 UTC
    const eveningIst = new Date('2026-08-26T18:00:00.000Z');
    expect(formatIsoDateInZone(eveningIst)).toBe('2026-08-26');
    expect(hourInZone(eveningIst)).toBe(23);

    // 2026-08-27 00:30 IST = 2026-08-26 19:00 UTC (UTC still 26th)
    const afterMidnightIst = new Date('2026-08-26T19:00:00.000Z');
    expect(formatIsoDateInZone(afterMidnightIst)).toBe('2026-08-27');
    expect(hourInZone(afterMidnightIst)).toBe(0);
  });

  it('matches Monday 16:00 IST window', () => {
    // 2026-08-24 is a Monday. 16:00 IST = 10:30 UTC
    const mondayFourPm = new Date('2026-08-24T10:30:00.000Z');
    const clock = zonedClock(mondayFourPm);
    expect(clock.isoDate).toBe('2026-08-24');
    expect(clock.hour).toBe(16);
  });
});
