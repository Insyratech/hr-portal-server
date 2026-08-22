import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { writeAuditLog } from '../audit/write-audit-log';

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

export type OrganizationSettings = {
  id: string;
  workingDays: string[];
};

type NamedRow = {
  id: string;
  name: string;
  code: string;
  status: 'active' | 'inactive';
};

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
        .select('id, working_days')
        .limit(1)
        .maybeSingle();

      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load organisation settings.', 500);
      }

      return {
        id: data.id as string,
        workingDays: data.working_days as string[],
      };
    },

    async updateSettings(workingDays: string[]): Promise<OrganizationSettings> {
      const current = await this.getSettings();
      const { data, error } = await supabase
        .from('organization_settings')
        .update({ working_days: workingDays })
        .eq('id', current.id)
        .select('id, working_days')
        .single();

      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update organisation settings.', 500);
      }

      return {
        id: data.id as string,
        workingDays: data.working_days as string[],
      };
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
      actorId: string,
      input: { name: string; code: string },
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      const created = await repo.insertNamed('departments', input);
      await writeAuditLog(supabase, {
        actorId,
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
      actorId: string,
      id: string,
      input: { name?: string; code?: string; status?: 'active' | 'inactive' },
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      const existing = await repo.findNamed('departments', id);
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Department not found.', 404);
      }
      const updated = await repo.updateNamed('departments', id, input);
      await writeAuditLog(supabase, {
        actorId,
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
      actorId: string,
      input: { name: string; code: string },
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      const created = await repo.insertNamed('designations', input);
      await writeAuditLog(supabase, {
        actorId,
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
      actorId: string,
      id: string,
      input: { name?: string; code?: string; status?: 'active' | 'inactive' },
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      const existing = await repo.findNamed('designations', id);
      if (!existing) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Designation not found.', 404);
      }
      const updated = await repo.updateNamed('designations', id, input);
      await writeAuditLog(supabase, {
        actorId,
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
      actorId: string,
      workingDays: string[],
      meta: { ipAddress?: string | null; userAgent?: string | null },
    ) {
      const existing = await repo.getSettings();
      const updated = await repo.updateSettings(workingDays);
      await writeAuditLog(supabase, {
        actorId,
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
