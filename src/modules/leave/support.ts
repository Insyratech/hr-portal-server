import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { isHrDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { portalUrl, sendPortalMail } from '../notifications/mail';
import { ledgerAvailable, currentPeriod } from './balance';
import { parsePolicyRules } from './parse-rules';
import type { PolicyRules } from './types';

export function mapRpcError(error: { message?: string } | null): never {
  const message = error?.message ?? '';
  if (message.includes('LEAVE_OVERLAP')) {
    throw new AppError(API_ERROR_CODES.LEAVE_OVERLAP, 'This request overlaps another leave application.', 400);
  }
  if (message.includes('INSUFFICIENT_LEAVE_BALANCE')) {
    throw new AppError(API_ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE, 'Insufficient leave balance.', 400);
  }
  if (message.includes('NOT_FOUND')) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Leave application not found.', 404);
  }
  throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, message || 'Leave operation failed.', 500);
}

type RoleEmployee = {
  employees?:
    | { user_id?: string; email?: string; notification_email?: string; full_name?: string }
    | { user_id?: string; email?: string; notification_email?: string; full_name?: string }[]
    | null;
  roles?: { code?: string } | { code?: string }[] | null;
};

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function loadApproverStaff(
  supabase: SupabaseClient,
): Promise<{ userId: string; email: string; name: string; role: string }[]> {
  const { data } = await supabase.from('employee_roles').select('employees ( user_id, email, notification_email, full_name ), roles ( code )');
  const staff: { userId: string; email: string; name: string; role: string }[] = [];
  const seen = new Set<string>();
  for (const row of (data ?? []) as RoleEmployee[]) {
    const code = firstRel(row.roles)?.code;
    if (code !== 'HR_MANAGER') continue;
    const employee = firstRel(row.employees);
    if (!employee?.user_id || seen.has(employee.user_id)) continue;
    seen.add(employee.user_id);
    staff.push({
      userId: employee.user_id,
      email: employee.notification_email || employee.email || '',
      name: employee.full_name ?? 'Approver',
      role: code,
    });
  }
  return staff;
}

export async function insertNotification(
  supabase: SupabaseClient,
  input: { userId: string; title: string; message: string; referenceId: string },
): Promise<void> {
  await supabase.from('notifications').insert({
    user_id: input.userId,
    type: 'leave',
    title: input.title,
    message: input.message,
    reference_type: 'leave_application',
    reference_id: input.referenceId,
  });
}

export async function notifyApprovers(
  supabase: SupabaseClient,
  applicationId: string,
  applicantName: string,
  options?: { handoverAcceptedBy?: string; updated?: boolean },
): Promise<void> {
  const staff = await loadApproverStaff(supabase);
  const title = options?.updated ? 'Leave updated' : options?.handoverAcceptedBy ? 'Leave ready to approve' : 'Leave pending';
  const message = options?.updated
    ? options.handoverAcceptedBy
      ? `${applicantName} updated an existing leave request. Handover remains accepted by ${options.handoverAcceptedBy}.`
      : `${applicantName} updated an existing leave request.`
    : options?.handoverAcceptedBy
      ? `${applicantName} applied for leave. ${options.handoverAcceptedBy} accepted the handover.`
      : `${applicantName} applied for leave.`;
  for (const person of staff) {
    await insertNotification(supabase, {
      userId: person.userId,
      title,
      message,
      referenceId: applicationId,
    });
    const reviewPath = `/hr/leaves/${applicationId}`;
    await sendPortalMail({
      to: [person.email],
      subject: title,
      eyebrow: 'Leave',
      title,
      greeting: `Hi ${person.name},`,
      paragraphs: [message, 'Review the request, then approve, decline, or ask the employee to update it.'],
      cta: { label: 'Review leave', href: portalUrl(reviewPath) },
    });
  }
}

