import type { SupabaseClient } from '@supabase/supabase-js';
import { writeAuditLog } from '../audit/write-audit-log';
import { formatIsoDate } from '../leave/day-count';
import { portalUrl } from '../notifications/mail';
import { notifyStaff, type StaffContact } from '../notifications/notify-staff';
import { mapWorkSettings, type WorkSettings } from './settings';
import { canPurgeAfterNotice, retentionCutoffDate } from './retention';

const SETTINGS_SELECT =
  'id, work_update_reminder_hour, work_update_second_reminder_hour, work_retention_days, work_archive_before_delete, work_notify_before_purge, work_purge_notify_days_before, work_legal_hold';

export type RetentionPurgeResult = {
  date: string;
  cutoffDate: string;
  retentionDays: number;
  legalHold: boolean;
  skipped: boolean;
  skipReason: string | null;
  notified: boolean;
  archivedDays: number;
  archivedPlans: number;
  deletedDays: number;
  deletedPlans: number;
  deletedReminders: number;
};

async function loadSettings(supabase: SupabaseClient): Promise<WorkSettings> {
  const { data } = await supabase.from('organization_settings').select(SETTINGS_SELECT).limit(1).maybeSingle();
  if (!data) {
    return {
      id: 'missing',
      timeZone: 'Asia/Kolkata',
      reminderHour: 20,
      secondReminderHour: 22,
      retentionDays: 180,
      archiveBeforeDelete: true,
      notifyBeforePurge: true,
      purgeNotifyDaysBefore: 7,
      legalHold: false,
    };
  }
  return mapWorkSettings(data);
}

async function listSuperAdminContacts(supabase: SupabaseClient): Promise<StaffContact[]> {
  const { data } = await supabase
    .from('employee_roles')
    .select('employees ( id, user_id, email, notification_email, full_name ), roles ( code )');
  const people: StaffContact[] = [];
  const seen = new Set<string>();
  for (const row of data ?? []) {
    const role = (row as { roles?: { code?: string } | { code?: string }[] }).roles;
    const code = Array.isArray(role) ? role[0]?.code : role?.code;
    if (code !== 'SUPER_ADMIN') continue;
    const rel = (row as {
      employees?:
        | { id?: string; user_id?: string | null; email?: string | null; notification_email?: string | null; full_name?: string | null }
        | { id?: string; user_id?: string | null; email?: string | null; notification_email?: string | null; full_name?: string | null }[]
        | null;
    }).employees;
    const employee = Array.isArray(rel) ? rel[0] : rel;
    if (!employee?.id || seen.has(employee.id)) continue;
    seen.add(employee.id);
    people.push({
      id: employee.id,
      userId: employee.user_id ?? null,
      email: employee.notification_email || employee.email || '',
      fullName: employee.full_name || 'there',
    });
  }
  return people;
}

async function countEligible(supabase: SupabaseClient, cutoffDate: string) {
  const [days, plans] = await Promise.all([
    supabase.from('daily_work_days').select('id', { count: 'exact', head: true }).lte('work_date', cutoffDate),
    supabase.from('weekly_plans').select('id', { count: 'exact', head: true }).lte('week_end', cutoffDate),
  ]);
  return { days: days.count ?? 0, plans: plans.count ?? 0 };
}

async function archiveDays(supabase: SupabaseClient, cutoffDate: string, retentionDays: number): Promise<number> {
  const { data: days, error: loadError } = await supabase
    .from('daily_work_days')
    .select('*, daily_work_entries ( * ), work_blockers ( * )')
    .lte('work_date', cutoffDate)
    .limit(500);
  if (loadError) throw loadError;
  if (!days?.length) return 0;
  const rows = days.map((day) => ({
    cutoff_date: cutoffDate,
    retention_days: retentionDays,
    source_table: 'daily_work_days',
    source_id: day.id as string,
    employee_id: day.employee_id as string,
    anchor_date: String(day.work_date).slice(0, 10),
    payload: day,
  }));
  const { error } = await supabase.from('work_data_archive').insert(rows);
  if (error) throw error;
  return rows.length;
}

async function archivePlans(supabase: SupabaseClient, cutoffDate: string, retentionDays: number): Promise<number> {
  const { data: plans, error: loadError } = await supabase
    .from('weekly_plans')
    .select('*, weekly_priorities ( * ), week_feedback ( * )')
    .lte('week_end', cutoffDate)
    .limit(500);
  if (loadError) throw loadError;
  if (!plans?.length) return 0;
  const rows = plans.map((plan) => ({
    cutoff_date: cutoffDate,
    retention_days: retentionDays,
    source_table: 'weekly_plans',
    source_id: plan.id as string,
    employee_id: plan.employee_id as string,
    anchor_date: String(plan.week_end).slice(0, 10),
    payload: plan,
  }));
  const { error } = await supabase.from('work_data_archive').insert(rows);
  if (error) throw error;
  return rows.length;
}

async function deleteEligible(supabase: SupabaseClient, cutoffDate: string) {
  const [{ data: dayRows }, { data: planRows }, { data: reminderRows }] = await Promise.all([
    supabase.from('daily_work_days').select('id').lte('work_date', cutoffDate).limit(500),
    supabase.from('weekly_plans').select('id').lte('week_end', cutoffDate).limit(500),
    supabase.from('work_reminder_log').select('employee_id, work_date, reminder_kind').lte('work_date', cutoffDate).limit(500),
  ]);

  const dayIds = (dayRows ?? []).map((row) => row.id as string);
  const planIds = (planRows ?? []).map((row) => row.id as string);
  let deletedReminders = 0;

  if (dayIds.length) {
    await supabase.from('daily_work_days').delete().in('id', dayIds);
  }
  if (planIds.length) {
    await supabase.from('weekly_plans').delete().in('id', planIds);
  }
  for (const row of reminderRows ?? []) {
    const { error } = await supabase
      .from('work_reminder_log')
      .delete()
      .eq('employee_id', row.employee_id)
      .eq('work_date', row.work_date)
      .eq('reminder_kind', row.reminder_kind);
    if (!error) deletedReminders += 1;
  }

  return { deletedDays: dayIds.length, deletedPlans: planIds.length, deletedReminders };
}

