export const PERMISSIONS = {
  USERS_MANAGE: 'users.manage',
  USERS_VIEW: 'users.view',
  ROLES_MANAGE: 'roles.manage',
  LEAVE_TYPES_MANAGE: 'leave.types.manage',
  LEAVE_POLICIES_MANAGE: 'leave.policies.manage',
  LEAVE_ALLOCATIONS_MANAGE: 'leave.allocations.manage',
  LEAVE_APPROVE: 'leave.approve',
  LEAVE_APPLY: 'leave.apply',
  LEAVE_VIEW: 'leave.view',
  HOLIDAYS_MANAGE: 'holidays.manage',
  ATTENDANCE_MANAGE: 'attendance.manage',
  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_CORRECT: 'attendance.correct',
  SHIFTS_MANAGE: 'shifts.manage',
  GRIEVANCES_MANAGE: 'grievances.manage',
  GRIEVANCE_CREATE: 'grievance.create',
  GRIEVANCE_VIEW_OWN: 'grievance.view_own',
  POLICIES_MANAGE: 'policies.manage',
  POLICIES_VIEW: 'policies.view',
  REPORTS_VIEW: 'reports.view',
  SYSTEM_MANAGE: 'system.manage',
  AUDIT_VIEW: 'audit.view',
  PROFILE_VIEW: 'profile.view',
  PAYROLL_VIEW: 'payroll.view',
  PAYROLL_MANAGE: 'payroll.manage',
  WORK_PERMISSION_APPLY: 'work_permission.apply',
  WORK_PERMISSION_APPROVE: 'work_permission.approve',
  SHIFT_CHANGE_APPLY: 'shift_change.apply',
  SHIFT_CHANGE_APPROVE: 'shift_change.approve',
  SHIFT_CHANGE_VIEW: 'shift_change.view',
  COMPANIES_MANAGE: 'companies.manage',
  WORK_OWN: 'work.own',
  WORK_VIEW: 'work.view',
  WORK_ASSIGN: 'work.assign',
  WORK_FEEDBACK: 'work.feedback',
  WORK_SETTINGS: 'work.settings',
  PROJECTS_MANAGE: 'projects.manage',
  FINANCE_ORG_MANAGE: 'finance.org.manage',
  FINANCE_COA_VIEW: 'finance.coa.view',
  FINANCE_COA_MANAGE: 'finance.coa.manage',
  FINANCE_TAX_MANAGE: 'finance.tax.manage',
  FINANCE_PARTIES_MANAGE: 'finance.parties.manage',
  FINANCE_ITEMS_MANAGE: 'finance.items.manage',
  FINANCE_SERIES_MANAGE: 'finance.series.manage',
  FINANCE_INDENT_APPLY: 'finance.indent.apply',
  FINANCE_INDENT_APPROVE: 'finance.indent.approve',
  FINANCE_PURCHASE_VIEW: 'finance.purchase.view',
  FINANCE_PURCHASE_MANAGE: 'finance.purchase.manage',
  FINANCE_SALES_VIEW: 'finance.sales.view',
  FINANCE_SALES_MANAGE: 'finance.sales.manage',
  FINANCE_EXPENSE_VIEW: 'finance.expense.view',
  FINANCE_EXPENSE_MANAGE: 'finance.expense.manage',
  FINANCE_EXPENSE_CLAIM_APPLY: 'finance.expense_claim.apply',
  FINANCE_EXPENSE_CLAIM_APPROVE: 'finance.expense_claim.approve',
  FINANCE_ACCOUNTANT_VIEW: 'finance.accountant.view',
  FINANCE_ACCOUNTANT_MANAGE: 'finance.accountant.manage',
  FINANCE_BANKING_VIEW: 'finance.banking.view',
  FINANCE_BANKING_MANAGE: 'finance.banking.manage',
  FINANCE_GST_VIEW: 'finance.gst.view',
  FINANCE_GST_MANAGE: 'finance.gst.manage',
  FINANCE_INTEGRATIONS_VIEW: 'finance.integrations.view',
  FINANCE_INTEGRATIONS_MANAGE: 'finance.integrations.manage',
  FINANCE_REPORTS_VIEW: 'finance.reports.view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLE_CODES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  GENERAL_MANAGER: 'GENERAL_MANAGER',
  HR_MANAGER: 'HR_MANAGER',
  CSO: 'CSO',
  FINANCE_MANAGER: 'FINANCE_MANAGER',
  EMPLOYEE: 'EMPLOYEE',
  /**
   * @deprecated Renamed to GENERAL_MANAGER in migration 027.
   * Kept only so one-release string compares against old fixtures still compile; do not assign.
   */
  ADMIN: 'ADMIN',
} as const;

export type RoleCode = (typeof ROLE_CODES)[keyof typeof ROLE_CODES];

/** Roles Super Admin may assign on a profile (create always forces EMPLOYEE only). */
export const SA_ASSIGNABLE_ROLE_CODES: readonly RoleCode[] = [
  ROLE_CODES.EMPLOYEE,
  ROLE_CODES.HR_MANAGER,
  ROLE_CODES.GENERAL_MANAGER,
  ROLE_CODES.CSO,
  ROLE_CODES.FINANCE_MANAGER,
];

/** Fixed role UUIDs (must match migrations 001 + 027). */
export const ROLE_IDS = {
  SUPER_ADMIN: '00000000-0000-4000-8000-000000000001',
  GENERAL_MANAGER: '00000000-0000-4000-8000-000000000002',
  EMPLOYEE: '00000000-0000-4000-8000-000000000003',
  HR_MANAGER: '00000000-0000-4000-8000-000000000004',
  CSO: '00000000-0000-4000-8000-000000000005',
  FINANCE_MANAGER: '00000000-0000-4000-8000-000000000006',
} as const;
