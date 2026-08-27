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
  companyId: string | null;
  joiningDate: string;
  employmentType: EmploymentType;
  managerId: string | null;
  status: EmployeeStatus;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  departmentName: string | null;
  designationName: string | null;
  companyName: string | null;
  roleCodes: string[];
};

export type CompensationInput = {
  basic: number;
  da: number;
  hra: number;
  fuel: number;
  incentives: number;
  other: number;
  professionalTax: number;
  tds: number;
  employeeWelfare: number;
  kpi: number;
  otherDeductions: number;
  effectiveFrom: string;
};

export type CompensationRecord = CompensationInput & {
  id: string;
  employeeId: string;
  createdAt: string;
};

export type PaymentInput = {
  pan?: string | null;
  bankAccountNumber?: string | null;
  bankName?: string | null;
  ifsc?: string | null;
};

export type PaymentRecord = {
  employeeId: string;
  pan: string | null;
  bankAccountNumber: string | null;
  bankName: string | null;
  ifsc: string | null;
  updatedAt: string;
};

export type EmployeePayroll = {
  current: CompensationRecord | null;
  history: CompensationRecord[];
  payment: PaymentRecord | null;
};

export type LeaveAllocationInput = {
  leaveTypeId: string;
  allocated: number;
};

export type CreateEmployeeInput = {
  employeeCode: string;
  fullName: string;
  email: string;
  phone?: string;
  dateOfBirth?: string;
  departmentId?: string;
  designationId?: string;
  companyId?: string;
  joiningDate: string;
  employmentType: EmploymentType;
  managerId?: string;
  status?: EmployeeStatus;
  roleId?: string;
  roleIds?: string[];
  password: string;
  shiftId?: string;
  compensation?: Partial<CompensationInput>;
  payment?: PaymentInput;
      leaveAllocations?: LeaveAllocationInput[];
      emailVerificationToken?: string;
    };

export type UpdateEmployeeInput = {
  employeeCode?: string;
  fullName?: string;
  phone?: string | null;
  notificationEmail?: string | null;
  dateOfBirth?: string | null;
  departmentId?: string | null;
  designationId?: string | null;
  companyId?: string | null;
  joiningDate?: string;
  employmentType?: EmploymentType;
  managerId?: string | null;
  status?: EmployeeStatus;
};

/** Managerial hats for PATCH /employees/:id/roles. Server always keeps EMPLOYEE. */
export type UpdateEmployeeRolesInput = {
  roleIds: string[];
};
