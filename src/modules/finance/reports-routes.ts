import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createFinanceReportsService } from './reports-service';

function requireDb(app: FastifyInstance, request: { user?: unknown }) {
  if (!app.supabase || !request.user) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

const viewPerms = [
  PERMISSIONS.FINANCE_REPORTS_VIEW,
  PERMISSIONS.FINANCE_ACCOUNTANT_VIEW,
  PERMISSIONS.FINANCE_ACCOUNTANT_MANAGE,
] as const;

const salesOverviewPerms = [
  PERMISSIONS.FINANCE_SALES_VIEW,
  PERMISSIONS.FINANCE_SALES_MANAGE,
  PERMISSIONS.FINANCE_REPORTS_VIEW,
  PERMISSIONS.FINANCE_ACCOUNTANT_VIEW,
  PERMISSIONS.FINANCE_ACCOUNTANT_MANAGE,
] as const;

const purchaseOverviewPerms = [
  PERMISSIONS.FINANCE_PURCHASE_VIEW,
  PERMISSIONS.FINANCE_PURCHASE_MANAGE,
  PERMISSIONS.FINANCE_REPORTS_VIEW,
  PERMISSIONS.FINANCE_ACCOUNTANT_VIEW,
  PERMISSIONS.FINANCE_ACCOUNTANT_MANAGE,
] as const;

export async function registerFinanceReportsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/finance/dashboard', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    const query = request.query as { fromDate?: string; toDate?: string };
    return ok(await createFinanceReportsService(app.supabase!).getDashboard(request.user!, query));
  });

  app.get(
    '/api/v1/finance/dashboard/sales',
    { preHandler: [requirePermission(...salesOverviewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate?: string; toDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getSalesOverview(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/dashboard/purchases',
    { preHandler: [requirePermission(...purchaseOverviewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate?: string; toDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getPurchaseOverview(request.user!, query));
    },
  );

  app.get('/api/v1/finance/reports/catalog', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(createFinanceReportsService(app.supabase!).getCatalog(request.user!));
  });

  app.get(
    '/api/v1/finance/reports/profit-loss',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate?: string; toDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getProfitAndLoss(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/reports/balance-sheet',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { asOfDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getBalanceSheet(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/reports/cash-flow',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate?: string; toDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getCashFlow(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/reports/sales-by-customer',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate?: string; toDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getSalesByCustomer(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/reports/sales-by-item',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate?: string; toDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getSalesByItem(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/reports/invoice-details',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate?: string; toDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getInvoiceDetails(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/reports/ar-aging',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { asOfDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getArAging(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/reports/customer-balances',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { asOfDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getCustomerBalances(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/reports/ap-aging',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { asOfDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getApAging(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/reports/vendor-balances',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { asOfDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getVendorBalances(request.user!, query));
    },
  );

  app.get('/api/v1/finance/reports/po-status', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createFinanceReportsService(app.supabase!).getPoStatus(request.user!));
  });

  app.get(
    '/api/v1/finance/reports/purchases-by-vendor',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate?: string; toDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getPurchasesByVendor(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/reports/purchases-by-item',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate?: string; toDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getPurchasesByItem(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/reports/tax-summary',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate?: string; toDate?: string };
      return ok(await createFinanceReportsService(app.supabase!).getTaxSummary(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/reports/banking-reconciliation',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createFinanceReportsService(app.supabase!).getBankingReconciliationSummary(request.user!));
    },
  );

  app.get('/api/v1/finance/reports/activity', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    const query = request.query as { fromDate?: string; toDate?: string };
    return ok(await createFinanceReportsService(app.supabase!).getActivity(request.user!, query));
  });
}
