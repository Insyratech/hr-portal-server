import { describe, expect, it } from 'vitest';
import {
  ATTENTION_RULES,
  buildAttentionLabels,
  defaultMonthRange,
  monthBounds,
  monthKeysInclusive,
  mondaysOverlapping,
  unplannedSharePct,
} from './analytics';

describe('work analytics helpers', () => {
  it('treats unplanned share as context ratio, not a penalty score', () => {
    expect(unplannedSharePct(8, 2)).toBe(20);
    expect(unplannedSharePct(0, 0)).toBe(0);
    expect(unplannedSharePct(0, 3)).toBe(100);
  });

  it('builds inclusive month keys and bounds', () => {
    expect(monthKeysInclusive('2026-03', '2026-05')).toEqual(['2026-03', '2026-04', '2026-05']);
    expect(monthBounds('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('defaults to a trailing month window', () => {
    expect(defaultMonthRange('2026-08-26', 6)).toEqual({ from: '2026-03', to: '2026-08' });
  });

  it('lists Mondays that overlap a date range', () => {
    expect(mondaysOverlapping('2026-08-24', '2026-08-28')).toEqual(['2026-08-24']);
    expect(mondaysOverlapping('2026-08-01', '2026-08-10')).toEqual(['2026-07-27', '2026-08-03', '2026-08-10']);
  });

  it('labels needs-attention with rules, not ranks', () => {
    const labels = buildAttentionLabels({
      requiredDays: 10,
      submittedDays: 4,
      weeksTotal: 2,
      weeksWithPlan: 1,
      openBlockers: 1,
      blocked: 2,
      completed: 1,
      carriedForward: 3,
    });
    expect(labels.map((row) => row.code)).toEqual([
      'LOW_COMPLIANCE',
      'NO_WEEK_PLAN',
      'OPEN_BLOCKER',
      'PRIORITIES_BLOCKED',
      'HEAVY_CARRY',
    ]);
    expect(labels.every((row) => row.label && row.detail)).toBe(true);
    expect(percentBelowThreshold(4, 10)).toBe(true);
  });

  it('does not flag healthy activity', () => {
    expect(
      buildAttentionLabels({
        requiredDays: 10,
        submittedDays: 9,
        weeksTotal: 2,
        weeksWithPlan: 2,
        openBlockers: 0,
        blocked: 0,
        completed: 4,
        carriedForward: 1,
      }),
    ).toEqual([]);
  });

  it('requires enough due days before low-compliance attention', () => {
    expect(
      buildAttentionLabels({
        requiredDays: ATTENTION_RULES.minRequiredDays - 1,
        submittedDays: 0,
        weeksTotal: 0,
        weeksWithPlan: 0,
        openBlockers: 0,
        blocked: 0,
        completed: 0,
        carriedForward: 0,
      }),
    ).toEqual([]);
  });
});

function percentBelowThreshold(submitted: number, required: number): boolean {
  return Math.round((submitted / required) * 100) < ATTENTION_RULES.complianceBelowPct;
}
