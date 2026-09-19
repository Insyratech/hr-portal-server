import { describe, expect, it } from 'vitest';
import { eachIsoDateInclusive, sharesShiftOnAllDates } from './handover-availability';

describe('eachIsoDateInclusive', () => {
  it('lists a single day', () => {
    expect(eachIsoDateInclusive('2026-09-18', '2026-09-18')).toEqual(['2026-09-18']);
  });

  it('lists an inclusive range', () => {
    expect(eachIsoDateInclusive('2026-09-18', '2026-09-20')).toEqual([
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
  });
});

describe('sharesShiftOnAllDates', () => {
  const assignments = [
    {
      employee_id: 'a',
      shift_id: 'day',
      effective_from: '2026-01-01',
      effective_to: null,
    },
    {
      employee_id: 'b',
      shift_id: 'day',
      effective_from: '2026-01-01',
      effective_to: null,
    },
    {
      employee_id: 'c',
      shift_id: 'night',
      effective_from: '2026-01-01',
      effective_to: null,
    },
  ];

  it('matches same shift colleagues', () => {
    expect(sharesShiftOnAllDates('a', 'b', '2026-09-18', '2026-09-19', assignments, [])).toBe(true);
  });

  it('rejects different shift colleagues', () => {
    expect(sharesShiftOnAllDates('a', 'c', '2026-09-18', '2026-09-19', assignments, [])).toBe(false);
  });

  it('uses approved override for the leave dates', () => {
    const overrides = [
      {
        employeeId: 'c',
        startDate: '2026-09-18',
        endDate: '2026-09-19',
        shiftId: 'day',
      },
    ];
    expect(sharesShiftOnAllDates('a', 'c', '2026-09-18', '2026-09-19', assignments, overrides)).toBe(true);
  });
});
