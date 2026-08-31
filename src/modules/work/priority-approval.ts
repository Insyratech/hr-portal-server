import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { portalUrl } from '../notifications/mail';
import { loadStaffById, notifyStaff, type StaffContact } from '../notifications/notify-staff';

export type PriorityForApproval = {
  id: string;
  employee_id: string;
  project_id: string | null;
  priority_type: string;
};

export function leadPriorityReviewHref(employeeId: string): string {
  return portalUrl(`/work/priorities/review?employeeId=${encodeURIComponent(employeeId)}`);
}

export async function loadLeadProjectIds(
  supabase: SupabaseClient,
  leadEmployeeId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('projects')
    .select('id')
    .eq('lead_employee_id', leadEmployeeId)
    .eq('status', 'active');
  return (data ?? []).map((row) => row.id as string);
}

export async function isProjectLead(supabase: SupabaseClient, employeeId: string): Promise<boolean> {
  const ids = await loadLeadProjectIds(supabase, employeeId);
  return ids.length > 0;
}

export async function canViewEmployeeAsPriorityApprover(
  supabase: SupabaseClient,
  approverEmployeeId: string,
  targetEmployeeId: string,
): Promise<boolean> {
  if (approverEmployeeId === targetEmployeeId) return true;
  const leadProjectIds = await loadLeadProjectIds(supabase, approverEmployeeId);
  if (leadProjectIds.length === 0) return false;
  const { data } = await supabase
    .from('project_members')
    .select('project_id')
    .eq('employee_id', targetEmployeeId)
    .in('project_id', leadProjectIds);
  return (data ?? []).length > 0;
}

/** Project lead for a PROJECT line; all member project leads for REGULAR / SKILL. */
export async function resolvePriorityApproverIds(
  supabase: SupabaseClient,
  priority: PriorityForApproval,
): Promise<string[]> {
  if (priority.project_id) {
    const { data } = await supabase
      .from('projects')
      .select('lead_employee_id, status')
      .eq('id', priority.project_id)
      .maybeSingle();
    if (!data || data.status !== 'active') return [];
    const leadId = data.lead_employee_id as string | null;
    return leadId ? [leadId] : [];
  }

  const { data: memberRows } = await supabase
    .from('project_members')
    .select('project_id, projects ( lead_employee_id, status )')
    .eq('employee_id', priority.employee_id);
  const leadIds = new Set<string>();
  for (const row of memberRows ?? []) {
    const project = Array.isArray(row.projects) ? row.projects[0] : row.projects;
    if (!project || project.status !== 'active') continue;
    const leadId = project.lead_employee_id as string | null;
    if (leadId) leadIds.add(leadId);
  }
  return [...leadIds];
}

export async function canActorApprovePriority(
  supabase: SupabaseClient,
  actorEmployeeId: string,
  priority: PriorityForApproval,
): Promise<boolean> {
  const approvers = await resolvePriorityApproverIds(supabase, priority);
  return approvers.includes(actorEmployeeId);
}

export async function assertCanApprovePriority(
  supabase: SupabaseClient,
  actor: RequestUser,
  priority: PriorityForApproval,
  action = 'review this priority',
): Promise<void> {
  const ok = await canActorApprovePriority(supabase, actor.employeeId, priority);
  if (!ok) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, `Only the project lead can ${action}.`, 403);
  }
}

export async function assertHasPriorityApprovers(
  supabase: SupabaseClient,
  priority: PriorityForApproval,
): Promise<void> {
  const approvers = await resolvePriorityApproverIds(supabase, priority);
  if (approvers.length === 0) {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      'No project lead can review this priority. Ask CSO to assign a project lead on your project.',
      400,
    );
  }
}

export async function loadStaffContactsByIds(
  supabase: SupabaseClient,
  employeeIds: string[],
): Promise<StaffContact[]> {
  const unique = [...new Set(employeeIds.filter(Boolean))];
  const contacts: StaffContact[] = [];
  for (const id of unique) {
    const staff = await loadStaffById(supabase, id);
    if (staff) contacts.push(staff);
  }
  return contacts;
}

type NotifyPayload = Parameters<typeof notifyStaff>[2];

export async function notifyPriorityApprovers(
  supabase: SupabaseClient,
  priority: PriorityForApproval,
  payload: NotifyPayload,
): Promise<void> {
  const leadEmployeeIds = await resolvePriorityApproverIds(supabase, priority);
  const leads = await loadStaffContactsByIds(supabase, leadEmployeeIds);
  if (leads.length === 0) return;
  await notifyStaff(supabase, leads, payload);
}

export async function collectApproverIdsForPriorities(
  supabase: SupabaseClient,
  priorities: PriorityForApproval[],
): Promise<string[]> {
  const leadIds = new Set<string>();
  for (const priority of priorities) {
    const ids = await resolvePriorityApproverIds(supabase, priority);
    for (const id of ids) leadIds.add(id);
  }
  return [...leadIds];
}
