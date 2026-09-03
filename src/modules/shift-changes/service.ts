import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { isHrDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import {
  listLeaveProjectOptions,
  loadProjectForLeave,
} from '../leave/project-lead-approval';
import { portalUrl } from '../notifications/mail';
import { loadStaffById, listStaffByRole, notifyStaff } from '../notifications/notify-staff';
import type { ShiftChangeApplyInput, ShiftChangeRequest, ShiftChangeStatus } from './types';
import { validateShiftChangeDates } from './validation';

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type Row = {
  id: string;
  employee_id: string;
  project_id: string | null;
  start_date: string;
  end_date: string;
  requested_shift_id: string;
  current_shift_id: string | null;
  reason: string;
  status: ShiftChangeStatus;
  project_lead_employee_id: string | null;
  project_lead_required: boolean;
  project_lead_accepted: boolean;
  project_lead_acted_at: string | null;
  reviewer_employee_id: string | null;
  reviewer_comment: string | null;
  reviewed_at: string | null;
  created_at: string;
  employees?: { full_name: string } | { full_name: string }[] | null;
  projects?: { name: string; code: string } | { name: string; code: string }[] | null;
  requested_shift?: { name: string } | { name: string }[] | null;
  current_shift?: { name: string } | { name: string }[] | null;
  project_lead?: { full_name: string } | { full_name: string }[] | null;
};

const SELECT =
  '*, employees!employee_id (full_name), projects (name, code), requested_shift:shifts!requested_shift_id (name), current_shift:shifts!current_shift_id (name), project_lead:employees!project_lead_employee_id (full_name)';

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function canApprove(actor: RequestUser): boolean {
  return isHrDomainOwner(actor) && actor.permissions.includes(PERMISSIONS.SHIFT_CHANGE_APPROVE);
}

function canListOrg(actor: RequestUser): boolean {
  return (
    canApprove(actor) ||
    actor.permissions.includes(PERMISSIONS.SHIFT_CHANGE_VIEW) ||
    actor.permissions.includes(PERMISSIONS.USERS_VIEW)
  );
}

function mapRow(row: Row): ShiftChangeRequest {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: firstRel(row.employees)?.full_name ?? null,
    projectId: row.project_id,
    projectName: firstRel(row.projects)?.name ?? null,
    projectCode: firstRel(row.projects)?.code ?? null,
    startDate: dateOnly(row.start_date),
    endDate: dateOnly(row.end_date),
    requestedShiftId: row.requested_shift_id,
    requestedShiftName: firstRel(row.requested_shift)?.name ?? null,
    currentShiftId: row.current_shift_id,
    currentShiftName: firstRel(row.current_shift)?.name ?? null,
    reason: row.reason ?? '',
    status: row.status,
    projectLeadEmployeeId: row.project_lead_employee_id,
    projectLeadName: firstRel(row.project_lead)?.full_name ?? null,
    projectLeadRequired: Boolean(row.project_lead_required),
    projectLeadAccepted: Boolean(row.project_lead_accepted),
    projectLeadActedAt: row.project_lead_acted_at,
    reviewerEmployeeId: row.reviewer_employee_id,
    reviewerComment: row.reviewer_comment,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

async function loadRequest(supabase: SupabaseClient, id: string): Promise<ShiftChangeRequest> {
  const { data, error } = await supabase.from('shift_change_requests').select(SELECT).eq('id', id).maybeSingle();
  if (error || !data) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Shift change request not found.', 404);
  }
  return mapRow(data as Row);
}

async function currentShiftIdOnDate(
  supabase: SupabaseClient,
  employeeId: string,
  isoDate: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('shift_assignments')
    .select('shift_id, effective_from, effective_to')
    .eq('employee_id', employeeId)
    .lte('effective_from', isoDate)
    .order('effective_from', { ascending: false });
  const match = (data ?? []).find((row) => !row.effective_to || String(row.effective_to).slice(0, 10) >= isoDate);
  return (match?.shift_id as string | undefined) ?? null;
}

async function notifyHrManagers(
  supabase: SupabaseClient,
  payload: { title: string; message: string; referenceId: string; paragraphs: string[] },
): Promise<void> {
  const managers = await listStaffByRole(supabase, 'HR_MANAGER');
  await notifyStaff(supabase, managers, {
    type: 'shift_change',
    title: payload.title,
    message: payload.message,
    referenceType: 'shift_change_request',
    referenceId: payload.referenceId,
    eyebrow: 'Shift change',
    paragraphs: payload.paragraphs,
    ctaLabel: 'Open request',
    ctaHref: portalUrl(`/hr/shift-changes?id=${payload.referenceId}`),
  });
}

function dateLabel(start: string, end: string): string {
  return start === end ? start : `${start} → ${end}`;
}

export function createShiftChangeService(supabase: SupabaseClient) {
  return {
    async listProjects(actor: RequestUser) {
      if (!actor.permissions.includes(PERMISSIONS.SHIFT_CHANGE_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request a shift change.', 403);
      }
      return listLeaveProjectOptions(supabase, actor.employeeId);
    },

    async listMine(actor: RequestUser): Promise<ShiftChangeRequest[]> {
      if (!actor.permissions.includes(PERMISSIONS.SHIFT_CHANGE_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view shift change requests.', 403);
      }
      const { data, error } = await supabase
        .from('shift_change_requests')
        .select(SELECT)
        .eq('employee_id', actor.employeeId)
        .order('created_at', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load shift change requests.', 500);
      }
      return ((data ?? []) as Row[]).map(mapRow);
    },

    async listLeadInbox(actor: RequestUser): Promise<ShiftChangeRequest[]> {
      const { data, error } = await supabase
        .from('shift_change_requests')
        .select(SELECT)
        .eq('status', 'PENDING')
        .eq('project_lead_required', true)
        .eq('project_lead_accepted', false)
        .eq('project_lead_employee_id', actor.employeeId)
        .order('created_at', { ascending: true });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load lead inbox.', 500);
      }
      return ((data ?? []) as Row[]).map(mapRow);
    },

    async listQueue(actor: RequestUser, status?: ShiftChangeStatus): Promise<ShiftChangeRequest[]> {
      if (!canListOrg(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view org shift change requests.', 403);
      }
      let query = supabase.from('shift_change_requests').select(SELECT).order('created_at', { ascending: false });
      if (status) {
        query = query.eq('status', status);
      }
      const { data, error } = await query;
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load shift change requests.', 500);
      }
      return ((data ?? []) as Row[]).map(mapRow);
    },

    async get(actor: RequestUser, id: string): Promise<ShiftChangeRequest> {
      const row = await loadRequest(supabase, id);
      const isOwner = row.employeeId === actor.employeeId;
      const isLead = row.projectLeadEmployeeId === actor.employeeId;
      if (!isOwner && !isLead && !canListOrg(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view this request.', 403);
      }
      return row;
    },

    async apply(actor: RequestUser, input: ShiftChangeApplyInput, meta: RequestMeta): Promise<ShiftChangeRequest> {
      if (!actor.permissions.includes(PERMISSIONS.SHIFT_CHANGE_APPLY)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request a shift change.', 403);
      }

      const startDate = input.startDate.slice(0, 10);
      const endDate = input.endDate.slice(0, 10);
      const reason = input.reason.trim();
      if (!reason) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Reason is required.', 400);
      }

      const dates = validateShiftChangeDates({ startDate, endDate, now: new Date() });
      if (!dates.ok) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, dates.message, 400);
      }

      const { data: shift, error: shiftError } = await supabase
        .from('shifts')
        .select('id, name, active')
        .eq('id', input.requestedShiftId)
        .maybeSingle();
      if (shiftError || !shift || !shift.active) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select an active shift.', 400);
      }

      const { data: pending } = await supabase
        .from('shift_change_requests')
        .select('id')
        .eq('employee_id', actor.employeeId)
        .eq('status', 'PENDING')
        .maybeSingle();
      if (pending) {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          'You already have a pending shift change request. Cancel or wait for a decision before applying again.',
          409,
        );
      }

      const projectOptions = await listLeaveProjectOptions(supabase, actor.employeeId);
      let projectId: string | null = null;
      let leadId: string | null = null;
      let leadRequired = false;
      let leadAccepted = false;

      if (projectOptions.length > 0) {
        if (!input.projectId) {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'Select which project this shift change relates to.',
            400,
          );
        }
        const project = await loadProjectForLeave(supabase, input.projectId, actor.employeeId);
        projectId = project.id;
        leadId = project.leadEmployeeId;
        if (leadId === actor.employeeId) {
          leadRequired = false;
          leadAccepted = false;
          leadId = null;
        } else {
          leadRequired = true;
          leadAccepted = false;
        }
      }

      const currentShiftId = await currentShiftIdOnDate(supabase, actor.employeeId, startDate);

      const { data: inserted, error } = await supabase
        .from('shift_change_requests')
        .insert({
          employee_id: actor.employeeId,
          project_id: projectId,
          start_date: startDate,
          end_date: endDate,
          requested_shift_id: input.requestedShiftId,
          current_shift_id: currentShiftId,
          reason,
          status: 'PENDING',
          project_lead_employee_id: leadId,
          project_lead_required: leadRequired,
          project_lead_accepted: leadAccepted,
        })
        .select('id')
        .single();
      if (error || !inserted) {
        if (/shift_change_requests_one_pending/i.test(error?.message ?? '')) {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            'You already have a pending shift change request.',
            409,
          );
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to submit request.', 500);
      }

      const created = await loadRequest(supabase, inserted.id as string);
      const when = dateLabel(created.startDate, created.endDate);
      const shiftName = created.requestedShiftName ?? 'requested shift';

      if (leadRequired && leadId) {
        const lead = await loadStaffById(supabase, leadId);
        if (lead) {
          await notifyStaff(supabase, [lead], {
            type: 'shift_change',
            title: 'Shift change — project lead approval',
            message: `${created.employeeName ?? 'A teammate'} requested ${shiftName} for ${when}. Please review.`,
            referenceType: 'shift_change_request',
            referenceId: created.id,
            eyebrow: 'Shift change',
            paragraphs: [
              `${created.employeeName ?? 'A teammate'} requested ${shiftName} for ${when}.`,
              'Review and approve as project lead before HR can decide.',
            ],
            details: [
              { label: 'Dates', value: when },
              { label: 'Requested shift', value: shiftName },
            ],
            ctaLabel: 'Review request',
            ctaHref: portalUrl(`/shift-change/lead/${created.id}`),
          });
        }
      } else {
        await notifyHrManagers(supabase, {
          title: 'Shift change ready for HR',
          message: `${created.employeeName ?? 'An employee'} requested ${shiftName} for ${when}.`,
          referenceId: created.id,
          paragraphs: [
            `${created.employeeName ?? 'An employee'} requested ${shiftName} for ${when}.`,
            'No project-lead step was required. Please review and decide.',
          ],
        });
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'shift_change.apply',
        entityType: 'shift_change_request',
        entityId: created.id,
        newValues: created,
        ...meta,
      });

      return created;
    },

    async acceptProjectLead(actor: RequestUser, id: string, meta: RequestMeta): Promise<ShiftChangeRequest> {
      const existing = await loadRequest(supabase, id);
      if (existing.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'This request is no longer pending.', 409);
      }
      if (!existing.projectLeadRequired || existing.projectLeadAccepted) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Project lead approval is not required.', 409);
      }
      if (existing.projectLeadEmployeeId !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only the project lead can approve this step.', 403);
      }

      const { error } = await supabase
        .from('shift_change_requests')
        .update({
          project_lead_accepted: true,
          project_lead_acted_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('status', 'PENDING');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to record project lead approval.', 500);
      }

      const updated = await loadRequest(supabase, id);
      const applicant = await loadStaffById(supabase, updated.employeeId);
      if (applicant) {
        await notifyStaff(supabase, applicant, {
          type: 'shift_change',
          title: 'Shift change — project lead approved',
          message: 'Your project lead approved the shift change. HR will review next.',
          referenceType: 'shift_change_request',
          referenceId: updated.id,
          eyebrow: 'Shift change',
          paragraphs: [
            `Your project lead approved the shift change for ${dateLabel(updated.startDate, updated.endDate)}.`,
            'Your request is now with HR.',
          ],
          ctaLabel: 'View status',
          ctaHref: portalUrl('/shift-change'),
        });
      }
      await notifyHrManagers(supabase, {
        title: 'Shift change ready for HR',
        message: `${updated.employeeName ?? 'An employee'} — project lead approved. Review ${dateLabel(updated.startDate, updated.endDate)}.`,
        referenceId: updated.id,
        paragraphs: [
          `${updated.employeeName ?? 'An employee'} has project-lead approval for a shift change.`,
          `Dates: ${dateLabel(updated.startDate, updated.endDate)}. Please review and decide.`,
        ],
      });

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'shift_change.project_lead_accept',
        entityType: 'shift_change_request',
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
      comment?: string,
    ): Promise<ShiftChangeRequest> {
      if (!canApprove(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot decide shift change requests.', 403);
      }
      const existing = await loadRequest(supabase, id);
      if (existing.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'This request is no longer pending.', 409);
      }
      if (existing.projectLeadRequired && !existing.projectLeadAccepted) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Wait for project lead approval before HR review.',
          400,
        );
      }

      const nextStatus: ShiftChangeStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
      const { error } = await supabase
        .from('shift_change_requests')
        .update({
          status: nextStatus,
          reviewer_employee_id: actor.employeeId,
          reviewer_comment: comment?.trim() || null,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('status', 'PENDING');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update shift change request.', 500);
      }

      const updated = await loadRequest(supabase, id);
      const applicant = await loadStaffById(supabase, updated.employeeId);
      const when = dateLabel(updated.startDate, updated.endDate);
      if (applicant) {
        await notifyStaff(supabase, applicant, {
          type: 'shift_change',
          title: action === 'approve' ? 'Shift change approved' : 'Shift change declined',
          message:
            action === 'approve'
              ? `HR approved your shift change for ${when}.`
              : `HR declined your shift change for ${when}.`,
          referenceType: 'shift_change_request',
          referenceId: updated.id,
          eyebrow: 'Shift change',
          paragraphs: [
            action === 'approve'
              ? `HR approved your shift change for ${when}. Attendance for those day(s) will use the requested shift.`
              : `HR declined your shift change for ${when}.`,
          ],
          ctaLabel: 'View status',
          ctaHref: portalUrl('/shift-change'),
        });
      }
      if (updated.projectLeadEmployeeId && updated.projectLeadEmployeeId !== actor.employeeId) {
        const lead = await loadStaffById(supabase, updated.projectLeadEmployeeId);
        if (lead) {
          await notifyStaff(supabase, lead, {
            type: 'shift_change',
            title: `Shift change ${nextStatus.toLowerCase()}`,
            message: `HR ${nextStatus.toLowerCase()} the shift change for ${updated.employeeName ?? 'your teammate'} (${when}).`,
            referenceType: 'shift_change_request',
            referenceId: updated.id,
            eyebrow: 'Shift change',
            paragraphs: [
              `HR ${nextStatus.toLowerCase()} the shift change for ${updated.employeeName ?? 'your teammate'} (${when}).`,
            ],
            ctaLabel: 'Open portal',
            ctaHref: portalUrl('/shift-change'),
          });
        }
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: action === 'approve' ? 'shift_change.approve' : 'shift_change.reject',
        entityType: 'shift_change_request',
        entityId: id,
        newValues: updated,
        ...meta,
      });
      return updated;
    },

    async cancel(actor: RequestUser, id: string, meta: RequestMeta): Promise<ShiftChangeRequest> {
      const existing = await loadRequest(supabase, id);
      if (existing.employeeId !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You can only cancel your own request.', 403);
      }
      if (existing.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Only a pending request can be cancelled.', 409);
      }
      const { error } = await supabase
        .from('shift_change_requests')
        .update({ status: 'CANCELLED' })
        .eq('id', id)
        .eq('status', 'PENDING');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to cancel request.', 500);
      }
      const updated = await loadRequest(supabase, id);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'shift_change.cancel',
        entityType: 'shift_change_request',
        entityId: id,
        newValues: updated,
        ...meta,
      });
      return updated;
    },
  };
}

