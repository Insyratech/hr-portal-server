import { describe, expect, it } from 'vitest';
import {
  canPurgeAfterNotice,
  isEligibleForPurge,
  isRetentionDays,
  matchingReminderSlot,
  retentionCutoffDate,
} from './retention';
import { mapWorkSettings } from './settings';

describe('work retention rules', () => {
  it('uses a rolling cutoff — does not wipe July on August 10 under 90-day retention', () => {
    expect(retentionCutoffDate('2026-08-10', 90)).toBe('2026-05-12');
    expect(isEligibleForPurge('2026-07-01', '2026-05-12')).toBe(false);
    expect(isEligibleForPurge('2026-07-31', '2026-05-12')).toBe(false);
    expect(isEligibleForPurge('2026-05-12', '2026-05-12')).toBe(true);
    expect(isEligibleForPurge('2026-05-11', '2026-05-12')).toBe(true);
  });

  it('only allows 90, 180, or 365 retention days', () => {
    expect(isRetentionDays(90)).toBe(true);
    expect(isRetentionDays(180)).toBe(true);
    expect(isRetentionDays(365)).toBe(true);
    expect(isRetentionDays(30)).toBe(false);
  });

  it('waits the notify window before purge', () => {
    expect(canPurgeAfterNotice('2026-08-01', '2026-08-08', 7)).toBe(true);
    expect(canPurgeAfterNotice('2026-08-01', '2026-08-07', 7)).toBe(false);
  });

  it('matches primary or optional second reminder hour', () => {
    expect(matchingReminderSlot(20, 20, 22)).toBe('primary');
    expect(matchingReminderSlot(22, 20, 22)).toBe('second');
    expect(matchingReminderSlot(21, 20, 22)).toBe(null);
    expect(matchingReminderSlot(20, 20, 20)).toBe('primary');
  });

  it('maps settings with safe defaults', () => {
    expect(
      mapWorkSettings({
        id: 'org-1',
        work_update_reminder_hour: 19,
        work_update_second_reminder_hour: 22,
        work_retention_days: 90,
        work_archive_before_delete: true,
        work_notify_before_purge: true,
        work_purge_notify_days_before: 7,
        work_legal_hold: false,
      }),
    ).toEqual({
      id: 'org-1',
      timeZone: 'Asia/Kolkata',
      reminderHour: 19,
      secondReminderHour: 22,
      retentionDays: 90,
      archiveBeforeDelete: true,
      notifyBeforePurge: true,
      purgeNotifyDaysBefore: 7,
      legalHold: false,
    });
  });

  it('defaults second reminder hour to 22 IST when unset', () => {
    expect(
      mapWorkSettings({
        id: 'org-1',
        work_update_reminder_hour: 20,
        work_update_second_reminder_hour: null,
        work_retention_days: 180,
      }).secondReminderHour,
    ).toBe(22);
  });
});