export async function runWorkRetentionPurge(
  supabase: SupabaseClient,
  now = new Date(),
): Promise<RetentionPurgeResult> {
  const today = formatIsoDate(now);
  const settings = await loadSettings(supabase);
  const cutoffDate = retentionCutoffDate(today, settings.retentionDays);
  const base: RetentionPurgeResult = {
    date: today,
    cutoffDate,
    retentionDays: settings.retentionDays,
    legalHold: settings.legalHold,
    skipped: true,
    skipReason: null,
    notified: false,
    archivedDays: 0,
    archivedPlans: 0,
    deletedDays: 0,
    deletedPlans: 0,
    deletedReminders: 0,
  };

  if (settings.legalHold) {
    base.skipReason = 'legal_hold';
    await writeAuditLog(supabase, {
      actorId: null,
      action: 'work_retention.skipped',
      entityType: 'work_retention',
      entityId: settings.id,
      newValues: { reason: 'legal_hold', cutoffDate, retentionDays: settings.retentionDays },
    });
    return base;
  }

  const eligible = await countEligible(supabase, cutoffDate);
  if (eligible.days === 0 && eligible.plans === 0) {
    base.skipReason = 'nothing_eligible';
    return base;
  }

  if (settings.notifyBeforePurge) {
    const { data: notice } = await supabase
      .from('work_purge_notices')
      .select('cutoff_date, notified_at')
      .eq('cutoff_date', cutoffDate)
      .maybeSingle();

    if (!notice) {
      const admins = await listSuperAdminContacts(supabase);
      await notifyStaff(supabase, admins, {
        type: 'work_purge_notice',
        title: 'Work data purge scheduled',
        message: `Work updates and week plans on or before ${cutoffDate} will be removed after the notice window (${settings.purgeNotifyDaysBefore} days), unless legal hold is on.`,
        referenceType: 'work_retention',
        referenceId: cutoffDate,
        eyebrow: 'Work retention',
        paragraphs: [
          'This is a rolling retention purge — not a calendar-month wipe.',
          `Cutoff date: ${cutoffDate} (${settings.retentionDays}-day retention).`,
          `About ${eligible.days} day rows and ${eligible.plans} week plans are in scope.`,
          settings.archiveBeforeDelete
            ? 'Rows will be archived before delete.'
            : 'Archive-before-delete is off; eligible rows will be deleted after the notice window.',
        ],
        details: [
          { label: 'Cutoff', value: cutoffDate },
          { label: 'Retention', value: `${settings.retentionDays} days` },
          { label: 'Notice window', value: `${settings.purgeNotifyDaysBefore} days` },
        ],
        ctaLabel: 'Open work settings',
        ctaHref: portalUrl('/super-admin/settings'),
      });
      await supabase.from('work_purge_notices').upsert({
        cutoff_date: cutoffDate,
        notified_at: now.toISOString(),
        retention_days: settings.retentionDays,
        eligible_days: eligible.days,
        eligible_plans: eligible.plans,
      });
      await writeAuditLog(supabase, {
        actorId: null,
        action: 'work_retention.notified',
        entityType: 'work_retention',
        entityId: cutoffDate,
        newValues: { cutoffDate, eligible, notifyDaysBefore: settings.purgeNotifyDaysBefore },
      });
      return { ...base, notified: true, skipReason: 'notify_pending' };
    }

    const noticeDate = String(notice.notified_at).slice(0, 10);
    if (!canPurgeAfterNotice(noticeDate, today, settings.purgeNotifyDaysBefore)) {
      base.skipReason = 'notify_pending';
      return base;
    }
  }

  let archivedDays = 0;
  let archivedPlans = 0;
  if (settings.archiveBeforeDelete) {
    try {
      archivedDays = await archiveDays(supabase, cutoffDate, settings.retentionDays);
      archivedPlans = await archivePlans(supabase, cutoffDate, settings.retentionDays);
    } catch {
      await writeAuditLog(supabase, {
        actorId: null,
        action: 'work_retention.archive_failed',
        entityType: 'work_retention',
        entityId: cutoffDate,
        newValues: { cutoffDate, eligible },
      });
      return { ...base, skipReason: 'archive_failed' };
    }
    await writeAuditLog(supabase, {
      actorId: null,
      action: 'work_retention.archived',
      entityType: 'work_retention',
      entityId: cutoffDate,
      newValues: { cutoffDate, archivedDays, archivedPlans },
    });
  }

  const deleted = await deleteEligible(supabase, cutoffDate);
  await writeAuditLog(supabase, {
    actorId: null,
    action: 'work_retention.purged',
    entityType: 'work_retention',
    entityId: cutoffDate,
    newValues: {
      cutoffDate,
      retentionDays: settings.retentionDays,
      archived: settings.archiveBeforeDelete,
      ...deleted,
    },
  });

  return {
    ...base,
    skipped: false,
    skipReason: null,
    archivedDays,
    archivedPlans,
    ...deleted,
  };
}
