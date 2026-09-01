import { describe, expect, it } from 'vitest';
import { canTransitionMilestone } from './goals-milestones';

describe('canTransitionMilestone', () => {
  it('allows UPCOMING → ACTIVE and CANCELLED', () => {
    expect(canTransitionMilestone('UPCOMING', 'ACTIVE')).toBe(true);
    expect(canTransitionMilestone('UPCOMING', 'CANCELLED')).toBe(true);
    expect(canTransitionMilestone('UPCOMING', 'COMPLETED')).toBe(false);
  });

  it('allows ACTIVE → COMPLETED and CANCELLED', () => {
    expect(canTransitionMilestone('ACTIVE', 'COMPLETED')).toBe(true);
    expect(canTransitionMilestone('ACTIVE', 'CANCELLED')).toBe(true);
    expect(canTransitionMilestone('ACTIVE', 'UPCOMING')).toBe(false);
  });

  it('blocks changes from terminal states', () => {
    expect(canTransitionMilestone('COMPLETED', 'ACTIVE')).toBe(false);
    expect(canTransitionMilestone('CANCELLED', 'ACTIVE')).toBe(false);
  });
});
