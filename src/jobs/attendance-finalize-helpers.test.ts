import { describe, expect, it } from 'vitest';
import { needsAttendanceFinalizationWrite, yesterdayIso } from './attendance-finalize-helpers';

describe('attendance finalization helpers', () => {
  it('marks yesterday correctly in UTC', () => {
    expect(yesterdayIso(new Date('2026-08-21T00:05:00.000Z'))).toBe('2026-08-20');
  });

  it('is idempotent when status already matches', () => {
    expect(needsAttendanceFinalizationWrite('ABSENT', 'ABSENT')).toBe(false);
    expect(needsAttendanceFinalizationWrite('WEEK_OFF', 'ABSENT')).toBe(true);
    expect(needsAttendanceFinalizationWrite(null, 'ABSENT')).toBe(true);
  });
});
