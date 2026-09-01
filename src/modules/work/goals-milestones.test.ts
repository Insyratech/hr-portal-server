import { describe, expect, it } from 'vitest';
import { collectMilestoneFieldChanges } from './goals-milestones';

describe('collectMilestoneFieldChanges', () => {
  it('returns only fields that changed', () => {
    const changes = collectMilestoneFieldChanges(
      {
        name: 'Phase 1',
        description: 'Build core',
        start_date: '2026-01-01',
        target_date: '2026-03-01',
        status: 'UPCOMING',
        sequence: 1,
      },
      {
        name: 'Phase 1',
        description: 'Build core features',
        start_date: '2026-01-01',
        target_date: '2026-03-15',
        status: 'ACTIVE',
        sequence: 1,
      },
    );
    expect(changes).toEqual([
      { field: 'description', oldValue: 'Build core', newValue: 'Build core features' },
      { field: 'target_date', oldValue: '2026-03-01', newValue: '2026-03-15' },
      { field: 'status', oldValue: 'UPCOMING', newValue: 'ACTIVE' },
    ]);
  });

  it('returns an empty list when nothing changed', () => {
    const snapshot = {
      name: 'Current phase',
      description: '',
      start_date: null,
      target_date: null,
      status: 'ACTIVE',
      sequence: 1,
    };
    expect(collectMilestoneFieldChanges(snapshot, snapshot)).toEqual([]);
  });
});
