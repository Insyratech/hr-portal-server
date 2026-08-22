import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { countLeaveQuantity, parseIsoDate, serviceDays } from './day-count';
import type { ApplicationInput, EngineResult, LeaveTypeFlags, PolicyRules, Violation } from './types';

function add(violations: Violation[], code: string, message: string): void {
  violations.push({ code, message });
}

export function isEligible(input: {
  rules: PolicyRules;
  joiningDate: string;
  now: Date;
  employmentType: string;
  departmentId: string | null;
  designationId: string | null;
}): boolean {
  if (serviceDays(input.joiningDate, input.now) < input.rules.minimumServiceDays) {
    return false;
  }
  if (input.rules.employmentTypes && !input.rules.employmentTypes.includes(input.employmentType)) {
    return false;
  }
  if (input.rules.departmentIds && (!input.departmentId || !input.rules.departmentIds.includes(input.departmentId))) {
    return false;
  }
  if (input.rules.designationIds && (!input.designationId || !input.rules.designationIds.includes(input.designationId))) {
    return false;
  }
  return true;
}

export function validateApplication(
  flags: LeaveTypeFlags,
  rules: PolicyRules,
  input: ApplicationInput,
): EngineResult {
  const violations: Violation[] = [];
  const requiresApproval = flags.requiresApproval || rules.requiresApproval;
  const requiresHandover = flags.requiresHandover || rules.requiresHandover;
  const requiresAttachment = flags.requiresAttachment || rules.requiresAttachment;
  const allowHalfDay = flags.allowHalfDay && rules.allowHalfDay;

  if (!flags.active) {
    add(violations, API_ERROR_CODES.VALIDATION_ERROR, 'This leave type is not active.');
  }

  if (input.employeeStatus !== 'active') {
    add(violations, API_ERROR_CODES.FORBIDDEN, 'Inactive employees cannot apply for leave.');
  }

  const start = parseIsoDate(input.startDate);
  const end = parseIsoDate(input.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    add(violations, API_ERROR_CODES.VALIDATION_ERROR, 'Leave dates are invalid.');
  }

  if (input.duration === 'half' && input.startDate !== input.endDate) {
    add(violations, API_ERROR_CODES.VALIDATION_ERROR, 'Half-day leave must be a single date.');
  }

  if (input.duration === 'half' && !allowHalfDay) {
    add(violations, API_ERROR_CODES.VALIDATION_ERROR, 'Half-day leave is not allowed for this type.');
  }

  if (input.startDate !== input.endDate && !flags.allowMultipleDays) {
    add(violations, API_ERROR_CODES.VALIDATION_ERROR, 'Multiple-day leave is not allowed for this type.');
  }

  if (!isEligible({ rules, ...input })) {
    add(violations, API_ERROR_CODES.NOT_ELIGIBLE, 'You are not eligible for this leave type.');
  }

  const quantity = countLeaveQuantity({
    startDate: input.startDate,
    endDate: input.endDate,
    duration: input.duration,
    workingDays: input.workingDays,
    holidayDates: input.holidayDates,
  });

  if (quantity <= 0) {
    add(
      violations,
      API_ERROR_CODES.HOLIDAY_OR_WEEKEND,
      'Selected dates are not working days for this organisation.',
    );
  }

  if (rules.maximumConsecutiveDays !== null && quantity > rules.maximumConsecutiveDays) {
    add(
      violations,
      API_ERROR_CODES.MAX_CONSECUTIVE_DAYS_EXCEEDED,
      `Maximum consecutive leave is ${rules.maximumConsecutiveDays} day(s).`,
    );
  }

  const hoursUntilStart = (start.getTime() - input.now.getTime()) / 3_600_000;
  const noticeHours =
    rules.noticePeriod.unit === 'days' ? rules.noticePeriod.value * 24 : rules.noticePeriod.value;
  if (noticeHours > 0 && hoursUntilStart < noticeHours) {
    add(
      violations,
      API_ERROR_CODES.NOTICE_PERIOD_NOT_MET,
      `This leave requires ${rules.noticePeriod.value} ${rules.noticePeriod.unit} notice.`,
    );
  }

  if (!rules.allowNegativeBalance && quantity > input.available) {
    add(violations, API_ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE, 'Insufficient leave balance.');
  }

  if (input.overlapping) {
    add(violations, API_ERROR_CODES.LEAVE_OVERLAP, 'This request overlaps another leave application.');
  }

  if (requiresHandover && !input.handoverEmployeeId && !input.handover?.trim()) {
    add(violations, API_ERROR_CODES.HANDOVER_REQUIRED, 'Handover is required for this leave.');
  }

  if (requiresAttachment && !input.attachmentUrl?.trim()) {
    add(violations, API_ERROR_CODES.ATTACHMENT_REQUIRED, 'An attachment is required for this leave.');
  }

  return {
    valid: violations.length === 0,
    violations,
    quantity,
    requiresApproval,
    requiresHandover,
    requiresAttachment,
  };
}
