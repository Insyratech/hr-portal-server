import type { PolicyRules } from './types';

type RawRules = Record<string, unknown>;

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

export function parsePolicyRules(raw: unknown): PolicyRules {
  const source = (raw && typeof raw === 'object' ? raw : {}) as RawRules;
  const notice = (source.notice_period as RawRules | undefined) ?? {};
  const eligibility = (source.eligibility as RawRules | undefined) ?? {};
  const unit = notice.unit === 'days' ? 'days' : 'hours';

  return {
    noticePeriod: {
      value: asNumber(notice.value, 0),
      unit,
    },
    requiresApproval: asBoolean(source.requires_approval, true),
    requiresHandover: asBoolean(source.requires_handover, false),
    requiresAttachment: asBoolean(source.requires_attachment, false),
    allowHalfDay: asBoolean(source.allow_half_day, true),
    allowNegativeBalance: asBoolean(source.allow_negative_balance, false),
    minimumServiceDays: asNumber(
      eligibility.minimum_service_days ?? source.minimum_service_days,
      0,
    ),
    maximumConsecutiveDays:
      source.maximum_consecutive_days === null
        ? null
        : asNumber(source.maximum_consecutive_days, 0) || null,
    annualAllocation: asNumber(source.annual_allocation, 0),
    carryForward: asNumber(source.carry_forward, 0),
    employmentTypes: asStringArray(eligibility.employment_types ?? source.employment_types),
    departmentIds: asStringArray(eligibility.department_ids ?? source.department_ids),
    designationIds: asStringArray(eligibility.designation_ids ?? source.designation_ids),
  };
}

export function serializePolicyRules(rules: PolicyRules): Record<string, unknown> {
  return {
    notice_period: { value: rules.noticePeriod.value, unit: rules.noticePeriod.unit },
    requires_approval: rules.requiresApproval,
    requires_handover: rules.requiresHandover,
    requires_attachment: rules.requiresAttachment,
    allow_half_day: rules.allowHalfDay,
    allow_negative_balance: rules.allowNegativeBalance,
    minimum_service_days: rules.minimumServiceDays,
    maximum_consecutive_days: rules.maximumConsecutiveDays,
    annual_allocation: rules.annualAllocation,
    carry_forward: rules.carryForward,
    eligibility: {
      minimum_service_days: rules.minimumServiceDays,
      employment_types: rules.employmentTypes,
      department_ids: rules.departmentIds,
      designation_ids: rules.designationIds,
    },
  };
}
