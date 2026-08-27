import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import type { RequestUser } from '../../shared/types/request-user';
import { createWorkPermissionService } from './service';
import type { SupabaseClient } from '@supabase/supabase-js';

const employee: RequestUser = {
  authUserId: 'e',
  employeeId: 'emp-1',
  email: 'e@example.com',
  fullName: 'Emp',
  roles: [ROLE_CODES.EMPLOYEE],
  permissions: [PERMISSIONS.WORK_PERMISSION_APPLY],
};

const superAdmin: RequestUser = {
  authUserId: 's',
  employeeId: 'sa-1',
  email: 'sa@example.com',
  fullName: 'SA',
  roles: [ROLE_CODES.SUPER_ADMIN],
  permissions: [PERMISSIONS.USERS_VIEW],
};

describe('work permission service', () => {
  it('lets Super Admin list the queue but not decide', async () => {
    const service = createWorkPermissionService({} as SupabaseClient);
    await expect(service.decide(superAdmin, 'wp-1', 'approve', {})).rejects.toMatchObject({
      code: API_ERROR_CODES.FORBIDDEN,
    });
  });

  it('blocks Super Admin from applying', async () => {
    const service = createWorkPermissionService({} as SupabaseClient);
    await expect(
      service.apply(superAdmin, { permissionDate: '2026-08-03', minutes: 60, slot: 'START' }, {}),
    ).rejects.toMatchObject({ code: API_ERROR_CODES.FORBIDDEN });
  });

  it('blocks listing the queue without view or approve', async () => {
    const service = createWorkPermissionService({} as SupabaseClient);
    await expect(service.listQueue(employee)).rejects.toMatchObject({
      code: API_ERROR_CODES.FORBIDDEN,
    });
  });
});