export type ShiftChangeService = ReturnType<typeof createShiftChangeService>;

/** Approved override shift id for one employee/date, if any. */
export async function approvedShiftOverrideId(
  supabase: SupabaseClient,
  employeeId: string,
  isoDate: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('shift_change_requests')
    .select('requested_shift_id, start_date, end_date')
    .eq('employee_id', employeeId)
    .eq('status', 'APPROVED')
    .lte('start_date', isoDate)
    .gte('end_date', isoDate)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.requested_shift_id as string | undefined) ?? null;
}

export type ApprovedShiftOverride = {
  employeeId: string;
  startDate: string;
  endDate: string;
  shiftId: string;
};

export async function listApprovedShiftOverrides(
  supabase: SupabaseClient,
  rangeStart: string,
  rangeEnd: string,
): Promise<ApprovedShiftOverride[]> {
  const { data, error } = await supabase
    .from('shift_change_requests')
    .select('employee_id, start_date, end_date, requested_shift_id')
    .eq('status', 'APPROVED')
    .lte('start_date', rangeEnd)
    .gte('end_date', rangeStart);
  if (error) return [];
  return (data ?? []).map((row) => ({
    employeeId: row.employee_id as string,
    startDate: dateOnly(String(row.start_date)),
    endDate: dateOnly(String(row.end_date)),
    shiftId: row.requested_shift_id as string,
  }));
}

export function overrideShiftIdOnDate(
  overrides: ApprovedShiftOverride[],
  employeeId: string,
  isoDate: string,
): string | null {
  const match = overrides.find(
    (row) => row.employeeId === employeeId && row.startDate <= isoDate && row.endDate >= isoDate,
  );
  return match?.shiftId ?? null;
}
