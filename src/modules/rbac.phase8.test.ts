import { describe, expect, it, vi } from 'vitest';
import { API_ERROR_CODES } from '../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../shared/constants/permissions';
import type { RequestUser } from '../shared/types/request-user';
import { createCompanyService } from './companies/service';
import { createEmployeeService } from './employees/service';
import type { EmployeeRepository } from './employees/repository';
import { canApprove } from './leave/support';
import { createOrganizationService } from './organization/service';
import type { SupabaseClient } from '@supabase/supabase-js';

const superAdmin: RequestUser = {
  authUserId: 'sa',
  employeeId: 'sa-1',
  email: 'sa@example.com',
  fullName: 'SA',
  roles: [ROLE_CODES.SUPER_ADMIN],
  permissions: [PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_VIEW, PERMISSIONS.PAYROLL_VIEW],
};

const hrManager: RequestUser = {
  authUserId: 'hr',
  employeeId: 'hr-1',
  email: 'hr@example.com',
  fullName: 'HR',
  roles: [ROLE_CODES.HR_MANAGER],
  permissions: [
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.COMPANIES_MANAGE,
    PERMISSIONS.SYSTEM_MANAGE,
    PERMISSIONS.LEAVE_APPROVE,
  ],
};

const generalManager: RequestUser = {
  authUserId: 'gm',
  employeeId: 'gm-1',
  email: 'gm@example.com',
  fullName: 'GM',
  roles: [ROLE_CODES.GENERAL_MANAGER],
  permissions: [PERMISSIONS.USERS_VIEW, PERMISSIONS.ATTENDANCE_MANAGE, PERMISSIONS.PAYROLL_MANAGE],
};

describe('phase 1 role restructure RBAC', () => {
  it('blocks Super Admin from PATCHing an employee row without unlock', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const supabase = { from: vi.fn(() => chain) } as unknown as SupabaseClient;
    const employees = {
      findById: vi.fn().mockResolvedValue({
        id: 'emp-2',
        roleCodes: [ROLE_CODES.EMPLOYEE],
        companyId: 'co-1',
        companyName: 'Insyra',
        fullName: 'Ada',
        status: 'active',
      }),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmployeeRepository;
    await expect(
      createEmployeeService(supabase, employees).update(superAdmin, 'emp-2', { fullName: 'Ada Lovelace' }, {}),
    ).rejects.toMatchObject({ code: API_ERROR_CODES.FORBIDDEN });
  });

  it('blocks Super Admin from PATCHing a company (HR owns org)', async () => {
    await expect(
      createCompanyService({} as SupabaseClient).update(superAdmin, 'co-1', { name: 'Insyra' }, {}),
    ).rejects.toMatchObject({ code: API_ERROR_CODES.FORBIDDEN });
  });

  it('blocks Super Admin from PATCHing working days (HR owns system.manage)', async () => {
    await expect(
      createOrganizationService({} as SupabaseClient).updateSettings(superAdmin, ['MON', 'TUE', 'WED', 'THU', 'FRI'], {}),
    ).rejects.toMatchObject({ code: API_ERROR_CODES.FORBIDDEN });
  });

  it('lets Super Admin create a designation while onboarding (users.manage)', async () => {
    const insert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { id: 'des-1', name: 'Engineer', code: 'ENG', status: 'active' },
          error: null,
        }),
      }),
    });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'designations') return { insert };
        if (table === 'audit_logs') return { insert: vi.fn().mockResolvedValue({ error: null }) };
        throw new Error(table);
      }),
    } as unknown as SupabaseClient;

    const created = await createOrganizationService(supabase).createDesignation(
      superAdmin,
      { name: 'Engineer', code: 'ENG' },
      {},
    );
    expect(created.code).toBe('ENG');
  });

  it('lets only HR Manager approve leave', () => {
    expect(canApprove(hrManager)).toBe(true);
    expect(canApprove(superAdmin)).toBe(false);
    expect(canApprove(generalManager)).toBe(false);
  });
});
