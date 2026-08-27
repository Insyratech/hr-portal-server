import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { assertHrDomainOwner, isHrDomainOwner, isSuperAdminOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';

/** HR owns the org catalog; Super Admin may add job titles while creating people. */
function canWriteDesignationCatalog(actor: RequestUser): boolean {
  if (isSuperAdminOwner(actor) && actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
    return true;
  }
  return isHrDomainOwner(actor) && actor.permissions.includes(PERMISSIONS.SYSTEM_MANAGE);
}
const WEEKDAY_CODES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

/** Calendar order. Unchecked codes are weekly offs — never special-case Saturday or Sunday. */
export function normalizeWorkingDays(days: string[]): string[] {
  const allowed = new Set<string>(WEEKDAY_CODES);
  const selected = new Set<string>();
  for (const day of days) {
    const code = day.trim().toUpperCase();
    if (!allowed.has(code)) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Working days must use MON–SUN codes.', 400);
    }
    selected.add(code);
  }
  if (selected.size === 0) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select at least one working day.', 400);
  }
  return WEEKDAY_CODES.filter((day) => selected.has(day));
}

export type NamedRecord = {
  id: string;
  name: string;
  code: string;
  status: 'active' | 'inactive';
};

export type RoleRecord = {
  id: string;
  code: string;
  name: string;
};

/** Working-day calendar only. Salary-slip letterhead lives on companies (payroll Phase 2), not here. */
export type OrganizationSettings = {
  id: string;
  workingDays: string[];
  /** Hour 0–23 in Asia/Kolkata (IST). Cron for daily work reminders should run near this hour IST. */
  workUpdateReminderHour: number;
};

type NamedRow = {
  id: string;
  name: string;
  code: string;
  status: 'active' | 'inactive';
};

function mapSettings(row: { id: string; working_days: string[]; work_update_reminder_hour?: number | null }): OrganizationSettings {
  const hour = Number(row.work_update_reminder_hour);
  return {
    id: row.id,
    workingDays: row.working_days,
    workUpdateReminderHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 20,
  };
}

function mapNamed(row: NamedRow): NamedRecord {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    status: row.status,
  };
}

