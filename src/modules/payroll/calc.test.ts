import { describe, expect, it } from 'vitest';
import { calculateSlipMoney, leaveCodeBucket, mergeCompensation } from './calc';

describe('mergeCompensation', () => {
  it('overrides any compensation field for this run', () => {
    const base = {
      basic: 10000,
      da: 1000,
      hra: 500,
      fuel: 200,
      incentives: 0,
      other: 0,
      professionalTax: 200,
      tds: 0,
      employeeWelfare: 0,
      kpi: 0,
      otherDeductions: 0,
    };
    const merged = mergeCompensation(base, { basic: 12000, incentives: 500, other: 100, tds: 50 });
    expect(merged.basic).toBe(12000);
    expect(merged.da).toBe(1000);
    expect(merged.incentives).toBe(500);
    expect(merged.other).toBe(100);
    expect(merged.tds).toBe(50);
    expect(merged.professionalTax).toBe(200);
  });
});

describe('calculateSlipMoney', () => {
  it('keeps full-month pay when working days equals calendar days', () => {
    const result = calculateSlipMoney({
      compensation: {
        basic: 6620,
        da: 0,
        hra: 0,
        fuel: 0,
        incentives: 0,
        other: 0,
        professionalTax: 0,
        tds: 0,
        employeeWelfare: 0,
        kpi: 0,
        otherDeductions: 0,
      },
      calendarDays: 4,
      workingDays: 4,
      lopDays: 3,
    });
    expect(result.monthlyGross).toBe(6620);
    expect(result.gross).toBe(6620);
    expect(result.dailyRate).toBe(1655);
    expect(result.nonWorkingAmount).toBe(0);
    expect(result.lopAmount).toBe(4965);
    expect(result.net).toBe(1655);
  });

  it('pays only for working days: 40000 / 30 × 23', () => {
    const result = calculateSlipMoney({
      compensation: {
        basic: 40000,
        da: 0,
        hra: 0,
        fuel: 0,
        incentives: 0,
        other: 0,
        professionalTax: 0,
        tds: 0,
        employeeWelfare: 0,
        kpi: 0,
        otherDeductions: 0,
      },
      calendarDays: 30,
      workingDays: 23,
      lopDays: 0,
    });
    expect(result.dailyRate).toBe(1333.33);
    expect(result.gross).toBe(40000);
    expect(result.nonWorkingDays).toBe(7);
    expect(result.nonWorkingAmount).toBe(9333.41);
    expect(result.lopAmount).toBe(0);
    expect(result.net).toBe(30666.59);
  });

  it('uses 31-day daily rate when the month has 31 days', () => {
    const result = calculateSlipMoney({
      compensation: {
        basic: 40000,
        da: 0,
        hra: 0,
        fuel: 0,
        incentives: 0,
        other: 0,
        professionalTax: 0,
        tds: 0,
        employeeWelfare: 0,
        kpi: 0,
        otherDeductions: 0,
      },
      calendarDays: 31,
      workingDays: 23,
      lopDays: 0,
    });
    expect(result.dailyRate).toBe(1290.32);
    expect(result.nonWorkingDays).toBe(8);
    expect(result.nonWorkingAmount).toBe(10322.64);
    expect(result.net).toBe(29677.36);
  });

  it('subtracts LOP and statutory deductions from monthly gross', () => {
    const result = calculateSlipMoney({
      compensation: {
        basic: 10000,
        da: 0,
        hra: 0,
        fuel: 0,
        incentives: 0,
        other: 0,
        professionalTax: 200,
        tds: 0,
        employeeWelfare: 0,
        kpi: 0,
        otherDeductions: 0,
      },
      calendarDays: 10,
      workingDays: 10,
      lopDays: 1,
    });
    expect(result.dailyRate).toBe(1000);
    expect(result.gross).toBe(10000);
    expect(result.nonWorkingAmount).toBe(0);
    expect(result.lopAmount).toBe(1000);
    expect(result.net).toBe(8800);
  });
});

describe('leaveCodeBucket', () => {
  it('maps maternity and paternity into one particular', () => {
    expect(leaveCodeBucket('MAT', 'Maternity Leave')).toBe('maternityPaternity');
    expect(leaveCodeBucket('PAT', null)).toBe('maternityPaternity');
    expect(leaveCodeBucket('CL', 'Casual Leave')).toBe('cl');
  });
});
