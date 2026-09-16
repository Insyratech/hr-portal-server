import { PERMISSIONS, type Permission } from '../../shared/constants/permissions';
import { isFinanceDomainOwner } from '../../shared/domain-owners';
import type { RequestUser } from '../../shared/types/request-user';

export type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

export function hasFinancePerm(actor: RequestUser, ...codes: Permission[]): boolean {
  return codes.some((code) => actor.permissions.includes(code));
}

export function canManageFinanceOrg(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_ORG_MANAGE);
}

export function canViewCoa(actor: RequestUser): boolean {
  return (
    isFinanceDomainOwner(actor) &&
    hasFinancePerm(actor, PERMISSIONS.FINANCE_COA_VIEW, PERMISSIONS.FINANCE_COA_MANAGE)
  );
}

export function canManageCoa(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_COA_MANAGE);
}

export function canManageTax(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_TAX_MANAGE);
}

export function canManageParties(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_PARTIES_MANAGE);
}

export function canManageItems(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_ITEMS_MANAGE);
}

export function canManageSeries(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_SERIES_MANAGE);
}

export function canApplyIndent(actor: RequestUser): boolean {
  return hasFinancePerm(actor, PERMISSIONS.FINANCE_INDENT_APPLY);
}

export function canApproveIndent(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_INDENT_APPROVE);
}

export function canViewPurchase(actor: RequestUser): boolean {
  return (
    hasFinancePerm(
      actor,
      PERMISSIONS.FINANCE_PURCHASE_VIEW,
      PERMISSIONS.FINANCE_PURCHASE_MANAGE,
      PERMISSIONS.FINANCE_INDENT_APPROVE,
    ) || (isFinanceDomainOwner(actor) && canApplyIndent(actor))
  );
}

export function canManagePurchase(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_PURCHASE_MANAGE);
}

export function canViewSales(actor: RequestUser): boolean {
  return (
    isFinanceDomainOwner(actor) &&
    hasFinancePerm(actor, PERMISSIONS.FINANCE_SALES_VIEW, PERMISSIONS.FINANCE_SALES_MANAGE)
  );
}

export function canManageSales(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_SALES_MANAGE);
}

export function canApplyExpenseClaim(actor: RequestUser): boolean {
  return hasFinancePerm(actor, PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPLY);
}

export function canApproveExpenseClaim(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPROVE);
}

export function canViewExpense(actor: RequestUser): boolean {
  return (
    isFinanceDomainOwner(actor) &&
    hasFinancePerm(
      actor,
      PERMISSIONS.FINANCE_EXPENSE_VIEW,
      PERMISSIONS.FINANCE_EXPENSE_MANAGE,
      PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPROVE,
    )
  );
}

export function canManageExpense(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_EXPENSE_MANAGE);
}

export function canViewAccountant(actor: RequestUser): boolean {
  return (
    isFinanceDomainOwner(actor) &&
    hasFinancePerm(
      actor,
      PERMISSIONS.FINANCE_ACCOUNTANT_VIEW,
      PERMISSIONS.FINANCE_ACCOUNTANT_MANAGE,
      PERMISSIONS.FINANCE_COA_VIEW,
      PERMISSIONS.FINANCE_COA_MANAGE,
    )
  );
}

export function canManageAccountant(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_ACCOUNTANT_MANAGE);
}

export function canViewBanking(actor: RequestUser): boolean {
  return (
    isFinanceDomainOwner(actor) &&
    hasFinancePerm(actor, PERMISSIONS.FINANCE_BANKING_VIEW, PERMISSIONS.FINANCE_BANKING_MANAGE)
  );
}

export function canManageBanking(actor: RequestUser): boolean {
  return isFinanceDomainOwner(actor) && hasFinancePerm(actor, PERMISSIONS.FINANCE_BANKING_MANAGE);
}

