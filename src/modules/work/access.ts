import { PERMISSIONS } from '../../shared/constants/permissions';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';

export function canViewOthersWork(actor: RequestUser): boolean {
  return actor.permissions.includes(PERMISSIONS.WORK_VIEW) || actor.permissions.includes(PERMISSIONS.WORK_ASSIGN);
}

export function targetEmployeeId(actor: RequestUser, employeeId?: string): string {
  const id = employeeId || actor.employeeId;
  if (id !== actor.employeeId && !canViewOthersWork(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view another person’s work.', 403);
  }
  return id;
}
