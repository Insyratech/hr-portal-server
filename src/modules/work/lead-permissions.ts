import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { mapApplication } from '../leave/application-service';
import { createShiftChangeService } from '../shift-changes/service';
import type { ShiftChangeRequest } from '../shift-changes/types';

type LeaveRow = Parameters<typeof mapApplication>[0];

export type LeadPermissionHistoryItem = {
  id: string;
  kind: 'leave' | 'shift_change';
  employeeName: string;
  projectName: string | null;
  projectCode: string | null;
  summary: string;
  detail: string | null;
  actedAt: string;
  requestStatus: string;
};

export type LeadPermissionsBoard = {
  pendingLeaves: ReturnType<typeof mapApplication>[];
  pendingShiftChanges: ShiftChangeRequest[];
  pendingPrioritiesCount: number;
  history: LeadPermissionHistoryItem[];
};

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** Same column ladder as leave listApplications — schema differs across environments. */
const LEAVE_SELECT_ATTEMPTS = [
  'id, employee_id, leave_type_id, policy_version_id, start_date, end_date, duration, quantity, reason, reviewer_comment, handover, handover_employee_id, project_id, attachment_url, status, created_at, leave_types (name, code), projects (name, code, lead_employee_id), leave_approvals (approver_role, status)',
  'id, employee_id, leave_type_id, policy_version_id, start_date, end_date, duration, quantity, reason, handover, handover_employee_id, project_id, attachment_url, status, created_at, leave_types (name, code), projects (name, code, lead_employee_id), leave_approvals (approver_role, status)',
  'id, employee_id, leave_type_id, policy_version_id, start_date, end_date, duration, quantity, reason, handover, project_id, attachment_url, status, created_at, leave_types (name, code), projects (name, code, lead_employee_id), leave_approvals (approver_role, status)',
  'id, employee_id, leave_type_id, policy_version_id, start_date, end_date, duration, quantity, reason, handover, project_id, attachment_url, status, created_at, leave_types (name, code), leave_approvals (approver_role, status)',
] as const;

async function leadProjectIds(supabase: SupabaseClient, employeeId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('id')
    .eq('lead_employee_id', employeeId)
    .eq('status', 'active');
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load led projects.', 500);
  }
  return (data ?? []).map((row) => row.id as string);
}

async function loadNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data } = await supabase.from('employees').select('id, full_name').in('id', unique);
  return new Map((data ?? []).map((row) => [row.id as string, row.full_name as string]));
}

async function fetchPendingLeavesForProjects(
  supabase: SupabaseClient,
  projectIds: string[],
): Promise<LeaveRow[]> {
  if (projectIds.length === 0) return [];

  let lastMessage = '';
  for (const columns of LEAVE_SELECT_ATTEMPTS) {
    const { data, error } = await supabase
      .from('leave_applications')
      .select(columns as string)
      .eq('status', 'PENDING')
      .in('project_id', projectIds)
      .order('created_at', { ascending: false })
      .limit(100);
    if (!error) {
      return (data ?? []) as unknown as LeaveRow[];
    }
    lastMessage = error.message || lastMessage;
  }

  // Last resort: no embeds — still enough to detect pending PROJECT_LEAD steps after a second query.
  const { data: bare, error: bareError } = await supabase
    .from('leave_applications')
    .select(
      'id, employee_id, leave_type_id, policy_version_id, start_date, end_date, duration, quantity, reason, handover, handover_employee_id, project_id, attachment_url, status, created_at',
    )
    .eq('status', 'PENDING')
    .in('project_id', projectIds)
    .order('created_at', { ascending: false })
    .limit(100);
  if (bareError) {
    throw new AppError(
      API_ERROR_CODES.INTERNAL_ERROR,
      `Failed to load leave approvals: ${bareError.message || lastMessage || 'unknown'}`,
      500,
    );
  }

  const rows = (bare ?? []) as unknown as LeaveRow[];
  if (rows.length === 0) return [];

  const appIds = rows.map((row) => row.id);
  const typeIds = [...new Set(rows.map((row) => row.leave_type_id).filter(Boolean))];
  const projIds = [
    ...new Set(rows.map((row) => row.project_id).filter((id): id is string => Boolean(id))),
  ];

  const [approvalsRes, typesRes, projectsRes] = await Promise.all([
    supabase.from('leave_approvals').select('application_id, approver_role, status').in('application_id', appIds),
    typeIds.length > 0
      ? supabase.from('leave_types').select('id, name, code').in('id', typeIds)
      : Promise.resolve({ data: [] as { id: string; name: string; code: string }[] }),
    projIds.length > 0
      ? supabase.from('projects').select('id, name, code, lead_employee_id').in('id', projIds)
      : Promise.resolve({
          data: [] as { id: string; name: string; code: string; lead_employee_id: string | null }[],
        }),
  ]);

  const approvalsByApp = new Map<string, { approver_role: string; status: string }[]>();
  for (const row of approvalsRes.data ?? []) {
    const appId = row.application_id as string;
    const list = approvalsByApp.get(appId) ?? [];
    list.push({ approver_role: row.approver_role as string, status: row.status as string });
    approvalsByApp.set(appId, list);
  }
  const typeById = new Map((typesRes.data ?? []).map((row) => [row.id as string, row]));
  const projectById = new Map((projectsRes.data ?? []).map((row) => [row.id as string, row]));

  return rows.map((row) => {
    const type = typeById.get(row.leave_type_id);
    const project = row.project_id ? projectById.get(row.project_id) : undefined;
    return {
      ...row,
      leave_types: type ? { name: type.name as string, code: type.code as string } : null,
      projects: project
        ? {
            name: project.name as string,
            code: project.code as string,
            lead_employee_id: (project.lead_employee_id as string | null) ?? null,
          }
        : null,
      leave_approvals: approvalsByApp.get(row.id) ?? [],
    };
  });
}

