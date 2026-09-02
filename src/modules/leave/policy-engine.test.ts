import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { countLeaveQuantity, serviceDays } from './day-count';
import { isEligible, validateApplication } from './policy-engine';
import type { ApplicationInput, LeaveTypeFlags, PolicyRules } from './types';

const workingDays = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

const flags: LeaveTypeFlags = {
  active: true,
  requiresApproval: true,
  requiresHandover: true,
  requiresAttachment: false,
  allowHalfDay: true,
  allowMultipleDays: true,
};

const casual: PolicyRules = {
  noticePeriod: { value: 24, unit: 'hours' },
  requiresApproval: true,
  requiresHandover: true,
  requiresAttachment: false,
  allowHalfDay: true,
  allowNegativeBalance: false,
  minimumServiceDays: 0,
  maximumConsecutiveDays: 3,
  annualAllocation: 12,
  carryForward: 0,
  employmentTypes: null,
  departmentIds: null,
  designationIds: null,
};

const earned: PolicyRules = {
  ...casual,
  requiresHandover: false,
  minimumServiceDays: 365,
  annualAllocation: 18,
  maximumConsecutiveDays: null,
};

function baseInput(overrides: Partial<ApplicationInput> = {}): ApplicationInput {
  return {
    startDate: '2026-08-24',
    endDate: '2026-08-24',
    duration: 'full',
    handover: 'Alex',
    now: new Date('2026-08-21T00:00:00.000Z'),
    joiningDate: '2025-08-12',
    employmentType: 'full_time',
    departmentId: null,
    designationId: null,
    employeeStatus: 'active',
    available: 12,
    overlapping: false,
    workingDays,
    holidayDates: ['2026-08-15'],
    ...overrides,
  };
}

describe('day-count', () => {
  it('skips weekends using configurable working days, not hardcoded Saturday/Sunday', () => {
    expect(
      countLeaveQuantity({
        startDate: '2026-08-26',
        endDate: '2026-08-28',
        duration: 'full',
        workingDays,
        holidayDates: [],
      }),
    ).toBe(3);
  });

  it('skips holidays', () => {
    expect(
      countLeaveQuantity({
        startDate: '2026-08-14',
        endDate: '2026-08-17',
        duration: 'full',
        workingDays,
        holidayDates: ['2026-08-15'],
      }),
    ).toBe(2);
  });

  it('counts 2nd and 4th Saturday as week off when that pattern is set', () => {
    expect(
      countLeaveQuantity({
        startDate: '2026-08-08',
        endDate: '2026-08-08',
        duration: 'full',
        workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
        holidayDates: [],
        weekPatternForDate: () => 'SECOND_FOURTH_SATURDAY',
      }),
    ).toBe(0);
    expect(
      countLeaveQuantity({
        startDate: '2026-08-15',
        endDate: '2026-08-15',
        duration: 'full',
        workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
        holidayDates: [],
        weekPatternForDate: () => 'SECOND_FOURTH_SATURDAY',
      }),
    ).toBe(1);
  });

  it('counts half-day as 0.5', () => {
    expect(
      countLeaveQuantity({
        startDate: '2026-08-21',
        endDate: '2026-08-21',
        duration: 'half',
        workingDays,
        holidayDates: [],
      }),
    ).toBe(0.5);
  });
});

describe('eligibility', () => {
  it('treats 374 days tenure as eligible for earned leave', () => {
    expect(
      isEligible({
        rules: earned,
        joiningDate: '2025-08-12',
        now: new Date('2026-08-21T00:00:00.000Z'),
        employmentType: 'full_time',
        departmentId: null,
        designationId: null,
      }),
    ).toBe(true);
    expect(serviceDays('2025-08-12', new Date('2026-08-21T00:00:00.000Z'))).toBe(374);
  });

  it('treats 232 days tenure as ineligible when policy requires 365', () => {
    expect(
      isEligible({
        rules: earned,
        joiningDate: '2026-01-01',
        now: new Date('2026-08-21T00:00:00.000Z'),
        employmentType: 'full_time',
        departmentId: null,
        designationId: null,
      }),
    ).toBe(false);
    expect(serviceDays('2026-01-01', new Date('2026-08-21T00:00:00.000Z'))).toBe(232);
  });
});

