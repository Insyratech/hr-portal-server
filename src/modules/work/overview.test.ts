import { describe, expect, it } from 'vitest';
import { buildFridaySummary, compliancePct, completionPct, percent } from './overview';

describe('work overview indicators', () => {
  it('computes completion from countable priorities', () => {
    expect(completionPct(['COMPLETED', 'COMPLETED', 'IN_PROGRESS', 'CANCELLED'])).toBe(67);
    expect(completionPct([])).toBe(0);
  });

  it('excludes leave and holiday from update compliance', () => {
    expect(
      compliancePct(
        [
          { isoDate: '2026-08-24', required: true, submitted: true },
          { isoDate: '2026-08-25', required: true, submitted: false },
          { isoDate: '2026-08-26', required: false, submitted: false },
        ],
        '2026-08-26',
      ),
    ).toBe(50);
  });

  it('builds a Friday summary from records without a form', () => {
    const summary = buildFridaySummary({
      priorities: [
        { status: 'COMPLETED', title: 'Ship A', carriedFromId: null },
        { status: 'CARRIED_FORWARD', title: 'Ship B', carriedFromId: null },
      ],
      entries: [
        { category: 'PLANNED', description: 'Shipped A' },
        { category: 'UNPLANNED', description: 'Prod hotfix' },
      ],
      blockers: [{ description: 'Waiting on design' }],
    });
    expect(summary).toEqual({
      done: 1,
      total: 2,
      unplanned: ['Prod hotfix'],
      blockers: ['Waiting on design'],
      carried: 1,
    });
    expect(percent(1, 2)).toBe(50);
  });
});
