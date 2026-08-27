import { describe, expect, it, vi } from 'vitest';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import type { RequestUser } from '../../shared/types/request-user';
import { createCompanyService } from './service';
import type { SupabaseClient } from '@supabase/supabase-js';

const hr: RequestUser = {
  authUserId: 'a',
  employeeId: 'hr-1',
  email: 'hr@example.com',
  fullName: 'HR',
  roles: [ROLE_CODES.HR_MANAGER],
  permissions: [PERMISSIONS.COMPANIES_MANAGE],
};

const superAdmin: RequestUser = {
  authUserId: 'b',
  employeeId: 'sa-1',
  email: 'sa@example.com',
  fullName: 'SA',
  roles: [ROLE_CODES.SUPER_ADMIN],
  permissions: [PERMISSIONS.USERS_VIEW, PERMISSIONS.PAYROLL_VIEW],
};

describe('company service', () => {
  it('lets Super Admin list companies and forbids create', async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
      })),
    } as unknown as SupabaseClient;
    const service = createCompanyService(supabase);
    await expect(service.list(superAdmin)).resolves.toEqual([]);
    await expect(service.create(superAdmin, { name: 'Insyra', address: 'Pune' }, {})).rejects.toMatchObject({
      code: API_ERROR_CODES.FORBIDDEN,
    });
    await expect(service.update(superAdmin, 'co-1', { name: 'Insyra' }, {})).rejects.toMatchObject({
      code: API_ERROR_CODES.FORBIDDEN,
    });
  });

  it('lets HR Manager create a company', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'companies') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: 'co-1',
                    name: 'Insyra',
                    address: 'Pune',
                    logo_storage_path: null,
                    status: 'active',
                    created_at: '2026-01-01T00:00:00.000Z',
                    updated_at: '2026-01-01T00:00:00.000Z',
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'audit_logs') {
          return { insert };
        }
        throw new Error(table);
      }),
    } as unknown as SupabaseClient;
    const created = await createCompanyService(supabase).create(hr, { name: 'Insyra', address: 'Pune' }, {});
    expect(created.name).toBe('Insyra');
    expect(insert).toHaveBeenCalled();
  });
});
