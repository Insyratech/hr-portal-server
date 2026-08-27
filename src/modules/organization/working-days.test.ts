import { describe, expect, it } from 'vitest';
import { normalizeWorkingDays } from './service';

describe('normalizeWorkingDays', () => {
  it('keeps Mon–Sat in calendar order and drops duplicates', () => {
    expect(normalizeWorkingDays(['sat', 'MON', 'FRI', 'MON', 'TUE', 'WED', 'THU'])).toEqual([
      'MON',
      'TUE',
      'WED',
      'THU',
      'FRI',
      'SAT',
    ]);
  });

  it('rejects empty or unknown codes', () => {
    expect(() => normalizeWorkingDays([])).toThrow(/at least one working day/);
    expect(() => normalizeWorkingDays(['MON', 'WEEKEND'])).toThrow(/MON/);
  });
});
