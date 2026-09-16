import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createGstService } from './gst-service';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function requireDb(app: FastifyInstance, request: { user?: unknown }) {
  if (!app.supabase || !request.user) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

const viewPerms = [
  PERMISSIONS.FINANCE_GST_VIEW,
  PERMISSIONS.FINANCE_GST_MANAGE,
  PERMISSIONS.FINANCE_TAX_MANAGE,
] as const;

const managePerms = [PERMISSIONS.FINANCE_GST_MANAGE, PERMISSIONS.FINANCE_TAX_MANAGE] as const;

const dateRangeQuery = Type.Object({
  fromDate: Type.String({ minLength: 10 }),
  toDate: Type.String({ minLength: 10 }),
});

const periodQuery = Type.Object({
  periodYear: Type.String({ minLength: 4 }),
  periodMonth: Type.String({ minLength: 1 }),
});

const tdsBody = Type.Object({
  tdsSection: Type.String({ minLength: 1 }),
  tdsPercent: Type.Number({ minimum: 0, maximum: 100 }),
});

const itcBody = Type.Object({
  itcEligibility: Type.Union([
    Type.Literal('eligible'),
    Type.Literal('ineligible'),
    Type.Literal('claimed'),
    Type.Literal('reversed'),
  ]),
});

export async function registerFinanceGstRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/finance/gst/summary',
    { preHandler: [requirePermission(...viewPerms)], schema: { querystring: dateRangeQuery } },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate: string; toDate: string };
      return ok(await createGstService(app.supabase!).getPeriodSummary(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/gst/outward',
    { preHandler: [requirePermission(...viewPerms)], schema: { querystring: dateRangeQuery } },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate: string; toDate: string };
      return ok(await createGstService(app.supabase!).getOutwardRegister(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/gst/inward',
    { preHandler: [requirePermission(...viewPerms)], schema: { querystring: dateRangeQuery } },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate: string; toDate: string };
      return ok(await createGstService(app.supabase!).getInwardRegister(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/gst/itc',
    { preHandler: [requirePermission(...viewPerms)], schema: { querystring: dateRangeQuery } },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate: string; toDate: string };
      return ok(await createGstService(app.supabase!).getItcTracker(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/gst/hsn',
    { preHandler: [requirePermission(...viewPerms)], schema: { querystring: dateRangeQuery } },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate: string; toDate: string };
      return ok(await createGstService(app.supabase!).getHsnSummary(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/gst/tds',
    { preHandler: [requirePermission(...viewPerms)], schema: { querystring: dateRangeQuery } },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { fromDate: string; toDate: string };
      return ok(await createGstService(app.supabase!).listTdsDeductions(request.user!, query));
    },
  );

  app.get(
    '/api/v1/finance/gst/export/gstr1',
    { preHandler: [requirePermission(...viewPerms)], schema: { querystring: periodQuery } },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { periodYear: string; periodMonth: string };
      return ok(
        await createGstService(app.supabase!).exportGstr1Workbook(request.user!, {
          periodYear: Number(query.periodYear),
          periodMonth: Number(query.periodMonth),
        }),
      );
    },
  );

  app.get(
    '/api/v1/finance/gst/export/gstr2b',
    { preHandler: [requirePermission(...viewPerms)], schema: { querystring: periodQuery } },
    async (request) => {
      requireDb(app, request);
      const query = request.query as { periodYear: string; periodMonth: string };
      return ok(
        await createGstService(app.supabase!).exportGstr2bWorkbook(request.user!, {
          periodYear: Number(query.periodYear),
          periodMonth: Number(query.periodMonth),
        }),
      );
    },
  );

  app.post(
    '/api/v1/finance/gst/bills/:id/tds',
    { preHandler: [requirePermission(...managePerms)], schema: { body: tdsBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createGstService(app.supabase!).applyBillTds(
          request.user!,
          id,
          request.body as { tdsSection: string; tdsPercent: number },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/gst/bills/:id/itc',
    { preHandler: [requirePermission(...managePerms)], schema: { body: itcBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createGstService(app.supabase!).setBillItcEligibility(
          request.user!,
          id,
          request.body as { itcEligibility: 'eligible' | 'ineligible' | 'claimed' | 'reversed' },
          metaOf(request),
        ),
      );
    },
  );
}
