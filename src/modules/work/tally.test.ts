import { describe, expect, it } from 'vitest';
import { dayContext } from './day-context';
import { tallyToday } from './tally';

const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

describe('tallyToday', () => {
  it('separates leave from missing so admins do not guess', () => {
    const submitted = dayContext({
      isoDate: '2026-08-25',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: false,
      submitted: true,
    });
    const missing = dayContext({
      isoDate: '2026-08-25',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: false,
      submitted: false,
    });
    const leave = dayContext({
      isoDate: '2026-08-25',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: true,
      submitted: false,
    });
    expect(tallyToday([submitted, missing, leave])).toEqual({
      expected: 2,
      submitted: 1,
      missing: 1,
      onLeave: 1,
    });
  });
});
