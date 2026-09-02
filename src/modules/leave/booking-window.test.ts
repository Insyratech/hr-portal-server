import { describe, expect, it } from 'vitest';
import { addUtcMonths } from './day-count';
import {
  isLeaveStartWithinBookingWindow,
  latestBookableLeaveStartDate,
  leaveTooFarInAdvanceMessage,
} from './booking-window';

describe('booking-window', () => {
  const oct3 = new Date('2026-10-03T12:00:00.000Z');

  it('adds one calendar month on the same day of month', () => {
    expect(addUtcMonths(new Date(Date.UTC(2026, 9, 3)), 1).toISOString().slice(0, 10)).toBe('2026-11-03');
  });

  it('clamps to the last day when the target month is shorter', () => {
    expect(addUtcMonths(new Date(Date.UTC(2026, 0, 31)), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('allows leave starting on the same day as the one-month limit', () => {
    expect(latestBookableLeaveStartDate(oct3)).toBe('2026-11-03');
    expect(isLeaveStartWithinBookingWindow('2026-11-03', oct3)).toBe(true);
  });

  it('blocks leave starting more than one month ahead', () => {
    expect(isLeaveStartWithinBookingWindow('2026-11-04', oct3)).toBe(false);
    expect(isLeaveStartWithinBookingWindow('2027-01-15', oct3)).toBe(false);
  });

  it('allows leave starting today or sooner', () => {
    expect(isLeaveStartWithinBookingWindow('2026-10-03', oct3)).toBe(true);
    expect(isLeaveStartWithinBookingWindow('2026-09-15', oct3)).toBe(true);
  });

  it('returns a helpful error message with the latest allowed date', () => {
    expect(leaveTooFarInAdvanceMessage(oct3)).toContain('3 Nov 2026');
  });
});
