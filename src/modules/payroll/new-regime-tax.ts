/**
 * Income tax — New Regime, FY 2026-27 (Apr–Mar).
 * Used only by the Sandip payslip playground until production cutover.
 */

import { roundMoney } from './calc';

export const NEW_REGIME_FY_LABEL = '2026-27';

export const NEW_REGIME_STANDARD_DEDUCTION = 75_000;
export const NEW_REGIME_87A_INCOME_LIMIT = 12_00_000;
export const NEW_REGIME_87A_MAX_REBATE = 60_000;
export const NEW_REGIME_CESS_RATE = 0.04;

export type TaxSlab = {
  from: number;
  to: number | null;
  rate: number;
  label: string;
};

export const NEW_REGIME_SLABS: readonly TaxSlab[] = [
  { from: 0, to: 4_00_000, rate: 0, label: '0 – 4 lakh' },
  { from: 4_00_000, to: 8_00_000, rate: 0.05, label: '4 – 8 lakh' },
  { from: 8_00_000, to: 12_00_000, rate: 0.1, label: '8 – 12 lakh' },
  { from: 12_00_000, to: 16_00_000, rate: 0.15, label: '12 – 16 lakh' },
  { from: 16_00_000, to: 20_00_000, rate: 0.2, label: '16 – 20 lakh' },
  { from: 20_00_000, to: 24_00_000, rate: 0.25, label: '20 – 24 lakh' },
  { from: 24_00_000, to: null, rate: 0.3, label: 'Above 24 lakh' },
];

/** Surcharge on tax after rebate (new regime cap 25%). */
export const NEW_REGIME_SURCHARGE: readonly { above: number; rate: number }[] = [
  { above: 2_00_00_000, rate: 0.25 },
  { above: 1_00_00_000, rate: 0.15 },
  { above: 50_00_000, rate: 0.1 },
];

export type SlabTaxRow = {
  label: string;
  from: number;
  to: number | null;
  rate: number;
  taxableInSlab: number;
  tax: number;
};

/** Round taxable income to nearest ₹10 (Form 16 style). */
export function roundTaxableIncome(value: number): number {
  return Math.round(value / 10) * 10;
}

export function taxOnSlabs(taxableIncome: number): { tax: number; rows: SlabTaxRow[] } {
  const income = Math.max(0, taxableIncome);
  const rows: SlabTaxRow[] = [];
  let tax = 0;
  for (const slab of NEW_REGIME_SLABS) {
    const upper = slab.to ?? Number.POSITIVE_INFINITY;
    const band = Math.max(0, Math.min(income, upper) - slab.from);
    const slabTax = roundMoney(band * slab.rate);
    rows.push({
      label: slab.label,
      from: slab.from,
      to: slab.to,
      rate: slab.rate,
      taxableInSlab: roundMoney(band),
      tax: slabTax,
    });
    tax = roundMoney(tax + slabTax);
  }
  return { tax, rows };
}

export function rebate87A(taxableIncome: number, taxBeforeRebate: number): number {
  if (taxableIncome <= NEW_REGIME_87A_INCOME_LIMIT) {
    return roundMoney(Math.min(taxBeforeRebate, NEW_REGIME_87A_MAX_REBATE));
  }
  return 0;
}

/**
 * Marginal relief when income is just above ₹12 lakh:
 * tax after rebate cannot exceed (taxableIncome − 12L).
 */
export function applyMarginalRelief(
  taxableIncome: number,
  taxAfterRebate: number,
): number {
  if (taxableIncome <= NEW_REGIME_87A_INCOME_LIMIT) return taxAfterRebate;
  const cap = roundMoney(Math.max(0, taxableIncome - NEW_REGIME_87A_INCOME_LIMIT));
  return roundMoney(Math.min(taxAfterRebate, cap));
}

export function surchargeRate(taxableIncome: number): number {
  for (const band of NEW_REGIME_SURCHARGE) {
    if (taxableIncome > band.above) return band.rate;
  }
  return 0;
}

export type AnnualTaxInput = {
  /** Projected / annual gross salary (before standard deduction). */
  annualGrossSalary: number;
  otherIncome?: number;
  relief89?: number;
  taxDeductedTillPreviousMonth?: number;
  monthsLeftIncludingThis?: number;
};

export type AnnualTaxResult = {
  annualGrossSalary: number;
  standardDeduction: number;
  otherIncome: number;
  taxableIncome: number;
  taxOnTotalIncome: number;
  slabRows: SlabTaxRow[];
  rebate87A: number;
  taxAfterRebate: number;
  surchargeRate: number;
  surcharge: number;
  cess: number;
  taxBeforeRelief89: number;
  relief89: number;
  netAnnualTax: number;
  taxDeductedTillPreviousMonth: number;
  balanceTax: number;
  monthsLeftIncludingThis: number;
  tdsThisMonth: number;
  taxRemainingAfterThisMonth: number;
};

/**
 * Annual salary projection for TDS:
 * YTD earnings
 * + gap fill for expected prior FY months with no published slip (mid-year / missing months)
 * + this month (incl. variable/bonus, after LOP)
 * + (months left − 1) × fixed monthly.
 * Incentives / bonus are not projected into future months.
 * `monthsLeftIncludingThis` is clamped to ≥ 1 (never divide by zero).
 */
