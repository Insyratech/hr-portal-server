import { describe, expect, it } from 'vitest';
import { dayContext } from './day-context';
import { skipsWorkApprovalLoop } from './approval';
import { WEEKLY_PPT_REMINDER_HOURS } from './ppt-week';
import { dueReminderSlot } from './retention';
import {
  dailyReminderKindForSlot,
  previousIsoDate,
  shouldMailDailyUpdate,
  shouldSkipMondayPriorityReminder,
  weeklyPptReminderKindForSlot,
} from './work-jobs';

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

  it('maps each daily hour to its own reminder kind, so all three slots can send', () => {
    const hours = [17, 20, 23];
    const kindAt = (hour: number) => dailyReminderKindForSlot(dueReminderSlot(hour, hours));

    expect(kindAt(16)).toBe(null);
    expect(kindAt(17)).toBe('daily_update');
    expect(kindAt(20)).toBe('daily_update_second');
    expect(kindAt(23)).toBe('daily_update_third');
  });

  it('maps the Sunday PPT hours 18 / 20 / 22 to their own reminder kinds', () => {
    const hours = [...WEEKLY_PPT_REMINDER_HOURS];
    const kindAt = (hour: number) => weeklyPptReminderKindForSlot(dueReminderSlot(hour, hours));

    expect(kindAt(17)).toBe(null);
    expect(kindAt(18)).toBe('weekly_ppt');
    expect(kindAt(20)).toBe('weekly_ppt_second');
    expect(kindAt(22)).toBe('weekly_ppt_third');
    // A tick a little after the slot still claims that slot rather than dropping it.
    expect(kindAt(23)).toBe('weekly_ppt_third');
  });
});
