export type CompensationParts = {
  basic: number;
  da: number;
  hra: number;
  fuel: number;
  incentives: number;
  other: number;
  professionalTax: number;
  tds: number;
  employeeWelfare: number;
  kpi: number;
  otherDeductions: number;
};

export type LeaveParticulars = {
  cl: number;
  sl: number;
  ml: number;
  el: number;
  maternityPaternity: number;
  missPunch: number;
  permissionsCount: number;
  permissionHours: number;
  lateDays: number;
  absent: number;
  totalLop: number;
};

/** All compensation fields can be overridden on the calculate screen for this run. */
export const PAYROLL_ADJUSTABLE_KEYS = [
  'basic',
  'da',
  'hra',
  'fuel',
  'incentives',
  'other',
  'professionalTax',
  'tds',
  'employeeWelfare',
  'kpi',
  'otherDeductions',
] as const satisfies readonly (keyof CompensationParts)[];

export type PayrollAdjustableKey = (typeof PAYROLL_ADJUSTABLE_KEYS)[number];

export function mergeCompensation(
  base: CompensationParts,
  override?: Partial<Pick<CompensationParts, PayrollAdjustableKey>>,
): CompensationParts {
  if (!override) return base;
  return {
    basic: override.basic ?? base.basic,
    da: override.da ?? base.da,
    hra: override.hra ?? base.hra,
    fuel: override.fuel ?? base.fuel,
    incentives: override.incentives ?? base.incentives,
    other: override.other ?? base.other,
    professionalTax: override.professionalTax ?? base.professionalTax,
    tds: override.tds ?? base.tds,
    employeeWelfare: override.employeeWelfare ?? base.employeeWelfare,
    kpi: override.kpi ?? base.kpi,
    otherDeductions: override.otherDeductions ?? base.otherDeductions,
  };
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function grossPay(c: CompensationParts): number {
  return roundMoney(c.basic + c.da + c.hra + c.fuel + c.incentives + c.other);
}

/**
 * Monthly package stays the same for 28/29/30/31-day months.
 * Daily rate = monthly gross ÷ calendar days in the period.
 * When payable days equal the calendar month, pay the full monthly gross (no round-off residue).
 * Otherwise payable = daily rate × working days; non-working = monthly − payable (not LOP).
 * LOP amount = daily rate × final LOP days (attendance).
 * Net = payable − PT − TDS − Welfare − KPI − Other − LOP.
 */
export function calculateSlipMoney(input: {
  compensation: CompensationParts;
  calendarDays: number;
  workingDays: number;
  lopDays: number;
}): {
  monthlyGross: number;
  gross: number;
  dailyRate: number;
  nonWorkingDays: number;
  nonWorkingAmount: number;
  lopAmount: number;
  net: number;
  workingDays: number;
} {
  const monthlyGross = grossPay(input.compensation);
  const calendarDays = Math.max(1, input.calendarDays);
  const workingDays = Math.min(Math.max(0, input.workingDays), calendarDays);
  const nonWorkingDays = roundMoney(calendarDays - workingDays);
  const dailyRate = roundMoney(monthlyGross / calendarDays);

  let payableGross: number;
  let nonWorkingAmount: number;
  if (nonWorkingDays === 0) {
    // Full month: avoid dailyRate × days round-off (e.g. 52000/30 × 30 → 51999.90).
    payableGross = monthlyGross;
    nonWorkingAmount = 0;
  } else if (workingDays === 0) {
    payableGross = 0;
    nonWorkingAmount = monthlyGross;
  } else {
    payableGross = roundMoney(dailyRate * workingDays);
    nonWorkingAmount = roundMoney(monthlyGross - payableGross);
  }

  const lopAmount = roundMoney(dailyRate * input.lopDays);
  const deductions =
    input.compensation.professionalTax +
    input.compensation.tds +
    input.compensation.employeeWelfare +
    input.compensation.kpi +
    input.compensation.otherDeductions;
  const net = roundMoney(payableGross - deductions - lopAmount);
  return {
    monthlyGross,
    gross: monthlyGross,
    dailyRate,
    nonWorkingDays,
    nonWorkingAmount,
    lopAmount,
    net,
    workingDays,
  };
}

export function emptyParticulars(): LeaveParticulars {
  return {
    cl: 0,
    sl: 0,
    ml: 0,
    el: 0,
    maternityPaternity: 0,
    missPunch: 0,
    permissionsCount: 0,
    permissionHours: 0,
    lateDays: 0,
    absent: 0,
    totalLop: 0,
  };
}

export function leaveCodeBucket(code: string | null | undefined, name: string | null | undefined): keyof LeaveParticulars | null {
  const c = (code ?? '').toUpperCase();
  const n = (name ?? '').toLowerCase();
  if (c === 'CL' || n.includes('casual')) return 'cl';
  if (c === 'SL' || n.includes('sick')) return 'sl';
  if (c === 'EL' || n.includes('earned') || n.includes('privilege')) return 'el';
  if (c === 'ML' || n.includes('menstrual')) return 'ml';
  if (c === 'MAT' || c === 'PAT' || n.includes('maternity') || n.includes('paternity')) return 'maternityPaternity';
  return null;
}

export function durationDays(duration: string | null | undefined): number {
  return duration === 'half' ? 0.5 : 1;
}

export function snapshotPayment(input: {
  pan?: string | null;
  bankAccountNumber?: string | null;
  bankName?: string | null;
  ifsc?: string | null;
}): {
  panMasked: string | null;
  bankAccountMasked: string | null;
  bankNameMasked: string | null;
  ifscMasked: string | null;
} {
  const trim = (value: string | null | undefined) => {
    const next = value?.trim() ?? '';
    return next || null;
  };
  return {
    panMasked: trim(input.pan),
    bankAccountMasked: trim(input.bankAccountNumber),
    bankNameMasked: trim(input.bankName),
    ifscMasked: trim(input.ifsc),
  };
}
