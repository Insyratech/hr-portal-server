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
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLE_CODES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  EMPLOYEE: 'EMPLOYEE',
} as const;

export type RoleCode = (typeof ROLE_CODES)[keyof typeof ROLE_CODES];
