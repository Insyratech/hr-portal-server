import { describe, expect, it } from 'vitest';
import { projectAnnualGrossSalary } from './new-regime-tax';
import {
  countMissingPriorMonths,
  expectedYtdPeriods,
  filterSlipsForYtd,
  joiningPeriodFromDate,
  resolvePlaygroundTds,
  sumYtdFromSlips,
} from './playground-ytd';

describe('joiningPeriodFromDate', () => {
  it('reads YYYY-MM from a joining date', () => {
    expect(joiningPeriodFromDate('2025-10-25')).toBe('2025-10');
    expect(joiningPeriodFromDate('2026-06')).toBe('2026-06');
    expect(joiningPeriodFromDate(null)).toBeNull();
  });
});

describe('Phase 5 YTD window', () => {
  it('lists Apr → month before playground (full FY employment)', () => {
    expect(expectedYtdPeriods('2026-10')).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
  });

  it('excludes months before mid-year join within the FY', () => {
    expect(expectedYtdPeriods('2026-10', '2026-06')).toEqual([
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
  });

  it('returns empty YTD window for April playground month', () => {
    expect(expectedYtdPeriods('2026-04')).toEqual([]);
  });

  it('filters published slips to the YTD window only', () => {
    const slips = [
      { period: '2025-10', basic: 1 }, // prior FY — ignore
      { period: '2026-05', basic: 2 },
      { period: '2026-09', basic: 3 },
      { period: '2026-10', basic: 4 }, // current month — ignore
    ];
    expect(filterSlipsForYtd(slips, '2026-10').map((s) => s.period)).toEqual(['2026-05', '2026-09']);
  });

  it('sums component YTD and sorts periods ascending; zero when empty', () => {
    expect(sumYtdFromSlips([]).slipCount).toBe(0);
    expect(sumYtdFromSlips([]).earnings).toBe(0);

    const ytd = sumYtdFromSlips([
      {
        period: '2026-09',
        basic: 30_000,
        da: 5_000,
        hra: 10_000,
        fuel: 2_000,
        incentives: 0,
        other: 5_000,
        professionalTax: 200,
        tds: 0,
        employeeWelfare: 500,
        otherDeductions: 0,
        lopAmount: 1_000,
        gross: 52_000,
      },
      {
        period: '2026-05',
        basic: 30_000,
        da: 5_000,
        hra: 10_000,
        fuel: 2_000,
        incentives: 10_000,
        other: 5_000,
        professionalTax: 200,
        tds: 100,
        employeeWelfare: 500,
        otherDeductions: 0,
        lopAmount: 0,
        gross: 62_000,
      },
    ]);
    expect(ytd.slipCount).toBe(2);
    expect(ytd.periods).toEqual(['2026-05', '2026-09']);
    expect(ytd.basic).toBe(60_000);
    expect(ytd.tds).toBe(100);
    // Sep: 52k components − 1k LOP; May: 62k components
    expect(ytd.earnings).toBe(51_000 + 62_000);
  });

  it('counts missing prior months for gap fill', () => {
    expect(countMissingPriorMonths(['2026-06', '2026-07', '2026-08', '2026-09'], ['2026-09'])).toBe(3);
    expect(countMissingPriorMonths(['2026-06', '2026-07'], ['2026-06', '2026-07'])).toBe(0);
  });
});

describe('Phase 6 hardening helpers', () => {
  it('projects mid-year join without inventing months before DOJ', () => {
    // Joined Jun 2026, playground Oct: expected prior = Jun–Sep; only Sep published → 3 missing
    const annual = projectAnnualGrossSalary({
      ytdEarnings: 52_000,
      thisMonthEarnings: 52_000,
      fixedMonthly: 52_000,
      monthsLeftIncludingThis: 6,
      missingPriorMonths: 3,
    });
    // YTD + 3 gap + this + 5 future
    expect(annual).toBe(52_000 + 3 * 52_000 + 52_000 + 5 * 52_000);
  });

  it('reduces this-month earnings for LOP in the annual projection', () => {
    const withLop = projectAnnualGrossSalary({
      ytdEarnings: 0,
      thisMonthEarnings: 50_000, // already net of LOP
      fixedMonthly: 52_000,
      monthsLeftIncludingThis: 1,
      missingPriorMonths: 0,
    });
    const full = projectAnnualGrossSalary({
      ytdEarnings: 0,
      thisMonthEarnings: 52_000,
      fixedMonthly: 52_000,
      monthsLeftIncludingThis: 1,
      missingPriorMonths: 0,
    });
    expect(withLop).toBe(50_000);
    expect(full - withLop).toBe(2_000);
  });

  it('clamps zero months left to 1 (full balance as this month TDS basis)', () => {
    expect(
      projectAnnualGrossSalary({
        ytdEarnings: 10_00_000,
        thisMonthEarnings: 50_000,
        fixedMonthly: 50_000,
        monthsLeftIncludingThis: 0,
      }),
    ).toBe(10_50_000);
  });

  it('resolves TDS override vs computed', () => {
    expect(resolvePlaygroundTds(1_200, null)).toEqual({ tds: 1_200, source: 'computed' });
    expect(resolvePlaygroundTds(1_200, undefined)).toEqual({ tds: 1_200, source: 'computed' });
    expect(resolvePlaygroundTds(1_200, 500)).toEqual({ tds: 500, source: 'override' });
  });
});
