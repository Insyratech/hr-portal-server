export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYEE_STATUSES = ['active', 'inactive'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export type EmployeeRecord = {
  id: string;
  userId: string | null;
  employeeCode: string;
  fullName: string;
  email: string;
  phone: string | null;
  notificationEmail: string | null;
  dateOfBirth: string | null;
  departmentId: string | null;
  designationId: string | null;
  joiningDate: string;
  employmentType: EmploymentType;
  managerId: string | null;
  status: EmployeeStatus;
  createdAt: string;
  updatedAt: string;
  departmentName: string | null;
  designationName: string | null;
  roleCodes: string[];
};

export type CreateEmployeeInput = {
  employeeCode: string;
  fullName: string;
  email: string;
  phone?: string;
  dateOfBirth?: string;
  departmentId?: string;
  designationId?: string;
  joiningDate: string;
  employmentType: EmploymentType;
  managerId?: string;
  status?: EmployeeStatus;
  roleId?: string;
  roleIds?: string[];
  password: string;
};

export type UpdateEmployeeInput = {
  employeeCode?: string;
  fullName?: string;
  phone?: string | null;
  notificationEmail?: string | null;
  dateOfBirth?: string | null;
  departmentId?: string | null;
  designationId?: string | null;
  joiningDate?: string;
  employmentType?: EmploymentType;
  managerId?: string | null;
  status?: EmployeeStatus;
  roleId?: string;
  roleIds?: string[];
};
