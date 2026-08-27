import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { EmployeeRecord, EmployeeStatus } from './types';

type EmployeeRow = {
  id: string;
  user_id: string | null;
  employee_code: string;
  full_name: string;
  email: string;
  phone: string | null;
  notification_email?: string | null;
  date_of_birth: string | null;
  department_id: string | null;
  designation_id: string | null;
  company_id: string | null;
  joining_date: string;
  employment_type: EmployeeRecord['employmentType'];
  manager_id: string | null;
  status: EmployeeStatus;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  departments: { name: string } | { name: string }[] | null;
  designations: { name: string } | { name: string }[] | null;
  companies: { name: string } | { name: string }[] | null;
  employee_roles: { roles: { code: string } | { code: string }[] | null }[] | null;
};

function firstName(
  value: { name: string } | { name: string }[] | null,
): string | null {
  if (!value) {
    return null;
  }
  return Array.isArray(value) ? (value[0]?.name ?? null) : value.name;
}

function roleCodes(
  value: EmployeeRow['employee_roles'],
): string[] {
  if (!value) {
    return [];
  }

  const codes: string[] = [];
  for (const item of value) {
    const roles = item.roles;
    if (!roles) {
      continue;
    }
    if (Array.isArray(roles)) {
      for (const role of roles) {
        codes.push(role.code);
      }
    } else {
      codes.push(roles.code);
    }
  }
  return codes;
}

function mapEmployee(row: EmployeeRow): EmployeeRecord {
  return {
    id: row.id,
    userId: row.user_id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    notificationEmail: row.notification_email ?? null,
    dateOfBirth: row.date_of_birth,
    departmentId: row.department_id,
    designationId: row.designation_id,
    companyId: row.company_id,
    joiningDate: row.joining_date,
    employmentType: row.employment_type,
    managerId: row.manager_id,
    status: row.status,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    departmentName: firstName(row.departments),
    designationName: firstName(row.designations),
    companyName: firstName(row.companies),
    roleCodes: roleCodes(row.employee_roles),
  };
}

const EMPLOYEE_SELECT = `
  id, user_id, employee_code, full_name, email, phone, notification_email, date_of_birth,
  department_id, designation_id, company_id, joining_date, employment_type, manager_id, status,
  deleted_at, created_at, updated_at,
  departments (name),
  designations (name),
  companies (name),
  employee_roles (roles (code))
`;

export function createEmployeeRepository(supabase: SupabaseClient) {
  return {
    async list(filters: { query?: string; status?: EmployeeStatus }): Promise<EmployeeRecord[]> {
      let request = supabase.from('employees').select(EMPLOYEE_SELECT).is('deleted_at', null).order('full_name');

      if (filters.status) {
        request = request.eq('status', filters.status);
      }

      if (filters.query) {
        const value = `%${filters.query}%`;
        request = request.or(`full_name.ilike.${value},employee_code.ilike.${value},email.ilike.${value}`);
      }

      const { data, error } = await request;
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to list employees.', 500);
      }

      return ((data ?? []) as EmployeeRow[]).map(mapEmployee);
    },

    async findById(id: string): Promise<EmployeeRecord | null> {
      const { data, error } = await supabase
        .from('employees')
        .select(EMPLOYEE_SELECT)
        .eq('id', id)
        .maybeSingle();

      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee.', 500);
      }

      return data ? mapEmployee(data as EmployeeRow) : null;
    },

    async findByEmail(email: string): Promise<EmployeeRecord | null> {
      const { data, error } = await supabase
        .from('employees')
        .select(EMPLOYEE_SELECT)
        .eq('email', email)
        .is('deleted_at', null)
        .maybeSingle();

      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee.', 500);
      }

      return data ? mapEmployee(data as EmployeeRow) : null;
    },

    async findByCode(employeeCode: string): Promise<EmployeeRecord | null> {
      const { data, error } = await supabase
        .from('employees')
        .select(EMPLOYEE_SELECT)
        .eq('employee_code', employeeCode)
        .is('deleted_at', null)
        .maybeSingle();

      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee.', 500);
      }

      return data ? mapEmployee(data as EmployeeRow) : null;
    },

    async insert(row: {
      userId: string;
      employeeCode: string;
      fullName: string;
      email: string;
      phone: string | null;
      dateOfBirth: string | null;
      departmentId: string | null;
      designationId: string | null;
      companyId: string | null;
      joiningDate: string;
      employmentType: string;
      managerId: string | null;
      status: EmployeeStatus;
    }): Promise<string> {
      const { data, error } = await supabase
        .from('employees')
        .insert({
          user_id: row.userId,
          employee_code: row.employeeCode,
          full_name: row.fullName,
          email: row.email,
          phone: row.phone,
          date_of_birth: row.dateOfBirth,
          department_id: row.departmentId,
          designation_id: row.designationId,
          company_id: row.companyId,
          joining_date: row.joiningDate,
          employment_type: row.employmentType,
          manager_id: row.managerId,
          status: row.status,
        })
        .select('id')
        .single();

      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error?.message ?? 'Failed to create employee.', 500);
      }

      return data.id as string;
    },

    async update(
      id: string,
      patch: Record<string, unknown>,
    ): Promise<void> {
      const { error } = await supabase.from('employees').update(patch).eq('id', id);
      if (error) {
        if (error.code === '22P02' || error.code === '23503') {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'One of the saved fields is not valid.', 400);
        }
        if (error.code === '23505') {
          throw new AppError(API_ERROR_CODES.CONFLICT, 'An employee with this code already exists.', 409);
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, error.message || 'Failed to update employee.', 500);
      }
    },

    async setRoles(employeeId: string, roleIds: string[]): Promise<void> {
      const unique = [...new Set(roleIds)];
      const { error: deleteError } = await supabase.from('employee_roles').delete().eq('employee_id', employeeId);
      if (deleteError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update employee roles.', 500);
      }
      if (unique.length === 0) {
        return;
      }
      const { error } = await supabase.from('employee_roles').insert(
        unique.map((roleId) => ({ employee_id: employeeId, role_id: roleId })),
      );
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to assign employee roles.', 500);
      }
    },

    async setRole(employeeId: string, roleId: string): Promise<void> {
      await this.setRoles(employeeId, [roleId]);
    },

    async roleExists(roleId: string): Promise<boolean> {
      const { data, error } = await supabase.from('roles').select('id').eq('id', roleId).maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load role.', 500);
      }
      return Boolean(data);
    },

    async findRoleCode(roleId: string): Promise<string | null> {
      const { data, error } = await supabase.from('roles').select('code').eq('id', roleId).maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load role.', 500);
      }
      return (data?.code as string | undefined) ?? null;
    },

    async findActiveCompany(id: string): Promise<{ id: string; name: string } | null> {
      const { data, error } = await supabase
        .from('companies')
        .select('id, name, status')
        .eq('id', id)
        .maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load company.', 500);
      }
      if (!data || data.status !== 'active') {
        return null;
      }
      return { id: data.id as string, name: data.name as string };
    },

    async findActiveShift(id: string): Promise<{ id: string; name: string } | null> {
      const { data, error } = await supabase.from('shifts').select('id, name, active').eq('id', id).maybeSingle();
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load shift.', 500);
      }
      if (!data || data.active === false) {
        return null;
      }
      return { id: data.id as string, name: data.name as string };
    },
  };
}

export type EmployeeRepository = ReturnType<typeof createEmployeeRepository>;
