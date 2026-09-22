import { PERMISSIONS, type Permission } from '../../shared/constants/permissions';
import { isInventoryDomainOwner, isSuperAdminOwner } from '../../shared/domain-owners';
import type { RequestUser } from '../../shared/types/request-user';

export type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

export function hasInventoryPerm(actor: RequestUser, ...codes: Permission[]): boolean {
  return codes.some((code) => actor.permissions.includes(code));
}

export function canViewInventoryOverview(actor: RequestUser): boolean {
  return (
    isInventoryDomainOwner(actor) && hasInventoryPerm(actor, PERMISSIONS.INVENTORY_OVERVIEW_VIEW)
  );
}

export function canManageLocations(actor: RequestUser): boolean {
  return (
    isInventoryDomainOwner(actor) && hasInventoryPerm(actor, PERMISSIONS.INVENTORY_LOCATIONS_MANAGE)
  );
}

export function canManageCategories(actor: RequestUser): boolean {
  return (
    isInventoryDomainOwner(actor) && hasInventoryPerm(actor, PERMISSIONS.INVENTORY_CATEGORIES_MANAGE)
  );
}

export function canManageCatalog(actor: RequestUser): boolean {
  return (
    isInventoryDomainOwner(actor) && hasInventoryPerm(actor, PERMISSIONS.INVENTORY_CATALOG_MANAGE)
  );
}

export function canManageAuthorizations(actor: RequestUser): boolean {
  return (
    isInventoryDomainOwner(actor) &&
    hasInventoryPerm(actor, PERMISSIONS.INVENTORY_AUTHORIZATIONS_MANAGE)
  );
}

export function canManageLots(actor: RequestUser): boolean {
  return isInventoryDomainOwner(actor) && hasInventoryPerm(actor, PERMISSIONS.INVENTORY_LOTS_MANAGE);
}

export function canAdjustLots(actor: RequestUser): boolean {
  return isInventoryDomainOwner(actor) && hasInventoryPerm(actor, PERMISSIONS.INVENTORY_LOTS_ADJUST);
}

export function canManagePrep(actor: RequestUser): boolean {
  return (
    isInventoryDomainOwner(actor) &&
    hasInventoryPerm(actor, PERMISSIONS.INVENTORY_PREP_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE)
  );
}

export function canManagePlastic(actor: RequestUser): boolean {
  return (
    isInventoryDomainOwner(actor) &&
    hasInventoryPerm(actor, PERMISSIONS.INVENTORY_PLASTIC_MANAGE, PERMISSIONS.INVENTORY_LOTS_MANAGE)
  );
}

export function canAdjustPlastic(actor: RequestUser): boolean {
  return (
    isInventoryDomainOwner(actor) &&
    hasInventoryPerm(actor, PERMISSIONS.INVENTORY_PLASTIC_ADJUST, PERMISSIONS.INVENTORY_LOTS_ADJUST)
  );
}

export function canViewAlerts(actor: RequestUser): boolean {
  return (
    isInventoryDomainOwner(actor) &&
    hasInventoryPerm(
      actor,
      PERMISSIONS.INVENTORY_ALERTS_VIEW,
      PERMISSIONS.INVENTORY_OVERVIEW_VIEW,
      PERMISSIONS.INVENTORY_LOTS_MANAGE,
    )
  );
}

export function canViewReports(actor: RequestUser): boolean {
  return (
    isInventoryDomainOwner(actor) &&
    hasInventoryPerm(
      actor,
      PERMISSIONS.INVENTORY_REPORTS_VIEW,
      PERMISSIONS.INVENTORY_OVERVIEW_VIEW,
      PERMISSIONS.INVENTORY_LOTS_MANAGE,
    )
  );
}

/** Super Admin read-only inventory stub / dashboard. */
export function canViewInventoryAdminOverview(actor: RequestUser): boolean {
  return isSuperAdminOwner(actor);
}
