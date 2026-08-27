import { describe, expect, it, vi } from 'vitest';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import type { RequestUser } from '../../shared/types/request-user';
import { createLeaveCatalogService } from './catalog-service';
import type { SupabaseClient } from '@supabase/supabase-js';

const hr: RequestUser = {
  authUserId: 'a',
  employeeId: 'hr-1',
  email: 'hr@example.com',
  fullName: 'HR',
  roles: [ROLE_CODES.HR_MANAGER],
  permissions: [PERMISSIONS.LEAVE_TYPES_MANAGE, PERMISSIONS.SYSTEM_MANAGE],
};

const superAdmin: RequestUser = {
  authUserId: 'b',
  employeeId: 'sa-1',
  email: 'sa@example.com',
  fullName: 'SA',
  roles: [ROLE_CODES.SUPER_ADMIN],
  permissions: [PERMISSIONS.USERS_VIEW, PERMISSIONS.LEAVE_VIEW],
};

describe('leave catalog', () => {
  it('stores the paid flag when HR creates a leave type', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const leaveInsert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: {
            id: 'lt-1',
            name: 'Casual',
            code: 'CL',
            description: '',
            active: true,
            requires_approval: true,
            requires_handover: false,
            requires_attachment: false,
            allow_half_day: true,
            allow_multiple_days: true,
            paid: true,
          },
          error: null,
        }),
      }),
    });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'leave_types') {
          return { insert: leaveInsert };
        }
        if (table === 'audit_logs') {
          return { insert };
        }
        throw new Error(table);
      }),
    } as unknown as SupabaseClient;

    const created = await createLeaveCatalogService(supabase).createType(
      hr,
      { name: 'Casual', code: 'CL', paid: true },
      {},
    );
    expect(created.paid).toBe(true);
    expect(leaveInsert.mock.calls[0][0].paid).toBe(true);
  });

  it('blocks Super Admin from creating a holiday', async () => {
    const service = createLeaveCatalogService({} as SupabaseClient);
    await expect(
      service.createHoliday(superAdmin, { name: 'Republic Day', date: '2026-01-26' }, {}),
    ).rejects.toMatchObject({ code: API_ERROR_CODES.FORBIDDEN });
  });
});
