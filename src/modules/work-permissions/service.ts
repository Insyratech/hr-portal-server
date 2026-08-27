import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { isHrDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { portalUrl } from '../notifications/mail';
import { loadStaffById, notifyStaff, type StaffContact } from '../notifications/notify-staff';
import {
  MONTHLY_QUOTA_MINUTES,
  assertApplyAllowed,
  monthOf,
  quotaUsed,
  quotaUses,
  remainingMinutes,
  slotLabel,
  type PermissionSlot,
} from './quota';
import type { WorkPermissionMine, WorkPermissionRecord, WorkPermissionStatus } from './types';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type PermissionRow = {
  id: string;
  employee_id: string;
  permission_date: string;
  minutes: number;
  slot?: string | null;
  reason: string;
  status: WorkPermissionStatus;
  actor_id: string | null;
  decided_at: string | null;
  created_at: string;
  employees?: { full_name: string } | { full_name: string }[] | null;
};

function firstName(value: PermissionRow['employees']): string | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0]?.full_name ?? null) : value.full_name;
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function canApprove(actor: RequestUser): boolean {
  return isHrDomainOwner(actor) && actor.permissions.includes(PERMISSIONS.WORK_PERMISSION_APPROVE);
}

function canListAll(actor: RequestUser): boolean {
  return canApprove(actor) || actor.permissions.includes(PERMISSIONS.USERS_VIEW);
}

function mapRow(row: PermissionRow, remaining: number, monthLabel: string): WorkPermissionRecord {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: firstName(row.employees),
    permissionDate: dateOnly(row.permission_date),
    minutes: row.minutes,
    slot: row.slot === 'END' ? 'END' : 'START',
    reason: row.reason ?? '',
    status: row.status,
    actorId: row.actor_id,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    remainingMinutes: remaining,
    monthLabel,
  };
}

async function loadHrManagers(supabase: SupabaseClient): Promise<StaffContact[]> {
  const { data } = await supabase
    .from('employee_roles')
    .select('employees ( id, user_id, email, notification_email, full_name ), roles ( code )');
  const people: StaffContact[] = [];
  const seen = new Set<string>();
  for (const row of data ?? []) {
    const role = row.roles as { code?: string } | { code?: string }[] | null;
    const code = Array.isArray(role) ? role[0]?.code : role?.code;
    if (code !== 'HR_MANAGER') continue;
    const employee = row.employees as
      | { id?: string; user_id?: string | null; email?: string | null; notification_email?: string | null; full_name?: string | null }
      | { id?: string; user_id?: string | null; email?: string | null; notification_email?: string | null; full_name?: string | null }[]
      | null;
    const person = Array.isArray(employee) ? employee[0] : employee;
    if (!person?.id || seen.has(person.id)) continue;
    seen.add(person.id);
    people.push({
      id: person.id,
      userId: person.user_id ?? null,
      email: person.notification_email || person.email || '',
      fullName: person.full_name || 'HR Manager',
    });
  }
  return people;
}

async function monthRows(
  supabase: SupabaseClient,
  employeeId: string,
  isoDate: string,
): Promise<PermissionRow[]> {
  const month = monthOf(isoDate);
  const { data, error } = await supabase
    .from('work_permissions')
    .select('*')
    .eq('employee_id', employeeId)
    .gte('permission_date', month.start)
    .lte('permission_date', month.end);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load permission requests.', 500);
  }
  return (data ?? []) as PermissionRow[];
}

async function remainingMap(
  supabase: SupabaseClient,
  rows: PermissionRow[],
): Promise<Map<string, { remaining: number; label: string }>> {
  const result = new Map<string, { remaining: number; label: string }>();
  if (rows.length === 0) return result;
  const employeeIds = [...new Set(rows.map((row) => row.employee_id))];
  const months = rows.map((row) => monthOf(dateOnly(row.permission_date)));
  const start = months.reduce((min, item) => (item.start < min ? item.start : min), months[0].start);
  const end = months.reduce((max, item) => (item.end > max ? item.end : max), months[0].end);
  const { data, error } = await supabase
    .from('work_permissions')
    .select('employee_id, permission_date, minutes, status')
    .in('employee_id', employeeIds)
    .in('status', ['PENDING', 'APPROVED'])
    .gte('permission_date', start)
    .lte('permission_date', end);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load permission quota.', 500);
  }
  const used = new Map<string, number>();
  for (const row of data ?? []) {
    const month = monthOf(dateOnly(String(row.permission_date)));
    const key = `${row.employee_id}:${month.key}`;
    used.set(key, (used.get(key) ?? 0) + Number(row.minutes));
  }
  for (const row of rows) {
    const month = monthOf(dateOnly(row.permission_date));
    const key = `${row.employee_id}:${month.key}`;
    result.set(`${row.id}`, { remaining: remainingMinutes(used.get(key) ?? 0), label: month.label });
  }
  return result;
}

function withRemaining(rows: PermissionRow[], remaining: Map<string, { remaining: number; label: string }>): WorkPermissionRecord[] {
  return rows.map((row) => {
    const month = monthOf(dateOnly(row.permission_date));
    const extra = remaining.get(row.id) ?? { remaining: MONTHLY_QUOTA_MINUTES, label: month.label };
    return mapRow(row, extra.remaining, extra.label);
  });
}

