import { describe, expect, it } from 'vitest';
import { instantFromWorkClock } from '../work/ist-clock';
import {
  FLEXIBLE_LEAVE_NOTICE_CLOCK,
  UNASSIGNED_LEAVE_NOTICE_CLOCK,
  leaveNoticeDeadline,
  leaveNoticeMet,
  noticeClockForShift,
  noticePeriodNotMetMessage,
} from './notice-deadline';

const evening = { name: 'Evening Shift', startTime: '13:30', flexible: false };

describe('leave notice vs shift start', () => {
  it('maps evening 13:30 IST to 08:00 UTC', () => {
    expect(instantFromWorkClock('2026-09-16', '13:30').toISOString()).toBe('2026-09-16T08:00:00.000Z');
  });

  it('sets the 1 hour deadline at 12:30 IST for an 13:30 evening start', () => {
    const deadline = leaveNoticeDeadline({
      startDate: '2026-09-16',
      noticeHours: 1,
      shift: evening,
    });
    expect(deadline.toISOString()).toBe('2026-09-16T07:00:00.000Z');
  });

  it('allows same-day sick leave at 08:37 IST when evening starts at 13:30', () => {
    expect(
      leaveNoticeMet({
        startDate: '2026-09-16',
        now: new Date('2026-09-16T03:07:00.000Z'),
        noticeHours: 1,
        shift: evening,
      }),
    ).toBe(true);
  });

  it('allows applying at exactly 12:30 IST', () => {
    expect(
      leaveNoticeMet({
        startDate: '2026-09-16',
        now: new Date('2026-09-16T07:00:00.000Z'),
        noticeHours: 1,
        shift: evening,
      }),
    ).toBe(true);
  });

  it('rejects applying at 12:45 IST', () => {
    expect(
      leaveNoticeMet({
        startDate: '2026-09-16',
        now: new Date('2026-09-16T07:15:00.000Z'),
        noticeHours: 1,
        shift: evening,
      }),
    ).toBe(false);
  });

  it('uses 08:00 IST as the flexible-shift notice clock, not stored 00:00', () => {
    expect(
      noticeClockForShift({ name: 'Flexible 9H', startTime: '00:00', flexible: true }),
    ).toBe(FLEXIBLE_LEAVE_NOTICE_CLOCK);
  });

  it('falls back to 09:00 IST when no shift is assigned', () => {
    expect(noticeClockForShift(null)).toBe(UNASSIGNED_LEAVE_NOTICE_CLOCK);
  });

  it('measures day notice from shift start, not midnight', () => {
    // 24h before 13:30 on 16 Sep is 13:30 on 15 Sep (08:00 UTC).
    const deadline = leaveNoticeDeadline({
      startDate: '2026-09-16',
      noticeHours: 24,
      shift: evening,
    });
    expect(deadline.toISOString()).toBe('2026-09-15T08:00:00.000Z');
  });

  it('names the shift and apply-by time in the error', () => {
    const message = noticePeriodNotMetMessage({
      noticePeriod: { value: 1, unit: 'hours' },
      startDate: '2026-09-16',
      shift: evening,
    });
    expect(message).toContain('1 hour notice');
    expect(message).toContain('Evening Shift');
    expect(message).toContain('1:30 pm');
    expect(message).toContain('12:30 pm');
  });
});
