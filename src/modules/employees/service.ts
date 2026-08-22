import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { portalLoginUrl, sendPortalMail } from '../notifications/mail';
import { notifyUser } from '../notifications/notify-user';
import { emptyToNull, toDateColumn } from './dates';
import type { EmployeeRepository } from './repository';
import type { CreateEmployeeInput, EmployeeRecord, EmployeeStatus, UpdateEmployeeInput } from './types';

/** Roles that may be assigned when creating or changing an employee via API. */
const ASSIGNABLE_ROLE_CODES = new Set(['EMPLOYEE', 'ADMIN']);

async function resolveAssignableRoleIds(
  employees: EmployeeRepository,
  input: { roleId?: string; roleIds?: string[] },
): Promise<string[]> {
  const requested = [...new Set(input.roleIds?.length ? input.roleIds : input.roleId ? [input.roleId] : [])];
  if (requested.length === 0) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select at least one access role.', 400);
  }
  for (const roleId of requested) {
    if (!(await employees.roleExists(roleId))) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Role not found.', 400);
    }
    const roleCode = await employees.findRoleCode(roleId);
    if (!roleCode || !ASSIGNABLE_ROLE_CODES.has(roleCode)) {
      throw new AppError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Onboarding may only assign Employee and/or Admin (HR manager).',
        400,
      );
    }
  }
  return requested;
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
      if (!employee) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
      }

      return employee;
    },

    async create(
      actor: RequestUser,
      input: CreateEmployeeInput,
      meta: RequestMeta,
    ): Promise<EmployeeRecord> {
      if (await employees.findByEmail(input.email)) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'An employee with this email already exists.', 409);
      }

      if (await employees.findByCode(input.employeeCode)) {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'An employee with this code already exists.', 409);
      }

      const roleIds = await resolveAssignableRoleIds(employees, input);

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
          joiningDate: toDateColumn(input.joiningDate, 'Joining date', true) as string,
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
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
      }

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

      if (Object.keys(patch).length > 0) {
        await employees.update(id, patch);
      }

      if (input.roleIds?.length || input.roleId) {
        const roleIds = await resolveAssignableRoleIds(employees, input);
        await employees.setRoles(id, roleIds);
        await writeAuditLog(supabase, {
          actorId: actor.employeeId,
          action: 'employee.role_change',
          entityType: 'employee',
          entityId: id,
          oldValues: { roleCodes: existing.roleCodes },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        });
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
  };
}

export type EmployeeService = ReturnType<typeof createEmployeeService>;
