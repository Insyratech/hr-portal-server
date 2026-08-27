import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { assertSuperAdminOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import {
  DEFAULT_DAILY_REMINDER_HOUR,
  DEFAULT_SECOND_DAILY_REMINDER_HOUR,
  WORK_TIMEZONE,
} from './ist-clock';
import { isRetentionDays, type RetentionDays } from './retention';

export type WorkSettings = {
  id: string;
  /** Hours are Asia/Kolkata (IST). */
  timeZone: string;
  reminderHour: number;
  secondReminderHour: number | null;
  retentionDays: RetentionDays;
  archiveBeforeDelete: boolean;
  notifyBeforePurge: boolean;
  purgeNotifyDaysBefore: number;
  legalHold: boolean;
};

export type WorkSettingsPatch = {
  reminderHour?: number;
  secondReminderHour?: number | null;
  retentionDays?: number;
  archiveBeforeDelete?: boolean;
  notifyBeforePurge?: boolean;
  purgeNotifyDaysBefore?: number;
  legalHold?: boolean;
};

type SettingsRow = {
  id: string;
  work_update_reminder_hour?: number | null;
  work_update_second_reminder_hour?: number | null;
  work_retention_days?: number | null;
  work_archive_before_delete?: boolean | null;
  work_notify_before_purge?: boolean | null;
  work_purge_notify_days_before?: number | null;
  work_legal_hold?: boolean | null;
};

const SETTINGS_SELECT =
  'id, work_update_reminder_hour, work_update_second_reminder_hour, work_retention_days, work_archive_before_delete, work_notify_before_purge, work_purge_notify_days_before, work_legal_hold';

function hourOr(value: number | null | undefined, fallback: number): number {
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : fallback;
}

function optionalHour(value: number | null | undefined): number | null {
  if (value == null) return null;
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

export function mapWorkSettings(row: SettingsRow): WorkSettings {
  const retention = Number(row.work_retention_days);
  return {
    id: row.id,
    timeZone: WORK_TIMEZONE,
    reminderHour: hourOr(row.work_update_reminder_hour, DEFAULT_DAILY_REMINDER_HOUR),
    secondReminderHour:
      optionalHour(row.work_update_second_reminder_hour) ?? DEFAULT_SECOND_DAILY_REMINDER_HOUR,
    retentionDays: isRetentionDays(retention) ? retention : 180,
    archiveBeforeDelete: row.work_archive_before_delete !== false,
    notifyBeforePurge: row.work_notify_before_purge !== false,
    purgeNotifyDaysBefore: (() => {
      const days = Number(row.work_purge_notify_days_before);
      return Number.isInteger(days) && days >= 1 && days <= 30 ? days : 7;
    })(),
    legalHold: Boolean(row.work_legal_hold),
  };
}

function assertHour(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 23) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, `${label} must be an hour from 0 to 23.`, 400);
  }
  return value;
}

export function createWorkSettingsService(supabase: SupabaseClient) {
  async function loadRow(): Promise<SettingsRow> {
    const { data, error } = await supabase.from('organization_settings').select(SETTINGS_SELECT).limit(1).maybeSingle();
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load work settings.', 500);
    }
    return data as SettingsRow;
  }

  return {
    async getSettings(actor: RequestUser): Promise<WorkSettings> {
      if (!actor.permissions.includes(PERMISSIONS.WORK_SETTINGS)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view work retention settings.', 403);
      }
      assertSuperAdminOwner(actor, 'view work retention settings');
      return mapWorkSettings(await loadRow());
    },

    async updateSettings(
      actor: RequestUser,
      patch: WorkSettingsPatch,
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ): Promise<WorkSettings> {
      if (!actor.permissions.includes(PERMISSIONS.WORK_SETTINGS)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot change work retention settings.', 403);
      }
      assertSuperAdminOwner(actor, 'change work retention settings');
      const existing = mapWorkSettings(await loadRow());
      const next: WorkSettings = { ...existing };

      if (patch.reminderHour !== undefined) next.reminderHour = assertHour(patch.reminderHour, 'Reminder time');
      if (patch.secondReminderHour !== undefined) {
        next.secondReminderHour =
          patch.secondReminderHour == null
            ? DEFAULT_SECOND_DAILY_REMINDER_HOUR
            : assertHour(patch.secondReminderHour, 'Second reminder');
      }
      if (patch.retentionDays !== undefined) {
        if (!isRetentionDays(patch.retentionDays)) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Retention must be 90, 180, or 365 days.', 400);
        }
        next.retentionDays = patch.retentionDays;
      }
      if (patch.archiveBeforeDelete !== undefined) next.archiveBeforeDelete = Boolean(patch.archiveBeforeDelete);
      if (patch.notifyBeforePurge !== undefined) next.notifyBeforePurge = Boolean(patch.notifyBeforePurge);
      if (patch.purgeNotifyDaysBefore !== undefined) {
        const days = patch.purgeNotifyDaysBefore;
        if (!Number.isInteger(days) || days < 1 || days > 30) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Notify-before-purge lead time must be 1–30 days.', 400);
        }
        next.purgeNotifyDaysBefore = days;
      }
      if (patch.legalHold !== undefined) next.legalHold = Boolean(patch.legalHold);

      if (next.secondReminderHour != null && next.secondReminderHour === next.reminderHour) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Second reminder must be a different hour.', 400);
      }

      const { data, error } = await supabase
        .from('organization_settings')
        .update({
          work_update_reminder_hour: next.reminderHour,
          work_update_second_reminder_hour: next.secondReminderHour,
          work_retention_days: next.retentionDays,
          work_archive_before_delete: next.archiveBeforeDelete,
          work_notify_before_purge: next.notifyBeforePurge,
          work_purge_notify_days_before: next.purgeNotifyDaysBefore,
          work_legal_hold: next.legalHold,
        })
        .eq('id', existing.id)
        .select(SETTINGS_SELECT)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save work settings.', 500);
      }

      const updated = mapWorkSettings(data as SettingsRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'work_settings.update',
        entityType: 'organization_settings',
        entityId: updated.id,
        oldValues: existing as unknown as Record<string, unknown>,
        newValues: updated as unknown as Record<string, unknown>,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return updated;
    },
  };
}
