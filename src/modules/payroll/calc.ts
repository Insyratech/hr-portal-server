import { maskSecret } from '../employees/payment-mask';

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

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function grossPay(c: CompensationParts): number {
  return roundMoney(c.basic + c.da + c.hra + c.fuel + c.incentives + c.other);
}

/**
 * Daily rate = Gross ÷ calendar days in the period.
 * LOP amount = daily rate × final LOP days.
 * Net = Gross − PT − TDS − Welfare − KPI − Other − LOP amount.
 */
export function calculateSlipMoney(input: {
  compensation: CompensationParts;
  calendarDays: number;
  lopDays: number;
}): {
  gross: number;
  dailyRate: number;
  lopAmount: number;
  net: number;
} {
  const gross = grossPay(input.compensation);
  const days = Math.max(1, input.calendarDays);
  const dailyRate = roundMoney(gross / days);
  const lopAmount = roundMoney(dailyRate * input.lopDays);
  const deductions =
    input.compensation.professionalTax +
    input.compensation.tds +
    input.compensation.employeeWelfare +
    input.compensation.kpi +
    input.compensation.otherDeductions;
  const net = roundMoney(gross - deductions - lopAmount);
  return { gross, dailyRate, lopAmount, net };
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
  return {
    panMasked: maskSecret(input.pan),
    bankAccountMasked: maskSecret(input.bankAccountNumber),
    bankNameMasked: input.bankName?.trim() ? '••••' : null,
    ifscMasked: maskSecret(input.ifsc),
  };
}
