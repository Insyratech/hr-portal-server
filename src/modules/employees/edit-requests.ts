import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { portalUrl, sendPortalMail } from '../notifications/mail';
import { notifyUser } from '../notifications/notify-user';
import { isHrManager, isSuperAdmin } from './access';

export type EditRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'FULFILLED' | 'CANCELLED';

export type DirectoryEditRequest = {
  id: string;
  targetEmployeeId: string;
  targetName: string;
  targetCode: string;
  requesterId: string;
  requesterName: string;
  reason: string;
  fieldHints: string | null;
  status: EditRequestStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  unlockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  fulfilledAt: string | null;
};

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

const DEFAULT_UNLOCK_HOURS = 72;

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function mapRow(row: Record<string, unknown>): DirectoryEditRequest {
  const target = firstRel(row.employees as { full_name?: string; employee_code?: string } | { full_name?: string; employee_code?: string }[] | null);
  const requester = firstRel(
    row.requester as { full_name?: string } | { full_name?: string }[] | null,
  );
  return {
    id: row.id as string,
    targetEmployeeId: row.target_employee_id as string,
    targetName: target?.full_name ?? 'Employee',
    targetCode: target?.employee_code ?? '',
    requesterId: row.requester_id as string,
    requesterName: requester?.full_name ?? 'HR Manager',
    reason: row.reason as string,
    fieldHints: (row.field_hints as string | null) ?? null,
    status: row.status as EditRequestStatus,
    decidedBy: (row.decided_by as string | null) ?? null,
    decisionNote: (row.decision_note as string | null) ?? null,
    unlockedUntil: (row.unlocked_until as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    decidedAt: (row.decided_at as string | null) ?? null,
    fulfilledAt: (row.fulfilled_at as string | null) ?? null,
  };
}

const SELECT =
  'id, target_employee_id, requester_id, reason, field_hints, status, decided_by, decision_note, unlocked_until, created_at, updated_at, decided_at, fulfilled_at, employees!directory_edit_requests_target_employee_id_fkey ( full_name, employee_code ), requester:employees!directory_edit_requests_requester_id_fkey ( full_name )';

async function loadSuperAdminContacts(
  supabase: SupabaseClient,
): Promise<{ userId: string; email: string; name: string }[]> {
  const { data } = await supabase
    .from('employee_roles')
    .select('employees ( user_id, email, notification_email, full_name ), roles ( code )');
  const people: { userId: string; email: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const row of data ?? []) {
    const role = firstRel((row as { roles?: { code?: string } | { code?: string }[] }).roles);
    if (role?.code !== ROLE_CODES.SUPER_ADMIN) continue;
    const employee = firstRel(
      (row as {
        employees?:
          | { user_id?: string; email?: string; notification_email?: string; full_name?: string }
          | { user_id?: string; email?: string; notification_email?: string; full_name?: string }[];
      }).employees,
    );
    if (!employee?.user_id || seen.has(employee.user_id)) continue;
    seen.add(employee.user_id);
    people.push({
      userId: employee.user_id,
      email: employee.notification_email || employee.email || '',
      name: employee.full_name ?? 'Super Admin',
    });
  }
  return people;
}

async function markFulfilled(
  supabase: SupabaseClient,
  id: string,
  actorId: string | null,
  meta: RequestMeta,
  targetEmployeeId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('directory_edit_requests')
    .update({ status: 'FULFILLED', fulfilled_at: now, updated_at: now })
    .eq('id', id)
    .eq('status', 'APPROVED');
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to close edit unlock. ${error.message}`, 500);
  }
  await writeAuditLog(supabase, {
    actorId,
    action: 'directory_edit.fulfilled',
    entityType: 'directory_edit_request',
    entityId: id,
    newValues: { targetEmployeeId, status: 'FULFILLED' },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
}

/** Active approved unlock for this employee (not expired). Expires stale rows to FULFILLED. */
export async function findActiveUnlock(
  supabase: SupabaseClient,
  targetEmployeeId: string,
): Promise<DirectoryEditRequest | null> {
  const { data, error } = await supabase
    .from('directory_edit_requests')
    .select(SELECT)
    .eq('target_employee_id', targetEmployeeId)
    .eq('status', 'APPROVED')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to load edit unlock. ${error.message}`, 500);
  }
  if (!data) return null;
  const mapped = mapRow(data as Record<string, unknown>);
  if (mapped.unlockedUntil && new Date(mapped.unlockedUntil) <= new Date()) {
    await markFulfilled(supabase, mapped.id, null, {}, targetEmployeeId);
    return null;
  }
  return mapped;
}

