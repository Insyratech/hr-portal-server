import { describe, expect, it } from 'vitest';
import { dayContext } from './day-context';

const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

describe('dayContext', () => {
  it('marks a company holiday even if it is a weekday', () => {
    const result = dayContext({
      isoDate: '2026-08-14',
      workingDays: weekdays,
      holidayDates: ['2026-08-14'],
      onApprovedLeave: false,
      submitted: false,
    });
    expect(result).toMatchObject({ status: 'HOLIDAY', required: false });
  });

  it('marks approved leave on a working day and does not require an update', () => {
    const result = dayContext({
      isoDate: '2026-08-26',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: true,
      submitted: false,
    });
    expect(result).toMatchObject({ status: 'ON_LEAVE', required: false });
  });

  it('does not treat leave as On Leave when the date is already a weekend', () => {
    const result = dayContext({
      isoDate: '2026-08-23',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: true,
      submitted: false,
    });
    expect(result.status).toBe('WEEKEND');
    expect(result.required).toBe(false);
  });

  it('marks Saturday as weekend when it is not a working day', () => {
    const result = dayContext({
      isoDate: '2026-08-22',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: false,
      submitted: false,
    });
    expect(result).toMatchObject({ status: 'WEEKEND', required: false });
  });

  it('requires an update on Saturday when Saturday is a working day', () => {
    const result = dayContext({
      isoDate: '2026-08-22',
      workingDays: [...weekdays, 'SAT'],
      holidayDates: [],
      onApprovedLeave: false,
      submitted: false,
    });
    expect(result).toMatchObject({ status: 'MISSING', required: true });
  });

  it('marks a submitted working day as completed', () => {
    const result = dayContext({
      isoDate: '2026-08-25',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: false,
      submitted: true,
    });
    expect(result).toMatchObject({ status: 'COMPLETED', required: true });
  });

  it('marks a working day without a submission as missing', () => {
    const result = dayContext({
      isoDate: '2026-08-25',
      workingDays: weekdays,
      holidayDates: [],
      onApprovedLeave: false,
      submitted: false,
    });
    expect(result).toMatchObject({ status: 'MISSING', required: true });
  });

  it('marks a weekday off the org calendar as not required', () => {
    const result = dayContext({
      isoDate: '2026-08-26',
      workingDays: ['MON', 'TUE'],
      holidayDates: [],
      onApprovedLeave: false,
      submitted: false,
    });
    expect(result).toMatchObject({ status: 'NOT_REQUIRED', required: false });
  });

  it('uses the personal week pattern over org working days', () => {
    const result = dayContext({
      isoDate: '2026-08-22',
      workingDays: [...weekdays, 'SAT'],
      holidayDates: [],
      weekPattern: 'WEEKEND_OFF',
      onApprovedLeave: false,
      submitted: false,
    });
    expect(result).toMatchObject({ status: 'WEEKEND', required: false });
  });
});
