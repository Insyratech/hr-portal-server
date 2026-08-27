import { API_ERROR_CODES } from './constants/error-codes';
import { ROLE_CODES } from './constants/permissions';
import { AppError } from './errors/app-error';
import type { RequestUser } from './types/request-user';

/** Phase 6 domain owners — role checks in services so guessed URLs still 403. */

export function isHrDomainOwner(actor: RequestUser): boolean {
  return actor.roles.includes(ROLE_CODES.HR_MANAGER) && !actor.roles.includes(ROLE_CODES.SUPER_ADMIN);
}

export function isGmDomainOwner(actor: RequestUser): boolean {
  return (
    (actor.roles.includes(ROLE_CODES.GENERAL_MANAGER) || actor.roles.includes(ROLE_CODES.ADMIN)) &&
    !actor.roles.includes(ROLE_CODES.SUPER_ADMIN)
  );
}

export function isCsoDomainOwner(actor: RequestUser): boolean {
  return actor.roles.includes(ROLE_CODES.CSO) && !actor.roles.includes(ROLE_CODES.SUPER_ADMIN);
}

export function isSuperAdminOwner(actor: RequestUser): boolean {
  return actor.roles.includes(ROLE_CODES.SUPER_ADMIN);
}

export function assertHrDomainOwner(actor: RequestUser, action = 'manage this'): void {
  if (isHrDomainOwner(actor)) return;
  throw new AppError(API_ERROR_CODES.FORBIDDEN, `Only HR Manager can ${action}.`, 403);
}

export function assertGmDomainOwner(actor: RequestUser, action = 'manage this'): void {
  if (isGmDomainOwner(actor)) return;
  throw new AppError(API_ERROR_CODES.FORBIDDEN, `Only General Manager can ${action}.`, 403);
}

export function assertCsoDomainOwner(actor: RequestUser, action = 'manage this'): void {
  if (isCsoDomainOwner(actor)) return;
  throw new AppError(API_ERROR_CODES.FORBIDDEN, `Only CSO can ${action}.`, 403);
}

export function assertSuperAdminOwner(actor: RequestUser, action = 'manage this'): void {
  if (isSuperAdminOwner(actor)) return;
  throw new AppError(API_ERROR_CODES.FORBIDDEN, `Only Super Admin can ${action}.`, 403);
}
