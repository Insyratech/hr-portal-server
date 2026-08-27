import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { ledgerAvailable, currentPeriod } from './balance';
import { validateApplication } from './policy-engine';
import type { LeaveDuration, LeaveTypeFlags } from './types';
import {
  canApprove,
  canSeeAllApplications,
  insertNotification,
  loadActivePolicy,
  loadHolidayDates,
  loadWorkingDays,
  mapRpcError,
  notifyApprovers,
  notifyHrLeaveRecorded,
  writeLeaveAudit,
} from './support';
import { listWorkWeekRows } from '../attendance/work-week';
import { patternOnDate } from './day-count';
import { loadStaffById, notifyStaff } from '../notifications/notify-staff';
import { portalUrl, sendPortalMail } from '../notifications/mail';
import { syncEmployeeWorkDays } from '../work/daily';
import { assertHandoverColleagueFree, employeeIdsOnLeave } from './handover-availability';
import {
  currentLeadEmployeeId,
  listLeaveProjectOptions,
  loadProjectForLeave,
  notifyProjectLeadApproval,
  persistLeaveProjectId,
  resetLeaveApprovals,
} from './project-lead-approval';

type ApplicationRow = {
  id: string;
  employee_id: string;
  leave_type_id: string;
  policy_version_id: string;
  start_date: string;
  end_date: string;
  duration: LeaveDuration;
  quantity: number;
  reason: string | null;
  handover: string | null;
  handover_employee_id?: string | null;
  project_id?: string | null;
  reviewer_comment?: string | null;
  attachment_url: string | null;
  status: string;
  created_at: string;
  employees?: { full_name: string } | { full_name: string }[] | null;
  handover_employee?: { full_name: string } | { full_name: string }[] | null;
  projects?:
    | { name: string; code: string; lead_employee_id: string | null }
    | { name: string; code: string; lead_employee_id: string | null }[]
    | null;
  leave_types?: { name: string; code: string } | { name: string; code: string }[] | null;
  leave_approvals?: { approver_role: string; status: string }[] | null;
};

function first<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function mapApplication(row: ApplicationRow) {
  const project = first(row.projects);
  const approvals = row.leave_approvals ?? [];
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: first(row.employees)?.full_name ?? null,
    leaveTypeId: row.leave_type_id,
    leaveTypeName: first(row.leave_types)?.name ?? null,
    leaveTypeCode: first(row.leave_types)?.code ?? null,
    policyVersionId: row.policy_version_id,
    startDate: row.start_date,
    endDate: row.end_date,
    duration: row.duration,
    quantity: Number(row.quantity),
    reason: row.reason,
    handover: row.handover,
    handoverEmployeeId: row.handover_employee_id ?? null,
    handoverEmployeeName: first(row.handover_employee)?.full_name ?? null,
    handoverAccepted: !approvals.some((item) => item.approver_role === 'HANDOVER' && item.status === 'PENDING'),
    projectId: row.project_id ?? null,
    projectName: project?.name ?? null,
    projectCode: project?.code ?? null,
    projectLeadEmployeeId: project?.lead_employee_id ?? null,
    projectLeadAccepted: !approvals.some(
      (item) => item.approver_role === 'PROJECT_LEAD' && item.status === 'PENDING',
    ),
    hasProjectLeadStep: approvals.some((item) => item.approver_role === 'PROJECT_LEAD'),
    reviewerComment: row.reviewer_comment ?? null,
    attachmentUrl: row.attachment_url,
    status: row.status,
    createdAt: row.created_at,
  };
}

const APPLICATION_COLUMNS =
  'id, employee_id, leave_type_id, policy_version_id, start_date, end_date, duration, quantity, reason, reviewer_comment, handover, handover_employee_id, project_id, attachment_url, status, created_at, leave_types (name, code), projects (name, code, lead_employee_id), leave_approvals (approver_role, status)';

const APPLICATION_COLUMNS_HANDOVER =
  'id, employee_id, leave_type_id, policy_version_id, start_date, end_date, duration, quantity, reason, handover, handover_employee_id, attachment_url, status, created_at, leave_types (name, code), leave_approvals (approver_role, status)';

const APPLICATION_COLUMNS_LEGACY =
  'id, employee_id, leave_type_id, policy_version_id, start_date, end_date, duration, quantity, reason, handover, attachment_url, status, created_at, leave_types (name, code), leave_approvals (approver_role, status)';

async function loadEmployeeNames(supabase: SupabaseClient, rows: ApplicationRow[]): Promise<Record<string, string>> {
  const ids = [...new Set(rows.flatMap((row) => [row.employee_id, row.handover_employee_id]).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return {};
  const { data } = await supabase.from('employees').select('id, full_name').in('id', ids);
  const names: Record<string, string> = {};
  for (const row of data ?? []) {
    names[row.id as string] = row.full_name as string;
  }
  return names;
}

function mapApplicationWithNames(row: ApplicationRow, names: Record<string, string>) {
  const mapped = mapApplication(row);
  return {
    ...mapped,
    employeeName: names[row.employee_id] ?? mapped.employeeName,
    handoverEmployeeName: row.handover_employee_id
      ? names[row.handover_employee_id] ?? mapped.handoverEmployeeName
      : mapped.handoverEmployeeName ?? row.handover,
  };
}

async function hydrateHandoverIds(supabase: SupabaseClient, rows: ApplicationRow[]): Promise<ApplicationRow[]> {
  const unresolved = rows.filter((row) => !row.handover_employee_id && row.handover);
  if (unresolved.length === 0) return rows;
  const labels = [...new Set(unresolved.map((row) => row.handover as string))];
  const { data } = await supabase.from('employees').select('id, full_name').in('full_name', labels);
  const byName = new Map((data ?? []).map((item) => [item.full_name as string, item.id as string]));
  return rows.map((row) => ({
    ...row,
    handover_employee_id: row.handover_employee_id ?? (row.handover ? byName.get(row.handover) ?? null : null),
  }));
}

async function persistHandoverEmployeeId(
  supabase: SupabaseClient,
  applicationId: string,
  employeeId: string | null,
): Promise<void> {
  const { error } = await supabase.from('leave_applications').update({ handover_employee_id: employeeId }).eq('id', applicationId);
  if (error && !/handover_employee_id/i.test(error.message ?? '')) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message || 'Failed to save handover colleague.', 500);
  }
}

