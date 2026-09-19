import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createSalesService } from './sales-service';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function requireDb(app: FastifyInstance, request: { user?: unknown }) {
  if (!app.supabase || !request.user) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

const salesLineBody = Type.Object({
  itemId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  description: Type.String({ minLength: 1 }),
  quantity: Type.Number({ exclusiveMinimum: 0 }),
  unit: Type.Optional(Type.String()),
  rate: Type.Number({ minimum: 0 }),
  taxPercent: Type.Number({ minimum: 0 }),
  catalogNo: Type.Optional(Type.String()),
  hsnSac: Type.Optional(Type.String()),
});

const quoteCreateBody = Type.Object({
  customerId: Type.String({ format: 'uuid' }),
  quoteDate: Type.Optional(Type.String()),
  expiryDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notes: Type.Optional(Type.String()),
  terms: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
  referenceText: Type.Optional(Type.String()),
  placeOfSupply: Type.Optional(Type.String()),
  orgGstProfileId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  billingAddressSnapshot: Type.Optional(Type.String()),
  shippingAddressSnapshot: Type.Optional(Type.String()),
  customerGstinSnapshot: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  shipToName: Type.Optional(Type.String()),
  lines: Type.Array(salesLineBody, { minItems: 1 }),
});

const quotePatchBody = Type.Object({
  customerId: Type.Optional(Type.String({ format: 'uuid' })),
  quoteDate: Type.Optional(Type.String()),
  expiryDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notes: Type.Optional(Type.String()),
  terms: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
  referenceText: Type.Optional(Type.String()),
  placeOfSupply: Type.Optional(Type.String()),
  orgGstProfileId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  billingAddressSnapshot: Type.Optional(Type.String()),
  shippingAddressSnapshot: Type.Optional(Type.String()),
  customerGstinSnapshot: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  shipToName: Type.Optional(Type.String()),
  changeNote: Type.Optional(Type.String()),
  lines: Type.Optional(Type.Array(salesLineBody, { minItems: 1 })),
});

const quoteEmailBody = Type.Object({
  to: Type.String({ minLength: 3 }),
  subject: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  saveEmailToCustomer: Type.Optional(Type.Boolean()),
});

const gstinLookupBody = Type.Object({
  gstin: Type.String({ minLength: 15, maxLength: 15 }),
});

const quoteDecideBody = Type.Object({
  decision: Type.Union([Type.Literal('accept'), Type.Literal('decline')]),
});

const salesOrderCreateBody = Type.Object({
  customerId: Type.String({ format: 'uuid' }),
  quoteId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  orderDate: Type.Optional(Type.String()),
  expectedDelivery: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  billingAddress: Type.Optional(Type.String()),
  shippingAddress: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  lines: Type.Array(salesLineBody, { minItems: 1 }),
});

const salesOrderFromQuoteBody = Type.Object({
  quoteId: Type.String({ format: 'uuid' }),
  orderDate: Type.Optional(Type.String()),
  expectedDelivery: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  billingAddress: Type.Optional(Type.String()),
  shippingAddress: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

const deliveryNoteFromSoBody = Type.Object({
  salesOrderId: Type.String({ format: 'uuid' }),
  deliveryDate: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  lines: Type.Array(
    Type.Object({
      salesOrderLineId: Type.String({ format: 'uuid' }),
      quantityDelivered: Type.Number({ exclusiveMinimum: 0 }),
    }),
    { minItems: 1 },
  ),
});

const invoiceFromSoBody = Type.Object({
  salesOrderId: Type.String({ format: 'uuid' }),
  deliveryNoteId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  invoiceDate: Type.Optional(Type.String()),
  dueDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notes: Type.Optional(Type.String()),
});

const invoiceFromQuoteBody = Type.Object({
  quoteId: Type.String({ format: 'uuid' }),
  invoiceDate: Type.Optional(Type.String()),
  dueDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notes: Type.Optional(Type.String()),
});

const customerPaymentCreateBody = Type.Object({
  customerId: Type.String({ format: 'uuid' }),
  paymentDate: Type.Optional(Type.String()),
  amount: Type.Number({ exclusiveMinimum: 0 }),
  bankAccountId: Type.String({ format: 'uuid' }),
  method: Type.Optional(Type.String()),
  reference: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  allocations: Type.Array(
    Type.Object({
      invoiceId: Type.String({ format: 'uuid' }),
      amount: Type.Number({ exclusiveMinimum: 0 }),
    }),
    { minItems: 1 },
  ),
});

const creditNoteCreateBody = Type.Object({
  customerId: Type.String({ format: 'uuid' }),
  invoiceId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  creditDate: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  lines: Type.Array(
    Type.Object({
      description: Type.String({ minLength: 1 }),
      quantity: Type.Number({ exclusiveMinimum: 0 }),
      rate: Type.Number({ minimum: 0 }),
      taxPercent: Type.Number({ minimum: 0 }),
    }),
    { minItems: 1 },
  ),
});

const salesViewPerms = [PERMISSIONS.FINANCE_SALES_VIEW, PERMISSIONS.FINANCE_SALES_MANAGE] as const;

export async function registerFinanceSalesRoutes(app: FastifyInstance): Promise<void> {
  // --- Quotes ---
  app.get('/api/v1/finance/quotes', { preHandler: [requirePermission(...salesViewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createSalesService(app.supabase!).listQuotes(request.user!));
  });

  app.get(
    '/api/v1/finance/quotes/next-number',
    { preHandler: [requirePermission(...salesViewPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createSalesService(app.supabase!).peekNextQuoteNumber(request.user!));
    },
  );

  app.post(
    '/api/v1/finance/gstin-lookup',
    {
      preHandler: [
        requirePermission(
          PERMISSIONS.FINANCE_SALES_VIEW,
          PERMISSIONS.FINANCE_SALES_MANAGE,
          PERMISSIONS.FINANCE_PARTIES_MANAGE,
        ),
      ],
      schema: { body: gstinLookupBody },
    },
    async (request) => {
      requireDb(app, request);
      const body = request.body as { gstin: string };
      return ok(await createSalesService(app.supabase!).lookupGstin(request.user!, body.gstin));
    },
  );

  app.get('/api/v1/finance/quotes/:id', { preHandler: [requirePermission(...salesViewPerms)] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createSalesService(app.supabase!).getQuote(request.user!, id));
  });

  app.get(
    '/api/v1/finance/quotes/:id/print',
    { preHandler: [requirePermission(...salesViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).getQuotePrint(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/quotes',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)], schema: { body: quoteCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createSalesService(app.supabase!).createQuote(
          request.user!,
          request.body as {
            customerId: string;
            lines: {
              description: string;
              quantity: number;
              rate: number;
              taxPercent: number;
              catalogNo?: string;
              hsnSac?: string;
              unit?: string;
              itemId?: string | null;
            }[];
            quoteDate?: string;
            expiryDate?: string | null;
            notes?: string;
            terms?: string;
            subject?: string;
            referenceText?: string;
            placeOfSupply?: string;
            orgGstProfileId?: string | null;
            billingAddressSnapshot?: string;
            shippingAddressSnapshot?: string;
            customerGstinSnapshot?: string | null;
            shipToName?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/finance/quotes/:id',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)], schema: { body: quotePatchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createSalesService(app.supabase!).updateQuote(
          request.user!,
          id,
          request.body as Record<string, unknown>,
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/quotes/:id/send',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).sendQuote(request.user!, id, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/finance/quotes/:id/decide',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)], schema: { body: quoteDecideBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createSalesService(app.supabase!).decideQuote(
          request.user!,
          id,
          request.body as { decision: 'accept' | 'decline' },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/quotes/:id/expire',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).expireQuote(request.user!, id, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/finance/quotes/:id/convert-to-order',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).convertQuoteToSalesOrder(request.user!, id, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/finance/quotes/:id/convert-to-invoice',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).convertQuoteToInvoice(request.user!, id, metaOf(request)));
    },
  );

  app.get(
    '/api/v1/finance/quotes/:id/versions',
    { preHandler: [requirePermission(...salesViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).listQuoteVersions(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/quotes/:id/email',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)], schema: { body: quoteEmailBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createSalesService(app.supabase!).emailQuote(
          request.user!,
          id,
          request.body as { to: string; subject?: string; message?: string; saveEmailToCustomer?: boolean },
          metaOf(request),
        ),
      );
    },
  );

  // --- Sales orders ---
  app.get('/api/v1/finance/sales-orders', { preHandler: [requirePermission(...salesViewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createSalesService(app.supabase!).listSalesOrders(request.user!));
  });

  app.get(
    '/api/v1/finance/sales-orders/:id',
    { preHandler: [requirePermission(...salesViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).getSalesOrder(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/sales-orders',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)], schema: { body: salesOrderCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createSalesService(app.supabase!).createSalesOrder(
          request.user!,
          request.body as {
            customerId: string;
            lines: { description: string; quantity: number; rate: number; taxPercent: number }[];
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/sales-orders/from-quote',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)], schema: { body: salesOrderFromQuoteBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createSalesService(app.supabase!).createSalesOrderFromQuote(
          request.user!,
          request.body as { quoteId: string },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/sales-orders/:id/confirm',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).confirmSalesOrder(request.user!, id, metaOf(request)));
    },
  );

  // --- Delivery notes ---
  app.get('/api/v1/finance/delivery-notes', { preHandler: [requirePermission(...salesViewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createSalesService(app.supabase!).listDeliveryNotes(request.user!));
  });

  app.get(
    '/api/v1/finance/delivery-notes/:id',
    { preHandler: [requirePermission(...salesViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).getDeliveryNote(request.user!, id));
    },
  );

  app.get(
    '/api/v1/finance/delivery-notes/:id/print',
    { preHandler: [requirePermission(...salesViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).getDeliveryNotePrint(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/delivery-notes/from-sales-order',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)], schema: { body: deliveryNoteFromSoBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createSalesService(app.supabase!).createDeliveryNoteFromSalesOrder(
          request.user!,
          request.body as {
            salesOrderId: string;
            lines: { salesOrderLineId: string; quantityDelivered: number }[];
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/delivery-notes/:id/post',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).postDeliveryNote(request.user!, id, metaOf(request)));
    },
  );

  // --- Invoices ---
  app.get('/api/v1/finance/invoices', { preHandler: [requirePermission(...salesViewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createSalesService(app.supabase!).listInvoices(request.user!));
  });

  app.get('/api/v1/finance/invoices/:id', { preHandler: [requirePermission(...salesViewPerms)] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createSalesService(app.supabase!).getInvoice(request.user!, id));
  });

  app.get(
    '/api/v1/finance/invoices/:id/print',
    { preHandler: [requirePermission(...salesViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).getInvoicePrint(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/invoices/from-sales-order',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)], schema: { body: invoiceFromSoBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createSalesService(app.supabase!).createInvoiceFromSalesOrder(
          request.user!,
          request.body as { salesOrderId: string },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/invoices/from-quote',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)], schema: { body: invoiceFromQuoteBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createSalesService(app.supabase!).createInvoiceFromQuote(
          request.user!,
          request.body as { quoteId: string },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/invoices/:id/send',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).sendInvoice(request.user!, id, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/finance/invoices/:id/post',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).postInvoice(request.user!, id, metaOf(request)));
    },
  );

  // --- Customer payments ---
  app.get(
    '/api/v1/finance/customer-payments',
    { preHandler: [requirePermission(...salesViewPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createSalesService(app.supabase!).listCustomerPayments(request.user!));
    },
  );

  app.get(
    '/api/v1/finance/customer-payments/:id',
    { preHandler: [requirePermission(...salesViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).getCustomerPayment(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/customer-payments',
    {
      preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)],
      schema: { body: customerPaymentCreateBody },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createSalesService(app.supabase!).createCustomerPayment(
          request.user!,
          request.body as {
            customerId: string;
            amount: number;
            bankAccountId: string;
            allocations: { invoiceId: string; amount: number }[];
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/customer-payments/:id/post',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).postCustomerPayment(request.user!, id, metaOf(request)));
    },
  );

  // --- Credit notes ---
  app.get('/api/v1/finance/credit-notes', { preHandler: [requirePermission(...salesViewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createSalesService(app.supabase!).listCreditNotes(request.user!));
  });

  app.get(
    '/api/v1/finance/credit-notes/:id',
    { preHandler: [requirePermission(...salesViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).getCreditNote(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/credit-notes',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)], schema: { body: creditNoteCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createSalesService(app.supabase!).createCreditNote(
          request.user!,
          request.body as {
            customerId: string;
            lines: { description: string; quantity: number; rate: number; taxPercent: number }[];
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/credit-notes/:id/post',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_SALES_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createSalesService(app.supabase!).postCreditNote(request.user!, id, metaOf(request)));
    },
  );
}
