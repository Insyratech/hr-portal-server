import { describe, expect, it } from 'vitest';
import { combineDateAndTime, deriveAttendance } from './rule-engine';
import type { ShiftDefinition } from './types';

const workingDays = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

const flexible: ShiftDefinition = {
  startTime: '08:00',
  endTime: '20:00',
  minimumDurationMinutes: 540,
  gracePeriodMinutes: 0,
  lateThresholdMinutes: 0,
  earlyExitThresholdMinutes: 0,
  flexible: true,
};

const morning: ShiftDefinition = {
  startTime: '08:00',
  endTime: '17:00',
  minimumDurationMinutes: 540,
  gracePeriodMinutes: 10,
  lateThresholdMinutes: 60,
  earlyExitThresholdMinutes: 30,
  flexible: false,
};

describe('deriveAttendance', () => {
  it('marks flexible 10:42–19:42 with 540m requirement as PRESENT', () => {
    const result = deriveAttendance({
      isoDate: '2026-08-21',
      workingDays,
      holidayDates: [],
      onApprovedLeave: false,
      shift: flexible,
      actualIn: combineDateAndTime('2026-08-21', '10:42'),
      actualOut: combineDateAndTime('2026-08-21', '19:42'),
    });
    expect(result.workedMinutes).toBe(540);
    expect(result.status).toBe('PRESENT');
  });

  it('marks fixed shift late beyond grace as LATE', () => {
    const result = deriveAttendance({
      isoDate: '2026-08-21',
      workingDays,
      holidayDates: [],
      onApprovedLeave: false,
      shift: morning,
      actualIn: combineDateAndTime('2026-08-21', '08:25'),
      actualOut: combineDateAndTime('2026-08-21', '17:25'),
    });
    expect(result.workedMinutes).toBe(540);
    expect(result.lateMinutes).toBe(15);
    expect(result.status).toBe('LATE');
  });

  it('marks approved leave as LEAVE and not PRESENT even with punches', () => {
    const result = deriveAttendance({
      isoDate: '2026-08-21',
      workingDays,
      holidayDates: [],
      onApprovedLeave: true,
      shift: morning,
      actualIn: combineDateAndTime('2026-08-21', '09:00'),
      actualOut: combineDateAndTime('2026-08-21', '18:00'),
    });
    expect(result.status).toBe('LEAVE');
  });

  it('marks punch-in without punch-out as MISSING_PUNCH', () => {
    const result = deriveAttendance({
      isoDate: '2026-08-21',
      workingDays,
      holidayDates: [],
      onApprovedLeave: false,
      shift: morning,
      actualIn: combineDateAndTime('2026-08-21', '08:00'),
      actualOut: null,
    });
    expect(result.status).toBe('MISSING_PUNCH');
  });

  it('marks holidays and week-offs', () => {
    expect(
      deriveAttendance({
        isoDate: '2026-08-15',
        workingDays,
        holidayDates: ['2026-08-15'],
        onApprovedLeave: false,
        shift: morning,
        actualIn: null,
        actualOut: null,
      }).status,
    ).toBe('HOLIDAY');

    expect(
      deriveAttendance({
        isoDate: '2026-08-22',
        workingDays,
        holidayDates: [],
        onApprovedLeave: false,
        shift: morning,
        actualIn: null,
        actualOut: null,
      }).status,
    ).toBe('WEEK_OFF');
  });

  it('marks no punches on a working day as ABSENT', () => {
    expect(
      deriveAttendance({
        isoDate: '2026-08-21',
        workingDays,
        holidayDates: [],
        onApprovedLeave: false,
        shift: morning,
        actualIn: null,
        actualOut: null,
      }).status,
    ).toBe('ABSENT');
  });
});