export function createLeadPermissionsService(supabase: SupabaseClient) {
  return {
    async board(actor: RequestUser): Promise<LeadPermissionsBoard> {
      if (!actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Employee profile is required.', 403);
      }

      const projectIds = await leadProjectIds(supabase, actor.employeeId);
      const shiftService = createShiftChangeService(supabase);

      const [leaveRows, shiftPending, priorityRes, leaveHistoryRes, shiftHistoryRes] = await Promise.all([
        fetchPendingLeavesForProjects(supabase, projectIds),
        shiftService.listLeadInbox(actor),
        projectIds.length === 0
          ? Promise.resolve({ count: 0 as number | null, error: null })
          : supabase
              .from('weekly_priorities')
              .select('id', { count: 'exact', head: true })
              .eq('approval_status', 'SUBMITTED')
              .in('project_id', projectIds),
        supabase
          .from('leave_approvals')
          .select(
            'id, decided_at, status, application_id, leave_applications!inner ( id, employee_id, start_date, end_date, quantity, status, reason, leave_types ( name, code ), projects ( name, code ) )',
          )
          .eq('approver_role', 'PROJECT_LEAD')
          .eq('status', 'APPROVED')
          .eq('actor_id', actor.employeeId)
          .order('decided_at', { ascending: false })
          .limit(50),
        supabase
          .from('shift_change_requests')
          .select(
            'id, status, start_date, end_date, reason, project_lead_acted_at, employee_id, project_id, employees!employee_id ( full_name ), projects ( name, code ), requested_shift:shifts!requested_shift_id ( name ), current_shift:shifts!current_shift_id ( name )',
          )
          .eq('project_lead_employee_id', actor.employeeId)
          .eq('project_lead_accepted', true)
          .eq('project_lead_required', true)
          .not('project_lead_acted_at', 'is', null)
          .order('project_lead_acted_at', { ascending: false })
          .limit(50),
      ]);

      const pendingLeadLeaves = leaveRows.filter((row) => {
        const approvals = row.leave_approvals ?? [];
        const waitingLead = approvals.some(
          (item) => item.approver_role === 'PROJECT_LEAD' && item.status === 'PENDING',
        );
        const waitingHandover = approvals.some(
          (item) => item.approver_role === 'HANDOVER' && item.status === 'PENDING',
        );
        return waitingLead && !waitingHandover && row.employee_id !== actor.employeeId;
      });

      const historyEmployeeIds: string[] = [];
      if (!leaveHistoryRes.error) {
        for (const row of leaveHistoryRes.data ?? []) {
          const app = firstRel(
            row.leave_applications as { employee_id?: string } | { employee_id?: string }[] | null,
          );
          if (app?.employee_id) historyEmployeeIds.push(app.employee_id);
        }
      }
      if (!shiftHistoryRes.error) {
        for (const row of shiftHistoryRes.data ?? []) {
          if (row.employee_id) historyEmployeeIds.push(row.employee_id as string);
        }
      }

      const names = await loadNames(supabase, [
        ...pendingLeadLeaves.map((row) => row.employee_id),
        ...historyEmployeeIds,
      ]);
      const pendingLeaves = pendingLeadLeaves.map((row) => {
        const mapped = mapApplication(row);
        return {
          ...mapped,
          employeeName: names.get(row.employee_id) ?? mapped.employeeName,
        };
      });

      const history: LeadPermissionHistoryItem[] = [];

      if (!leaveHistoryRes.error) {
        for (const row of leaveHistoryRes.data ?? []) {
          const app = firstRel(
            row.leave_applications as
              | {
                  id?: string;
                  employee_id?: string;
                  start_date?: string;
                  end_date?: string;
                  quantity?: number;
                  status?: string;
                  reason?: string | null;
                  leave_types?: { name?: string; code?: string } | { name?: string; code?: string }[] | null;
                  projects?: { name?: string; code?: string } | { name?: string; code?: string }[] | null;
                }
              | {
                  id?: string;
                  employee_id?: string;
                  start_date?: string;
                  end_date?: string;
                  quantity?: number;
                  status?: string;
                  reason?: string | null;
                  leave_types?: { name?: string; code?: string } | { name?: string; code?: string }[] | null;
                  projects?: { name?: string; code?: string } | { name?: string; code?: string }[] | null;
                }[]
              | null,
          );
          if (!app?.id || !row.decided_at) continue;
          const type = firstRel(app.leave_types);
          const project = firstRel(app.projects);
          const typeLabel = type?.name ?? type?.code ?? 'Leave';
          history.push({
            id: `leave:${app.id}`,
            kind: 'leave',
            employeeName: (app.employee_id && names.get(app.employee_id)) || 'Employee',
            projectName: project?.name ?? null,
            projectCode: project?.code ?? null,
            summary: `${typeLabel} · ${app.start_date ?? '—'} → ${app.end_date ?? '—'}`,
            detail: app.reason ?? null,
            actedAt: row.decided_at as string,
            requestStatus: (app.status as string) || 'PENDING',
          });
        }
      }

      if (!shiftHistoryRes.error) {
        for (const row of shiftHistoryRes.data ?? []) {
          if (!row.project_lead_acted_at) continue;
          const emp = firstRel(
            row.employees as { full_name?: string } | { full_name?: string }[] | null,
          );
          const project = firstRel(
            row.projects as { name?: string; code?: string } | { name?: string; code?: string }[] | null,
          );
          const requested = firstRel(
            row.requested_shift as { name?: string } | { name?: string }[] | null,
          );
          const current = firstRel(
            row.current_shift as { name?: string } | { name?: string }[] | null,
          );
          const start = (row.start_date as string) ?? '';
          const end = (row.end_date as string) ?? start;
          const dates = start === end ? start : `${start} → ${end}`;
          const employeeId = row.employee_id as string | undefined;
          history.push({
            id: `shift:${row.id as string}`,
            kind: 'shift_change',
            employeeName: emp?.full_name ?? (employeeId ? names.get(employeeId) : undefined) ?? 'Employee',
            projectName: project?.name ?? null,
            projectCode: project?.code ?? null,
            summary: `Shift change · ${dates} · ${current?.name ?? '—'} → ${requested?.name ?? '—'}`,
            detail: (row.reason as string) || null,
            actedAt: row.project_lead_acted_at as string,
            requestStatus: row.status as string,
          });
        }
      }

      history.sort((a, b) => b.actedAt.localeCompare(a.actedAt));

      return {
        pendingLeaves,
        pendingShiftChanges: shiftPending,
        pendingPrioritiesCount: priorityRes.error ? 0 : (priorityRes.count ?? 0),
        history: history.slice(0, 75),
      };
    },
  };
}