const ACTION_LABEL: Record<'approve' | 'reject' | 'cancel', string> = {
  approve: 'approved',
  reject: 'rejected',
  cancel: 'cancelled',
};

type LeaveWriteInput = {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  duration: LeaveDuration;
  reason?: string;
  handover?: string;
  handoverEmployeeId?: string;
  attachmentUrl?: string;
  projectId?: string;
};

async function persistReviewerComment(
  supabase: SupabaseClient,
  applicationId: string,
  comment: string | null,
): Promise<void> {
  const { error } = await supabase.from('leave_applications').update({ reviewer_comment: comment }).eq('id', applicationId);
  if (error && !/reviewer_comment/i.test(error.message ?? '')) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message || 'Failed to save reviewer comment.', 500);
  }
}

async function approveApprovalRole(
  supabase: SupabaseClient,
  applicationId: string,
  role: string,
  actorId: string,
): Promise<void> {
  const { error } = await supabase
    .from('leave_approvals')
    .update({ status: 'APPROVED', actor_id: actorId, decided_at: new Date().toISOString() })
    .eq('application_id', applicationId)
    .eq('approver_role', role)
    .eq('status', 'PENDING');
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to complete ${role} approval.`, 500);
  }
}

async function resolveLeaveProjectStep(
  supabase: SupabaseClient,
  actor: RequestUser,
  requiresApproval: boolean,
  projectId: string | undefined,
): Promise<{
  project: Awaited<ReturnType<typeof loadProjectForLeave>> | null;
  withProjectLead: boolean;
  projectLeadAccepted: boolean;
}> {
  if (!requiresApproval) {
    return { project: null, withProjectLead: false, projectLeadAccepted: true };
  }
  const options = await listLeaveProjectOptions(supabase, actor.employeeId);
  if (options.length === 0) {
    return { project: null, withProjectLead: false, projectLeadAccepted: true };
  }
  if (!projectId) {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      'Select which project this leave relates to.',
      400,
    );
  }
  const project = await loadProjectForLeave(supabase, projectId, actor.employeeId);
  const applicantIsLead = project.leadEmployeeId === actor.employeeId;
  return {
    project,
    withProjectLead: true,
    projectLeadAccepted: applicantIsLead,
  };
}

export function createLeaveApplicationService(supabase: SupabaseClient) {
  return {
    async listBalances(actor: RequestUser) {
      const { data: allocations, error } = await supabase
        .from('leave_allocations')
        .select('id, leave_type_id, period, allocated, carried_forward, adjusted, used, available, leave_types (code, name)')
        .eq('employee_id', actor.employeeId)
        .eq('period', currentPeriod());
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load leave balances.', 500);
      }

      const items = [];
      for (const row of allocations ?? []) {
        const { data: ledger } = await supabase
          .from('leave_ledger')
          .select('quantity')
          .eq('allocation_id', row.id);
        const computed = ledgerAvailable((ledger ?? []) as { quantity: number }[]);
        const available = Number(row.available);
        if (computed !== available) {
          await supabase.rpc('recompute_leave_allocation', { p_allocation_id: row.id });
        }
        const type = first(row.leave_types as { code: string; name: string } | { code: string; name: string }[] | null);
        items.push({
          leaveTypeId: row.leave_type_id as string,
          code: type?.code ?? '',
          name: type?.name ?? '',
          period: row.period as string,
          allocated: Number(row.allocated),
          used: Number(row.used),
          available: computed,
        });
      }
      return items;
    },

    async listApplications(actor: RequestUser, status?: string) {
      const canSeeAll = canSeeAllApplications(actor);

      const fetchScoped = async (columns: string) => {
        if (canSeeAll) {
          let query = supabase.from('leave_applications').select(columns).order('created_at', { ascending: false });
          if (status) query = query.eq('status', status);
          return query;
        }

        let own = supabase
          .from('leave_applications')
          .select(columns)
          .eq('employee_id', actor.employeeId)
          .order('created_at', { ascending: false });
        if (status) own = own.eq('status', status);
        const ownResult = await own;

        let handover = supabase
          .from('leave_applications')
          .select(columns)
          .eq('handover_employee_id', actor.employeeId)
          .order('created_at', { ascending: false });
        if (status) handover = handover.eq('status', status);
        const handoverResult = await handover;

        if (ownResult.error && handoverResult.error) {
          return { data: null, error: ownResult.error };
        }

        const byId = new Map<string, ApplicationRow>();
        for (const row of (ownResult.data ?? []) as unknown as ApplicationRow[]) {
          byId.set(row.id, row);
        }
        if (!handoverResult.error) {
          for (const row of (handoverResult.data ?? []) as unknown as ApplicationRow[]) {
            byId.set(row.id, row);
          }
        }

        const { data: actorRow } = await supabase.from('employees').select('full_name').eq('id', actor.employeeId).maybeSingle();
        const handoverLabel = actorRow?.full_name as string | undefined;
        if (handoverLabel) {
          let named = supabase
            .from('leave_applications')
            .select(columns)
            .eq('handover', handoverLabel)
            .order('created_at', { ascending: false });
          if (status) named = named.eq('status', status);
          const namedResult = await named;
          if (!namedResult.error) {
            for (const row of (namedResult.data ?? []) as unknown as ApplicationRow[]) {
              byId.set(row.id, row);
            }
          }
        }

        // Pending PROJECT_LEAD steps for projects I currently lead.
        const { data: leadProjects } = await supabase
          .from('projects')
          .select('id')
          .eq('lead_employee_id', actor.employeeId);
        const leadProjectIds = (leadProjects ?? []).map((row) => row.id as string);
        if (leadProjectIds.length) {
          let leadQuery = supabase
            .from('leave_applications')
            .select(columns)
            .in('project_id', leadProjectIds)
            .order('created_at', { ascending: false });
          if (status) leadQuery = leadQuery.eq('status', status);
          const leadResult = await leadQuery;
          if (!leadResult.error) {
            for (const row of (leadResult.data ?? []) as unknown as ApplicationRow[]) {
              const pendingLead = (row.leave_approvals ?? []).some(
                (item) => item.approver_role === 'PROJECT_LEAD' && item.status === 'PENDING',
              );
              if (pendingLead) byId.set(row.id, row);
            }
          }
        }

        const withLead = [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        return { data: withLead, error: null };
      };

      let { data, error } = await fetchScoped(APPLICATION_COLUMNS);
      if (error) {
        ({ data, error } = await fetchScoped(APPLICATION_COLUMNS_HANDOVER));
      }
      if (error) {
        ({ data, error } = await fetchScoped(APPLICATION_COLUMNS_LEGACY));
      }
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message || 'Failed to load leave applications.', 500);
      }
      const rows = await hydrateHandoverIds(supabase, (data ?? []) as unknown as ApplicationRow[]);
      const names = await loadEmployeeNames(supabase, rows);
      return rows.map((row) => mapApplicationWithNames(row, names));
    },

    async getApplication(actor: RequestUser, id: string) {
      let { data, error } = await supabase.from('leave_applications').select(APPLICATION_COLUMNS).eq('id', id).maybeSingle();
      if (error) {
        ({ data, error } = await supabase.from('leave_applications').select(APPLICATION_COLUMNS_HANDOVER).eq('id', id).maybeSingle());
      }
      if (error) {
        ({ data, error } = await supabase.from('leave_applications').select(APPLICATION_COLUMNS_LEGACY).eq('id', id).maybeSingle());
      }
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message || 'Failed to load leave application.', 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Leave application not found.', 404);
      }
      const row = ((await hydrateHandoverIds(supabase, [data as ApplicationRow]))[0] ?? data) as ApplicationRow;
      const names = await loadEmployeeNames(supabase, [row]);
      const mapped = mapApplicationWithNames(row, names);
      const isLeadViewer =
        Boolean(mapped.projectId) &&
        mapped.projectLeadEmployeeId === actor.employeeId &&
        mapped.hasProjectLeadStep &&
        !mapped.projectLeadAccepted;
      if (
        mapped.employeeId !== actor.employeeId &&
        mapped.handoverEmployeeId !== actor.employeeId &&
        !isLeadViewer &&
        !canSeeAllApplications(actor)
      ) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view this application.', 403);
      }
      return mapped;
    },

    async apply(
      actor: RequestUser,
      input: {
        leaveTypeId: string;
        startDate: string;
        endDate: string;
        duration: LeaveDuration;
        reason?: string;
        handover?: string;
        handoverEmployeeId?: string;
        attachmentUrl?: string;
        projectId?: string;
      },
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      if (!actor.permissions.includes(PERMISSIONS.LEAVE_APPLY) && !canApprove(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot apply for leave.', 403);
      }

      const { data: employee, error: employeeError } = await supabase
        .from('employees')
        .select('id, full_name, joining_date, employment_type, department_id, designation_id, status, user_id')
        .eq('id', actor.employeeId)
        .maybeSingle();
      if (employeeError || !employee) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
      }

      const { data: leaveType, error: typeError } = await supabase
        .from('leave_types')
        .select('*')
        .eq('id', input.leaveTypeId)
        .maybeSingle();
      if (typeError || !leaveType) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Leave type not found.', 404);
      }

      const flags: LeaveTypeFlags = {
        active: Boolean(leaveType.active),
        requiresApproval: Boolean(leaveType.requires_approval),
        requiresHandover: Boolean(leaveType.requires_handover),
        requiresAttachment: Boolean(leaveType.requires_attachment),
        allowHalfDay: Boolean(leaveType.allow_half_day),
        allowMultipleDays: Boolean(leaveType.allow_multiple_days),
      };

      const policy = await loadActivePolicy(supabase, input.leaveTypeId);
      const workingDays = await loadWorkingDays(supabase);
      const holidayDates = await loadHolidayDates(supabase);
      const workWeeks = await listWorkWeekRows(supabase, actor.employeeId);
      const weekPatternForDate = (isoDate: string) => patternOnDate(workWeeks, actor.employeeId, isoDate);
      const period = currentPeriod();

      const { data: allocation } = await supabase
        .from('leave_allocations')
        .select('id, available')
        .eq('employee_id', actor.employeeId)
        .eq('leave_type_id', input.leaveTypeId)
        .eq('period', period)
        .maybeSingle();
      if (!allocation) {
        throw new AppError(API_ERROR_CODES.NOT_ELIGIBLE, 'This leave type is not allocated to you.', 403);
      }

      const { data: overlaps } = await supabase
        .from('leave_applications')
        .select('id')
        .eq('employee_id', actor.employeeId)
        .in('status', ['PENDING', 'APPROVED'])
        .lte('start_date', input.endDate)
        .gte('end_date', input.startDate);

      const result = validateApplication(flags, policy.rules, {
        startDate: input.startDate,
        endDate: input.endDate,
        duration: input.duration,
        reason: input.reason,
        handover: input.handover,
        handoverEmployeeId: input.handoverEmployeeId,
        attachmentUrl: input.attachmentUrl,
        now: new Date(),
        joiningDate: employee.joining_date as string,
        employmentType: employee.employment_type as string,
        departmentId: (employee.department_id as string | null) ?? null,
        designationId: (employee.designation_id as string | null) ?? null,
        employeeStatus: employee.status as 'active' | 'inactive',
        available: allocation ? Number(allocation.available) : policy.rules.annualAllocation,
        overlapping: (overlaps ?? []).length > 0,
        workingDays,
        holidayDates,
        weekPatternForDate,
      });

      if (!result.valid) {
        const first = result.violations[0];
        throw new AppError(first.code, first.message, first.code === API_ERROR_CODES.FORBIDDEN ? 403 : 400);
      }

      let handoverPerson: { id: string; full_name: string; email: string | null; user_id: string | null } | null = null;
      if (result.requiresHandover) {
        if (!input.handoverEmployeeId || input.handoverEmployeeId === actor.employeeId) {
          throw new AppError(API_ERROR_CODES.HANDOVER_REQUIRED, 'Select a colleague to take handover.', 400);
        }
        const loaded = await supabase
          .from('employees')
          .select('id, full_name, email, user_id')
          .eq('id', input.handoverEmployeeId)
          .maybeSingle();
        if (!loaded.data) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Handover colleague was not found.', 400);
        }
        handoverPerson = loaded.data as { id: string; full_name: string; email: string | null; user_id: string | null };
        await assertHandoverColleagueFree(supabase, handoverPerson.id, input.startDate, input.endDate);
      }

      const projectStep = await resolveLeaveProjectStep(
        supabase,
        actor,
        result.requiresApproval,
        input.projectId,
      );

      const status = result.requiresApproval || result.requiresHandover ? 'PENDING' : 'APPROVED';
      const { data, error } = await supabase.rpc('apply_leave_application', {
        p_employee_id: actor.employeeId,
        p_leave_type_id: input.leaveTypeId,
        p_policy_version_id: policy.versionId,
        p_start_date: input.startDate,
        p_end_date: input.endDate,
        p_duration: input.duration,
        p_quantity: result.quantity,
        p_reason: input.reason ?? null,
        p_handover: handoverPerson?.full_name ?? input.handover ?? null,
        p_attachment_url: input.attachmentUrl ?? null,
        p_status: status,
        p_period: period,
        p_annual_allocation: policy.rules.annualAllocation,
        p_allow_negative: policy.rules.allowNegativeBalance,
      });

      if (error) {
        mapRpcError(error);
      }

      const createdId = typeof data === 'string' ? (JSON.parse(data) as { id: string }).id : (data as { id: string }).id;
      await persistLeaveProjectId(supabase, createdId, projectStep.project?.id ?? null);
      if (handoverPerson) {
        await persistHandoverEmployeeId(supabase, createdId, handoverPerson.id);
      }

      const combineLeadWithHandover = Boolean(
        projectStep.withProjectLead &&
          handoverPerson &&
          handoverPerson.id === projectStep.project?.leadEmployeeId,
      );

      if (status === 'PENDING') {
        await resetLeaveApprovals(supabase, createdId, {
          withHandover: Boolean(handoverPerson),
          withProjectLead: projectStep.withProjectLead,
          handoverAccepted: false,
          projectLeadAccepted: projectStep.projectLeadAccepted,
        });

        if (handoverPerson) {
          if (handoverPerson.user_id) {
            await insertNotification(supabase, {
              userId: handoverPerson.user_id,
              title: 'Handover requested',
              message: `${employee.full_name as string} asked you to take handover for leave.`,
              referenceId: createdId,
            });
          }
          await sendPortalMail({
            to: [handoverPerson.email ?? ''],
            subject: 'Handover requested',
            eyebrow: 'Leave',
            title: 'Handover requested',
            paragraphs: [
              `${employee.full_name as string} applied for leave and named you for handover.`,
              combineLeadWithHandover
                ? 'Accepting also completes the project-lead step because you lead this project.'
                : 'Review and accept the handover in HR Portal before the next approval step.',
            ],
            cta: { label: 'Review and accept', href: portalUrl(`/leave/handover/${createdId}`) },
          });
        } else if (projectStep.withProjectLead && !projectStep.projectLeadAccepted && projectStep.project) {
          await notifyProjectLeadApproval(supabase, {
            applicationId: createdId,
            projectName: projectStep.project.name,
            applicantName: employee.full_name as string,
            startDate: input.startDate,
            endDate: input.endDate,
            leadEmployeeId: projectStep.project.leadEmployeeId,
          });
        } else {
          await notifyApprovers(supabase, createdId, employee.full_name as string);
        }
      } else {
        await notifyStaff(supabase, await loadStaffById(supabase, actor.employeeId), {
          type: 'leave',
          title: 'Leave approved',
          message: 'Your leave was auto-approved.',
          referenceType: 'leave_application',
          referenceId: createdId,
          eyebrow: 'Leave',
          paragraphs: ['Your leave request was auto-approved. Sign in to review the dates.'],
          ctaLabel: 'View leave',
        });
        await notifyHrLeaveRecorded(
          supabase,
          createdId,
          employee.full_name as string,
          (leaveType.name as string) || 'leave',
        );
        await syncEmployeeWorkDays(supabase, actor.employeeId, input.startDate, input.endDate);
      }

      const created = await this.getApplication(actor, createdId);
      await writeLeaveAudit(supabase, actor.employeeId, 'leave.apply', createdId, created, meta);
      return created;
    },

    async update(actor: RequestUser, id: string, input: LeaveWriteInput, meta: { ipAddress?: string | null; userAgent?: string | null }) {
      const existing = await this.getApplication(actor, id);
      if (existing.employeeId !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You can only edit your own leave request.', 403);
      }
      if (existing.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Only a pending leave request can be edited.', 409);
      }
      if (!actor.permissions.includes(PERMISSIONS.LEAVE_APPLY) && !canApprove(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot edit this leave request.', 403);
      }

      const { data: employee, error: employeeError } = await supabase
        .from('employees')
        .select('id, full_name, joining_date, employment_type, department_id, designation_id, status, user_id')
        .eq('id', actor.employeeId)
        .maybeSingle();
      if (employeeError || !employee) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
      }

      const { data: leaveType, error: typeError } = await supabase
        .from('leave_types')
        .select('*')
        .eq('id', input.leaveTypeId)
        .maybeSingle();
      if (typeError || !leaveType) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Leave type not found.', 404);
      }

      const flags: LeaveTypeFlags = {
        active: Boolean(leaveType.active),
        requiresApproval: Boolean(leaveType.requires_approval),
        requiresHandover: Boolean(leaveType.requires_handover),
        requiresAttachment: Boolean(leaveType.requires_attachment),
        allowHalfDay: Boolean(leaveType.allow_half_day),
        allowMultipleDays: Boolean(leaveType.allow_multiple_days),
      };

      const policy = await loadActivePolicy(supabase, input.leaveTypeId);
      const workingDays = await loadWorkingDays(supabase);
      const holidayDates = await loadHolidayDates(supabase);
      const workWeeks = await listWorkWeekRows(supabase, actor.employeeId);
      const weekPatternForDate = (isoDate: string) => patternOnDate(workWeeks, actor.employeeId, isoDate);
      const period = currentPeriod();

      const { data: allocation } = await supabase
        .from('leave_allocations')
        .select('id, available')
        .eq('employee_id', actor.employeeId)
        .eq('leave_type_id', input.leaveTypeId)
        .eq('period', period)
        .maybeSingle();
      if (!allocation) {
        throw new AppError(API_ERROR_CODES.NOT_ELIGIBLE, 'This leave type is not allocated to you.', 403);
      }

      const sameType = existing.leaveTypeId === input.leaveTypeId;
      const available =
        (allocation ? Number(allocation.available) : policy.rules.annualAllocation) + (sameType ? existing.quantity : 0);

      const { data: overlaps } = await supabase
        .from('leave_applications')
        .select('id')
        .eq('employee_id', actor.employeeId)
        .in('status', ['PENDING', 'APPROVED'])
        .neq('id', id)
        .lte('start_date', input.endDate)
        .gte('end_date', input.startDate);

      const result = validateApplication(flags, policy.rules, {
        startDate: input.startDate,
        endDate: input.endDate,
        duration: input.duration,
        reason: input.reason,
        handover: input.handover,
        handoverEmployeeId: input.handoverEmployeeId,
        attachmentUrl: input.attachmentUrl,
        now: new Date(),
        joiningDate: employee.joining_date as string,
        employmentType: employee.employment_type as string,
        departmentId: (employee.department_id as string | null) ?? null,
        designationId: (employee.designation_id as string | null) ?? null,
        employeeStatus: employee.status as 'active' | 'inactive',
        available,
        overlapping: (overlaps ?? []).length > 0,
        workingDays,
        holidayDates,
        weekPatternForDate,
      });

      if (!result.valid) {
        const first = result.violations[0];
        throw new AppError(first.code, first.message, first.code === API_ERROR_CODES.FORBIDDEN ? 403 : 400);
      }

      let handoverPerson: { id: string; full_name: string; email: string | null; user_id: string | null } | null = null;
      if (result.requiresHandover) {
        if (!input.handoverEmployeeId || input.handoverEmployeeId === actor.employeeId) {
          throw new AppError(API_ERROR_CODES.HANDOVER_REQUIRED, 'Select a colleague to take handover.', 400);
        }
        const loaded = await supabase
          .from('employees')
          .select('id, full_name, email, user_id')
          .eq('id', input.handoverEmployeeId)
          .maybeSingle();
        if (!loaded.data) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Handover colleague was not found.', 400);
        }
        handoverPerson = loaded.data as { id: string; full_name: string; email: string | null; user_id: string | null };
        await assertHandoverColleagueFree(supabase, handoverPerson.id, input.startDate, input.endDate);
      }

      const { error: updateError } = await supabase
        .from('leave_applications')
        .update({
          leave_type_id: input.leaveTypeId,
          policy_version_id: policy.versionId,
          start_date: input.startDate,
          end_date: input.endDate,
          duration: input.duration,
          quantity: result.quantity,
          reason: input.reason ?? null,
          handover: handoverPerson?.full_name ?? input.handover ?? null,
          attachment_url: input.attachmentUrl ?? null,
          status: 'PENDING',
        })
        .eq('id', id);
      if (updateError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, updateError.message || 'Failed to update leave request.', 500);
      }
      await persistHandoverEmployeeId(supabase, id, handoverPerson?.id ?? null);
      await persistReviewerComment(supabase, id, null);

      const projectStep = await resolveLeaveProjectStep(
        supabase,
        actor,
        result.requiresApproval,
        input.projectId,
      );
      await persistLeaveProjectId(supabase, id, projectStep.project?.id ?? null);

      if (sameType && allocation) {
        await supabase
          .from('leave_ledger')
          .update({ quantity: -result.quantity })
          .eq('reference_id', id)
          .eq('transaction_type', 'LEAVE_PENDING');
        await supabase.rpc('recompute_leave_allocation', { p_allocation_id: allocation.id });
      } else {
        const { data: oldAlloc } = await supabase
          .from('leave_allocations')
          .select('id')
          .eq('employee_id', actor.employeeId)
          .eq('leave_type_id', existing.leaveTypeId)
          .eq('period', period)
          .maybeSingle();
        await supabase.from('leave_ledger').delete().eq('reference_id', id).eq('transaction_type', 'LEAVE_PENDING');
        if (oldAlloc?.id) {
          await supabase.rpc('recompute_leave_allocation', { p_allocation_id: oldAlloc.id });
        }
        if (allocation?.id) {
          await supabase.from('leave_ledger').insert({
            employee_id: actor.employeeId,
            leave_type_id: input.leaveTypeId,
            allocation_id: allocation.id,
            transaction_type: 'LEAVE_PENDING',
            quantity: -result.quantity,
            reference_type: 'leave_application',
            reference_id: id,
          });
          await supabase.rpc('recompute_leave_allocation', { p_allocation_id: allocation.id });
        }
      }

      const keepHandover = Boolean(
        handoverPerson && existing.handoverEmployeeId === handoverPerson.id && existing.handoverAccepted,
      );
      const keepLead = Boolean(
        projectStep.withProjectLead &&
          existing.projectId === projectStep.project?.id &&
          existing.projectLeadAccepted &&
          (keepHandover ||
            !handoverPerson ||
            (handoverPerson &&
              existing.handoverAccepted &&
              handoverPerson.id === projectStep.project?.leadEmployeeId)),
      );
      const combineLeadWithHandover = Boolean(
        projectStep.withProjectLead &&
          handoverPerson &&
          handoverPerson.id === projectStep.project?.leadEmployeeId,
      );
      const projectLeadAccepted =
        projectStep.projectLeadAccepted ||
        keepLead ||
        (combineLeadWithHandover && keepHandover);

      await resetLeaveApprovals(supabase, id, {
        withHandover: Boolean(handoverPerson),
        withProjectLead: projectStep.withProjectLead,
        handoverAccepted: keepHandover,
        projectLeadAccepted,
      });

      if (handoverPerson && !keepHandover) {
        if (handoverPerson.user_id) {
          await insertNotification(supabase, {
            userId: handoverPerson.user_id,
            title: 'Handover requested',
            message: `${employee.full_name as string} updated a leave request and asked you to take handover.`,
            referenceId: id,
          });
        }
        await sendPortalMail({
          to: [handoverPerson.email ?? ''],
          subject: 'Handover requested',
          eyebrow: 'Leave',
          title: 'Handover requested',
          paragraphs: [
            `${employee.full_name as string} updated an existing leave request and named you for handover.`,
            combineLeadWithHandover
              ? 'Accepting also completes the project-lead step because you lead this project.'
              : 'Review and accept the handover in HR Portal before the next approval step.',
          ],
          cta: { label: 'Review and accept', href: portalUrl(`/leave/handover/${id}`) },
        });
      } else if (
        projectStep.withProjectLead &&
        !projectLeadAccepted &&
        projectStep.project &&
        keepHandover
      ) {
        await notifyProjectLeadApproval(supabase, {
          applicationId: id,
          projectName: projectStep.project.name,
          applicantName: employee.full_name as string,
          startDate: input.startDate,
          endDate: input.endDate,
          leadEmployeeId: projectStep.project.leadEmployeeId,
        });
      } else if (!handoverPerson || keepHandover) {
        if (projectStep.withProjectLead && !projectLeadAccepted && projectStep.project && !handoverPerson) {
          await notifyProjectLeadApproval(supabase, {
            applicationId: id,
            projectName: projectStep.project.name,
            applicantName: employee.full_name as string,
            startDate: input.startDate,
            endDate: input.endDate,
            leadEmployeeId: projectStep.project.leadEmployeeId,
          });
        } else if (projectLeadAccepted || !projectStep.withProjectLead) {
          await notifyApprovers(supabase, id, employee.full_name as string, {
            updated: true,
            handoverAcceptedBy: keepHandover
              ? (existing.handoverEmployeeName ?? handoverPerson?.full_name ?? undefined)
              : undefined,
          });
        }
      }

      const updated = await this.getApplication(actor, id);
      await writeLeaveAudit(supabase, actor.employeeId, 'leave.update', id, updated, meta);
      return updated;
    },

    async decide(
      actor: RequestUser,
      id: string,
      action: 'approve' | 'reject' | 'cancel',
      comment: string | undefined,
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      const existing = await this.getApplication(actor, id);
      if (action === 'cancel' && existing.employeeId !== actor.employeeId && !canApprove(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot cancel this application.', 403);
      }
      if (action !== 'cancel' && !canApprove(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot decide this application.', 403);
      }
      if (action === 'approve' && !existing.handoverAccepted) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Handover must be accepted before HR can approve.', 400);
      }
      if (action === 'approve' && existing.hasProjectLeadStep && !existing.projectLeadAccepted) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Project lead must approve before HR can approve.',
          400,
        );
      }

      const { error } = await supabase.rpc('finalise_leave_application', {
        p_application_id: id,
        p_action: action,
        p_actor_id: actor.employeeId,
        p_comment: comment ?? null,
      });
      if (error) {
        mapRpcError(error);
      }

      const updated = await this.getApplication(actor, id);
      await writeLeaveAudit(supabase, actor.employeeId, `leave.${action}`, id, updated, meta);
      if (action === 'approve' || action === 'cancel') {
        await syncEmployeeWorkDays(supabase, existing.employeeId, existing.startDate, existing.endDate);
      }

      const verb = ACTION_LABEL[action];
      const applicant = await loadStaffById(supabase, existing.employeeId);
      const handoverColleague = existing.handoverEmployeeId
        ? await loadStaffById(supabase, existing.handoverEmployeeId)
        : null;

      if (applicant) {
        await notifyStaff(supabase, applicant, {
          type: 'leave',
          title: `Leave ${verb}`,
          message: `Leave for ${existing.startDate} to ${existing.endDate} was ${verb}.`,
          referenceType: 'leave_application',
          referenceId: id,
          eyebrow: 'Leave',
          paragraphs: [`Leave for ${existing.startDate} to ${existing.endDate} was ${verb}.`],
          details: [
            { label: 'From', value: existing.startDate },
            { label: 'To', value: existing.endDate },
            { label: 'Status', value: verb[0].toUpperCase() + verb.slice(1) },
          ],
          ctaLabel: 'View leave',
          ctaHref: portalUrl('/leave'),
        });
      }

      if (handoverColleague && handoverColleague.id !== applicant?.id) {
        const applicantName = existing.employeeName ?? 'A colleague';
        const handoverMessage =
          action === 'cancel'
            ? `${applicantName} cancelled leave you were asked to take handover for (${existing.startDate} to ${existing.endDate}).`
            : `Leave you were named for handover (${existing.startDate} to ${existing.endDate}) was ${verb}.`;
        await notifyStaff(supabase, handoverColleague, {
          type: 'leave',
          title: action === 'cancel' ? 'Leave cancelled' : `Leave ${verb}`,
          message: handoverMessage,
          referenceType: 'leave_application',
          referenceId: id,
          eyebrow: 'Leave',
          paragraphs: [handoverMessage],
          details: [
            { label: 'From', value: existing.startDate },
            { label: 'To', value: existing.endDate },
            { label: 'Status', value: verb[0].toUpperCase() + verb.slice(1) },
          ],
          ctaLabel: 'Review leave',
          ctaHref: portalUrl(`/leave/handover/${id}`),
        });
      }
      return updated;
    },

    async requestChanges(
      actor: RequestUser,
      id: string,
      comment: string,
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      if (!canApprove(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request changes on this application.', 403);
      }
      const note = comment.trim();
      if (!note) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Describe the changes you need.', 400);
      }
      const existing = await this.getApplication(actor, id);
      if (existing.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Only a pending leave request can be updated.', 409);
      }
      await persistReviewerComment(supabase, id, note);
      await writeLeaveAudit(supabase, actor.employeeId, 'leave.request_changes', id, { comment: note }, meta);
      await notifyStaff(supabase, await loadStaffById(supabase, existing.employeeId), {
        type: 'leave',
        title: 'Changes requested',
        message: `${actor.fullName} asked you to update your leave request: ${note}`,
        referenceType: 'leave_application',
        referenceId: id,
        eyebrow: 'Leave',
        paragraphs: [`${actor.fullName} asked you to update your leave request.`, note],
        details: [
          { label: 'From', value: existing.startDate },
          { label: 'To', value: existing.endDate },
        ],
        ctaLabel: 'Update leave',
        ctaHref: portalUrl(`/leave?applicationId=${id}`),
      });
      return this.getApplication(actor, id);
    },

    async acceptHandover(actor: RequestUser, id: string, meta: { ipAddress?: string | null; userAgent?: string | null }) {
      const existing = await this.getApplication(actor, id);
      if (existing.handoverEmployeeId !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only the handover colleague can accept this request.', 403);
      }
      if (existing.handoverAccepted) {
        return existing;
      }
      await approveApprovalRole(supabase, id, 'HANDOVER', actor.employeeId);

      const leadId =
        existing.projectLeadEmployeeId ?? (await currentLeadEmployeeId(supabase, existing.projectId));
      const combinesLead = Boolean(
        existing.hasProjectLeadStep && !existing.projectLeadAccepted && leadId && leadId === actor.employeeId,
      );
      if (combinesLead) {
        await approveApprovalRole(supabase, id, 'PROJECT_LEAD', actor.employeeId);
      }

      const applicantName = existing.employeeName ?? 'Employee';
      const acceptorName = actor.fullName || existing.handoverEmployeeName || 'Handover colleague';
      await notifyStaff(supabase, await loadStaffById(supabase, existing.employeeId), {
        type: 'leave',
        title: 'Handover accepted',
        message: `${acceptorName} accepted your handover request.`,
        referenceType: 'leave_application',
        referenceId: id,
        eyebrow: 'Leave',
        paragraphs: [
          `${acceptorName} accepted handover for your leave (${existing.startDate} to ${existing.endDate}).`,
          combinesLead
            ? 'Project-lead approval was completed in the same step. Your request is now with HR.'
            : existing.hasProjectLeadStep && !existing.projectLeadAccepted
              ? 'Next, your project lead will review the request.'
              : 'Your request is now under review.',
        ],
        details: [
          { label: 'From', value: existing.startDate },
          { label: 'To', value: existing.endDate },
          { label: 'Handover', value: acceptorName },
        ],
        ctaLabel: 'View leave',
        ctaHref: portalUrl('/leave'),
      });

      if (combinesLead || !existing.hasProjectLeadStep || existing.projectLeadAccepted) {
        await notifyApprovers(supabase, id, applicantName, { handoverAcceptedBy: acceptorName });
      } else if (existing.projectId && leadId) {
        await notifyProjectLeadApproval(supabase, {
          applicationId: id,
          projectName: existing.projectName ?? 'Project',
          applicantName,
          startDate: existing.startDate,
          endDate: existing.endDate,
          leadEmployeeId: leadId,
        });
      }

      await writeLeaveAudit(supabase, actor.employeeId, 'leave.handover_accept', id, existing, meta);
      return this.getApplication(actor, id);
    },

    async acceptProjectLead(
      actor: RequestUser,
      id: string,
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      const existing = await this.getApplication(actor, id);
      if (!existing.projectId || !existing.hasProjectLeadStep) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This leave has no project-lead step.', 400);
      }
      if (existing.status !== 'PENDING') {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'Only a pending leave request can be approved.', 409);
      }
      if (!existing.handoverAccepted) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Handover must be accepted before project-lead approval.',
          400,
        );
      }
      if (existing.projectLeadAccepted) {
        return existing;
      }

      const leadId =
        (await currentLeadEmployeeId(supabase, existing.projectId)) ?? existing.projectLeadEmployeeId;
      if (!leadId || leadId !== actor.employeeId) {
        throw new AppError(
          API_ERROR_CODES.FORBIDDEN,
          'Only the current project lead can approve this step.',
          403,
        );
      }

      await approveApprovalRole(supabase, id, 'PROJECT_LEAD', actor.employeeId);

      const applicantName = existing.employeeName ?? 'Employee';
      await notifyStaff(supabase, await loadStaffById(supabase, existing.employeeId), {
        type: 'leave',
        title: 'Project lead approved',
        message: `${actor.fullName} approved your leave as project lead.`,
        referenceType: 'leave_application',
        referenceId: id,
        eyebrow: 'Leave',
        paragraphs: [
          `${actor.fullName} approved your leave as project lead (${existing.startDate} to ${existing.endDate}).`,
          'Your request is now with HR.',
        ],
        details: [
          { label: 'From', value: existing.startDate },
          { label: 'To', value: existing.endDate },
          { label: 'Project', value: existing.projectName ?? existing.projectCode ?? 'Project' },
        ],
        ctaLabel: 'View leave',
        ctaHref: portalUrl('/leave'),
      });
      await notifyApprovers(supabase, id, applicantName, {
        handoverAcceptedBy: existing.handoverEmployeeName ?? undefined,
      });
      await writeLeaveAudit(supabase, actor.employeeId, 'leave.project_lead_accept', id, existing, meta);
      return this.getApplication(actor, id);
    },

    async listLeaveProjects(actor: RequestUser) {
      return listLeaveProjectOptions(supabase, actor.employeeId);
    },

    async listColleagues(actor: RequestUser, startDate?: string, endDate?: string) {
      const { data, error } = await supabase
        .from('employees')
        .select('id, full_name')
        .eq('status', 'active')
        .neq('id', actor.employeeId)
        .order('full_name');
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load colleagues.', 500);
      const rangeStart = startDate?.slice(0, 10);
      const rangeEnd = (endDate || startDate)?.slice(0, 10);
      const busy =
        rangeStart && rangeEnd ? await employeeIdsOnLeave(supabase, rangeStart, rangeEnd) : new Map<string, { startDate: string; endDate: string }>();
      return (data ?? []).map((row) => {
        const id = row.id as string;
        const clash = busy.get(id);
        return {
          id,
          fullName: row.full_name as string,
          available: !clash,
          leaveDates: clash ? `${clash.startDate} – ${clash.endDate}` : null,
        };
      });
    },
  };
}
