import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { loadStaffById, notifyStaff } from '../notifications/notify-staff';
import { portalUrl } from '../notifications/mail';

export type LeaveProjectOption = {
  id: string;
  name: string;
  code: string;
  leadEmployeeId: string;
  leadName: string;
};

export type ApprovalStepInsert = {
  application_id: string;
  step_order: number;
  approver_role: string;
  status: string;
};

/** Active projects the employee belongs to that have a project lead. */
export async function listLeaveProjectOptions(
  supabase: SupabaseClient,
  employeeId: string,
): Promise<LeaveProjectOption[]> {
  const { data: memberRows, error } = await supabase
    .from('project_members')
    .select('project_id, projects ( id, name, code, status, lead_employee_id )')
    .eq('employee_id', employeeId);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load your projects.', 500);
  }

  const options: LeaveProjectOption[] = [];
  const leadIds = new Set<string>();
  for (const row of memberRows ?? []) {
    const project = Array.isArray(row.projects) ? row.projects[0] : row.projects;
    if (!project || project.status !== 'active' || !project.lead_employee_id) continue;
    leadIds.add(project.lead_employee_id as string);
    options.push({
      id: project.id as string,
      name: project.name as string,
      code: project.code as string,
      leadEmployeeId: project.lead_employee_id as string,
      leadName: '',
    });
  }
  if (options.length === 0) return [];

  const { data: leads } = await supabase
    .from('employees')
    .select('id, full_name')
    .in('id', [...leadIds]);
  const names = new Map((leads ?? []).map((row) => [row.id as string, row.full_name as string]));
  return options
    .map((item) => ({ ...item, leadName: names.get(item.leadEmployeeId) ?? 'Project lead' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadProjectForLeave(
  supabase: SupabaseClient,
  projectId: string,
  applicantId: string,
): Promise<LeaveProjectOption> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, code, status, lead_employee_id')
    .eq('id', projectId)
    .maybeSingle();
  if (error || !data || data.status !== 'active') {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select an active project for this leave.', 400);
  }
  const leadId = data.lead_employee_id as string | null;
  if (!leadId) {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      'That project has no project lead. Ask CSO to assign one, or pick another project.',
      400,
    );
  }

  const { data: membership } = await supabase
    .from('project_members')
    .select('project_id')
    .eq('project_id', projectId)
    .eq('employee_id', applicantId)
    .maybeSingle();
  if (!membership) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'You can only pick a project you belong to.', 400);
  }

  const lead = await loadStaffById(supabase, leadId);
  return {
    id: data.id as string,
    name: data.name as string,
    code: data.code as string,
    leadEmployeeId: leadId,
    leadName: lead?.fullName ?? 'Project lead',
  };
}

export function buildLeaveApprovalSteps(input: {
  applicationId: string;
  withHandover: boolean;
  withProjectLead: boolean;
  handoverAccepted?: boolean;
  projectLeadAccepted?: boolean;
}): ApprovalStepInsert[] {
  const rows: ApprovalStepInsert[] = [];
  let step = 1;
  if (input.withHandover) {
    rows.push({
      application_id: input.applicationId,
      step_order: step++,
      approver_role: 'HANDOVER',
      status: input.handoverAccepted ? 'APPROVED' : 'PENDING',
    });
  }
  if (input.withProjectLead) {
    rows.push({
      application_id: input.applicationId,
      step_order: step++,
      approver_role: 'PROJECT_LEAD',
      status: input.projectLeadAccepted ? 'APPROVED' : 'PENDING',
    });
  }
  rows.push({
    application_id: input.applicationId,
    step_order: step,
    approver_role: 'HR_MANAGER',
    status: 'PENDING',
  });
  return rows;
}