export function createOrganizationRepository(supabase: SupabaseClient) {
  return {
    async listNamed(table: 'departments' | 'designations'): Promise<NamedRecord[]> {
      const { data, error } = await supabase.from(table).select('id, name, code, status').order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to list ${table}.`, 500);
      }
      return ((data ?? []) as NamedRow[]).map(mapNamed);
    },

    async findNamed(table: 'departments' | 'designations', id: string): Promise<NamedRecord | null> {
      const { data, error } = await supabase
        .from(table)
        .select('id, name, code, status')
        .eq('id', id)
        .maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to load ${table}.`, 500);
      }
      return data ? mapNamed(data as NamedRow) : null;
    },

    async insertNamed(
      table: 'departments' | 'designations',
      input: { name: string; code: string; status?: 'active' | 'inactive' },
    ): Promise<NamedRecord> {
      const { data, error } = await supabase
        .from(table)
        .insert({
          name: input.name,
          code: input.code,
          status: input.status ?? 'active',
        })
        .select('id, name, code, status')
        .single();

      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, `A record with this code already exists.`, 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to create ${table}.`, 500);
      }

      return mapNamed(data as NamedRow);
    },

    async updateNamed(
      table: 'departments' | 'designations',
      id: string,
      input: { name?: string; code?: string; status?: 'active' | 'inactive' },
    ): Promise<NamedRecord> {
      const { data, error } = await supabase
        .from(table)
        .update(input)
        .eq('id', id)
        .select('id, name, code, status')
        .maybeSingle();

      if (error) {
        if (error.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, `A record with this code already exists.`, 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, `Failed to update ${table}.`, 500);
      }

      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Record not found.', 404);
      }

      return mapNamed(data as NamedRow);
    },

    async listRoles(): Promise<RoleRecord[]> {
      const { data, error } = await supabase.from('roles').select('id, code, name').order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list roles.', 500);
      }
      return (data ?? []) as RoleRecord[];
    },

    async getSettings(): Promise<OrganizationSettings> {
      const { data, error } = await supabase
        .from('organization_settings')
        .select('id, working_days, work_update_reminder_hour')
        .limit(1)
        .maybeSingle();

      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load organisation settings.', 500);
      }

      return mapSettings(data as { id: string; working_days: string[]; work_update_reminder_hour?: number | null });
    },

    async updateSettings(workingDays: string[]): Promise<OrganizationSettings> {
      const current = await this.getSettings();
      const { data, error } = await supabase
        .from('organization_settings')
        .update({ working_days: normalizeWorkingDays(workingDays) })
        .eq('id', current.id)
        .select('id, working_days, work_update_reminder_hour')
        .single();

      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update organisation settings.', 500);
      }

      return mapSettings(data as { id: string; working_days: string[]; work_update_reminder_hour?: number | null });
    },
  };
}

export function createOrganizationService(supabase: SupabaseClient) {
  const repo = createOrganizationRepository(supabase);

  return {
    listDepartments: () => repo.listNamed('departments'),
    listDesignations: () => repo.listNamed('designations'),
    listRoles: () => repo.listRoles(),
    getSettings: () => repo.getSettings(),

    async createDepartment(
      actor: RequestUser,
      input: { name: string; code: string },
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      assertHrDomainOwner(actor, 'manage departments');
      if (!actor.permissions.includes(PERMISSIONS.SYSTEM_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage departments.', 403);
      }
      const created = await repo.insertNamed('departments', input);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'department.create',
        entityType: 'department',
        entityId: created.id,
        newValues: created,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return created;
    },

    async updateDepartment(
      actor: RequestUser,
      id: string,
      input: { name?: string; code?: string; status?: 'active' | 'inactive' },
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      assertHrDomainOwner(actor, 'manage departments');
      if (!actor.permissions.includes(PERMISSIONS.SYSTEM_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage departments.', 403);
      }
      const existing = await repo.findNamed('departments', id);
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Department not found.', 404);
      }
      const updated = await repo.updateNamed('departments', id, input);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'department.update',
        entityType: 'department',
        entityId: id,
        oldValues: existing,
        newValues: updated,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return updated;
    },

    async createDesignation(
      actor: RequestUser,
      input: { name: string; code: string },
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      if (!canWriteDesignationCatalog(actor)) {
        throw new AppError(
          API_ERROR_CODES.FORBIDDEN,
          'Only Super Admin or HR Manager can create designations.',
          403,
        );
      }
      const created = await repo.insertNamed('designations', input);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'designation.create',
        entityType: 'designation',
        entityId: created.id,
        newValues: created,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return created;
    },

    async updateDesignation(
      actor: RequestUser,
      id: string,
      input: { name?: string; code?: string; status?: 'active' | 'inactive' },
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      if (!canWriteDesignationCatalog(actor)) {
        throw new AppError(
          API_ERROR_CODES.FORBIDDEN,
          'Only Super Admin or HR Manager can update designations.',
          403,
        );
      }
      const existing = await repo.findNamed('designations', id);
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Designation not found.', 404);
      }
      const updated = await repo.updateNamed('designations', id, input);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'designation.update',
        entityType: 'designation',
        entityId: id,
        oldValues: existing,
        newValues: updated,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return updated;
    },

    async updateSettings(
      actor: RequestUser,
      workingDays: string[],
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      assertHrDomainOwner(actor, 'change working days');
      if (!actor.permissions.includes(PERMISSIONS.SYSTEM_MANAGE)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot change working days.', 403);
      }
      const existing = await repo.getSettings();
      const updated = await repo.updateSettings(workingDays);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'organization_settings.update',
        entityType: 'organization_settings',
        entityId: updated.id,
        oldValues: { workingDays: existing.workingDays },
        newValues: { workingDays: updated.workingDays },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return updated;
    },
  };
}
