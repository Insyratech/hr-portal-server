import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { isHrDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { listWorkWeekRows } from '../attendance/work-week';
import { refreshOpenImportsForEmployeeDate } from '../attendance/import/refresh-for-date';
import { patternOnDate } from '../leave/day-count';
import {
  currentLeadEmployeeId,
  listLeaveProjectOptions,
  loadProjectForLeave,
} from '../leave/project-lead-approval';
import { loadHolidayDates, loadWorkingDays } from '../leave/support';
import { portalUrl } from '../notifications/mail';
import { loadStaffById, listStaffByRole, notifyStaff, type StaffContact } from '../notifications/notify-staff';
import { zonedClock } from '../work/ist-clock';
import {
  consumeCompBalance,
  creditCompEarned,
  ensureCompAllocation,
  loadCompEarnCap,
  remainingEarnCap,
  restoreOriginalLeaveBalance,
} from './credit';
import type {
  CompOffAdjustmentRecord,
  CompOffEligibleLeave,
  CompOffWaitingOn,
  CompOffWorkKind,
  CompOffWorkRecord,
  CompOffWorkStatus,
} from './types';
import {
  assertWorkDateIsOff,
  leaveWorkingDates,
  monthBounds,
  monthKey,
} from './validation';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type CompOffRow = {
  id: string;
  kind?: string | null;
  employee_id: string;
  leave_application_id: string | null;
  work_date: string;
  leave_date: string | null;
  quantity: number;
  reason: string;
  status: CompOffWorkStatus;
  balance_restored: number;
  project_id?: string | null;
  project_lead_employee_id?: string | null;
  project_lead_required?: boolean;
  project_lead_accepted?: boolean;
  project_lead_acted_at?: string | null;
  hr_accepted?: boolean;
  hr_acted_at?: string | null;
  work_confirmed_at?: string | null;
  credited_at?: string | null;
  credited_quantity?: number;
  actor_id: string | null;
  decided_at: string | null;
  created_at: string;
  employees?: { full_name: string } | { full_name: string }[] | null;
  projects?: { name: string; code: string } | { name: string; code: string }[] | null;
  project_lead?: { full_name: string } | { full_name: string }[] | null;
  leave_applications?:
    | {
        start_date: string;
        end_date: string;
        duration: string;
        status: string;
        leave_types?: { code: string; name: string; paid: boolean } | { code: string; name: string; paid: boolean }[] | null;
      }
    | {
        start_date: string;
        end_date: string;
        duration: string;
        status: string;
        leave_types?: { code: string; name: string; paid: boolean } | { code: string; name: string; paid: boolean }[] | null;
      }[]
    | null;
};

type AdjustmentRow = {
  id: string;
  employee_id: string;
  leave_application_id: string;
  leave_date: string;
  quantity: number;
  reason: string;
  status: CompOffWorkStatus;
  comp_consumed: number;
  original_restored: number;
  actor_id: string | null;
  decided_at: string | null;
  created_at: string;
  employees?: { full_name: string } | { full_name: string }[] | null;
  leave_applications?:
    | {
        start_date: string;
        end_date: string;
        duration: string;
        status: string;
        leave_types?: { code: string; name: string } | { code: string; name: string }[] | null;
      }
    | {
        start_date: string;
        end_date: string;
        duration: string;
        status: string;
        leave_types?: { code: string; name: string } | { code: string; name: string }[] | null;
      }[]
    | null;
};

function dateOnly(value: string): string {
  return String(value).slice(0, 10);
}

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function employeeName(value: CompOffRow['employees'] | AdjustmentRow['employees']): string | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0]?.full_name ?? null) : value.full_name;
}

function canApprove(actor: RequestUser): boolean {
  return isHrDomainOwner(actor) && actor.permissions.includes(PERMISSIONS.COMP_OFF_APPROVE);
}

function canListAll(actor: RequestUser): boolean {
  return canApprove(actor) || actor.permissions.includes(PERMISSIONS.USERS_VIEW);
}

function todayIso(): string {
  return zonedClock(new Date()).isoDate;
}

function asKind(value: string | null | undefined, leaveApplicationId: string | null): CompOffWorkKind {
  if (value === 'LEGACY_OFFSET' || (leaveApplicationId && value !== 'EARN')) return 'LEGACY_OFFSET';
  return 'EARN';
}

function waitingOn(row: CompOffRow): CompOffWaitingOn {
  if (row.status !== 'PENDING') return null;
  const kind = asKind(row.kind, row.leave_application_id);
  if (kind === 'LEGACY_OFFSET') return 'HR';
  if (row.project_lead_required && !row.project_lead_accepted) return 'PROJECT_LEAD';
  if (!row.hr_accepted) return 'HR';
  if (!row.credited_at) return 'WORK_CONFIRM';
  return null;
}