export function canViewGst(actor: RequestUser): boolean {
  return (
    isFinanceDomainOwner(actor) &&
    hasFinancePerm(
      actor,
      PERMISSIONS.FINANCE_GST_VIEW,
      PERMISSIONS.FINANCE_GST_MANAGE,
      PERMISSIONS.FINANCE_TAX_MANAGE,
    )
  );
}

export function canManageGst(actor: RequestUser): boolean {
  return (
    isFinanceDomainOwner(actor) &&
    hasFinancePerm(actor, PERMISSIONS.FINANCE_GST_MANAGE, PERMISSIONS.FINANCE_TAX_MANAGE)
  );
}

export function canViewIntegrations(actor: RequestUser): boolean {
  return (
    isFinanceDomainOwner(actor) &&
    hasFinancePerm(
      actor,
      PERMISSIONS.FINANCE_INTEGRATIONS_VIEW,
      PERMISSIONS.FINANCE_INTEGRATIONS_MANAGE,
      PERMISSIONS.FINANCE_GST_VIEW,
      PERMISSIONS.FINANCE_GST_MANAGE,
    )
  );
}

export function canManageIntegrations(actor: RequestUser): boolean {
  return (
    isFinanceDomainOwner(actor) &&
    hasFinancePerm(actor, PERMISSIONS.FINANCE_INTEGRATIONS_MANAGE, PERMISSIONS.FINANCE_GST_MANAGE)
  );
}

export function canViewReports(actor: RequestUser): boolean {
  return (
    isFinanceDomainOwner(actor) &&
    hasFinancePerm(
      actor,
      PERMISSIONS.FINANCE_REPORTS_VIEW,
      PERMISSIONS.FINANCE_ACCOUNTANT_VIEW,
      PERMISSIONS.FINANCE_ACCOUNTANT_MANAGE,
    )
  );
}

export function canViewSalesOverview(actor: RequestUser): boolean {
  return canViewSales(actor) || canViewReports(actor);
}

export function canViewPurchaseOverview(actor: RequestUser): boolean {
  return canViewPurchase(actor) || canViewReports(actor);
}

/** Any Phase 0 finance read for setup checklist. */
export function canAccessFinanceDesk(actor: RequestUser): boolean {
  return (
    isFinanceDomainOwner(actor) &&
    hasFinancePerm(
      actor,
      PERMISSIONS.FINANCE_ORG_MANAGE,
      PERMISSIONS.FINANCE_COA_VIEW,
      PERMISSIONS.FINANCE_COA_MANAGE,
      PERMISSIONS.FINANCE_TAX_MANAGE,
      PERMISSIONS.FINANCE_PARTIES_MANAGE,
      PERMISSIONS.FINANCE_ITEMS_MANAGE,
      PERMISSIONS.FINANCE_SERIES_MANAGE,
      PERMISSIONS.FINANCE_PURCHASE_VIEW,
      PERMISSIONS.FINANCE_PURCHASE_MANAGE,
      PERMISSIONS.FINANCE_INDENT_APPLY,
      PERMISSIONS.FINANCE_INDENT_APPROVE,
      PERMISSIONS.FINANCE_SALES_VIEW,
      PERMISSIONS.FINANCE_SALES_MANAGE,
      PERMISSIONS.FINANCE_EXPENSE_VIEW,
      PERMISSIONS.FINANCE_EXPENSE_MANAGE,
      PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPLY,
      PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPROVE,
      PERMISSIONS.FINANCE_ACCOUNTANT_VIEW,
      PERMISSIONS.FINANCE_ACCOUNTANT_MANAGE,
      PERMISSIONS.FINANCE_BANKING_VIEW,
      PERMISSIONS.FINANCE_BANKING_MANAGE,
      PERMISSIONS.FINANCE_GST_VIEW,
      PERMISSIONS.FINANCE_GST_MANAGE,
      PERMISSIONS.FINANCE_INTEGRATIONS_VIEW,
      PERMISSIONS.FINANCE_INTEGRATIONS_MANAGE,
      PERMISSIONS.FINANCE_REPORTS_VIEW,
    )
  );
}