export function projectAnnualGrossSalary(input: {
  ytdEarnings: number;
  thisMonthEarnings: number;
  fixedMonthly: number;
  monthsLeftIncludingThis: number;
  /** Expected prior months (on/after join) with no published slip. */
  missingPriorMonths?: number;
}): number {
  const monthsLeft = Math.max(1, Math.floor(input.monthsLeftIncludingThis));
  const remainingAfterThis = Math.max(0, monthsLeft - 1);
  const missingPrior = Math.max(0, Math.floor(input.missingPriorMonths ?? 0));
  const fixed = Math.max(0, input.fixedMonthly);
  return roundMoney(
    Math.max(0, input.ytdEarnings) +
      missingPrior * fixed +
      Math.max(0, input.thisMonthEarnings) +
      remainingAfterThis * fixed,
  );
}

export function computeNewRegimeAnnualTax(input: AnnualTaxInput): AnnualTaxResult {
  const annualGrossSalary = roundMoney(Math.max(0, input.annualGrossSalary));
  const otherIncome = roundMoney(Math.max(0, input.otherIncome ?? 0));
  const relief89 = roundMoney(Math.max(0, input.relief89 ?? 0));
  const taxDeductedTillPreviousMonth = roundMoney(Math.max(0, input.taxDeductedTillPreviousMonth ?? 0));
  const monthsLeftIncludingThis = Math.max(1, Math.floor(input.monthsLeftIncludingThis ?? 1));

  const afterStd = Math.max(0, annualGrossSalary - NEW_REGIME_STANDARD_DEDUCTION);
  const taxableIncome = roundTaxableIncome(afterStd + otherIncome);

  const { tax: taxOnTotalIncome, rows: slabRows } = taxOnSlabs(taxableIncome);
  const rebate = rebate87A(taxableIncome, taxOnTotalIncome);
  let taxAfterRebate = roundMoney(Math.max(0, taxOnTotalIncome - rebate));
  taxAfterRebate = applyMarginalRelief(taxableIncome, taxAfterRebate);

  const sRate = surchargeRate(taxableIncome);
  const surcharge = roundMoney(taxAfterRebate * sRate);
  const taxPlusSurcharge = roundMoney(taxAfterRebate + surcharge);
  const cess = roundMoney(taxPlusSurcharge * NEW_REGIME_CESS_RATE);
  const taxBeforeRelief89 = roundMoney(taxPlusSurcharge + cess);
  const netAnnualTax = roundMoney(Math.max(0, taxBeforeRelief89 - relief89));

  const balanceTax = roundMoney(Math.max(0, netAnnualTax - taxDeductedTillPreviousMonth));
  const tdsThisMonth = roundMoney(balanceTax / monthsLeftIncludingThis);
  const taxRemainingAfterThisMonth = roundMoney(Math.max(0, balanceTax - tdsThisMonth));

  return {
    annualGrossSalary,
    standardDeduction: NEW_REGIME_STANDARD_DEDUCTION,
    otherIncome,
    taxableIncome,
    taxOnTotalIncome,
    slabRows,
    rebate87A: rebate,
    taxAfterRebate,
    surchargeRate: sRate,
    surcharge,
    cess,
    taxBeforeRelief89,
    relief89,
    netAnnualTax,
    taxDeductedTillPreviousMonth,
    balanceTax,
    monthsLeftIncludingThis,
    tdsThisMonth,
    taxRemainingAfterThisMonth,
  };
}

/** Apr = 1 … Mar = 12 for a calendar month 1–12. */
export function fyMonthIndex(calendarMonth: number): number {
  if (calendarMonth < 1 || calendarMonth > 12) {
    throw new Error('calendarMonth must be 1–12');
  }
  return calendarMonth >= 4 ? calendarMonth - 3 : calendarMonth + 9;
}

/** Months left in FY including the given calendar month. */
export function monthsLeftInFy(calendarMonth: number): number {
  return 13 - fyMonthIndex(calendarMonth);
}

/**
 * FY label and April start year for a calendar period `YYYY-MM`.
 * Oct 2026 → FY 2026-27, start year 2026.
 * Feb 2027 → FY 2026-27, start year 2026.
 */
export function financialYearForPeriod(periodKey: string): {
  label: string;
  startYear: number;
  startPeriod: string;
  endPeriod: string;
} {
  const match = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (!match) throw new Error(`Invalid period ${periodKey}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const startYear = month >= 4 ? year : year - 1;
  return {
    label: `${startYear}-${String(startYear + 1).slice(-2)}`,
    startYear,
    startPeriod: `${startYear}-04`,
    endPeriod: `${startYear + 1}-03`,
  };
}

export function periodsInFyBefore(periodKey: string): string[] {
  const fy = financialYearForPeriod(periodKey);
  const out: string[] = [];
  let y = fy.startYear;
  let m = 4;
  while (true) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key >= periodKey) break;
    out.push(key);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (key === fy.endPeriod) break;
  }
  return out;
}
