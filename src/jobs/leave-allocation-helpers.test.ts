import { describe, expect, it } from 'vitest';
import { computeCarryForward, previousPeriod } from './leave-allocation-helpers';

describe('leave allocation helpers', () => {
  it('caps carry-forward and never goes negative', () => {
    expect(computeCarryForward(5, 3)).toBe(3);
    expect(computeCarryForward(2, 5)).toBe(2);
    expect(computeCarryForward(-1, 5)).toBe(0);
    expect(computeCarryForward(4, 0)).toBe(0);
  });

  it('derives the previous calendar period', () => {
    expect(previousPeriod('2026')).toBe('2025');
  });
});