export async function resetLeaveApprovals(
  supabase: SupabaseClient,
  applicationId: string,
  options: {
    withHandover: boolean;
    withProjectLead: boolean;
    handoverAccepted?: boolean;
    projectLeadAccepted?: boolean;
  },
): Promise<void> {
  await supabase.from('leave_approvals').delete().eq('application_id', applicationId);
  const rows = buildLeaveApprovalSteps({ applicationId, ...options });
  const { error } = await supabase.from('leave_approvals').insert(rows);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to set leave approval steps.', 500);
  }
}

export async function persistLeaveProjectId(
  supabase: SupabaseClient,
  applicationId: string,
  projectId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('leave_applications')
    .update({ project_id: projectId })
    .eq('id', applicationId);
  if (error && !/project_id/i.test(error.message ?? '')) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message || 'Failed to save leave project.', 500);
  }
}

export async function currentLeadEmployeeId(
  supabase: SupabaseClient,
  projectId: string | null | undefined,
): Promise<string | null> {
  if (!projectId) return null;
  const { data } = await supabase
    .from('projects')
    .select('lead_employee_id')
    .eq('id', projectId)
    .maybeSingle();
  return (data?.lead_employee_id as string | null) ?? null;
}

export async function notifyProjectLeadApproval(
  supabase: SupabaseClient,
  input: {
    applicationId: string;
    projectName: string;
    applicantName: string;
    startDate: string;
    endDate: string;
    leadEmployeeId: string;
  },
): Promise<void> {
  const lead = await loadStaffById(supabase, input.leadEmployeeId);
  if (!lead) return;

  await notifyStaff(supabase, lead, {
    type: 'leave',
    title: 'Project lead approval',
    message: `${input.applicantName} needs your approval for leave on ${input.projectName}.`,
    referenceType: 'leave_application',
    referenceId: input.applicationId,
    eyebrow: 'Leave',
    paragraphs: [
      `${input.applicantName} applied for leave linked to ${input.projectName}.`,
      'Review and approve as project lead before HR can decide.',
    ],
    details: [
      { label: 'Project', value: input.projectName },
      { label: 'From', value: input.startDate },
      { label: 'To', value: input.endDate },
    ],
    ctaLabel: 'Review leave',
    ctaHref: portalUrl(`/leave/lead/${input.applicationId}`),
  });
}

/** When the project lead changes, pending PROJECT_LEAD steps move with the role — notify the new lead. */
export async function notifyNewLeadOfPendingLeave(
  supabase: SupabaseClient,
  input: { projectId: string; projectName: string; leadEmployeeId: string },
): Promise<void> {
  const { data: apps, error } = await supabase
    .from('leave_applications')
    .select(
      'id, start_date, end_date, employee_id, leave_approvals ( approver_role, status ), employees ( full_name )',
    )
    .eq('project_id', input.projectId)
    .eq('status', 'PENDING');
  if (error || !apps?.length) return;

  for (const row of apps) {
    const approvals = (row.leave_approvals ?? []) as { approver_role: string; status: string }[];
    if (!approvals.some((item) => item.approver_role === 'PROJECT_LEAD' && item.status === 'PENDING')) {
      continue;
    }
    const employee = Array.isArray(row.employees) ? row.employees[0] : row.employees;
    await notifyProjectLeadApproval(supabase, {
      applicationId: row.id as string,
      projectName: input.projectName,
      applicantName: (employee?.full_name as string | undefined) ?? 'A colleague',
      startDate: String(row.start_date).slice(0, 10),
      endDate: String(row.end_date).slice(0, 10),
      leadEmployeeId: input.leadEmployeeId,
    });
  }
}

export function isProjectLeadPending(
  approvals: { approver_role: string; status: string }[] | null | undefined,
): boolean {
  return (approvals ?? []).some(
    (item) => item.approver_role === 'PROJECT_LEAD' && item.status === 'PENDING',
  );
}

export function hasProjectLeadStep(
  approvals: { approver_role: string; status: string }[] | null | undefined,
): boolean {
  return (approvals ?? []).some((item) => item.approver_role === 'PROJECT_LEAD');
}
