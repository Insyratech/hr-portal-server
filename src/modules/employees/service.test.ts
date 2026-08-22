import { describe, expect, it, vi } from 'vitest';
import { createEmployeeService } from './service';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import type { RequestUser } from '../../shared/types/request-user';
import type { EmployeeRepository } from './repository';
import type { EmployeeRecord } from './types';
import type { SupabaseClient } from '@supabase/supabase-js';

const actor: RequestUser = {
  authUserId: 'auth-1',
  employeeId: 'actor-1',
  email: 'admin@example.com',
  fullName: 'Admin',
  roles: ['ADMIN'],
  permissions: [PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_VIEW],
};

const created: EmployeeRecord = {
  id: 'emp-2',
  userId: 'auth-2',
  employeeCode: 'E-2',
  fullName: 'New Person',
  email: 'new@example.com',
  phone: null,
  notificationEmail: null,
  dateOfBirth: null,
  departmentId: null,
  designationId: null,
  joiningDate: '2026-01-01',
  employmentType: 'full_time',
  managerId: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  departmentName: null,
  designationName: null,
  roleCodes: ['EMPLOYEE'],
};

describe('createEmployeeService', () => {
  it('refuses list without users.view or users.manage', async () => {
    const service = createEmployeeService({} as SupabaseClient, {} as EmployeeRepository);
    const employeeActor: RequestUser = {
      ...actor,
      permissions: [PERMISSIONS.LEAVE_VIEW],
    };

    await expect(service.list(employeeActor, {})).rejects.toMatchObject({
      code: API_ERROR_CODES.FORBIDDEN,
    });
  });

  it('blocks viewing another employee without users.view', async () => {
    const employees = {
      findById: vi.fn(),
    } as unknown as EmployeeRepository;
    const service = createEmployeeService({} as SupabaseClient, employees);
    const employeeActor: RequestUser = {
      ...actor,
      employeeId: 'emp-1',
      permissions: [PERMISSIONS.PROFILE_VIEW],
    };

    await expect(service.getById(employeeActor, 'emp-2')).rejects.toMatchObject({
      code: API_ERROR_CODES.FORBIDDEN,
    });
    expect(employees.findById).not.toHaveBeenCalled();
  });

  it('writes an audit log after creating an employee', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      auth: {
        admin: {
          createUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'auth-2' } },
            error: null,
          }),
          deleteUser: vi.fn(),
        },
      },
      from: vi.fn((table: string) => {
        if (table === 'audit_logs') {
          return { insert };
        }
        if (table === 'notifications') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    } as unknown as SupabaseClient;

    const employees = {
      findByEmail: vi.fn().mockResolvedValue(null),
      findByCode: vi.fn().mockResolvedValue(null),
      roleExists: vi.fn().mockResolvedValue(true),
      findRoleCode: vi.fn().mockResolvedValue('EMPLOYEE'),
      insert: vi.fn().mockResolvedValue('emp-2'),
      setRoles: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue(created),
    } as unknown as EmployeeRepository;

    const service = createEmployeeService(supabase, employees);
    const result = await service.create(
      actor,
      {
        employeeCode: 'E-2',
        fullName: 'New Person',
        email: 'new@example.com',
        joiningDate: '2026-01-01',
        employmentType: 'full_time',
        roleId: '00000000-0000-4000-8000-000000000003',
        password: 'password1',
      },
      {},
    );

    expect(result.id).toBe('emp-2');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0].action).toBe('employee.create');
  });

  it('rejects Super Admin as an onboarding role', async () => {
    const employees = {
      findByEmail: vi.fn().mockResolvedValue(null),
      findByCode: vi.fn().mockResolvedValue(null),
      roleExists: vi.fn().mockResolvedValue(true),
      findRoleCode: vi.fn().mockResolvedValue('SUPER_ADMIN'),
    } as unknown as EmployeeRepository;
    const service = createEmployeeService({} as SupabaseClient, employees);

    await expect(
      service.create(
        actor,
        {
          employeeCode: 'E-3',
          fullName: 'Nope',
          email: 'nope@example.com',
          joiningDate: '2026-01-01',
          employmentType: 'full_time',
          roleId: '00000000-0000-4000-8000-000000000001',
          password: 'password1',
        },
        {},
      ),
    ).rejects.toMatchObject({
      code: API_ERROR_CODES.VALIDATION_ERROR,
    });
  });
});
