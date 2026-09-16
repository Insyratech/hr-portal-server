import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createFinanceService } from './service';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function requireDb(app: FastifyInstance, request: { user?: unknown }) {
  if (!app.supabase || !request.user) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

const partyStatus = Type.Union([Type.Literal('active'), Type.Literal('inactive')]);
const accountType = Type.Union([
  Type.Literal('asset'),
  Type.Literal('liability'),
  Type.Literal('equity'),
  Type.Literal('income'),
  Type.Literal('expense'),
]);

const orgPatchBody = Type.Object({
  legalName: Type.Optional(Type.String()),
  tradeName: Type.Optional(Type.String()),
  cin: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  pan: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  gstin: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  industry: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  stateCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  stateName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  addressLine1: Type.Optional(Type.String()),
  addressLine2: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  postalCode: Type.Optional(Type.String()),
  fiscalYearStartMonth: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
  gstRegistered: Type.Optional(Type.Boolean()),
  gstRegistrationType: Type.Optional(
    Type.Union([Type.Literal('regular'), Type.Literal('composition'), Type.Literal('unregistered'), Type.Null()]),
  ),
  markSetupComplete: Type.Optional(Type.Boolean()),
});

const accountCreateBody = Type.Object({
  code: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  accountType,
  sortOrder: Type.Optional(Type.Integer()),
});

const accountPatchBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  isActive: Type.Optional(Type.Boolean()),
  sortOrder: Type.Optional(Type.Integer()),
});

const customerCreateBody = Type.Object({
  displayName: Type.String({ minLength: 1 }),
  companyName: Type.Optional(Type.String()),
  email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  gstin: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  pan: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  stateCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  stateName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  billingAddress: Type.Optional(Type.String()),
  shippingAddress: Type.Optional(Type.String()),
  paymentTermsDays: Type.Optional(Type.Integer({ minimum: 0 })),
  notes: Type.Optional(Type.String()),
});

const customerPatchBody = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1 })),
  companyName: Type.Optional(Type.String()),
  email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  gstin: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  pan: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  stateCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  stateName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  billingAddress: Type.Optional(Type.String()),
  shippingAddress: Type.Optional(Type.String()),
  paymentTermsDays: Type.Optional(Type.Integer({ minimum: 0 })),
  status: Type.Optional(partyStatus),
  notes: Type.Optional(Type.String()),
});

const vendorCreateBody = Type.Object({
  displayName: Type.String({ minLength: 1 }),
  companyName: Type.Optional(Type.String()),
  email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  gstin: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  pan: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  stateCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  stateName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  billingAddress: Type.Optional(Type.String()),
  paymentTermsDays: Type.Optional(Type.Integer({ minimum: 0 })),
  notes: Type.Optional(Type.String()),
});

const vendorPatchBody = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1 })),
  companyName: Type.Optional(Type.String()),
  email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  gstin: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  pan: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  stateCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  stateName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  billingAddress: Type.Optional(Type.String()),
  paymentTermsDays: Type.Optional(Type.Integer({ minimum: 0 })),
  status: Type.Optional(partyStatus),
  notes: Type.Optional(Type.String()),
});

const itemCreateBody = Type.Object({
  code: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  itemType: Type.Union([Type.Literal('goods'), Type.Literal('service')]),
  hsnSac: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  unit: Type.Optional(Type.String()),
  saleRate: Type.Optional(Type.Number({ minimum: 0 })),
  purchaseRate: Type.Optional(Type.Number({ minimum: 0 })),
  incomeAccountId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  expenseAccountId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  taxGroupId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  description: Type.Optional(Type.String()),
});

const itemPatchBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  hsnSac: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  unit: Type.Optional(Type.String()),
  saleRate: Type.Optional(Type.Number({ minimum: 0 })),
  purchaseRate: Type.Optional(Type.Number({ minimum: 0 })),
  incomeAccountId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  expenseAccountId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  taxGroupId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  description: Type.Optional(Type.String()),
  status: Type.Optional(partyStatus),
});

const seriesPatchBody = Type.Object({
  prefix: Type.Optional(Type.String({ minLength: 1 })),
  padLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  nextNumber: Type.Optional(Type.Integer({ minimum: 1 })),
  resetYearly: Type.Optional(Type.Boolean()),
});