describe('validateApplication', () => {
  it('returns NOT_ELIGIBLE for earned leave under 365 days', () => {
    const result = validateApplication(flags, earned, baseInput({ joiningDate: '2026-01-01' }));
    expect(result.valid).toBe(false);
    expect(result.violations.some((item) => item.code === API_ERROR_CODES.NOT_ELIGIBLE)).toBe(true);
  });

  it('returns NOTICE_PERIOD_NOT_MET when applying too late', () => {
    const result = validateApplication(
      flags,
      casual,
      baseInput({ startDate: '2026-08-21', endDate: '2026-08-21', now: new Date('2026-08-21T12:00:00.000Z') }),
    );
    expect(result.violations.some((item) => item.code === API_ERROR_CODES.NOTICE_PERIOD_NOT_MET)).toBe(true);
  });

  it('returns LEAVE_OVERLAP when another application exists', () => {
    const result = validateApplication(flags, casual, baseInput({ overlapping: true }));
    expect(result.violations.some((item) => item.code === API_ERROR_CODES.LEAVE_OVERLAP)).toBe(true);
  });

  it('returns HOLIDAY_OR_WEEKEND when quantity is zero', () => {
    const result = validateApplication(
      flags,
      casual,
      baseInput({ startDate: '2026-08-15', endDate: '2026-08-15' }),
    );
    expect(result.violations.some((item) => item.code === API_ERROR_CODES.HOLIDAY_OR_WEEKEND)).toBe(true);
  });

  it('returns HANDOVER_REQUIRED when handover is missing', () => {
    const result = validateApplication(flags, casual, baseInput({ handover: '' }));
    expect(result.violations.some((item) => item.code === API_ERROR_CODES.HANDOVER_REQUIRED)).toBe(true);
  });

  it('returns MAX_CONSECUTIVE_DAYS_EXCEEDED', () => {
    const result = validateApplication(
      flags,
      casual,
      baseInput({ startDate: '2026-08-24', endDate: '2026-08-28' }),
    );
    expect(result.quantity).toBe(5);
    expect(result.violations.some((item) => item.code === API_ERROR_CODES.MAX_CONSECUTIVE_DAYS_EXCEEDED)).toBe(
      true,
    );
  });

  it('returns INSUFFICIENT_LEAVE_BALANCE unless LOP allows negative', () => {
    const result = validateApplication(flags, casual, baseInput({ available: 0 }));
    expect(result.violations.some((item) => item.code === API_ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE)).toBe(
      true,
    );
    const lop = validateApplication(flags, { ...casual, allowNegativeBalance: true }, baseInput({ available: 0 }));
    expect(lop.violations.some((item) => item.code === API_ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE)).toBe(false);
  });

  it('returns LEAVE_TOO_FAR_IN_ADVANCE when start date is more than one month ahead', () => {
    const now = new Date('2026-10-03T00:00:00.000Z');
    const result = validateApplication(
      flags,
      casual,
      baseInput({ startDate: '2026-12-01', endDate: '2026-12-01', now }),
    );
    expect(result.violations.some((item) => item.code === API_ERROR_CODES.LEAVE_TOO_FAR_IN_ADVANCE)).toBe(true);
  });

  it('allows leave starting within one month from today', () => {
    const now = new Date('2026-10-03T00:00:00.000Z');
    const result = validateApplication(
      flags,
      { ...casual, noticePeriod: { value: 0, unit: 'hours' } },
      baseInput({ startDate: '2026-11-03', endDate: '2026-11-03', now }),
    );
    expect(result.violations.some((item) => item.code === API_ERROR_CODES.LEAVE_TOO_FAR_IN_ADVANCE)).toBe(false);
  });

  it('skips advance booking window when enforceAdvanceBookingWindow is false', () => {
    const now = new Date('2026-10-03T00:00:00.000Z');
    const result = validateApplication(
      flags,
      { ...casual, noticePeriod: { value: 0, unit: 'hours' } },
      baseInput({
        startDate: '2027-01-15',
        endDate: '2027-01-15',
        now,
        enforceAdvanceBookingWindow: false,
      }),
    );
    expect(result.violations.some((item) => item.code === API_ERROR_CODES.LEAVE_TOO_FAR_IN_ADVANCE)).toBe(false);
  });

  it('accepts a valid casual leave request', () => {
    const result = validateApplication(flags, casual, baseInput());
    expect(result.valid).toBe(true);
    expect(result.quantity).toBe(1);
    expect(result.requiresApproval).toBe(true);
  });
});
