import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createIntegrationsService } from './integrations-service';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function requireDb(app: FastifyInstance, request: { user?: unknown }) {
  if (!app.supabase || !request.user) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

const viewPerms = [
  PERMISSIONS.FINANCE_INTEGRATIONS_VIEW,
  PERMISSIONS.FINANCE_INTEGRATIONS_MANAGE,
  PERMISSIONS.FINANCE_GST_VIEW,
  PERMISSIONS.FINANCE_GST_MANAGE,
] as const;

const managePerms = [
  PERMISSIONS.FINANCE_INTEGRATIONS_MANAGE,
  PERMISSIONS.FINANCE_GST_MANAGE,
] as const;

const settingsPatchBody = Type.Object({
  gspMode: Type.Optional(Type.Union([Type.Literal('sandbox'), Type.Literal('live')])),
  paymentGatewayEnabled: Type.Optional(Type.Boolean()),
  paymentGatewayProvider: Type.Optional(
    Type.Union([Type.Literal('none'), Type.Literal('razorpay'), Type.Literal('stripe')]),
  ),
  bankFeedEnabled: Type.Optional(Type.Boolean()),
  bankFeedProvider: Type.Optional(
    Type.Union([
      Type.Literal('none'),
      Type.Literal('account_aggregator'),
      Type.Literal('manual_api'),
    ]),
  ),
  notes: Type.Optional(Type.String()),
});

const cancelBody = Type.Object({
  reason: Type.Optional(Type.String()),
});

const ewayBody = Type.Object({
  sourceType: Type.Union([Type.Literal('invoice'), Type.Literal('delivery_note')]),
  sourceId: Type.String({ format: 'uuid' }),
  transporterId: Type.Optional(Type.String()),
  transporterName: Type.Optional(Type.String()),
  vehicleNumber: Type.Optional(Type.String()),
  transportMode: Type.Optional(
    Type.Union([
      Type.Literal('road'),
      Type.Literal('rail'),
      Type.Literal('air'),
      Type.Literal('ship'),
    ]),
  ),
  distanceKm: Type.Optional(Type.Number({ minimum: 0 })),
  fromPlace: Type.Optional(Type.String()),
  toPlace: Type.Optional(Type.String()),
});

const periodBody = Type.Object({
  periodYear: Type.Integer({ minimum: 2000, maximum: 2100 }),
  periodMonth: Type.Integer({ minimum: 1, maximum: 12 }),
});

const checkoutBody = Type.Object({
  invoiceId: Type.String({ format: 'uuid' }),
});

export async function registerFinanceIntegrationsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/finance/integrations/settings',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createIntegrationsService(app.supabase!).getSettings(request.user!));
    },
  );

  app.patch(
    '/api/v1/finance/integrations/settings',
    { preHandler: [requirePermission(...managePerms)], schema: { body: settingsPatchBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createIntegrationsService(app.supabase!).updateSettings(
          request.user!,
          request.body as {
            gspMode?: 'sandbox' | 'live';
            paymentGatewayEnabled?: boolean;
            paymentGatewayProvider?: 'none' | 'razorpay' | 'stripe';
            bankFeedEnabled?: boolean;
            bankFeedProvider?: 'none' | 'account_aggregator' | 'manual_api';
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/finance/integrations/einvoices',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createIntegrationsService(app.supabase!).listEinvoices(request.user!));
    },
  );

  app.get(
    '/api/v1/finance/integrations/einvoices/by-invoice/:invoiceId',
    {
      preHandler: [requirePermission(...viewPerms)],
      schema: { params: Type.Object({ invoiceId: Type.String({ format: 'uuid' }) }) },
    },
    async (request) => {
      requireDb(app, request);
      const { invoiceId } = request.params as { invoiceId: string };
      return ok(
        await createIntegrationsService(app.supabase!).getEinvoiceByInvoice(request.user!, invoiceId),
      );
    },
  );

  app.post(
    '/api/v1/finance/integrations/einvoices/:invoiceId/generate',
    {
      preHandler: [requirePermission(...managePerms)],
      schema: { params: Type.Object({ invoiceId: Type.String({ format: 'uuid' }) }) },
    },
    async (request) => {
      requireDb(app, request);
      const { invoiceId } = request.params as { invoiceId: string };
      return ok(
        await createIntegrationsService(app.supabase!).generateEinvoice(
          request.user!,
          invoiceId,
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/integrations/einvoices/:id/cancel',
    {
      preHandler: [requirePermission(...managePerms)],
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: cancelBody,
      },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createIntegrationsService(app.supabase!).cancelEinvoice(
          request.user!,
          id,
          request.body as { reason?: string },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/finance/integrations/eway-bills',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createIntegrationsService(app.supabase!).listEwayBills(request.user!));
    },
  );

  app.post(
    '/api/v1/finance/integrations/eway-bills',
    { preHandler: [requirePermission(...managePerms)], schema: { body: ewayBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createIntegrationsService(app.supabase!).generateEwayBill(
          request.user!,
          request.body as {
            sourceType: 'invoice' | 'delivery_note';
            sourceId: string;
            transporterId?: string;
            transporterName?: string;
            vehicleNumber?: string;
            transportMode?: 'road' | 'rail' | 'air' | 'ship';
            distanceKm?: number;
            fromPlace?: string;
            toPlace?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/finance/integrations/gstn-jobs',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createIntegrationsService(app.supabase!).listGstnJobs(request.user!));
    },
  );

  app.post(
    '/api/v1/finance/integrations/gstn/gstr1-push',
    { preHandler: [requirePermission(...managePerms)], schema: { body: periodBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createIntegrationsService(app.supabase!).pushGstr1(
          request.user!,
          request.body as { periodYear: number; periodMonth: number },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/integrations/gstn/gstr2b-pull',
    { preHandler: [requirePermission(...managePerms)], schema: { body: periodBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createIntegrationsService(app.supabase!).pullGstr2b(
          request.user!,
          request.body as { periodYear: number; periodMonth: number },
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/finance/integrations/payment-checkouts',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createIntegrationsService(app.supabase!).listPaymentCheckouts(request.user!));
    },
  );

  app.post(
    '/api/v1/finance/integrations/payment-checkouts',
    { preHandler: [requirePermission(...managePerms)], schema: { body: checkoutBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createIntegrationsService(app.supabase!).createPaymentCheckout(
          request.user!,
          request.body as { invoiceId: string },
          metaOf(request),
        ),
      );
    },
  );
}