function mapRow(row: CompOffRow): CompOffWorkRecord {
  const app = firstRel(row.leave_applications);
  const type = firstRel(app?.leave_types ?? null);
  const project = firstRel(row.projects);
  return {
    id: row.id,
    kind: asKind(row.kind, row.leave_application_id),
    employeeId: row.employee_id,
    employeeName: employeeName(row.employees),
    leaveApplicationId: row.leave_application_id,
    leaveTypeCode: type?.code ?? null,
    leaveTypeName: type?.name ?? null,
    workDate: dateOnly(row.work_date),
    leaveDate: row.leave_date ? dateOnly(row.leave_date) : null,
    quantity: Number(row.quantity),
    reason: row.reason ?? '',
    status: row.status,
    waitingOn: waitingOn(row),
    balanceRestored: Number(row.balance_restored ?? 0),
    projectId: row.project_id ?? null,
    projectName: project?.name ?? null,
    projectCode: project?.code ?? null,
    projectLeadEmployeeId: row.project_lead_employee_id ?? null,
    projectLeadName: firstRel(row.project_lead)?.full_name ?? null,
    projectLeadRequired: Boolean(row.project_lead_required),
    projectLeadAccepted: Boolean(row.project_lead_accepted),
    projectLeadActedAt: row.project_lead_acted_at ?? null,
    hrAccepted: Boolean(row.hr_accepted),
    hrActedAt: row.hr_acted_at ?? null,
    workConfirmedAt: row.work_confirmed_at ?? null,
    creditedAt: row.credited_at ?? null,
    creditedQuantity: Number(row.credited_quantity ?? 0),
    actorId: row.actor_id,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

function mapAdjustment(row: AdjustmentRow): CompOffAdjustmentRecord {
  const app = firstRel(row.leave_applications);
  const type = firstRel(app?.leave_types ?? null);
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: employeeName(row.employees),
    leaveApplicationId: row.leave_application_id,
    leaveTypeCode: type?.code ?? null,
    leaveTypeName: type?.name ?? null,
    leaveDate: dateOnly(row.leave_date),
    quantity: Number(row.quantity),
    reason: row.reason ?? '',
    status: row.status,
    compConsumed: Number(row.comp_consumed ?? 0),
    originalRestored: Number(row.original_restored ?? 0),
    actorId: row.actor_id,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

const SELECT_WITH_RELS =
  '*, employees!employee_id (full_name), projects (name, code), project_lead:employees!project_lead_employee_id (full_name), leave_applications (start_date, end_date, duration, status, leave_types (code, name, paid))';

const SELECT_WORK_FALLBACK =
  '*, employees!employee_id (full_name), leave_applications (start_date, end_date, duration, status, leave_types (code, name, paid))';

const ADJUST_SELECT =
  '*, employees!employee_id (full_name), leave_applications (start_date, end_date, duration, status, leave_types (code, name))';

async function loadWorkRow(supabase: SupabaseClient, id: string): Promise<CompOffRow> {
  const full = await supabase.from('comp_off_work_requests').select(SELECT_WITH_RELS).eq('id', id).maybeSingle();
  if (!full.error && full.data) return full.data as CompOffRow;
  const fallback = await supabase.from('comp_off_work_requests').select(SELECT_WORK_FALLBACK).eq('id', id).maybeSingle();
  if (fallback.error || !fallback.data) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Compensatory work request not found.', 404);
  }
  return fallback.data as CompOffRow;
}

async function loadHrManagers(supabase: SupabaseClient): Promise<StaffContact[]> {
  return listStaffByRole(supabase, 'HR_MANAGER');
}

async function claimedLeaveDates(
  supabase: SupabaseClient,
  leaveApplicationIds: string[],
): Promise<Set<string>> {
  if (leaveApplicationIds.length === 0) return new Set();
  const claimed = new Set<string>();
  const [{ data: legacy, error: legacyError }, { data: adjustments, error: adjustError }] = await Promise.all([
    supabase
      .from('comp_off_work_requests')
      .select('leave_application_id, leave_date')
      .in('leave_application_id', leaveApplicationIds)
      .in('status', ['PENDING', 'APPROVED']),
    supabase
      .from('comp_off_adjustments')
      .select('leave_application_id, leave_date')
      .in('leave_application_id', leaveApplicationIds)
      .in('status', ['PENDING', 'APPROVED']),
  ]);
  if (legacyError) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load existing compensatory claims.', 500);
  }
  if (adjustError) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensatory leave adjustments.', 500);
  }
  for (const row of [...(legacy ?? []), ...(adjustments ?? [])]) {
    if (!row.leave_application_id || !row.leave_date) continue;
    claimed.add(`${row.leave_application_id as string}:${dateOnly(String(row.leave_date))}`);
  }
  return claimed;
}

async function restoreLeaveBalanceIfPossible(
  supabase: SupabaseClient,
  input: {
    leaveApplicationId: string;
    employeeId: string;
    leaveTypeId: string;
    quantity: number;
    requestId: string;
    actorId: string;
  },
): Promise<number> {
  const { data: ledger, error } = await supabase
    .from('leave_ledger')
    .select('id, allocation_id, quantity')
    .eq('reference_id', input.leaveApplicationId)
    .eq('transaction_type', 'LEAVE_APPROVED')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load leave ledger for restore.', 500);
  }
  if (!ledger) {
    return 0;
  }
  const currentQty = Number(ledger.quantity);
  if (!(currentQty < 0) || Math.abs(currentQty) + 1e-9 < input.quantity) {
    return 0;
  }
  const nextQty = Number((currentQty + input.quantity).toFixed(2));
  const { error: updateError } = await supabase
    .from('leave_ledger')
    .update({ quantity: nextQty })
    .eq('id', ledger.id);
  if (updateError) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to restore leave balance.', 500);
  }
  await supabase.rpc('recompute_leave_allocation', { p_allocation_id: ledger.allocation_id });
  await writeAuditLog(supabase, {
    actorId: input.actorId,
    action: 'comp_off.balance_restore',
    entityType: 'comp_off_work_request',
    entityId: input.requestId,
    newValues: {
      leaveApplicationId: input.leaveApplicationId,
      leaveTypeId: input.leaveTypeId,
      employeeId: input.employeeId,
      quantity: input.quantity,
      ledgerId: ledger.id,
      previousQuantity: currentQty,
      nextQuantity: nextQty,
    },
  });
  return input.quantity;
}

async function notifyHrManagers(
  supabase: SupabaseClient,
  payload: {
    title: string;
    message: string;
    referenceId: string;
    paragraphs: string[];
    referenceType?: string;
  },
): Promise<void> {
  const managers = (await loadHrManagers(supabase)).filter((person) => person.id);
  await notifyStaff(supabase, managers, {
    type: 'comp_off',
    title: payload.title,
    message: payload.message,
    referenceType: payload.referenceType ?? 'comp_off_work_request',
    referenceId: payload.referenceId,
    eyebrow: 'Comp-off',
    paragraphs: payload.paragraphs,
    ctaLabel: 'Review request',
    ctaHref: portalUrl('/hr/comp-off'),
  });
}