export async function registerFinanceRoutes(app: FastifyInstance): Promise<void> {
  const financePerms = [
    PERMISSIONS.FINANCE_ORG_MANAGE,
    PERMISSIONS.FINANCE_COA_VIEW,
    PERMISSIONS.FINANCE_COA_MANAGE,
    PERMISSIONS.FINANCE_TAX_MANAGE,
    PERMISSIONS.FINANCE_PARTIES_MANAGE,
    PERMISSIONS.FINANCE_ITEMS_MANAGE,
    PERMISSIONS.FINANCE_SERIES_MANAGE,
  ] as const;

  app.get(
    '/api/v1/finance/setup',
    { preHandler: [requirePermission(...financePerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createFinanceService(app.supabase!).getSetup(request.user!));
    },
  );

  app.get(
    '/api/v1/finance/organization',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_ORG_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createFinanceService(app.supabase!).getOrganization(request.user!));
    },
  );

  app.patch(
    '/api/v1/finance/organization',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_ORG_MANAGE)], schema: { body: orgPatchBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createFinanceService(app.supabase!).updateOrganization(
          request.user!,
          request.body as Record<string, unknown>,
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/finance/accounts',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_COA_VIEW, PERMISSIONS.FINANCE_COA_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createFinanceService(app.supabase!).listAccounts(request.user!));
    },
  );

  app.post(
    '/api/v1/finance/accounts',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_COA_MANAGE)], schema: { body: accountCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createFinanceService(app.supabase!).createAccount(
          request.user!,
          request.body as { code: string; name: string; accountType: 'asset' | 'liability' | 'equity' | 'income' | 'expense'; sortOrder?: number },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/finance/accounts/:id',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_COA_MANAGE)], schema: { body: accountPatchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createFinanceService(app.supabase!).updateAccount(
          request.user!,
          id,
          request.body as { name?: string; isActive?: boolean; sortOrder?: number },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/finance/tax-rates',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_TAX_MANAGE, PERMISSIONS.FINANCE_ITEMS_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createFinanceService(app.supabase!).listTaxRates(request.user!));
    },
  );

  app.get(
    '/api/v1/finance/tax-groups',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_TAX_MANAGE, PERMISSIONS.FINANCE_ITEMS_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createFinanceService(app.supabase!).listTaxGroups(request.user!));
    },
  );

  app.get(
    '/api/v1/finance/tds-rates',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_TAX_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createFinanceService(app.supabase!).listTdsRates(request.user!));
    },
  );

  app.get(
    '/api/v1/finance/customers',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PARTIES_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createFinanceService(app.supabase!).listCustomers(request.user!));
    },
  );

  app.post(
    '/api/v1/finance/customers',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PARTIES_MANAGE)], schema: { body: customerCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createFinanceService(app.supabase!).createCustomer(
          request.user!,
          request.body as { displayName: string },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/finance/customers/:id',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PARTIES_MANAGE)], schema: { body: customerPatchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createFinanceService(app.supabase!).updateCustomer(
          request.user!,
          id,
          request.body as Record<string, unknown>,
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/finance/vendors',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PARTIES_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createFinanceService(app.supabase!).listVendors(request.user!));
    },
  );

  app.post(
    '/api/v1/finance/vendors',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PARTIES_MANAGE)], schema: { body: vendorCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createFinanceService(app.supabase!).createVendor(
          request.user!,
          request.body as { displayName: string },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/finance/vendors/:id',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PARTIES_MANAGE)], schema: { body: vendorPatchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createFinanceService(app.supabase!).updateVendor(
          request.user!,
          id,
          request.body as Record<string, unknown>,
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/finance/items',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_ITEMS_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createFinanceService(app.supabase!).listItems(request.user!));
    },
  );

  app.post(
    '/api/v1/finance/items',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_ITEMS_MANAGE)], schema: { body: itemCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createFinanceService(app.supabase!).createItem(
          request.user!,
          request.body as { code: string; name: string; itemType: 'goods' | 'service' },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/finance/items/:id',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_ITEMS_MANAGE)], schema: { body: itemPatchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createFinanceService(app.supabase!).updateItem(
          request.user!,
          id,
          request.body as Record<string, unknown>,
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/finance/number-series',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SERIES_MANAGE, PERMISSIONS.FINANCE_ORG_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createFinanceService(app.supabase!).listSeries(request.user!));
    },
  );

  app.patch(
    '/api/v1/finance/number-series/:id',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SERIES_MANAGE)], schema: { body: seriesPatchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createFinanceService(app.supabase!).updateSeries(
          request.user!,
          id,
          request.body as { prefix?: string; padLength?: number; nextNumber?: number; resetYearly?: boolean },
          metaOf(request),
        ),
      );
    },
  );
}
