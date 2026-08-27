import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES, ROLE_IDS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { portalLoginUrl, sendPortalMail } from '../notifications/mail';
import { notifyUser } from '../notifications/notify-user';
import {
  confirmWorkEmailOtp,
  consumeWorkEmailVerification,
  issueWorkEmailOtp,
  normalizeWorkEmail,
} from './email-otp';
import {
  assertCanAssignRoles,
  assertCanLifecycleTarget,
  assertCanMutateTarget,
  canWriteEmployeeCompany,
  hasRole,
  isSuperAdmin,
} from './access';
import { emptyToNull, toDateColumn } from './dates';
import { findActiveUnlock } from './edit-requests';
import { createEmployeeMasterService } from './master';
import { assertCanStaffDirectoryTarget } from './staff-target';
import type { EmployeeRepository } from './repository';
import type {
  CompensationInput,
  CreateEmployeeInput,
  EmployeeRecord,
  EmployeeStatus,
  PaymentInput,
  UpdateEmployeeInput,
  UpdateEmployeeRolesInput,
} from './types';

const MANAGERIAL_ROLE_CODES: ReadonlySet<string> = new Set([
  ROLE_CODES.HR_MANAGER,
  ROLE_CODES.GENERAL_MANAGER,
  ROLE_CODES.CSO,
  ROLE_CODES.FINANCE_MANAGER,
  ROLE_CODES.ADMIN,
]);

function normalizeManagerialCode(code: string): string {
  return code === ROLE_CODES.ADMIN ? ROLE_CODES.GENERAL_MANAGER : code;
}

function managerialRoleLabel(code: string): string {
  switch (normalizeManagerialCode(code)) {
    case ROLE_CODES.HR_MANAGER:
      return 'HR Manager';
    case ROLE_CODES.GENERAL_MANAGER:
      return 'General Manager';
    case ROLE_CODES.CSO:
      return 'Chief Scientific Officer';
    case ROLE_CODES.FINANCE_MANAGER:
      return 'Finance Manager';
    default:
      return code;
  }
}

function managerialHats(roleCodes: string[]): string[] {
  return [
    ...new Set(
      roleCodes.filter((code) => MANAGERIAL_ROLE_CODES.has(code)).map(normalizeManagerialCode),
    ),
  ].sort();
}

function formatRoleList(codes: string[]): string {
  if (codes.length === 0) return 'none';
  return codes.map(managerialRoleLabel).join(', ');
}

async function resolveProfileRoleIds(
  employees: EmployeeRepository,
  actor: RequestUser,
  roleIds: string[],
): Promise<string[]> {
  const requested = [...new Set(roleIds)];
  const roleCodes: string[] = [];
  for (const roleId of requested) {
    if (!(await employees.roleExists(roleId))) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Role not found.', 400);
    }
    const roleCode = await employees.findRoleCode(roleId);
    if (!roleCode) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Role not found.', 400);
    }
    roleCodes.push(roleCode);
  }
  if (roleCodes.length > 0) {
    assertCanAssignRoles(actor, roleCodes);
  }
  if (!(await employees.roleExists(ROLE_IDS.EMPLOYEE))) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Employee role is missing from the database.', 500);
  }
  return [...new Set([...requested, ROLE_IDS.EMPLOYEE])];
}