async function creditApprovedEarn(
  supabase: SupabaseClient,
  current: CompOffRow,
  actorId: string,
): Promise<CompOffRow> {
  if (current.credited_at) return current;
  const quantity = Number(current.quantity) || 1;
  const credited = await creditCompEarned(supabase, {
    employeeId: current.employee_id,
    requestId: current.id,
    quantity,
  });
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('comp_off_work_requests')
    .update({
      status: 'APPROVED',
      work_confirmed_at: current.work_confirmed_at ?? now,
      work_confirmed_by: actorId,
      credited_at: now,
      credited_quantity: credited || quantity,
      actor_id: actorId,
      decided_at: current.decided_at ?? now,
      hr_accepted: true,
      hr_acted_at: current.hr_acted_at ?? now,
    })
    .eq('id', current.id)
    .eq('status', 'PENDING')
    .select(SELECT_WORK_FALLBACK)
    .single();
  if (error || !data) {
    const existing = await loadWorkRow(supabase, current.id);
    if (existing.status === 'APPROVED' && existing.credited_at) return existing;
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to credit compensatory leave.', 500);
  }
  await writeAuditLog(supabase, {
    actorId,
    action: 'comp_off.credit',
    entityType: 'comp_off_work_request',
    entityId: current.id,
    newValues: { quantity: credited || quantity, workDate: dateOnly(current.work_date) },
  });
  return data as CompOffRow;
}

