import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRACE_MINUTES,
  PUNCH_CLOCK_SKEW_MINUTES,
  adjustPunchClock,
  effectiveGraceMinutes,
} from './punch-clock';
import { combineDateAndTime } from './rule-engine';

describe('punch clock helpers', () => {
  it('uses a 9-minute machine skew and 15-minute default grace', () => {
    expect(PUNCH_CLOCK_SKEW_MINUTES).toBe(9);
    expect(DEFAULT_GRACE_MINUTES).toBe(15);
    expect(effectiveGraceMinutes(0)).toBe(15);
    expect(effectiveGraceMinutes(10)).toBe(15);
    expect(effectiveGraceMinutes(20)).toBe(20);
  });

  it('subtracts skew from punch times', () => {
    const raw = combineDateAndTime('2026-09-16', '09:20');
    const adjusted = adjustPunchClock(raw);
    expect(adjusted?.toISOString().slice(11, 16)).toBe('09:11');
    expect(adjustPunchClock(null)).toBeNull();
  });
});