export function createDirectoryEditRequestService(supabase: SupabaseClient) {
  return {
    async list(actor: RequestUser, status?: EditRequestStatus): Promise<DirectoryEditRequest[]> {
      if (!actor.permissions.includes(PERMISSIONS.USERS_VIEW) && !actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view edit requests.', 403);
      }
      let query = supabase.from('directory_edit_requests').select(SELECT).order('created_at', { ascending: false });
      if (isSuperAdmin(actor)) {
        if (status) query = query.eq('status', status);
      } else if (isHrManager(actor)) {
        query = query.eq('requester_id', actor.employeeId);
        if (status) query = query.eq('status', status);
      } else {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view edit requests.', 403);
      }
      const { data, error } = await query.limit(100);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to list edit requests. ${error.message}`, 500);
      }
      const items: DirectoryEditRequest[] = [];
      for (const row of data ?? []) {
        const mapped = mapRow(row as Record<string, unknown>);
        if (mapped.status === 'APPROVED' && mapped.unlockedUntil && new Date(mapped.unlockedUntil) <= new Date()) {
          await markFulfilled(supabase, mapped.id, null, {}, mapped.targetEmployeeId);
          items.push({ ...mapped, status: 'FULFILLED', fulfilledAt: new Date().toISOString() });
        } else {
          items.push(mapped);
        }
      }
      return items;
    },

    async getForTarget(actor: RequestUser, targetEmployeeId: string): Promise<{
      open: DirectoryEditRequest | null;
      canRequest: boolean;
      canEdit: boolean;
    }> {
      if (!actor.permissions.includes(PERMISSIONS.USERS_VIEW) && !actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view edit requests.', 403);
      }
      const { data, error } = await supabase
        .from('directory_edit_requests')
        .select(SELECT)
        .eq('target_employee_id', targetEmployeeId)
        .in('status', ['PENDING', 'APPROVED'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to load edit request. ${error.message}`, 500);
      }
      let open = data ? mapRow(data as Record<string, unknown>) : null;
      if (open?.status === 'APPROVED' && open.unlockedUntil && new Date(open.unlockedUntil) <= new Date()) {
        await markFulfilled(supabase, open.id, null, {}, targetEmployeeId);
        open = null;
      }
      const canRequest = isHrManager(actor) && !open;
      const canEdit =
        isSuperAdmin(actor) &&
        open?.status === 'APPROVED' &&
        Boolean(open.unlockedUntil && new Date(open.unlockedUntil) > new Date());
      return { open, canRequest, canEdit };
    },

    async create(
      actor: RequestUser,
      input: { targetEmployeeId: string; reason: string; fieldHints?: string | null },
      meta: RequestMeta,
    ): Promise<DirectoryEditRequest> {
      if (!isHrManager(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only HR Manager can request directory edits.', 403);
      }
      if (!actor.permissions.includes(PERMISSIONS.USERS_VIEW)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request directory edits.', 403);
      }
      const reason = input.reason.trim();
      if (reason.length < 8) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Explain why this edit is needed (at least 8 characters).', 400);
      }
      if (input.targetEmployeeId === actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request an edit of your own account this way.', 403);
      }

      const { data: target, error: targetError } = await supabase
        .from('employees')
        .select('id, full_name, employee_code, deleted_at, employee_roles ( roles ( code ) )')
        .eq('id', input.targetEmployeeId)
        .maybeSingle();
      if (targetError || !target || target.deleted_at) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
      }
      const roleRows = (target.employee_roles ?? []) as { roles?: { code?: string } | { code?: string }[] }[];
      for (const row of roleRows) {
        const code = firstRel(row.roles)?.code;
        if (code === ROLE_CODES.SUPER_ADMIN) {
          throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Super Admin accounts cannot be edited this way.', 403);
        }
      }

      const { data, error } = await supabase
        .from('directory_edit_requests')
        .insert({
          target_employee_id: input.targetEmployeeId,
          requester_id: actor.employeeId,
          reason,
          field_hints: input.fieldHints?.trim() || null,
          status: 'PENDING',
        })
        .select(SELECT)
        .single();
      if (error) {
        if (error.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.CONFLICT,
            'An open edit request already exists for this employee.',
            409,
          );
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to create edit request. ${error.message}`, 500);
      }
      const mapped = mapRow(data as Record<string, unknown>);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'directory_edit.requested',
        entityType: 'directory_edit_request',
        entityId: mapped.id,
        newValues: {
          targetEmployeeId: mapped.targetEmployeeId,
          reason: mapped.reason,
          fieldHints: mapped.fieldHints,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      const title = 'Directory edit requested';
      const message = `${actor.fullName} asked to unlock ${mapped.targetName} (${mapped.targetCode}): ${mapped.reason}`;
      for (const person of await loadSuperAdminContacts(supabase)) {
        await notifyUser(supabase, {
          userId: person.userId,
          type: 'directory_edit',
          title,
          message,
          referenceType: 'directory_edit_request',
          referenceId: mapped.id,
        });
        await sendPortalMail({
          to: [person.email],
          subject: title,
          eyebrow: 'Directory',
          title,
          greeting: `Hi ${person.name},`,
          paragraphs: [message, 'Approve to unlock this employee for editing, or reject the request.'],
          cta: { label: 'Review request', href: portalUrl('/super-admin/edit-requests') },
        });
      }
      return mapped;
    },

    async approve(
      actor: RequestUser,
      id: string,
      input: { note?: string | null; unlockHours?: number },
      meta: RequestMeta,
    ): Promise<DirectoryEditRequest> {
      if (!isSuperAdmin(actor) || !actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only Super Admin can approve edit requests.', 403);
      }
      const hours = input.unlockHours ?? DEFAULT_UNLOCK_HOURS;
      const unlockedUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('directory_edit_requests')
        .update({
          status: 'APPROVED',
          decided_by: actor.employeeId,
          decision_note: input.note?.trim() || null,
          unlocked_until: unlockedUntil,
          decided_at: now,
          updated_at: now,
        })
        .eq('id', id)
        .eq('status', 'PENDING')
        .select(SELECT)
        .maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to approve edit request. ${error.message}`, 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Pending edit request not found.', 404);
      }
      const mapped = mapRow(data as Record<string, unknown>);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'directory_edit.approved',
        entityType: 'directory_edit_request',
        entityId: mapped.id,
        newValues: {
          targetEmployeeId: mapped.targetEmployeeId,
          unlockedUntil,
          decisionNote: mapped.decisionNote,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      const { data: requester } = await supabase
        .from('employees')
        .select('user_id, email, notification_email, full_name')
        .eq('id', mapped.requesterId)
        .maybeSingle();
      if (requester?.user_id) {
        const title = 'Edit request approved';
        const message = `Super Admin unlocked ${mapped.targetName} for editing until ${new Date(unlockedUntil).toLocaleString()}.`;
        await notifyUser(supabase, {
          userId: requester.user_id as string,
          type: 'directory_edit',
          title,
          message,
          referenceType: 'directory_edit_request',
          referenceId: mapped.id,
        });
        await sendPortalMail({
          to: [(requester.notification_email as string) || (requester.email as string)],
          subject: title,
          eyebrow: 'Directory',
          title,
          greeting: `Hi ${(requester.full_name as string) ?? 'there'},`,
          paragraphs: [message],
          cta: {
            label: 'Open employee',
            href: portalUrl(`/hr/employees/${mapped.targetEmployeeId}`),
          },
        });
      }
      return mapped;
    },

    async reject(
      actor: RequestUser,
      id: string,
      input: { note?: string | null },
      meta: RequestMeta,
    ): Promise<DirectoryEditRequest> {
      if (!isSuperAdmin(actor) || !actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only Super Admin can reject edit requests.', 403);
      }
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('directory_edit_requests')
        .update({
          status: 'REJECTED',
          decided_by: actor.employeeId,
          decision_note: input.note?.trim() || null,
          decided_at: now,
          updated_at: now,
          unlocked_until: null,
        })
        .eq('id', id)
        .eq('status', 'PENDING')
        .select(SELECT)
        .maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to reject edit request. ${error.message}`, 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Pending edit request not found.', 404);
      }
      const mapped = mapRow(data as Record<string, unknown>);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'directory_edit.rejected',
        entityType: 'directory_edit_request',
        entityId: mapped.id,
        newValues: { targetEmployeeId: mapped.targetEmployeeId, decisionNote: mapped.decisionNote },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return mapped;
    },

    async cancel(actor: RequestUser, id: string, meta: RequestMeta): Promise<DirectoryEditRequest> {
      if (!isHrManager(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only the requester can cancel a pending edit request.', 403);
      }
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('directory_edit_requests')
        .update({ status: 'CANCELLED', updated_at: now })
        .eq('id', id)
        .eq('requester_id', actor.employeeId)
        .eq('status', 'PENDING')
        .select(SELECT)
        .maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to cancel edit request. ${error.message}`, 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Pending edit request not found.', 404);
      }
      const mapped = mapRow(data as Record<string, unknown>);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'directory_edit.cancelled',
        entityType: 'directory_edit_request',
        entityId: mapped.id,
        newValues: { targetEmployeeId: mapped.targetEmployeeId },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return mapped;
    },

    /** Super Admin closes an approved unlock early after editing. */
    async fulfill(actor: RequestUser, id: string, meta: RequestMeta): Promise<DirectoryEditRequest> {
      if (!isSuperAdmin(actor) || !actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only Super Admin can close an edit unlock.', 403);
      }
      const { data: existing, error: loadError } = await supabase
        .from('directory_edit_requests')
        .select(SELECT)
        .eq('id', id)
        .eq('status', 'APPROVED')
        .maybeSingle();
      if (loadError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to load edit request. ${loadError.message}`, 500);
      }
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Approved edit unlock not found.', 404);
      }
      const mapped = mapRow(existing as Record<string, unknown>);
      await markFulfilled(supabase, mapped.id, actor.employeeId, meta, mapped.targetEmployeeId);
      return { ...mapped, status: 'FULFILLED', fulfilledAt: new Date().toISOString() };
    },
  };
}