export function createCompOffWorkService(supabase: SupabaseClient) {
  return {
    async listProjects(actor: RequestUser) {
      if (!actor.permissions.includes(PERMISSIONS.COMP_OFF_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request compensatory work.', 403);
      }
      return listLeaveProjectOptions(supabase, actor.employeeId);
    },

    async listMine(actor: RequestUser): Promise<CompOffWorkRecord[]> {
      if (!actor.permissions.includes(PERMISSIONS.COMP_OFF_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view compensatory work requests.', 403);
      }
      const { data, error } = await supabase
        .from('comp_off_work_requests')
        .select(SELECT_WITH_RELS)
        .eq('employee_id', actor.employeeId)
        .order('work_date', { ascending: false });
      if (error) {
        const fallback = await supabase
          .from('comp_off_work_requests')
          .select(SELECT_WORK_FALLBACK)
          .eq('employee_id', actor.employeeId)
          .order('work_date', { ascending: false });
        if (fallback.error) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensatory work requests.', 500);
        }
        return ((fallback.data ?? []) as CompOffRow[]).map(mapRow);
      }
      return ((data ?? []) as CompOffRow[]).map(mapRow);
    },

    async listLeadInbox(actor: RequestUser): Promise<CompOffWorkRecord[]> {
      if (!actor.employeeId) return [];
      const { data: led } = await supabase
        .from('projects')
        .select('id')
        .eq('lead_employee_id', actor.employeeId)
        .eq('status', 'active');
      const projectIds = (led ?? []).map((row) => row.id as string);
      const orFilter = projectIds.length
        ? `project_lead_employee_id.eq.${actor.employeeId},project_id.in.(${projectIds.join(',')})`
        : `project_lead_employee_id.eq.${actor.employeeId}`;
      const { data, error } = await supabase
        .from('comp_off_work_requests')
        .select(SELECT_WITH_RELS)
        .eq('status', 'PENDING')
        .eq('kind', 'EARN')
        .eq('project_lead_required', true)
        .eq('project_lead_accepted', false)
        .or(orFilter)
        .order('created_at', { ascending: true });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensatory work lead inbox.', 500);
      }
      const byId = new Map<string, CompOffWorkRecord>();
      for (const row of (data ?? []) as CompOffRow[]) {
        const mapped = mapRow(row);
        if (mapped.employeeId === actor.employeeId) continue;
        byId.set(mapped.id, mapped);
      }
      return [...byId.values()];
    },

    async listQueue(actor: RequestUser, status?: CompOffWorkStatus): Promise<CompOffWorkRecord[]> {
      if (!canListAll(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view compensatory work requests.', 403);
      }
      let query = supabase.from('comp_off_work_requests').select(SELECT_WITH_RELS).order('created_at', { ascending: false });
      if (status) {
        query = query.eq('status', status);
      }
      const { data, error } = await query;
      if (error) {
        let fallback = supabase
          .from('comp_off_work_requests')
          .select(SELECT_WORK_FALLBACK)
          .order('created_at', { ascending: false });
        if (status) fallback = fallback.eq('status', status);
        const retry = await fallback;
        if (retry.error) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensatory work requests.', 500);
        }
        return ((retry.data ?? []) as CompOffRow[]).map(mapRow);
      }
      return ((data ?? []) as CompOffRow[]).map(mapRow);
    },

    async listEligibleLeaves(actor: RequestUser, yearMonth: string): Promise<CompOffEligibleLeave[]> {
      if (!actor.permissions.includes(PERMISSIONS.COMP_OFF_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request a compensatory leave adjustment.', 403);
      }
      let bounds: { start: string; end: string };
      try {
        bounds = monthBounds(yearMonth);
      } catch {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Provide month as YYYY-MM.', 400);
      }
      if (yearMonth !== monthKey(todayIso())) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Previously taken leave can only be adjusted in the current calendar month.',
          400,
        );
      }

      const [workingDays, holidayDates, workWeeks] = await Promise.all([
        loadWorkingDays(supabase),
        loadHolidayDates(supabase),
        listWorkWeekRows(supabase, actor.employeeId),
      ]);

      const { data, error } = await supabase
        .from('leave_applications')
        .select('id, start_date, end_date, duration, status, leave_types (code, name)')
        .eq('employee_id', actor.employeeId)
        .eq('status', 'APPROVED')
        .lte('start_date', bounds.end)
        .gte('end_date', bounds.start)
        .order('start_date', { ascending: true });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load leave applications.', 500);
      }

      const apps = (data ?? []).filter((row) => {
        const type = firstRel(row.leave_types as { code: string } | { code: string }[] | null);
        return type?.code !== 'COMP';
      });
      const claimed = await claimedLeaveDates(
        supabase,
        apps.map((row) => row.id as string),
      );

      const result: CompOffEligibleLeave[] = [];
      for (const row of apps) {
        const startDate = dateOnly(String(row.start_date));
        const endDate = dateOnly(String(row.end_date));
        const duration = (row.duration as 'full' | 'half') ?? 'full';
        const type = firstRel(row.leave_types as { code: string; name: string } | { code: string; name: string }[] | null);
        const days = leaveWorkingDates({
          startDate,
          endDate,
          duration,
          workingDays,
          holidayDates,
          weekPatternForDate: (iso) => patternOnDate(workWeeks, actor.employeeId, iso),
        })
          .filter((day) => monthKey(day.leaveDate) === yearMonth && day.leaveDate <= todayIso())
          .map((day) => ({
            leaveDate: day.leaveDate,
            quantity: day.quantity,
            available: !claimed.has(`${row.id as string}:${day.leaveDate}`),
          }));
        if (days.length === 0) continue;
        result.push({
          leaveApplicationId: row.id as string,
          leaveTypeCode: type?.code ?? null,
          leaveTypeName: type?.name ?? null,
          startDate,
          endDate,
          duration,
          status: String(row.status),
          days,
        });
      }
      return result;
    },

    async apply(
      actor: RequestUser,
      input: { workDate: string; reason?: string; projectId?: string },
      meta: RequestMeta,
    ): Promise<CompOffWorkRecord> {
      if (!actor.permissions.includes(PERMISSIONS.COMP_OFF_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request compensatory work.', 403);
      }

      const workDate = dateOnly(input.workDate);
      const [workingDays, holidayDates, workWeeks] = await Promise.all([
        loadWorkingDays(supabase),
        loadHolidayDates(supabase),
        listWorkWeekRows(supabase, actor.employeeId),
      ]);
      try {
        assertWorkDateIsOff({
          workDate,
          workingDays,
          holidayDates,
          weekPattern: patternOnDate(workWeeks, actor.employeeId, workDate),
        });
      } catch {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Work date must be a week-off or holiday for your calendar.',
          400,
        );
      }

      const allocation = await ensureCompAllocation(supabase, actor.employeeId);
      const cap = await loadCompEarnCap(supabase);
      const { data: pendingRows } = await supabase
        .from('comp_off_work_requests')
        .select('quantity')
        .eq('employee_id', actor.employeeId)
        .eq('kind', 'EARN')
        .eq('status', 'PENDING');
      const pendingQty = (pendingRows ?? []).reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);
      const remaining = remainingEarnCap(cap, allocation.earned, pendingQty);
      if (remaining < 1) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          cap > 0
            ? `You have reached the compensatory leave cap of ${cap} day(s) for this year.`
            : 'You cannot request more compensatory work right now.',
          400,
        );
      }

      const projectOptions = await listLeaveProjectOptions(supabase, actor.employeeId);
      let projectId: string | null = null;
      let leadId: string | null = null;
      let leadRequired = false;
      if (projectOptions.length > 0) {
        if (!input.projectId) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Select which project this compensatory work relates to.',
            400,
          );
        }
        const project = await loadProjectForLeave(supabase, input.projectId, actor.employeeId);
        projectId = project.id;
        leadId = project.leadEmployeeId === actor.employeeId ? null : project.leadEmployeeId;
        leadRequired = Boolean(leadId);
      }

      const { data, error } = await supabase
        .from('comp_off_work_requests')
        .insert({
          employee_id: actor.employeeId,
          kind: 'EARN',
          leave_application_id: null,
          work_date: workDate,
          leave_date: null,
          quantity: 1,
          reason: input.reason?.trim() ?? '',
          status: 'PENDING',
          project_id: projectId,
          project_lead_employee_id: leadId,
          project_lead_required: leadRequired,
          project_lead_accepted: false,
        })
        .select(SELECT_WORK_FALLBACK)
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            'This work date already has a pending or approved compensatory request.',
            409,
          );
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to submit request.', 500);
      }

      const created = mapRow(data as CompOffRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'comp_off.apply',
        entityType: 'comp_off_work_request',
        entityId: created.id,
        newValues: { kind: 'EARN', workDate, projectId, quantity: 1 },
        ...meta,
      });

      if (leadRequired && leadId) {
        const lead = await loadStaffById(supabase, leadId);
        if (lead) {
          await notifyStaff(supabase, [lead], {
            type: 'comp_off',
            title: 'Compensatory work — project lead approval',
            message: `${actor.fullName} requested to work on ${workDate} (holiday/week-off) to earn COMP leave.`,
            referenceType: 'comp_off_work_request',
            referenceId: created.id,
            eyebrow: 'Comp-off',
            paragraphs: [
              `${actor.fullName} requested permission to work on ${workDate} (holiday or week-off) to earn compensatory leave.`,
              'Review and approve as project lead before HR can decide.',
            ],
            ctaLabel: 'Review request',
            ctaHref: portalUrl('/work/team-permissions'),
          });
        }
      } else {
        await notifyHrManagers(supabase, {
          title: 'Compensatory work ready for HR',
          message: `${actor.fullName} requested to work on ${workDate} to earn COMP leave.`,
          referenceId: created.id,
          paragraphs: [
            `${actor.fullName} requested permission to work on ${workDate} (holiday or week-off) to earn compensatory leave.`,
            'No project-lead step was required. Please review and decide.',
          ],
        });
      }

      return created;
    },

    async acceptProjectLead(actor: RequestUser, id: string, meta: RequestMeta): Promise<CompOffWorkRecord> {
      const current = await loadWorkRow(supabase, id);
      if (current.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'This request is no longer pending.', 409);
      }
      if (asKind(current.kind, current.leave_application_id) !== 'EARN') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Project lead approval is not used on legacy offset requests.', 400);
      }
      if (!current.project_lead_required || current.project_lead_accepted) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Project lead approval is not required.', 409);
      }
      const liveLeadId = current.project_id ? await currentLeadEmployeeId(supabase, current.project_id) : null;
      if (current.project_lead_employee_id !== actor.employeeId && liveLeadId !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only the project lead can approve this step.', 403);
      }
      if (current.employee_id === actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot approve your own compensatory work request.', 403);
      }

      const { error } = await supabase
        .from('comp_off_work_requests')
        .update({
          project_lead_accepted: true,
          project_lead_acted_at: new Date().toISOString(),
          project_lead_employee_id: actor.employeeId,
        })
        .eq('id', id)
        .eq('status', 'PENDING');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to record project lead approval.', 500);
      }

      const updated = mapRow(await loadWorkRow(supabase, id));
      const applicant = await loadStaffById(supabase, updated.employeeId);
      if (applicant) {
        await notifyStaff(supabase, applicant, {
          type: 'comp_off',
          title: 'Compensatory work — project lead approved',
          message: `Your project lead approved work on ${updated.workDate}. HR will review next.`,
          referenceType: 'comp_off_work_request',
          referenceId: updated.id,
          eyebrow: 'Comp-off',
          paragraphs: [
            `Your project lead approved compensatory work on ${updated.workDate}.`,
            'Your request is now with HR. COMP leave is credited only after HR approval and work confirmation.',
          ],
          ctaLabel: 'View status',
          ctaHref: portalUrl('/leave'),
        });
      }
      await notifyHrManagers(supabase, {
        title: 'Compensatory work ready for HR',
        message: `${updated.employeeName ?? 'An employee'} — project lead approved work on ${updated.workDate}.`,
        referenceId: updated.id,
        paragraphs: [
          `${updated.employeeName ?? 'An employee'} has project-lead approval to work on ${updated.workDate} and earn COMP leave.`,
          'Please review and decide. Credit happens after you approve, once the work date is confirmed.',
        ],
      });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'comp_off.project_lead_accept',
        entityType: 'comp_off_work_request',
        entityId: id,
        newValues: updated,
        ...meta,
      });
      return updated;
    },

    async decide(
      actor: RequestUser,
      id: string,
      action: 'approve' | 'reject',
      meta: RequestMeta,
    ): Promise<CompOffWorkRecord> {
      if (!canApprove(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot decide compensatory work requests.', 403);
      }

      const current = await loadWorkRow(supabase, id);
      if (current.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.INVALID_STATUS_TRANSITION, 'This request has already been decided.', 409);
      }

      if (action === 'reject') {
        const { data, error } = await supabase
          .from('comp_off_work_requests')
          .update({
            status: 'REJECTED',
            actor_id: actor.employeeId,
            decided_at: new Date().toISOString(),
            hr_acted_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('status', 'PENDING')
          .select(SELECT_WORK_FALLBACK)
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to reject request.', 500);
        }
        const mapped = mapRow(data as CompOffRow);
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'comp_off.reject',
          entityType: 'comp_off_work_request',
          entityId: id,
          oldValues: { status: current.status },
          newValues: { status: 'REJECTED' },
          ...meta,
        });
        await notifyStaff(supabase, await loadStaffById(supabase, mapped.employeeId), {
          type: 'comp_off',
          title: 'Compensatory work rejected',
          message: `Your compensatory work request for ${mapped.workDate} was rejected.`,
          referenceType: 'comp_off_work_request',
          referenceId: mapped.id,
          eyebrow: 'Comp-off',
          paragraphs: [`Your request to work on ${mapped.workDate} was rejected. No COMP leave was credited.`],
          ctaLabel: 'View leave',
          ctaHref: portalUrl('/leave'),
        });
        return mapped;
      }

      const kind = asKind(current.kind, current.leave_application_id);
      if (kind === 'EARN') {
        if (current.project_lead_required && !current.project_lead_accepted) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Wait for project lead approval before HR review.',
            400,
          );
        }

        const workDate = dateOnly(current.work_date);
        const [workingDays, holidayDates, workWeeks] = await Promise.all([
          loadWorkingDays(supabase),
          loadHolidayDates(supabase),
          listWorkWeekRows(supabase, current.employee_id),
        ]);
        try {
          assertWorkDateIsOff({
            workDate,
            workingDays,
            holidayDates,
            weekPattern: patternOnDate(workWeeks, current.employee_id, workDate),
          });
        } catch {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Work date is no longer a week-off or holiday for this employee.',
            409,
          );
        }

        const nowIso = new Date().toISOString();
        const { error: hrError } = await supabase
          .from('comp_off_work_requests')
          .update({
            hr_accepted: true,
            hr_acted_at: nowIso,
            actor_id: actor.employeeId,
            decided_at: nowIso,
          })
          .eq('id', id)
          .eq('status', 'PENDING');
        if (hrError) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to record HR approval.', 500);
        }

        let next = await loadWorkRow(supabase, id);
        const creditNow = workDate <= todayIso();
        if (creditNow) {
          next = await creditApprovedEarn(supabase, next, actor.employeeId);
        }

        const mapped = mapRow(next);
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'comp_off.approve',
          entityType: 'comp_off_work_request',
          entityId: id,
          oldValues: { status: current.status },
          newValues: { status: mapped.status, creditedQuantity: mapped.creditedQuantity },
          ...meta,
        });

        try {
          await refreshOpenImportsForEmployeeDate(supabase, current.employee_id, workDate);
        } catch {
          // Approval already committed; attendance refresh is best-effort for open imports.
        }

        await notifyStaff(supabase, await loadStaffById(supabase, mapped.employeeId), {
          type: 'comp_off',
          title: creditNow ? 'Compensatory leave credited' : 'Compensatory work approved',
          message: creditNow
            ? `Your work on ${mapped.workDate} earned ${mapped.creditedQuantity || mapped.quantity} COMP day(s).`
            : `HR approved work on ${mapped.workDate}. COMP leave will be credited after that day is confirmed.`,
          referenceType: 'comp_off_work_request',
          referenceId: mapped.id,
          eyebrow: 'Comp-off',
          paragraphs: creditNow
            ? [
                `HR approved your compensatory work on ${mapped.workDate}.`,
                `${mapped.creditedQuantity || mapped.quantity} COMP day(s) were credited. Apply compensatory leave from the leave page when you need the day off.`,
              ]
            : [
                `HR approved permission to work on ${mapped.workDate}.`,
                'COMP leave is credited after that date is confirmed. You can apply COMP leave once the balance appears.',
              ],
          ctaLabel: 'View leave',
          ctaHref: portalUrl('/leave'),
        });
        return mapped;
      }

      const leaveApp = firstRel(current.leave_applications);
      if (!leaveApp || leaveApp.status !== 'APPROVED' || !current.leave_application_id || !current.leave_date) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Linked leave must still be approved before compensatory work can be approved.',
          409,
        );
      }

      const workDate = dateOnly(current.work_date);
      const leaveDate = dateOnly(current.leave_date);
      const [workingDays, holidayDates, workWeeks] = await Promise.all([
        loadWorkingDays(supabase),
        loadHolidayDates(supabase),
        listWorkWeekRows(supabase, current.employee_id),
      ]);
      try {
        assertWorkDateIsOff({
          workDate,
          workingDays,
          holidayDates,
          weekPattern: patternOnDate(workWeeks, current.employee_id, workDate),
        });
      } catch {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Work date is no longer a week-off or holiday for this employee.',
          409,
        );
      }

      const { data: leaveFull, error: leaveLoadError } = await supabase
        .from('leave_applications')
        .select('id, employee_id, leave_type_id, start_date, end_date, duration, status')
        .eq('id', current.leave_application_id)
        .maybeSingle();
      if (leaveLoadError || !leaveFull || leaveFull.status !== 'APPROVED') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Linked leave is not available.', 409);
      }

      const eligible = leaveWorkingDates({
        startDate: dateOnly(String(leaveFull.start_date)),
        endDate: dateOnly(String(leaveFull.end_date)),
        duration: (leaveFull.duration as 'full' | 'half') ?? 'full',
        workingDays,
        holidayDates,
        weekPatternForDate: (iso) => patternOnDate(workWeeks, current.employee_id, iso),
      });
      if (!eligible.some((day) => day.leaveDate === leaveDate)) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Leave date is no longer a valid working day inside the linked leave.',
          409,
        );
      }

      const { data, error } = await supabase
        .from('comp_off_work_requests')
        .update({
          status: 'APPROVED',
          actor_id: actor.employeeId,
          decided_at: new Date().toISOString(),
          hr_accepted: true,
          hr_acted_at: new Date().toISOString(),
          balance_restored: 0,
        })
        .eq('id', id)
        .eq('status', 'PENDING')
        .select(SELECT_WORK_FALLBACK)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to approve request.', 500);
      }

      let balanceRestored = 0;
      try {
        balanceRestored = await restoreLeaveBalanceIfPossible(supabase, {
          leaveApplicationId: current.leave_application_id,
          employeeId: current.employee_id,
          leaveTypeId: leaveFull.leave_type_id as string,
          quantity: Number(current.quantity),
          requestId: id,
          actorId: actor.employeeId,
        });
        if (balanceRestored > 0) {
          await supabase.from('comp_off_work_requests').update({ balance_restored: balanceRestored }).eq('id', id);
        }
      } catch {
        balanceRestored = 0;
      }

      const mapped = {
        ...mapRow(data as CompOffRow),
        balanceRestored,
        status: 'APPROVED' as const,
        waitingOn: null,
      };
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'comp_off.approve',
        entityType: 'comp_off_work_request',
        entityId: id,
        oldValues: { status: current.status },
        newValues: { status: 'APPROVED', balanceRestored, kind: 'LEGACY_OFFSET' },
        ...meta,
      });

      try {
        await refreshOpenImportsForEmployeeDate(supabase, current.employee_id, leaveDate);
      } catch {
        // Approval already committed; attendance refresh is best-effort for open imports.
      }

      const restoreNote =
        balanceRestored > 0
          ? ` Leave balance restored by ${balanceRestored} day(s).`
          : ' Leave history kept; attendance will treat that day as compensated (no leave/LOP).';
      await notifyStaff(supabase, await loadStaffById(supabase, mapped.employeeId), {
        type: 'comp_off',
        title: 'Compensatory work approved',
        message: `Your work on ${mapped.workDate} offsets leave on ${mapped.leaveDate}.${restoreNote}`,
        referenceType: 'comp_off_work_request',
        referenceId: mapped.id,
        eyebrow: 'Comp-off',
        paragraphs: [
          `Your compensatory work on ${mapped.workDate} was approved to offset leave on ${mapped.leaveDate}.`,
          balanceRestored > 0
            ? `${balanceRestored} day(s) were restored to your leave balance.`
            : 'The leave day is marked compensated so attendance/payroll will not count it as leave or LOP.',
        ],
        ctaLabel: 'View leave',
        ctaHref: portalUrl('/leave'),
      });

      return mapped;
    },

    async confirmWork(actor: RequestUser, id: string, meta: RequestMeta): Promise<CompOffWorkRecord> {
      if (!canApprove(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot confirm compensatory work.', 403);
      }
      const current = await loadWorkRow(supabase, id);
      if (current.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.INVALID_STATUS_TRANSITION, 'This request is not waiting for work confirmation.', 409);
      }
      if (asKind(current.kind, current.leave_application_id) !== 'EARN') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Only earned compensatory work is confirmed this way.', 400);
      }
      if (current.project_lead_required && !current.project_lead_accepted) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Wait for project lead approval first.', 400);
      }
      if (!current.hr_accepted) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'HR must approve the request before work can be confirmed.', 400);
      }
      if (dateOnly(current.work_date) > todayIso()) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Work date has not arrived yet.', 400);
      }

      const credited = await creditApprovedEarn(supabase, current, actor.employeeId);
      const mapped = mapRow(credited);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'comp_off.confirm_work',
        entityType: 'comp_off_work_request',
        entityId: id,
        newValues: mapped,
        ...meta,
      });
      try {
        await refreshOpenImportsForEmployeeDate(supabase, current.employee_id, dateOnly(current.work_date));
      } catch {
        // Credit already committed.
      }
      await notifyStaff(supabase, await loadStaffById(supabase, mapped.employeeId), {
        type: 'comp_off',
        title: 'Compensatory leave credited',
        message: `Work on ${mapped.workDate} was confirmed. ${mapped.creditedQuantity || mapped.quantity} COMP day(s) credited.`,
        referenceType: 'comp_off_work_request',
        referenceId: mapped.id,
        eyebrow: 'Comp-off',
        paragraphs: [
          `Your compensatory work on ${mapped.workDate} was confirmed.`,
          `${mapped.creditedQuantity || mapped.quantity} COMP day(s) were credited. Apply compensatory leave from the leave page when you need the day off.`,
        ],
        ctaLabel: 'View leave',
        ctaHref: portalUrl('/leave'),
      });
      return mapped;
    },

    async cancel(actor: RequestUser, id: string, meta: RequestMeta): Promise<CompOffWorkRecord> {
      if (!actor.permissions.includes(PERMISSIONS.COMP_OFF_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot revoke compensatory work requests.', 403);
      }
      const current = await loadWorkRow(supabase, id);
      if (current.employee_id !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You can only revoke your own request.', 403);
      }
      if (current.status !== 'PENDING') {
        throw new AppError(
          API_ERROR_CODES.INVALID_STATUS_TRANSITION,
          current.status === 'APPROVED'
            ? 'This request was already approved. Contact HR if you need a change.'
            : 'Only a pending request can be revoked.',
          409,
        );
      }
      if (current.credited_at) {
        throw new AppError(API_ERROR_CODES.INVALID_STATUS_TRANSITION, 'COMP leave was already credited for this request.', 409);
      }

      const { data, error } = await supabase
        .from('comp_off_work_requests')
        .update({
          status: 'CANCELLED',
          actor_id: actor.employeeId,
          decided_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('status', 'PENDING')
        .eq('employee_id', actor.employeeId)
        .select(SELECT_WORK_FALLBACK)
        .single();
      if (error || !data) {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          'Could not revoke this request. It may already have been decided.',
          409,
        );
      }
      const mapped = mapRow(data as CompOffRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'comp_off.cancel',
        entityType: 'comp_off_work_request',
        entityId: id,
        oldValues: { status: current.status },
        newValues: { status: 'CANCELLED' },
        ...meta,
      });
      return mapped;
    },

    async listMyAdjustments(actor: RequestUser): Promise<CompOffAdjustmentRecord[]> {
      if (!actor.permissions.includes(PERMISSIONS.COMP_OFF_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view compensatory leave adjustments.', 403);
      }
      const { data, error } = await supabase
        .from('comp_off_adjustments')
        .select(ADJUST_SELECT)
        .eq('employee_id', actor.employeeId)
        .order('created_at', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensatory leave adjustments.', 500);
      }
      return ((data ?? []) as AdjustmentRow[]).map(mapAdjustment);
    },

    async listAdjustmentQueue(actor: RequestUser, status?: CompOffWorkStatus): Promise<CompOffAdjustmentRecord[]> {
      if (!canListAll(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view compensatory leave adjustments.', 403);
      }
      let query = supabase.from('comp_off_adjustments').select(ADJUST_SELECT).order('created_at', { ascending: false });
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensatory leave adjustments.', 500);
      }
      return ((data ?? []) as AdjustmentRow[]).map(mapAdjustment);
    },

    async applyAdjustment(
      actor: RequestUser,
      input: { leaveApplicationId: string; leaveDate: string; reason?: string },
      meta: RequestMeta,
    ): Promise<CompOffAdjustmentRecord> {
      if (!actor.permissions.includes(PERMISSIONS.COMP_OFF_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request a compensatory leave adjustment.', 403);
      }

      const leaveDate = dateOnly(input.leaveDate);
      if (monthKey(leaveDate) !== monthKey(todayIso())) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Only leave taken in the current calendar month can be adjusted against COMP.',
          400,
        );
      }
      if (leaveDate > todayIso()) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'You can only adjust leave that has already been taken.', 400);
      }

      const eligible = await this.listEligibleLeaves(actor, monthKey(leaveDate));
      const app = eligible.find((row) => row.leaveApplicationId === input.leaveApplicationId);
      const day = app?.days.find((item) => item.leaveDate === leaveDate);
      if (!app || !day) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Leave date must be an approved working day in the current month.',
          400,
        );
      }
      if (!day.available) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'This leave day already has a pending or approved adjustment.', 409);
      }

      const allocation = await ensureCompAllocation(supabase, actor.employeeId);
      if (allocation.available + 1e-9 < day.quantity) {
        throw new AppError(
          API_ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE,
          'Not enough compensatory leave balance to adjust this leave day.',
          400,
        );
      }

      const { data, error } = await supabase
        .from('comp_off_adjustments')
        .insert({
          employee_id: actor.employeeId,
          leave_application_id: input.leaveApplicationId,
          leave_date: leaveDate,
          quantity: day.quantity,
          reason: input.reason?.trim() ?? '',
          status: 'PENDING',
        })
        .select(ADJUST_SELECT)
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            'This leave day already has a pending or approved adjustment.',
            409,
          );
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to submit adjustment.', 500);
      }

      const created = mapAdjustment(data as AdjustmentRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'comp_off.adjustment.apply',
        entityType: 'comp_off_adjustment',
        entityId: created.id,
        newValues: created,
        ...meta,
      });
      await notifyHrManagers(supabase, {
        title: 'COMP leave adjustment',
        message: `${actor.fullName} asked to adjust ${leaveDate} against compensatory leave.`,
        referenceId: created.id,
        referenceType: 'comp_off_adjustment',
        paragraphs: [
          `${actor.fullName} requested to adjust approved leave on ${leaveDate} (${app.leaveTypeCode ?? 'leave'}) against available COMP balance.`,
          'The original leave application stays in history. Approving this consumes COMP and restores the original leave type.',
        ],
      });
      return created;
    },

    async decideAdjustment(
      actor: RequestUser,
      id: string,
      action: 'approve' | 'reject',
      meta: RequestMeta,
    ): Promise<CompOffAdjustmentRecord> {
      if (!canApprove(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot decide compensatory leave adjustments.', 403);
      }
      const { data: existing, error: loadError } = await supabase
        .from('comp_off_adjustments')
        .select(ADJUST_SELECT)
        .eq('id', id)
        .maybeSingle();
      if (loadError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load adjustment.', 500);
      }
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Compensatory leave adjustment not found.', 404);
      }
      const current = existing as AdjustmentRow;
      if (current.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.INVALID_STATUS_TRANSITION, 'This adjustment has already been decided.', 409);
      }

      if (action === 'reject') {
        const { data, error } = await supabase
          .from('comp_off_adjustments')
          .update({
            status: 'REJECTED',
            actor_id: actor.employeeId,
            decided_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('status', 'PENDING')
          .select(ADJUST_SELECT)
          .single();
        if (error || !data) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to reject adjustment.', 500);
        }
        const mapped = mapAdjustment(data as AdjustmentRow);
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'comp_off.adjustment.reject',
          entityType: 'comp_off_adjustment',
          entityId: id,
          newValues: { status: 'REJECTED' },
          ...meta,
        });
        await notifyStaff(supabase, await loadStaffById(supabase, mapped.employeeId), {
          type: 'comp_off',
          title: 'COMP leave adjustment rejected',
          message: `Your request to adjust leave on ${mapped.leaveDate} was rejected.`,
          referenceType: 'comp_off_adjustment',
          referenceId: mapped.id,
          eyebrow: 'Comp-off',
          paragraphs: [`HR rejected the request to adjust leave on ${mapped.leaveDate} against COMP.`],
          ctaLabel: 'View leave',
          ctaHref: portalUrl('/leave'),
        });
        return mapped;
      }

      const { data: leaveFull, error: leaveError } = await supabase
        .from('leave_applications')
        .select('id, employee_id, leave_type_id, status')
        .eq('id', current.leave_application_id)
        .maybeSingle();
      if (leaveError || !leaveFull || leaveFull.status !== 'APPROVED') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Linked leave must still be approved.', 409);
      }

      const consumed = await consumeCompBalance(supabase, {
        employeeId: current.employee_id,
        quantity: Number(current.quantity),
        referenceType: 'comp_off_adjustment',
        referenceId: id,
      });
      const restored = await restoreOriginalLeaveBalance(supabase, {
        employeeId: current.employee_id,
        leaveTypeId: leaveFull.leave_type_id as string,
        quantity: Number(current.quantity),
        referenceId: id,
      });

      const { data, error } = await supabase
        .from('comp_off_adjustments')
        .update({
          status: 'APPROVED',
          actor_id: actor.employeeId,
          decided_at: new Date().toISOString(),
          comp_consumed: consumed,
          original_restored: restored,
        })
        .eq('id', id)
        .eq('status', 'PENDING')
        .select(ADJUST_SELECT)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to approve adjustment.', 500);
      }

      const mapped = mapAdjustment(data as AdjustmentRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'comp_off.adjustment.approve',
        entityType: 'comp_off_adjustment',
        entityId: id,
        newValues: { status: 'APPROVED', consumed, restored },
        ...meta,
      });
      try {
        await refreshOpenImportsForEmployeeDate(supabase, current.employee_id, dateOnly(current.leave_date));
      } catch {
        // Adjustment already committed.
      }
      await notifyStaff(supabase, await loadStaffById(supabase, mapped.employeeId), {
        type: 'comp_off',
        title: 'COMP leave adjustment approved',
        message: `Leave on ${mapped.leaveDate} was adjusted against compensatory leave.`,
        referenceType: 'comp_off_adjustment',
        referenceId: mapped.id,
        eyebrow: 'Comp-off',
        paragraphs: [
          `HR approved adjusting leave on ${mapped.leaveDate} against COMP.`,
          `${consumed} COMP day(s) were used. The original leave application stays in history.`,
        ],
        ctaLabel: 'View leave',
        ctaHref: portalUrl('/leave'),
      });
      return mapped;
    },

    async cancelAdjustment(actor: RequestUser, id: string, meta: RequestMeta): Promise<CompOffAdjustmentRecord> {
      if (!actor.permissions.includes(PERMISSIONS.COMP_OFF_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot revoke this adjustment.', 403);
      }
      const { data: existing, error: loadError } = await supabase
        .from('comp_off_adjustments')
        .select(ADJUST_SELECT)
        .eq('id', id)
        .maybeSingle();
      if (loadError || !existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Compensatory leave adjustment not found.', 404);
      }
      const current = existing as AdjustmentRow;
      if (current.employee_id !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You can only revoke your own request.', 403);
      }
      if (current.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.INVALID_STATUS_TRANSITION, 'Only a pending adjustment can be revoked.', 409);
      }
      const { data, error } = await supabase
        .from('comp_off_adjustments')
        .update({
          status: 'CANCELLED',
          actor_id: actor.employeeId,
          decided_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('status', 'PENDING')
        .eq('employee_id', actor.employeeId)
        .select(ADJUST_SELECT)
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Could not revoke this adjustment.', 409);
      }
      const mapped = mapAdjustment(data as AdjustmentRow);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'comp_off.adjustment.cancel',
        entityType: 'comp_off_adjustment',
        entityId: id,
        newValues: { status: 'CANCELLED' },
        ...meta,
      });
      return mapped;
    },
  };
}