export function createWorkPermissionService(supabase: SupabaseClient) {
  return {
    async listMine(actor: RequestUser): Promise<WorkPermissionMine> {
      if (!actor.permissions.includes(PERMISSIONS.WORK_PERMISSION_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request permission time.', 403);
      }
      const { data, error } = await supabase
        .from('work_permissions')
        .select('*, employees!employee_id (full_name)')
        .eq('employee_id', actor.employeeId)
        .order('permission_date', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load permission requests.', 500);
      }
      const rows = (data ?? []) as PermissionRow[];
      const remaining = await remainingMap(supabase, rows);
      return { quotaMinutes: MONTHLY_QUOTA_MINUTES, items: withRemaining(rows, remaining) };
    },

    async listQueue(actor: RequestUser, status?: WorkPermissionStatus): Promise<WorkPermissionRecord[]> {
      if (!canListAll(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view permission requests.', 403);
      }
      let query = supabase
        .from('work_permissions')
        .select('*, employees!employee_id (full_name)')
        .order('permission_date', { ascending: false });
      if (status) {
        query = query.eq('status', status);
      }
      const { data, error } = await query;
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load permission requests.', 500);
      }
      const rows = (data ?? []) as PermissionRow[];
      const remaining = await remainingMap(supabase, rows);
      return withRemaining(rows, remaining);
    },

    async apply(
      actor: RequestUser,
      input: { permissionDate: string; minutes: number; slot: PermissionSlot; reason?: string },
      meta: RequestMeta,
    ): Promise<WorkPermissionRecord> {
      if (!actor.permissions.includes(PERMISSIONS.WORK_PERMISSION_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request permission time.', 403);
      }
      const permissionDate = dateOnly(input.permissionDate);
      const month = monthOf(permissionDate);
      const existing = await monthRows(supabase, actor.employeeId, permissionDate);
      assertApplyAllowed({
        minutes: input.minutes,
        usedMinutes: quotaUsed(existing),
        usedCount: quotaUses(existing),
        hasOpenOnDate: existing.some(
          (row) => dateOnly(row.permission_date) === permissionDate && (row.status === 'PENDING' || row.status === 'APPROVED'),
        ),
        slot: input.slot,
        monthLabel: month.label,
      });
      const { data, error } = await supabase
        .from('work_permissions')
        .insert({
          employee_id: actor.employeeId,
          permission_date: permissionDate,
          minutes: input.minutes,
          slot: input.slot,
          reason: input.reason?.trim() ?? '',
          status: 'PENDING',
        })
        .select('*, employees!employee_id (full_name)')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'You already have a permission request on this date.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to request permission.', 500);
      }
      const row = data as PermissionRow;
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'work_permission.apply',
        entityType: 'work_permission',
        entityId: row.id,
        newValues: { permissionDate, minutes: input.minutes, slot: input.slot },
        ...meta,
      });
      const remaining = remainingMinutes(quotaUsed([...existing, row]));
      const created = mapRow(row, remaining, month.label);
      const when = slotLabel(input.slot);
      await notifyStaff(
        supabase,
        (await loadHrManagers(supabase)).filter((person) => person.id !== actor.employeeId),
        {
          type: 'work_permission',
          title: 'Permission request',
          message: `${actor.fullName} requested 1 hour at the ${when} on ${permissionDate}.`,
          referenceType: 'work_permission',
          referenceId: created.id,
          eyebrow: 'Permission',
          paragraphs: [`${actor.fullName} requested 1 hour of permission at the ${when} on ${permissionDate}.`],
          ctaLabel: 'Review permission',
          ctaHref: portalUrl('/hr/permissions'),
        },
      );
      return created;
    },

    async decide(
      actor: RequestUser,
      id: string,
      action: 'approve' | 'reject',
      meta: RequestMeta,
    ): Promise<WorkPermissionRecord> {
      if (!canApprove(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot decide permission requests.', 403);
      }
      const { data: existing, error: loadError } = await supabase
        .from('work_permissions')
        .select('*, employees!employee_id (full_name)')
        .eq('id', id)
        .maybeSingle();
      if (loadError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load permission request.', 500);
      }
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Permission request not found.', 404);
      }
      const current = existing as PermissionRow;
      if (current.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.INVALID_STATUS_TRANSITION, 'This request has already been decided.', 409);
      }
      const nextStatus: WorkPermissionStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
      const { data, error } = await supabase
        .from('work_permissions')
        .update({ status: nextStatus, actor_id: actor.employeeId, decided_at: new Date().toISOString() })
        .eq('id', id)
        .select('*, employees!employee_id (full_name)')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update permission request.', 500);
      }
      const saved = data as PermissionRow;
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: `work_permission.${action}`,
        entityType: 'work_permission',
        entityId: id,
        oldValues: { status: current.status },
        newValues: { status: nextStatus },
        ...meta,
      });
      const month = monthOf(dateOnly(saved.permission_date));
      const inMonth = await monthRows(supabase, saved.employee_id, dateOnly(saved.permission_date));
      const mapped = mapRow(saved, remainingMinutes(quotaUsed(inMonth)), month.label);
      const when = slotLabel(mapped.slot);
      const approved = action === 'approve';
      await notifyStaff(supabase, await loadStaffById(supabase, saved.employee_id), {
        type: 'work_permission',
        title: approved ? 'Permission approved' : 'Permission rejected',
        message: approved
          ? `Your 1 hour at the ${when} on ${mapped.permissionDate} was approved.`
          : `Your 1 hour permission on ${mapped.permissionDate} was rejected. You can use that day again this month.`,
        referenceType: 'work_permission',
        referenceId: mapped.id,
        eyebrow: 'Permission',
        paragraphs: [
          approved
            ? `Your 1 hour at the ${when} on ${mapped.permissionDate} was approved.`
            : `Your 1 hour permission on ${mapped.permissionDate} was rejected. You can request that day again this month.`,
        ],
        ctaLabel: 'View permission',
        ctaHref: portalUrl(`/permission?permissionId=${mapped.id}`),
      });
      return mapped;
    },
  };
}
