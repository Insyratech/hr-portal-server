import { describe, expect, it } from 'vitest';
import { combineDateAndTime, deriveAttendance } from '../rule-engine';
import type { DeriveAttendanceResult, ShiftDefinition } from '../types';
import { proposeLop, untouchedFlagCount } from './lop-proposal';

const morning: ShiftDefinition = {
  startTime: '09:00',
  endTime: '18:00',
  minimumDurationMinutes: 540,
  gracePeriodMinutes: 10,
  lateThresholdMinutes: 60,
  earlyExitThresholdMinutes: 30,
  flexible: false,
};

const monSat = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function derive(isoDate: string, inn: string | null, out: string | null, leave = false) {
  return deriveAttendance({
    isoDate,
    workingDays: monSat,
    holidayDates: [],
    onApprovedLeave: leave,
    shift: morning,
    actualIn: inn ? combineDateAndTime(isoDate, inn) : null,
    actualOut: out ? combineDateAndTime(isoDate, out) : null,
  });
}

describe('proposeLop', () => {
  it('does not treat empty Sunday as LOP when Sunday is not a working day', () => {
    const derived = derive('2026-08-23', null, null);
    expect(derived.status).toBe('WEEK_OFF');
    const proposal = proposeLop({ derived, permissionMinutes: 0, leave: null });
    expect(proposal.skippedFromLop).toBe(true);
    expect(proposal.proposedLop).toBe(0);
    expect(proposal.needsHrDecision).toBe(false);
  });

  it('waits for HR on miss punch and never auto half-day', () => {
    const derived = derive('2026-08-24', '09:00', null);
    expect(derived.status).toBe('MISSING_PUNCH');
    const proposal = proposeLop({ derived, permissionMinutes: 120, leave: null });
    expect(proposal.needsHrDecision).toBe(true);
    expect(proposal.proposedLop).toBeNull();
    expect(proposal.hrAction).toBeNull();
  });

  it('proposes no LOP when 45m late is covered by 1h permission', () => {
    const derived = derive('2026-08-24', '09:55', '18:55');
    expect(derived.lateMinutes).toBe(45);
    const proposal = proposeLop({ derived, permissionMinutes: 60, leave: null });
    expect(proposal.needsHrDecision).toBe(false);
    expect(proposal.proposedLop).toBe(0);
    expect(proposal.permissionCovered).toBe(true);
  });

  it('asks HR when 45m late has 0 permission', () => {
    const derived = derive('2026-08-24', '09:55', '18:55');
    const proposal = proposeLop({ derived, permissionMinutes: 0, leave: null });
    expect(proposal.needsHrDecision).toBe(true);
    expect(proposal.proposedLop).toBeNull();
  });

  it('follows Saturday as a working day when it is in workingDays', () => {
    const derived = derive('2026-08-22', null, null);
    expect(derived.status).toBe('ABSENT');
    const proposal = proposeLop({ derived, permissionMinutes: 0, leave: null });
    expect(proposal.proposedLop).toBe(1);
    expect(proposal.skippedFromLop).toBe(false);
  });

  it('blocks confirm while a flagged day has no HR action', () => {
    expect(
      untouchedFlagCount([
        { needsHrDecision: true, hrAction: null },
        { needsHrDecision: false, hrAction: 'FULL_LOP' },
      ]),
    ).toBe(1);
    expect(untouchedFlagCount([{ needsHrDecision: true, hrAction: 'NO_LOP' }])).toBe(0);
  });

  it('skips holidays from LOP', () => {
    const derived = deriveAttendance({
      isoDate: '2026-08-15',
      workingDays: monSat,
      holidayDates: ['2026-08-15'],
      onApprovedLeave: false,
      shift: morning,
      actualIn: null,
      actualOut: null,
    });
    expect(derived.status).toBe('HOLIDAY');
    const proposal = proposeLop({ derived, permissionMinutes: 0, leave: null });
    expect(proposal.skippedFromLop).toBe(true);
    expect(proposal.proposedLop).toBe(0);
  });

  it('proposes no LOP for paid leave and full LOP for unpaid LOP leave', () => {
    const derived = derive('2026-08-24', null, null, true);
    expect(proposeLop({ derived, permissionMinutes: 0, leave: { typeName: 'Casual', paid: true, duration: 'full' } })).toMatchObject({
      proposedLop: 0,
      skippedFromLop: true,
      needsHrDecision: false,
    });
    expect(proposeLop({ derived, permissionMinutes: 0, leave: { typeName: 'LOP', paid: false, duration: 'full' } })).toMatchObject({
      proposedLop: 1,
      skippedFromLop: false,
      needsHrDecision: false,
    });
  });

  it('proposes half LOP for unpaid half-day leave', () => {
    const derived = derive('2026-08-24', null, null, true);
    expect(proposeLop({ derived, permissionMinutes: 0, leave: { typeName: 'LOP', paid: false, duration: 'half' } }).proposedLop).toBe(0.5);
  });

  it('treats Saturday as weekly off when it is not in working days', () => {
    const derived = deriveAttendance({
      isoDate: '2026-08-22',
      workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
      holidayDates: [],
      onApprovedLeave: false,
      shift: morning,
      actualIn: null,
      actualOut: null,
    });
    expect(derived.status).toBe('WEEK_OFF');
    expect(proposeLop({ derived, permissionMinutes: 0, leave: null }).skippedFromLop).toBe(true);
  });

  it('marks flexible short hours as half day or absent, never auto half for miss punch', () => {
    const flexible = {
      startTime: '09:00',
      endTime: '18:00',
      minimumDurationMinutes: 540,
      gracePeriodMinutes: 0,
      lateThresholdMinutes: 0,
      earlyExitThresholdMinutes: 0,
      flexible: true,
    };
    const half = deriveAttendance({
      isoDate: '2026-08-24',
      workingDays: monSat,
      holidayDates: [],
      onApprovedLeave: false,
      shift: flexible,
      actualIn: combineDateAndTime('2026-08-24', '09:00'),
      actualOut: combineDateAndTime('2026-08-24', '14:00'),
    });
    expect(half.status).toBe('HALF_DAY');
    expect(proposeLop({ derived: half, permissionMinutes: 0, leave: null }).proposedLop).toBe(0.5);

    const fullDay = deriveAttendance({
      isoDate: '2026-07-01',
      workingDays: monSat,
      holidayDates: [],
      onApprovedLeave: false,
      shift: flexible,
      actualIn: combineDateAndTime('2026-07-01', '08:56'),
      actualOut: combineDateAndTime('2026-07-01', '18:18'),
    });
    expect(fullDay.status).toBe('PRESENT');
    expect(fullDay.lateMinutes).toBe(0);
    expect(proposeLop({ derived: fullDay, permissionMinutes: 0, leave: null })).toMatchObject({
      needsHrDecision: false,
      proposedLop: 0,
      hrAction: 'NO_LOP',
    });

    const short = deriveAttendance({
      isoDate: '2026-08-24',
      workingDays: monSat,
      holidayDates: [],
      onApprovedLeave: false,
      shift: flexible,
      actualIn: combineDateAndTime('2026-08-24', '09:00'),
      actualOut: combineDateAndTime('2026-08-24', '12:00'),
    });
    expect(short.status).toBe('ABSENT');
    expect(proposeLop({ derived: short, permissionMinutes: 0, leave: null }).proposedLop).toBe(1);
  });

  it('covers early exit when permission is at end of shift', () => {
    const derived: DeriveAttendanceResult = {
      status: 'HALF_DAY',
      workedMinutes: 480,
      lateMinutes: 0,
      earlyExitMinutes: 60,
      overtimeMinutes: 0,
      scheduledIn: null,
      scheduledOut: null,
    };
    const proposal = proposeLop({
      derived,
      permissionMinutes: 60,
      permissionSlot: 'END',
      leave: null,
    });
    expect(proposal.permissionCovered).toBe(true);
    expect(proposal.proposedLop).toBe(0);
    expect(proposal.needsHrDecision).toBe(false);
  });
});