/** Info-only: leave was auto-approved (approval not required). HR does not need to act. */
export async function notifyHrLeaveRecorded(
  supabase: SupabaseClient,
  applicationId: string,
  applicantName: string,
  leaveTypeName: string,
): Promise<void> {
  const staff = await loadApproverStaff(supabase);
  const title = 'Leave recorded';
  const message = `${applicantName} applied for ${leaveTypeName}. No approval is required — this is for your awareness.`;
  for (const person of staff) {
    await insertNotification(supabase, {
      userId: person.userId,
      title,
      message,
      referenceId: applicationId,
    });
    await sendPortalMail({
      to: [person.email],
      subject: title,
      eyebrow: 'Leave',
      title,
      greeting: `Hi ${person.name},`,
      paragraphs: [message, 'Open the leave record if you need the dates. You do not need to approve this request.'],
      cta: { label: 'View leave', href: portalUrl(`/hr/leaves/${applicationId}`) },
    });
  }
}

export function requireSupabase(supabase: SupabaseClient | null): SupabaseClient {
  if (!supabase) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
  return supabase;
}

/** Working days from org settings. Unchecked weekdays are weekly offs. Do not hardcode Saturday or Sunday. */
export async function loadWorkingDays(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase.from('organization_settings').select('working_days').limit(1).maybeSingle();
  if (error || !data) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Organisation working days are not configured.', 500);
  }
  return data.working_days as string[];
}

export async function loadHolidayDates(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase.from('holidays').select('holiday_date, optional');
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load holidays.', 500);
  }
  return ((data ?? []) as { holiday_date: string; optional: boolean }[])
    .filter((row) => !row.optional)
    .map((row) => row.holiday_date);
}

export async function loadActivePolicy(
  supabase: SupabaseClient,
  leaveTypeId: string,
): Promise<{ policyId: string; versionId: string; rules: PolicyRules }> {
  const { data: policy, error: policyError } = await supabase
    .from('leave_policies')
    .select('id')
    .eq('leave_type_id', leaveTypeId)
    .maybeSingle();
  if (policyError || !policy) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'No leave policy is configured for this type.', 404);
  }

  const { data: version, error: versionError } = await supabase
    .from('leave_policy_versions')
    .select('id, leave_policy_rules ( rules )')
    .eq('policy_id', policy.id)
    .eq('status', 'published')
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (versionError || !version) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'No published policy version exists for this type.', 404);
  }

  const rulesRow = version.leave_policy_rules as { rules: unknown } | { rules: unknown }[] | null;
  const raw = Array.isArray(rulesRow) ? rulesRow[0]?.rules : rulesRow?.rules;
  return { policyId: policy.id as string, versionId: version.id as string, rules: parsePolicyRules(raw) };
}

export { currentPeriod, ledgerAvailable };

export async function writeLeaveAudit(
  supabase: SupabaseClient,
  actorId: string,
  action: string,
  entityId: string,
  values: Record<string, unknown>,
  meta: { ipAddress?: string | null; userAgent?: string | null },
): Promise<void> {
  await writeAuditLog(supabase, {
    actorId,
    action,
    entityType: 'leave_application',
    entityId,
    newValues: values,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
}

export function canApprove(user: RequestUser): boolean {
  return isHrDomainOwner(user) && user.permissions.includes(PERMISSIONS.LEAVE_APPROVE);
}

export function canSeeAllApplications(user: RequestUser): boolean {
  return canApprove(user) || canManageAllocations(user);
}

export function canManageTypes(user: RequestUser): boolean {
  return isHrDomainOwner(user) && user.permissions.includes(PERMISSIONS.LEAVE_TYPES_MANAGE);
}

export function canManagePolicies(user: RequestUser): boolean {
  return isHrDomainOwner(user) && user.permissions.includes(PERMISSIONS.LEAVE_POLICIES_MANAGE);
}

export function canManageAllocations(user: RequestUser): boolean {
  return isHrDomainOwner(user) && user.permissions.includes(PERMISSIONS.LEAVE_ALLOCATIONS_MANAGE);
}
