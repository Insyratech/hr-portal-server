import { describe, expect, it } from 'vitest';
import { dayContext } from './day-context';
import { skipsWorkApprovalLoop } from './approval';
import { previousIsoDate, shouldMailDailyUpdate, shouldSkipMondayPriorityReminder } from './work-jobs';

const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

describe('work reminder rules', () => {
  it('does not mail a work update on approved leave', () => {
    const context = dayContext({
      isoDate: '2026-08-26',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: true,
      submitted: false,
    });
    expect(shouldMailDailyUpdate(context)).toBe(false);
  });

  it('does not mail on a holiday', () => {
    const context = dayContext({
      isoDate: '2026-08-14',
      workingDays: weekdays,
      holidayDates: ['2026-08-14'],
      onApprovedLeave: false,
      submitted: false,
    });
    expect(shouldMailDailyUpdate(context)).toBe(false);
  });

  it('does not mail after the person already submitted', () => {
    const context = dayContext({
      isoDate: '2026-08-25',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: false,
      submitted: true,
    });
    expect(shouldMailDailyUpdate(context)).toBe(false);
  });

  it('mails once for a working day with no update', () => {
    const context = dayContext({
      isoDate: '2026-08-25',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: false,
      submitted: false,
    });
    expect(shouldMailDailyUpdate(context)).toBe(true);
  });

  it('closes the previous calendar date after the reminder window', () => {
    expect(previousIsoDate('2026-08-26')).toBe('2026-08-25');
  });

  it('skips the Monday priority reminder when the person is on leave', () => {
    const onLeave = dayContext({
      isoDate: '2026-08-24',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: true,
      submitted: false,
    });
    expect(shouldSkipMondayPriorityReminder(onLeave)).toBe(true);
    expect(onLeave.required).toBe(false);
  });

  it('sends the Monday reminder on a working day (reminder only — submit is not blocked later)', () => {
    const working = dayContext({
      isoDate: '2026-08-24',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: false,
      submitted: false,
    });
    expect(shouldSkipMondayPriorityReminder(working)).toBe(false);
  });

  it('skips managerial hats from the personal reminder loop', () => {
    expect(skipsWorkApprovalLoop(['HR_MANAGER'])).toBe(true);
    expect(skipsWorkApprovalLoop(['EMPLOYEE'])).toBe(false);
    expect(skipsWorkApprovalLoop(['CSO', 'EMPLOYEE'])).toBe(false);
  });
});
