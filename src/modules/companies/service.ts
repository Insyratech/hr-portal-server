import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { isHrDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import type { CompanyLogoUpload, CompanyRecord } from './types';

const BUCKET = 'company-logos';
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type CompanyRow = {
  id: string;
  name: string;
  address: string;
  logo_storage_path: string | null;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
};

function canView(actor: RequestUser): boolean {
  return (
    actor.permissions.includes(PERMISSIONS.USERS_VIEW) ||
    actor.permissions.includes(PERMISSIONS.USERS_MANAGE) ||
    actor.permissions.includes(PERMISSIONS.COMPANIES_MANAGE) ||
    actor.permissions.includes(PERMISSIONS.PAYROLL_VIEW) ||
    actor.permissions.includes(PERMISSIONS.PAYROLL_MANAGE)
  );
}

function canManage(actor: RequestUser): boolean {
  return isHrDomainOwner(actor) && actor.permissions.includes(PERMISSIONS.COMPANIES_MANAGE);
}

function mapCompany(row: CompanyRow, logoUrl: string | null): CompanyRecord {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    logoStoragePath: row.logo_storage_path,
    logoUrl,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function signedLogoUrl(supabase: SupabaseClient, path: string | null): Promise<string | null> {
  if (!path) {
    return null;
  }
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
  if (error || !data) {
    return null;
  }
  return data.signedUrl;
}

export function createCompanyService(supabase: SupabaseClient) {
  return {
    async list(actor: RequestUser): Promise<CompanyRecord[]> {
      if (!canView(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view companies.', 403);
      }
      const { data, error } = await supabase.from('companies').select('*').order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list companies.', 500);
      }
      const rows = (data ?? []) as CompanyRow[];
      return Promise.all(rows.map(async (row) => mapCompany(row, await signedLogoUrl(supabase, row.logo_storage_path))));
    },

    async get(actor: RequestUser, id: string): Promise<CompanyRecord> {
      if (!canView(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view companies.', 403);
      }
      const { data, error } = await supabase.from('companies').select('*').eq('id', id).maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load company.', 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Company not found.', 404);
      }
      const row = data as CompanyRow;
      return mapCompany(row, await signedLogoUrl(supabase, row.logo_storage_path));
    },

    async create(
      actor: RequestUser,
      input: { name: string; address: string; status?: 'active' | 'inactive' },
      meta: RequestMeta,
    ): Promise<CompanyRecord> {
      if (!canManage(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage companies.', 403);
      }
      const name = input.name.trim();
      const address = input.address.trim();
      if (!name) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Company name is required.', 400);
      }
      const { data, error } = await supabase
        .from('companies')
        .insert({ name, address, status: input.status ?? 'active' })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'A company with this name already exists.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create company.', 500);
      }
      const created = mapCompany(data as CompanyRow, null);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'company.create',
        entityType: 'company',
        entityId: created.id,
        newValues: { name: created.name, address: created.address, status: created.status },
        ...meta,
      });
      return created;
    },

    async update(
      actor: RequestUser,
      id: string,
      input: { name?: string; address?: string; status?: 'active' | 'inactive'; logoStoragePath?: string | null },
      meta: RequestMeta,
    ): Promise<CompanyRecord> {
      if (!canManage(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage companies.', 403);
      }
      const existing = await this.get(actor, id);
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Company name is required.', 400);
        }
        patch.name = name;
      }
      if (input.address !== undefined) patch.address = input.address.trim();
      if (input.status !== undefined) patch.status = input.status;
      if (input.logoStoragePath !== undefined) patch.logo_storage_path = input.logoStoragePath;

      if (Object.keys(patch).length === 0) {
        return existing;
      }

      const { data, error } = await supabase.from('companies').update(patch).eq('id', id).select('*').maybeSingle();
      if (error) {
        if (error.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'A company with this name already exists.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update company.', 500);
      }
      if (!data) {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Company not found.', 404);
      }
      const updated = mapCompany(data as CompanyRow, await signedLogoUrl(supabase, (data as CompanyRow).logo_storage_path));
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'company.update',
        entityType: 'company',
        entityId: id,
        oldValues: { name: existing.name, address: existing.address, status: existing.status },
        newValues: { name: updated.name, address: updated.address, status: updated.status },
        ...meta,
      });
      return updated;
    },

    async createLogoUpload(
      actor: RequestUser,
      id: string,
      input: { fileName: string; contentType: string; sizeBytes: number },
      meta: RequestMeta,
    ): Promise<CompanyLogoUpload> {
      if (!canManage(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage companies.', 403);
      }
      await this.get(actor, id);
      if (input.sizeBytes > MAX_LOGO_BYTES) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Logo must be 2MB or smaller.', 400);
      }
      if (!LOGO_TYPES.has(input.contentType)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Logo must be a JPEG, PNG, or WebP image.', 400);
      }
      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${id}/${crypto.randomUUID()}-${safeName}`;
      const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
      if (signError || !signed) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          'Failed to create upload URL. Ensure the company-logos bucket exists.',
          500,
        );
      }
      const { error } = await supabase.from('companies').update({ logo_storage_path: path }).eq('id', id);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save logo path.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'company.logo',
        entityType: 'company',
        entityId: id,
        newValues: { logoStoragePath: path, fileName: input.fileName },
        ...meta,
      });
      return { path, token: signed.token, uploadUrl: signed.signedUrl };
    },
  };
}
