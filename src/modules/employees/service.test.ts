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
  email: 'sa@example.com',
  fullName: 'Super Admin',
  roles: ['SUPER_ADMIN'],
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
  companyId: null,
  joiningDate: '2026-01-01',
  employmentType: 'full_time',
  managerId: null,
  status: 'active',
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  departmentName: null,
  designationName: null,
  companyName: null,
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
        password: 'password1',
      },
      {},
    );

    expect(result.id).toBe('emp-2');
    expect(employees.insert).toHaveBeenCalledWith(expect.objectContaining({ companyId: null }));
    expect(employees.setRoles).toHaveBeenCalledWith('emp-2', ['00000000-0000-4000-8000-000000000003']);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0].action).toBe('employee.create');
  });

  it('creates without company, shift, or pay (HR fills those later)', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      auth: {
        admin: {
          createUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'auth-5' } },
            error: null,
          }),
          deleteUser: vi.fn(),
        },
      },
      from: vi.fn((table: string) => {
        if (table === 'audit_logs') return { insert };
        if (table === 'notifications') return { insert: vi.fn().mockResolvedValue({ error: null }) };
        throw new Error(`unexpected table ${table}`);
      }),
    } as unknown as SupabaseClient;
    const employees = {
      findByEmail: vi.fn().mockResolvedValue(null),
      findByCode: vi.fn().mockResolvedValue(null),
      roleExists: vi.fn().mockResolvedValue(true),
      insert: vi.fn().mockResolvedValue('emp-5'),
      setRoles: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue({ ...created, id: 'emp-5' }),
    } as unknown as EmployeeRepository;

    const result = await createEmployeeService(supabase, employees).create(
      actor,
      {
        employeeCode: 'E-5',
        fullName: 'Staff',
        email: 'staff2@example.com',
        joiningDate: '2026-01-01',
        employmentType: 'full_time',
        password: 'password1',
        companyId: 'co-1',
        shiftId: 'sh-1',
        compensation: { basic: 1, da: 0, hra: 0, fuel: 0 },
      },
      {},
    );
    expect(result.id).toBe('emp-5');
    expect(employees.insert).toHaveBeenCalledWith(expect.objectContaining({ companyId: null }));
  });

  it('ignores managerial roleId on create and assigns Employee only', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      auth: {
        admin: {
          createUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'auth-3' } },
            error: null,
          }),
          deleteUser: vi.fn(),
        },
      },
      from: vi.fn((table: string) => {
        if (table === 'audit_logs') return { insert };
        if (table === 'notifications') return { insert: vi.fn().mockResolvedValue({ error: null }) };
        throw new Error(`unexpected table ${table}`);
      }),
    } as unknown as SupabaseClient;
    const employees = {
      findByEmail: vi.fn().mockResolvedValue(null),
      findByCode: vi.fn().mockResolvedValue(null),
      roleExists: vi.fn().mockResolvedValue(true),
      insert: vi.fn().mockResolvedValue('emp-3'),
      setRoles: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue({ ...created, id: 'emp-3' }),
    } as unknown as EmployeeRepository;

    await createEmployeeService(supabase, employees).create(
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
    );
    expect(employees.setRoles).toHaveBeenCalledWith('emp-3', ['00000000-0000-4000-8000-000000000003']);
  });

  it('creates as Employee even when the client sends a managerial roleId', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      auth: {
        admin: {
          createUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'auth-gm' } },
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
      insert: vi.fn().mockResolvedValue('emp-gm'),
      setRoles: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue({ ...created, id: 'emp-gm', roleCodes: ['EMPLOYEE'] }),
    } as unknown as EmployeeRepository;
    const service = createEmployeeService(supabase, employees);

    const result = await service.create(
      actor,
      {
        employeeCode: 'GM-1',
        fullName: 'GM Person',
        email: 'gm@example.com',
        joiningDate: '2026-01-01',
        employmentType: 'full_time',
        roleId: '00000000-0000-4000-8000-000000000002',
        password: 'password1',
      },
      {},
    );

    expect(result.roleCodes).toEqual(['EMPLOYEE']);
    expect(employees.setRoles).toHaveBeenCalledWith('emp-gm', ['00000000-0000-4000-8000-000000000003']);
  });

  it('rejects company changes on directory PATCH (HR assigns company separately)', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'req-1',
          target_employee_id: 'emp-2',
          status: 'APPROVED',
          unlocked_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        error: null,
      }),
    };
    const supabase = { from: vi.fn(() => chain) } as unknown as SupabaseClient;
    const employees = {
      findById: vi.fn().mockResolvedValue(created),
      update: vi.fn(),
    } as unknown as EmployeeRepository;
    const service = createEmployeeService(supabase, employees);

    await expect(service.update(actor, 'emp-2', { companyId: 'co-2' }, {})).rejects.toMatchObject({
      code: API_ERROR_CODES.VALIDATION_ERROR,
    });
    expect(employees.update).not.toHaveBeenCalled();
  });

  it('lets HR assign company without a directory unlock', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const staffChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'emp-2', deleted_at: null }, error: null }),
    };
    const rolesChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: [{ roles: { code: 'EMPLOYEE' } }], error: null }),
    };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'employees') return staffChain;
        if (table === 'employee_roles') return rolesChain;
        if (table === 'audit_logs') return { insert };
        throw new Error(table);
      }),
    } as unknown as SupabaseClient;
    const employees = {
      findById: vi
        .fn()
        .mockResolvedValueOnce(created)
        .mockResolvedValueOnce({ ...created, companyId: 'co-1', companyName: 'Insyra' }),
      findActiveCompany: vi.fn().mockResolvedValue({ id: 'co-1', name: 'Insyra' }),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmployeeRepository;
    const hr: RequestUser = {
      authUserId: 'auth-hr',
      employeeId: 'hr-1',
      email: 'hr@example.com',
      fullName: 'HR',
      roles: ['HR_MANAGER'],
      permissions: [PERMISSIONS.COMPANIES_MANAGE, PERMISSIONS.USERS_VIEW],
    };

    const result = await createEmployeeService(supabase, employees).updateCompany(hr, 'emp-2', 'co-1', {});
    expect(result.companyId).toBe('co-1');
    expect(employees.update).toHaveBeenCalledWith('emp-2', { company_id: 'co-1' });
    expect(insert.mock.calls[0][0].action).toBe('employee.company_change');
  });

  it('blocks Super Admin from changing personal fields without unlock', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const supabase = { from: vi.fn(() => chain) } as unknown as SupabaseClient;
    const employees = {
      findById: vi.fn().mockResolvedValue(created),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmployeeRepository;
    const service = createEmployeeService(supabase, employees);

    await expect(service.update(actor, 'emp-2', { fullName: 'Ada' }, {})).rejects.toMatchObject({
      code: API_ERROR_CODES.FORBIDDEN,
    });
  });
  it('lets Super Admin change an employee when an unlock is active', async () => {
    const unlockUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'req-1',
          target_employee_id: 'emp-2',
          requester_id: 'hr-1',
          reason: 'Fix joining date',
          field_hints: null,
          status: 'APPROVED',
          decided_by: 'sa-1',
          decision_note: null,
          unlocked_until: unlockUntil,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          decided_at: new Date().toISOString(),
          fulfilled_at: null,
          employees: { full_name: 'Ada', employee_code: 'E-2' },
          requester: { full_name: 'HR' },
        },
        error: null,
      }),
      update: vi.fn().mockReturnThis(),
      insert: vi.fn().mockResolvedValue({ error: null }),
    };
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'directory_edit_requests') return chain;
        if (table === 'audit_logs' || table === 'notifications') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    } as unknown as SupabaseClient;
    const employees = {
      findById: vi.fn().mockResolvedValue({ ...created, fullName: 'Ada Lovelace' }),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmployeeRepository;

    const result = await createEmployeeService(supabase, employees).update(
      actor,
      'emp-2',
      { fullName: 'Ada Lovelace' },
      {},
    );
    expect(result.fullName).toBe('Ada Lovelace');
    expect(employees.update).toHaveBeenCalled();
  });

  it('lets Super Admin create an employee', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      auth: {
        admin: {
          createUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'auth-4' } },
            error: null,
          }),
          deleteUser: vi.fn(),
        },
      },
      from: vi.fn((table: string) => {
        if (table === 'audit_logs') return { insert };
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
      insert: vi.fn().mockResolvedValue('emp-4'),
      setRoles: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue({ ...created, id: 'emp-4' }),
    } as unknown as EmployeeRepository;
    const service = createEmployeeService(supabase, employees);

    const result = await service.create(
      actor,
      {
        employeeCode: 'E-4',
        fullName: 'Staff',
        email: 'staff@example.com',
        joiningDate: '2026-01-01',
        employmentType: 'full_time',
        password: 'password1',
      },
      {},
    );
    expect(result.id).toBe('emp-4');
  });

  it('blocks General Manager from creating accounts', async () => {
    const employees = {
      findByEmail: vi.fn().mockResolvedValue(null),
      findByCode: vi.fn().mockResolvedValue(null),
      roleExists: vi.fn().mockResolvedValue(true),
      findRoleCode: vi.fn().mockResolvedValue('EMPLOYEE'),
    } as unknown as EmployeeRepository;
    const service = createEmployeeService({} as SupabaseClient, employees);
    const gm: RequestUser = {
      ...actor,
      roles: ['GENERAL_MANAGER'],
      permissions: [PERMISSIONS.USERS_VIEW],
    };

    await expect(
      service.create(
        gm,
        {
          employeeCode: 'E-9',
          fullName: 'Staff',
          email: 'staff9@example.com',
          joiningDate: '2026-01-01',
          employmentType: 'full_time',
          roleId: '00000000-0000-4000-8000-000000000003',
          password: 'password1',
        },
        {},
      ),
    ).rejects.toMatchObject({
      code: API_ERROR_CODES.FORBIDDEN,
    });
  });

  it('lets Super Admin deactivate an employee without editing their profile', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'audit_logs') return { insert };
        throw new Error(table);
      }),
    } as unknown as SupabaseClient;
    const employees = {
      findById: vi.fn().mockResolvedValueOnce(created).mockResolvedValueOnce({ ...created, status: 'inactive' }),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmployeeRepository;
    const superAdmin: RequestUser = {
      ...actor,
      roles: ['SUPER_ADMIN'],
      permissions: [PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_VIEW],
    };
    const result = await createEmployeeService(supabase, employees).setStatus(superAdmin, 'emp-2', 'inactive', {});
    expect(result.status).toBe('inactive');
    expect(insert.mock.calls[0][0].action).toBe('employee.deactivate');
  });

  it('lets Super Admin permanently remove an employee', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const deleteUser = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      auth: { admin: { deleteUser } },
      from: vi.fn((table: string) => {
        if (table === 'audit_logs') return { insert };
        throw new Error(table);
      }),
    } as unknown as SupabaseClient;
    const employees = {
      findById: vi.fn().mockResolvedValue(created),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmployeeRepository;
    const superAdmin: RequestUser = {
      ...actor,
      roles: ['SUPER_ADMIN'],
      permissions: [PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_VIEW],
    };
    await createEmployeeService(supabase, employees).remove(superAdmin, 'emp-2', {});
    expect(employees.update).toHaveBeenCalledWith(
      'emp-2',
      expect.objectContaining({ status: 'inactive', user_id: null }),
    );
    expect(deleteUser).toHaveBeenCalledWith('auth-2');
    expect(insert.mock.calls[0][0].action).toBe('employee.delete');
  });

  it('lets Super Admin assign managerial hats without a directory unlock', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'audit_logs') return { insert };
        throw new Error(`unexpected table ${table}`);
      }),
    } as unknown as SupabaseClient;
    const employees = {
      findById: vi
        .fn()
        .mockResolvedValueOnce(created)
        .mockResolvedValueOnce({
          ...created,
          roleCodes: ['EMPLOYEE', 'HR_MANAGER', 'GENERAL_MANAGER'],
        }),
      roleExists: vi.fn().mockResolvedValue(true),
      findRoleCode: vi.fn(async (id: string) => {
        if (id === '00000000-0000-4000-8000-000000000004') return 'HR_MANAGER';
        if (id === '00000000-0000-4000-8000-000000000002') return 'GENERAL_MANAGER';
        if (id === '00000000-0000-4000-8000-000000000003') return 'EMPLOYEE';
        return null;
      }),
      setRoles: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmployeeRepository;

    const result = await createEmployeeService(supabase, employees).updateRoles(
      actor,
      'emp-2',
      {
        roleIds: [
          '00000000-0000-4000-8000-000000000004',
          '00000000-0000-4000-8000-000000000002',
        ],
      },
      {},
    );

    expect(employees.setRoles).toHaveBeenCalledWith('emp-2', [
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ]);
    expect(result.roleCodes).toEqual(['EMPLOYEE', 'HR_MANAGER', 'GENERAL_MANAGER']);
    expect(insert.mock.calls[0][0]).toMatchObject({
      action: 'employee.role_change',
      old_values: { roleCodes: ['EMPLOYEE'] },
      new_values: { roleCodes: ['EMPLOYEE', 'HR_MANAGER', 'GENERAL_MANAGER'] },
    });
  });

  it('keeps Employee when Super Admin removes all managerial hats', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'audit_logs') return { insert };
        throw new Error(table);
      }),
    } as unknown as SupabaseClient;
    const employees = {
      findById: vi
        .fn()
        .mockResolvedValueOnce({ ...created, roleCodes: ['EMPLOYEE', 'FINANCE_MANAGER'] })
        .mockResolvedValueOnce(created),
      roleExists: vi.fn().mockResolvedValue(true),
      findRoleCode: vi.fn(),
      setRoles: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmployeeRepository;

    const result = await createEmployeeService(supabase, employees).updateRoles(actor, 'emp-2', { roleIds: [] }, {});
    expect(employees.setRoles).toHaveBeenCalledWith('emp-2', ['00000000-0000-4000-8000-000000000003']);
    expect(result.roleCodes).toEqual(['EMPLOYEE']);
  });

  it('blocks General Manager from assigning roles on a profile', async () => {
    const employees = {
      findById: vi.fn().mockResolvedValue(created),
    } as unknown as EmployeeRepository;
    const gm: RequestUser = {
      ...actor,
      roles: ['GENERAL_MANAGER'],
      permissions: [PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_VIEW],
    };

    await expect(
      createEmployeeService({} as SupabaseClient, employees).updateRoles(
        gm,
        'emp-2',
        { roleIds: ['00000000-0000-4000-8000-000000000004'] },
        {},
      ),
    ).rejects.toMatchObject({ code: API_ERROR_CODES.FORBIDDEN });
    expect(employees.findById).not.toHaveBeenCalled();
  });

  it('blocks role changes on a Super Admin target', async () => {
    const employees = {
      findById: vi.fn().mockResolvedValue({ ...created, roleCodes: ['SUPER_ADMIN'] }),
      setRoles: vi.fn(),
    } as unknown as EmployeeRepository;

    await expect(
      createEmployeeService({} as SupabaseClient, employees).updateRoles(
        actor,
        'emp-2',
        { roleIds: ['00000000-0000-4000-8000-000000000004'] },
        {},
      ),
    ).rejects.toMatchObject({ code: API_ERROR_CODES.FORBIDDEN });
    expect(employees.setRoles).not.toHaveBeenCalled();
  });
});
