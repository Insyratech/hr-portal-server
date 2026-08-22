import type { Permission, RoleCode } from '../constants/permissions';

export type RequestUser = {
  authUserId: string;
  employeeId: string;
  email: string;
  fullName: string;
  roles: RoleCode[];
  permissions: Permission[];
};
