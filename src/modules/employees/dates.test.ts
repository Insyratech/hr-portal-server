import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { emptyToNull, toDateColumn } from './dates';

describe('employee date helpers', () => {
  it('turns blank values into null', () => {
    expect(emptyToNull('')).toBeNull();
    expect(emptyToNull('  ')).toBeNull();
    expect(emptyToNull(null)).toBeNull();
    expect(emptyToNull('x')).toBe('x');
  });

  it('normalizes ISO and DMY dates', () => {
    expect(toDateColumn('2025-10-24T00:00:00.000Z', 'Joining date')).toBe('2025-10-24');
    expect(toDateColumn('24/10/2025', 'Joining date')).toBe('2025-10-24');
    expect(toDateColumn('', 'Date of birth')).toBeNull();
  });

  it('rejects invalid dates', () => {
    try {
      toDateColumn('not-a-date', 'Joining date');
      throw new Error('expected validation error');
    } catch (error) {
      expect(error).toMatchObject({ code: API_ERROR_CODES.VALIDATION_ERROR });
    }
  });
});
