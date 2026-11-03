import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth } from '../../plugins/permissions';
import { createHrInvoiceService } from './service';
import type { CreateHrInvoiceInput } from './types';

const lineBody = Type.Object({
  description: Type.String({ minLength: 1, maxLength: 240 }),
  detail: Type.Optional(Type.String({ maxLength: 240 })),
  quantity: Type.Number({ exclusiveMinimum: 0, maximum: 1000000 }),
  unitPrice: Type.Number({ minimum: 0, maximum: 100000000 }),
});

const createBody = Type.Object({
  companyId: Type.String({ minLength: 1 }),
  clientId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  client: Type.Optional(
    Type.Union([
      Type.Object({
        name: Type.String({ minLength: 1, maxLength: 160 }),
        address: Type.Optional(Type.String({ maxLength: 800 })),
      }),
      Type.Null(),
    ]),
  ),
  issueDate: Type.String({ minLength: 10, maxLength: 10 }),
  dueDate: Type.String({ minLength: 10, maxLength: 10 }),
  reference: Type.Optional(Type.String({ maxLength: 80 })),
  currency: Type.Union([
    Type.Literal('INR'),
    Type.Literal('GBP'),
    Type.Literal('USD'),
    Type.Literal('EUR'),
  ]),
  issuerEmail: Type.String({ minLength: 3, maxLength: 160 }),
  signatureName: Type.String({ minLength: 1, maxLength: 120 }),
  lines: Type.Array(lineBody, { minItems: 1, maxItems: 20 }),
});

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function requireDb(app: FastifyInstance, request: { user?: unknown }) {
  if (!app.supabase || !request.user) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

export async function registerHrInvoiceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/hr/invoice-clients', { preHandler: [requireAuth()] }, async (request) => {
    requireDb(app, request);
    return ok(await createHrInvoiceService(app.supabase!).listClients(request.user!));
  });

  app.get('/api/v1/hr/invoices', { preHandler: [requireAuth()] }, async (request) => {
    requireDb(app, request);
    return ok(await createHrInvoiceService(app.supabase!).list(request.user!));
  });

  app.get('/api/v1/hr/invoices/:id', { preHandler: [requireAuth()] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createHrInvoiceService(app.supabase!).get(request.user!, id));
  });

  app.post(
    '/api/v1/hr/invoices',
    { preHandler: [requireAuth()], schema: { body: createBody } },
    async (request) => {
      requireDb(app, request);
      const body = request.body as CreateHrInvoiceInput;
      return ok(await createHrInvoiceService(app.supabase!).create(request.user!, body, metaOf(request)), {
        created: true,
      });
    },
  );
}
