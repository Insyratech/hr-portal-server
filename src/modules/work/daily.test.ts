import { describe, expect, it } from 'vitest';
import { dayContext } from './day-context';
import { historyMark, skipMessage } from './daily';

const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

describe('daily update skip and history marks', () => {
  it('does not ask for an update on approved leave', () => {
    const context = dayContext({
      isoDate: '2026-08-26',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: true,
      submitted: false,
    });
    expect(context.required).toBe(false);
    expect(skipMessage(context)).toMatch(/on leave/i);
    expect(historyMark(context, '2026-08-26')).toBe('L');
  });

  it('marks a holiday as H and skips the form', () => {
    const context = dayContext({
      isoDate: '2026-08-14',
      workingDays: weekdays,
      holidayDates: ['2026-08-14'],
      onApprovedLeave: false,
      submitted: false,
    });
    expect(skipMessage(context)).toMatch(/holiday/i);
    expect(historyMark(context, '2026-08-26')).toBe('H');
  });

  it('marks a missed working day as M', () => {
    const context = dayContext({
      isoDate: '2026-08-24',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: false,
      submitted: false,
    });
    expect(historyMark(context, '2026-08-26')).toBe('M');
  });

  it('marks a submitted day as done', () => {
    const context = dayContext({
      isoDate: '2026-08-25',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: false,
      submitted: true,
    });
    expect(historyMark(context, '2026-08-26')).toBe('✓');
    expect(skipMessage(context)).toBeNull();
  });
});
