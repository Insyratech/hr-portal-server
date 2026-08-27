import { describe, expect, it } from 'vitest';
import { calculateSlipMoney, leaveCodeBucket } from './calc';

describe('calculateSlipMoney', () => {
  it('matches 3 LOP on 4 calendar days with CTC 6620 → LOP 4965, net 1655', () => {
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
      lopDays: 3,
    });
    expect(result.gross).toBe(6620);
    expect(result.dailyRate).toBe(1655);
    expect(result.lopAmount).toBe(4965);
    expect(result.net).toBe(1655);
  });

  it('subtracts statutory deductions after LOP', () => {
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
      lopDays: 1,
    });
    expect(result.dailyRate).toBe(1000);
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
