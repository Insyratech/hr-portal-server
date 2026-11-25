import { describe, expect, it } from 'vitest';
import {
  applyMarginalRelief,
  computeNewRegimeAnnualTax,
  financialYearForPeriod,
  fyMonthIndex,
  monthsLeftInFy,
  periodsInFyBefore,
  projectAnnualGrossSalary,
  rebate87A,
  roundTaxableIncome,
  surchargeRate,
  taxOnSlabs,
} from './new-regime-tax';

describe('fy helpers', () => {
  it('maps calendar months to FY index Apr=1 … Mar=12', () => {
    expect(fyMonthIndex(4)).toBe(1);
    expect(fyMonthIndex(10)).toBe(7);
    expect(fyMonthIndex(3)).toBe(12);
  });

  it('counts months left including this month', () => {
    expect(monthsLeftInFy(4)).toBe(12);
    expect(monthsLeftInFy(10)).toBe(6);
    expect(monthsLeftInFy(3)).toBe(1);
  });

  it('resolves FY label and periods for a calendar month', () => {
    expect(financialYearForPeriod('2026-10')).toEqual({
      label: '2026-27',
      startYear: 2026,
      startPeriod: '2026-04',
      endPeriod: '2027-03',
    });
    expect(financialYearForPeriod('2027-02').label).toBe('2026-27');
  });

  it('lists FY periods strictly before the playground month', () => {
    expect(periodsInFyBefore('2026-10')).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    expect(periodsInFyBefore('2026-04')).toEqual([]);
  });
});

describe('projectAnnualGrossSalary', () => {
  it('adds YTD + this month + remaining fixed months (no forward incentives)', () => {
    // Oct: 6 months left → 5 future months × fixed only
    expect(
      projectAnnualGrossSalary({
        ytdEarnings: 3_00_000,
        thisMonthEarnings: 62_000, // includes incentives this month
        fixedMonthly: 52_000,
        monthsLeftIncludingThis: 6,
      }),
    ).toBe(3_00_000 + 62_000 + 5 * 52_000);
  });

  it('does not project beyond the current month when monthsLeft is 1', () => {
    expect(
      projectAnnualGrossSalary({
        ytdEarnings: 10_00_000,
        thisMonthEarnings: 50_000,
        fixedMonthly: 50_000,
        monthsLeftIncludingThis: 1,
      }),
    ).toBe(10_50_000);
  });

  it('fills missing prior months at fixed pay (mid-year / unpublished gaps)', () => {
    expect(
      projectAnnualGrossSalary({
        ytdEarnings: 52_000,
        thisMonthEarnings: 52_000,
        fixedMonthly: 52_000,
        monthsLeftIncludingThis: 6,
        missingPriorMonths: 2,
      }),
    ).toBe(52_000 + 2 * 52_000 + 52_000 + 5 * 52_000);
  });
});

describe('taxOnSlabs / 87A / surcharge', () => {
  it('zeros tax in the nil slab', () => {
    expect(taxOnSlabs(3_50_000).tax).toBe(0);
  });

  it('taxes the 4–8L band at 5%', () => {
    expect(taxOnSlabs(5_00_000).tax).toBe(5_000);
  });

  it('Excel ~₹5.63L taxable → full 87A → annual tax and TDS 0', () => {
    // annualGross 6,38,000 − std 75,000 = taxable 5,63,000
    const annualGross = 6_38_000;
    const result = computeNewRegimeAnnualTax({
      annualGrossSalary: annualGross,
      monthsLeftIncludingThis: 6,
      taxDeductedTillPreviousMonth: 0,
    });
    expect(result.taxableIncome).toBe(5_63_000);
    // 4L @0 + 1.63L @5% = 8,150
    expect(result.taxOnTotalIncome).toBe(8_150);
    expect(result.rebate87A).toBe(8_150);
    expect(result.taxAfterRebate).toBe(0);
    expect(result.cess).toBe(0);
    expect(result.netAnnualTax).toBe(0);
    expect(result.tdsThisMonth).toBe(0);
  });

  it('rebates up to 60k when income ≤ 12L', () => {
    const tax = taxOnSlabs(12_00_000).tax;
    expect(rebate87A(12_00_000, tax)).toBe(Math.min(tax, 60_000));
    expect(rebate87A(12_00_010, tax)).toBe(0);
  });

  it('applies marginal relief just above 12L', () => {
    const income = 12_10_000;
    const raw = taxOnSlabs(income).tax;
    const relieved = applyMarginalRelief(income, raw);
    expect(relieved).toBe(10_000);
    expect(relieved).toBeLessThan(raw);
  });

  it('rounds taxable income to nearest ₹10', () => {
    expect(roundTaxableIncome(5_63_004)).toBe(5_63_000);
    expect(roundTaxableIncome(5_63_005)).toBe(5_63_010);
  });

  it('applies surcharge bands on taxable income', () => {
    expect(surchargeRate(40_00_000)).toBe(0);
    expect(surchargeRate(60_00_000)).toBe(0.1);
    expect(surchargeRate(1_50_00_000)).toBe(0.15);
    expect(surchargeRate(2_50_00_000)).toBe(0.25);
  });

  it('adds 4% cess on tax after rebate/surcharge and splits TDS by months left', () => {
    const result = computeNewRegimeAnnualTax({
      annualGrossSalary: 20_00_000,
      monthsLeftIncludingThis: 4,
      taxDeductedTillPreviousMonth: 0,
    });
    expect(result.netAnnualTax).toBeGreaterThan(0);
    expect(result.cess).toBe(
      Math.round((result.taxAfterRebate + result.surcharge) * 0.04 * 100) / 100,
    );
    expect(result.tdsThisMonth).toBe(Math.round((result.balanceTax / 4) * 100) / 100);
    expect(result.taxRemainingAfterThisMonth).toBe(
      Math.round((result.balanceTax - result.tdsThisMonth) * 100) / 100,
    );
  });
});
