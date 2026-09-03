import { describe, expect, it } from 'vitest';
import { earliestShiftChangeStartDate, validateShiftChangeDates } from './validation';

describe('shift-change validation', () => {
  const now = new Date('2026-09-03T10:00:00.000Z');

  it('requires at least one day notice', () => {
    expect(earliestShiftChangeStartDate(now)).toBe('2026-09-04');
    const sameDay = validateShiftChangeDates({
      startDate: '2026-09-03',
      endDate: '2026-09-03',
      now,
    });
    expect(sameDay.ok).toBe(false);
  });

  it('allows tomorrow through one month ahead', () => {
    expect(validateShiftChangeDates({ startDate: '2026-09-04', endDate: '2026-09-04', now }).ok).toBe(true);
    expect(validateShiftChangeDates({ startDate: '2026-09-15', endDate: '2026-09-17', now }).ok).toBe(true);
    expect(validateShiftChangeDates({ startDate: '2026-10-03', endDate: '2026-10-03', now }).ok).toBe(true);
  });

  it('blocks more than one month ahead', () => {
    const result = validateShiftChangeDates({
      startDate: '2026-10-04',
      endDate: '2026-10-04',
      now,
    });
    expect(result.ok).toBe(false);
  });

  it('blocks end date beyond the one-month window', () => {
    const result = validateShiftChangeDates({
      startDate: '2026-09-20',
      endDate: '2026-10-10',
      now,
    });
    expect(result.ok).toBe(false);
  });
});