type RequestMeta = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export function createEmployeeService(supabase: SupabaseClient, employees: EmployeeRepository) {
  async function createAuthUser(email: string, password: string): Promise<string> {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error || !data.user) {
      if (error?.message.toLowerCase().includes('already')) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'An account with this email already exists.', 409);
      }
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create login.', 500);
    }

    return data.user.id;
  }

  return {
    async list(actor: RequestUser, filters: { query?: string; status?: EmployeeStatus }): Promise<EmployeeRecord[]> {
      const canList =
        actor.permissions.includes(PERMISSIONS.USERS_VIEW) ||
        actor.permissions.includes(PERMISSIONS.USERS_MANAGE);

      if (!canList) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You do not have permission to list employees.', 403);
      }

      return employees.list(filters);
    },

    async getById(actor: RequestUser, id: string): Promise<EmployeeRecord> {
      const canViewOthers =
        actor.permissions.includes(PERMISSIONS.USERS_VIEW) ||
        actor.permissions.includes(PERMISSIONS.USERS_MANAGE);

      if (id !== actor.employeeId && !canViewOthers) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view this employee.', 403);
      }

      const employee = await employees.findById(id);
      if (!employee || employee.deletedAt) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
      }

      return employee;
    },

    async create(
      actor: RequestUser,
      input: CreateEmployeeInput,
      meta: RequestMeta,
    ): Promise<EmployeeRecord> {
      if (!isSuperAdmin(actor) || !actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only Super Admin can create accounts.', 403);
      }
      consumeWorkEmailVerification(actor.employeeId, input.email, input.emailVerificationToken);
      if (await employees.findByEmail(input.email)) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'An employee with this email already exists.', 409);
      }

      if (await employees.findByCode(input.employeeCode)) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'An employee with this code already exists.', 409);
      }

      // Create is always Employee. HR later sets company, shift, leave, and pay.
      const roleIds = [ROLE_IDS.EMPLOYEE];
      if (!(await employees.roleExists(ROLE_IDS.EMPLOYEE))) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Employee role is missing from the database.', 500);
      }

      const joiningDate = toDateColumn(input.joiningDate, 'Joining date', true) as string;

      const userId = await createAuthUser(input.email, input.password);
      let employeeId: string;

      try {
        employeeId = await employees.insert({
          userId,
          employeeCode: input.employeeCode,
          fullName: input.fullName,
          email: input.email,
          phone: emptyToNull(input.phone) ?? null,
          dateOfBirth: toDateColumn(input.dateOfBirth ?? null, 'Date of birth') ?? null,
          departmentId: emptyToNull(input.departmentId) ?? null,
          designationId: emptyToNull(input.designationId) ?? null,
          companyId: null,
          joiningDate,
          employmentType: input.employmentType,
          managerId: emptyToNull(input.managerId) ?? null,
          status: input.status ?? 'active',
        });
        await employees.setRoles(employeeId, roleIds);
      } catch (error) {
        await supabase.auth.admin.deleteUser(userId);
        throw error;
      }

      const created = await employees.findById(employeeId);
      if (!created) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Employee was created but could not be loaded.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'employee.create',
        entityType: 'employee',
        entityId: employeeId,
        newValues: {
          employeeCode: created.employeeCode,
          email: created.email,
          fullName: created.fullName,
          status: created.status,
          roleCodes: created.roleCodes,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      try {
        const portalUrl = portalLoginUrl();
        await notifyUser(supabase, {
          userId: created.userId,
          type: 'profile',
          title: 'Your HR Portal account is ready',
          message: 'An administrator created your account. Sign in with the email sent to you and change your password.',
          referenceType: 'employee',
          referenceId: created.id,
        });
        await sendPortalMail({
          to: [created.email],
          subject: 'Your HR Portal account is ready',
          eyebrow: 'Account',
          title: 'Your account is ready',
          greeting: `Hi ${created.fullName},`,
          paragraphs: [
            'Your HR Portal account has been created. Use the details below to sign in, then change your password from More → Password.',
          ],
          details: [
            { label: 'Work email', value: created.email },
            { label: 'Temporary password', value: input.password },
          ],
          cta: { label: 'Sign in', href: portalUrl },
        });
      } catch {
        /* Account is created even if mail or in-app notify is unavailable. */
      }

      return created;
    },

    async update(
      actor: RequestUser,
      id: string,
      input: UpdateEmployeeInput,
      meta: RequestMeta,
    ): Promise<EmployeeRecord> {
      const existing = await employees.findById(id);
      if (!existing || existing.deletedAt) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
      }
      const unlock = await findActiveUnlock(supabase, id);
      assertCanMutateTarget(actor, existing.roleCodes, { unlocked: Boolean(unlock) });

      if (input.employeeCode && input.employeeCode !== existing.employeeCode) {
        const clash = await employees.findByCode(input.employeeCode);
        if (clash) {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'An employee with this code already exists.', 409);
        }
      }

      const patch: Record<string, unknown> = {};
      if (input.employeeCode !== undefined) patch.employee_code = input.employeeCode;
      if (input.fullName !== undefined) patch.full_name = input.fullName;
      if (input.phone !== undefined) patch.phone = emptyToNull(input.phone);
      if (input.notificationEmail !== undefined) patch.notification_email = emptyToNull(input.notificationEmail);
      if (input.dateOfBirth !== undefined) patch.date_of_birth = toDateColumn(input.dateOfBirth, 'Date of birth');
      if (input.departmentId !== undefined) patch.department_id = emptyToNull(input.departmentId);
      if (input.designationId !== undefined) patch.designation_id = emptyToNull(input.designationId);
      if (input.joiningDate !== undefined) patch.joining_date = toDateColumn(input.joiningDate, 'Joining date', true);
      if (input.employmentType !== undefined) patch.employment_type = input.employmentType;
      if (input.managerId !== undefined) patch.manager_id = emptyToNull(input.managerId);
      if (input.status !== undefined) patch.status = input.status;

      if (input.companyId !== undefined) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Company is assigned by HR Manager on the profile, not via directory edit.',
          400,
        );
      }

      if (Object.keys(patch).length > 0) {
        await employees.update(id, patch);
      }

      const updated = await employees.findById(id);
      if (!updated) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Employee was updated but could not be loaded.', 500);
      }

      if (Object.keys(patch).length > 0) {
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: existing.status !== updated.status ? 'employee.status_change' : 'employee.update',
          entityType: 'employee',
          entityId: id,
          oldValues: {
            employeeCode: existing.employeeCode,
            fullName: existing.fullName,
            status: existing.status,
          },
          newValues: {
            employeeCode: updated.employeeCode,
            fullName: updated.fullName,
            status: updated.status,
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        });
      }

      if (actor.employeeId !== id) {
        try {
          const portalUrl = portalLoginUrl();
          const statusNote =
            existing.status !== updated.status ? ` Your status is now ${updated.status}.` : '';
          await notifyUser(supabase, {
            userId: updated.userId,
            type: 'profile',
            title: 'Your profile was updated',
            message: `An administrator updated your HR Portal profile.${statusNote}`,
            referenceType: 'employee',
            referenceId: updated.id,
          });
          await sendPortalMail({
            to: [updated.notificationEmail || updated.email],
            subject: 'Your HR Portal profile was updated',
            eyebrow: 'Profile',
            title: 'Your profile was updated',
            greeting: `Hi ${updated.fullName},`,
            paragraphs: [
              `An administrator updated your HR Portal profile.${statusNote}`,
              'Sign in to review your details and confirm everything looks correct.',
            ],
            cta: { label: 'Review profile', href: portalUrl },
          });
        } catch {
          /* Profile is saved even if mail or in-app notify is unavailable. */
        }
      }

      return updated;
    },

    async updateRoles(
      actor: RequestUser,
      id: string,
      input: UpdateEmployeeRolesInput,
      meta: RequestMeta,
    ): Promise<EmployeeRecord> {
      if (!isSuperAdmin(actor) || !actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only Super Admin can assign access roles.', 403);
      }

      const existing = await employees.findById(id);
      if (!existing || existing.deletedAt) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
      }
      if (hasRole(existing.roleCodes, ROLE_CODES.SUPER_ADMIN)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'This account cannot be edited here.', 403);
      }

      const roleIds = await resolveProfileRoleIds(employees, actor, input.roleIds ?? []);
      await employees.setRoles(id, roleIds);

      const updated = await employees.findById(id);
      if (!updated) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          'Roles were updated but the employee could not be loaded.',
          500,
        );
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'employee.role_change',
        entityType: 'employee',
        entityId: id,
        oldValues: { roleCodes: existing.roleCodes },
        newValues: { roleCodes: updated.roleCodes },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      const previousHats = managerialHats(existing.roleCodes);
      const nextHats = managerialHats(updated.roleCodes);
      if (previousHats.join(',') !== nextHats.join(',')) {
        const added = nextHats.filter((code) => !previousHats.includes(code));
        const removed = previousHats.filter((code) => !nextHats.includes(code));
        const changeParts: string[] = [];
        if (added.length > 0) changeParts.push(`added ${formatRoleList(added)}`);
        if (removed.length > 0) changeParts.push(`removed ${formatRoleList(removed)}`);
        const changeSummary = changeParts.join('; ');
        const alertTitle =
          added.length > 0 && removed.length === 0
            ? 'Portal access role assigned'
            : removed.length > 0 && added.length === 0
              ? 'Portal access role removed'
              : 'Portal access roles updated';
        const alertMessage =
          nextHats.length > 0
            ? `Your access roles were updated (${changeSummary}). You now have: ${formatRoleList(nextHats)}. Refresh the page (or sign in again) so your menu and home desk match the new role.`
            : `Your managerial access was removed (${changeSummary}). You still have Employee access for personal tools. Refresh the page so your menu updates.`;

        try {
          const portalUrl = portalLoginUrl();
          await notifyUser(supabase, {
            userId: updated.userId,
            type: 'profile',
            title: alertTitle,
            message: alertMessage,
            referenceType: 'employee',
            referenceId: updated.id,
          });
          await sendPortalMail({
            to: [updated.notificationEmail || updated.email],
            subject: alertTitle,
            eyebrow: 'Access',
            title: alertTitle,
            greeting: `Hi ${updated.fullName},`,
            paragraphs: [
              alertMessage,
              'Open Alerts in the portal for the same update. Use Sign in if you are not already logged in.',
            ],
            details: [
              { label: 'Previous roles', value: formatRoleList(previousHats) },
              { label: 'Current roles', value: formatRoleList(nextHats) },
            ],
            cta: { label: 'Open portal', href: portalUrl },
          });
        } catch {
          /* Role change is saved even if mail or in-app notify is unavailable. */
        }
      }

      return updated;
    },

    async updateCompany(
      actor: RequestUser,
      id: string,
      companyId: string | null,
      meta: RequestMeta,
    ): Promise<EmployeeRecord> {
      if (!canWriteEmployeeCompany(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only HR Manager can assign company.', 403);
      }
      await assertCanStaffDirectoryTarget(supabase, actor, id);

      const existing = await employees.findById(id);
      if (!existing || existing.deletedAt) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
      }

      const nextId = emptyToNull(companyId) ?? null;
      if (!nextId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select a company for this employee.', 400);
      }
      const company = await employees.findActiveCompany(nextId);
      if (!company) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Company not found or inactive.', 400);
      }

      if (existing.companyId === nextId) {
        return existing;
      }

      await employees.update(id, { company_id: nextId });
      const updated = await employees.findById(id);
      if (!updated) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Company was saved but the employee could not be loaded.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'employee.company_change',
        entityType: 'employee',
        entityId: id,
        oldValues: { companyId: existing.companyId, companyName: existing.companyName },
        newValues: { companyId: updated.companyId, companyName: updated.companyName ?? company.name },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return updated;
    },

    async setStatus(
      actor: RequestUser,
      id: string,
      status: 'active' | 'inactive',
      meta: RequestMeta,
    ): Promise<EmployeeRecord> {
      const existing = await employees.findById(id);
      if (!existing || existing.deletedAt) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
      }
      if (!actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot change account status.', 403);
      }
      assertCanLifecycleTarget(actor, existing.roleCodes, id);
      if (existing.status === status) {
        return existing;
      }
      await employees.update(id, { status });
      const updated = await employees.findById(id);
      if (!updated) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Employee status was saved but could not be loaded.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: status === 'inactive' ? 'employee.deactivate' : 'employee.activate',
        entityType: 'employee',
        entityId: id,
        oldValues: { status: existing.status },
        newValues: { status },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return updated;
    },

    async remove(actor: RequestUser, id: string, meta: RequestMeta): Promise<void> {
      const existing = await employees.findById(id);
      if (!existing || existing.deletedAt) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
      }
      if (!actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot delete this employee.', 403);
      }
      assertCanLifecycleTarget(actor, existing.roleCodes, id);
      const userId = existing.userId;
      await employees.update(id, {
        status: 'inactive',
        deleted_at: new Date().toISOString(),
        user_id: null,
        email: `deleted.${id.replaceAll('-', '')}@invalid.local`,
        employee_code: `DEL-${id.slice(0, 8).toUpperCase()}`,
      });
      if (userId) {
        await supabase.auth.admin.deleteUser(userId);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'employee.delete',
        entityType: 'employee',
        entityId: id,
        oldValues: { employeeCode: existing.employeeCode, fullName: existing.fullName, status: existing.status },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
    },

    async getPayroll(actor: RequestUser, id: string) {
      await this.getById(actor, id);
      return createEmployeeMasterService(supabase).getPayroll(actor, id);
    },

    async saveCompensation(actor: RequestUser, id: string, input: Partial<CompensationInput>, meta: RequestMeta) {
      await assertCanStaffDirectoryTarget(supabase, actor, id);
      return createEmployeeMasterService(supabase).saveCompensation(actor, id, input, meta);
    },

    async savePayment(actor: RequestUser, id: string, input: PaymentInput, meta: RequestMeta) {
      await assertCanStaffDirectoryTarget(supabase, actor, id);
      return createEmployeeMasterService(supabase).savePayment(actor, id, input, meta);
    },

    async sendWorkEmailOtp(actor: RequestUser, email: string): Promise<{ sent: true }> {
      if (!actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot create employee logins.', 403);
      }
      const normalized = normalizeWorkEmail(email);
      if (await employees.findByEmail(normalized)) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'An employee with this email already exists.', 409);
      }
      const code = issueWorkEmailOtp(actor.employeeId, normalized);
      await sendPortalMail({
        to: [normalized],
        subject: 'Confirm this work email',
        eyebrow: 'Work email',
        title: 'Your confirmation code',
        greeting: 'Hello',
        paragraphs: [
          'HR is setting up your HR Portal account. Give them this 4-digit code so they can use this email for updates and login.',
          'The code expires in 10 minutes. If you did not expect this, you can ignore it.',
        ],
        details: [{ label: 'Code', value: code }],
      });
      return { sent: true };
    },

    async verifyWorkEmailOtp(
      actor: RequestUser,
      email: string,
      code: string,
    ): Promise<{ email: string; emailVerificationToken: string }> {
      if (!actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot create employee logins.', 403);
      }
      const token = confirmWorkEmailOtp(actor.employeeId, email, code);
      return { email: normalizeWorkEmail(email), emailVerificationToken: token };
    },
  };
}

export type EmployeeService = ReturnType<typeof createEmployeeService>;
