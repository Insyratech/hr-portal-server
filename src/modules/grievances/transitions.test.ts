import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition } from './transitions';

describe('grievance status transitions', () => {
  it('allows the explicit forward path only when skip is disallowed', () => {
    expect(canTransition({ from: 'OPEN', to: 'UNDER_REVIEW', allowSkip: false })).toBe(true);
    expect(canTransition({ from: 'UNDER_REVIEW', to: 'INVESTIGATING', allowSkip: false })).toBe(true);
    expect(canTransition({ from: 'INVESTIGATING', to: 'RESOLVED', allowSkip: false })).toBe(true);
    expect(canTransition({ from: 'RESOLVED', to: 'CLOSED', allowSkip: false })).toBe(true);
    expect(canTransition({ from: 'OPEN', to: 'INVESTIGATING', allowSkip: false })).toBe(false);
    expect(canTransition({ from: 'OPEN', to: 'RESOLVED', allowSkip: false })).toBe(false);
    expect(canTransition({ from: 'CLOSED', to: 'OPEN', allowSkip: false })).toBe(false);
  });

  it('allows skip only when permission grants allowSkip', () => {
    expect(canTransition({ from: 'OPEN', to: 'INVESTIGATING', allowSkip: true })).toBe(true);
    expect(canTransition({ from: 'OPEN', to: 'CLOSED', allowSkip: true })).toBe(true);
    expect(canTransition({ from: 'RESOLVED', to: 'OPEN', allowSkip: true })).toBe(false);
  });

  it('assertTransition throws INVALID_STATUS_TRANSITION on illegal hops', () => {
    expect(() => assertTransition({ from: 'OPEN', to: 'RESOLVED', allowSkip: false })).toThrow(
      'INVALID_STATUS_TRANSITION',
    );
    expect(assertTransition({ from: 'OPEN', to: 'UNDER_REVIEW', allowSkip: false })).toEqual({
      from: 'OPEN',
      to: 'UNDER_REVIEW',
    });
  });
});
