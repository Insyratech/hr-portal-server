import { describe, expect, it } from 'vitest';
import {
  PRESENCE_PAST_DAYS,
  presencePastFrom,
  resolvePresenceAsOf,
  splitPresenceApplications,
} from './leave-presence';

describe('leave presence helpers', () => {
  it('defaults asOf to today when missing or invalid', () => {
    expect(resolvePresenceAsOf(undefined, '2026-09-30')).toBe('2026-09-30');
    expect(resolvePresenceAsOf('not-a-date', '2026-09-30')).toBe('2026-09-30');
    expect(resolvePresenceAsOf('2026-10-05', '2026-09-30')).toBe('2026-10-05');
  });

  it('computes the past window start', () => {
    expect(presencePastFrom('2026-09-30')).toBe(
      formatExpectedPast('2026-09-30'),
    );
    expect(PRESENCE_PAST_DAYS).toBe(90);
  });

  it('splits approved leave into on-leave, upcoming, and past', () => {
    const rows = [
      { id: '1', status: 'APPROVED', startDate: '2026-09-28', endDate: '2026-10-02' },
      { id: '2', status: 'APPROVED', startDate: '2026-10-10', endDate: '2026-10-12' },
      { id: '3', status: 'APPROVED', startDate: '2026-09-01', endDate: '2026-09-03' },
      { id: '4', status: 'PENDING', startDate: '2026-10-20', endDate: '2026-10-21' },
      { id: '5', status: 'APPROVED', startDate: '2026-09-30', endDate: '2026-09-30' },
    ];
    const split = splitPresenceApplications(rows, '2026-09-30');
    expect(split.onLeave.map((row) => row.id)).toEqual(['1', '5']);
    expect(split.upcoming.map((row) => row.id)).toEqual(['2']);
    expect(split.past.map((row) => row.id)).toEqual(['3']);
  });
});

function formatExpectedPast(asOf: string): string {
  const [y, m, d] = asOf.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - PRESENCE_PAST_DAYS);
  return date.toISOString().slice(0, 10);
}
