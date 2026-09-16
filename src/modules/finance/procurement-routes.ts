import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createProcurementService } from './procurement-service';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function requireDb(app: FastifyInstance, request: { user?: unknown }) {
  if (!app.supabase || !request.user) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

const indentPriority = Type.Union([
  Type.Literal('low'),
  Type.Literal('normal'),
  Type.Literal('high'),
  Type.Literal('urgent'),
]);

const indentLineBody = Type.Object({
  itemId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  description: Type.String({ minLength: 1 }),
  quantity: Type.Number({ exclusiveMinimum: 0 }),
  unit: Type.Optional(Type.String()),
  estimatedRate: Type.Number({ minimum: 0 }),
});

const indentCreateBody = Type.Object({
  departmentId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  requiredDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  priority: Type.Optional(indentPriority),
  purpose: Type.String({ minLength: 1 }),
  justification: Type.Optional(Type.String()),
  lines: Type.Array(indentLineBody, { minItems: 1 }),
});

const indentPatchBody = Type.Object({
  departmentId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  requiredDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  priority: Type.Optional(indentPriority),
  purpose: Type.Optional(Type.String({ minLength: 1 })),
  justification: Type.Optional(Type.String()),
  lines: Type.Optional(Type.Array(indentLineBody, { minItems: 1 })),
});

const decideBody = Type.Object({
  decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
  comment: Type.Optional(Type.String()),
});

const rfqFromIndentBody = Type.Object({
  indentId: Type.String({ format: 'uuid' }),
  vendorIds: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1 }),
  title: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

const quoteLineBody = Type.Object({
  rfqLineId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  description: Type.String({ minLength: 1 }),
  quantity: Type.Number({ exclusiveMinimum: 0 }),
  unit: Type.Optional(Type.String()),
  rate: Type.Number({ minimum: 0 }),
  taxPercent: Type.Number({ minimum: 0 }),
});

const quoteCreateBody = Type.Object({
  vendorId: Type.String({ format: 'uuid' }),
  quoteDate: Type.Optional(Type.String()),
  deliveryDays: Type.Optional(Type.Integer({ minimum: 0 })),
  shippingAmount: Type.Optional(Type.Number({ minimum: 0 })),
  notes: Type.Optional(Type.String()),
  lines: Type.Array(quoteLineBody, { minItems: 1 }),
});

const poLineBody = Type.Object({
  itemId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  description: Type.String({ minLength: 1 }),
  quantity: Type.Number({ exclusiveMinimum: 0 }),
  unit: Type.Optional(Type.String()),
  rate: Type.Number({ minimum: 0 }),
  taxPercent: Type.Number({ minimum: 0 }),
});

const poCreateBody = Type.Object({
  vendorId: Type.String({ format: 'uuid' }),
  indentId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  rfqId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  vendorQuoteId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  orderDate: Type.Optional(Type.String()),
  expectedDelivery: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  billingAddress: Type.Optional(Type.String()),
  deliveryAddress: Type.Optional(Type.String()),
  paymentTermsDays: Type.Optional(Type.Integer({ minimum: 0 })),
  notes: Type.Optional(Type.String()),
  lines: Type.Array(poLineBody, { minItems: 1 }),
});

const poFromQuoteBody = Type.Object({
  quoteId: Type.String({ format: 'uuid' }),
  orderDate: Type.Optional(Type.String()),
  expectedDelivery: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  billingAddress: Type.Optional(Type.String()),
  deliveryAddress: Type.Optional(Type.String()),
  paymentTermsDays: Type.Optional(Type.Integer({ minimum: 0 })),
  notes: Type.Optional(Type.String()),
});

const receiptCreateBody = Type.Object({
  purchaseOrderId: Type.String({ format: 'uuid' }),
  receiptDate: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  lines: Type.Array(
    Type.Object({
      purchaseOrderLineId: Type.String({ format: 'uuid' }),
      quantityReceived: Type.Number({ exclusiveMinimum: 0 }),
      description: Type.Optional(Type.String()),
    }),
    { minItems: 1 },
  ),
});

const billFromPoBody = Type.Object({
  purchaseOrderId: Type.String({ format: 'uuid' }),
  receiptId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  billDate: Type.Optional(Type.String()),
  dueDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  vendorInvoiceNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notes: Type.Optional(Type.String()),
});

const paymentCreateBody = Type.Object({
  vendorId: Type.String({ format: 'uuid' }),
  paymentDate: Type.Optional(Type.String()),
  amount: Type.Number({ exclusiveMinimum: 0 }),
  bankAccountId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  method: Type.Optional(Type.String()),
  reference: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  allocations: Type.Array(
    Type.Object({
      billId: Type.String({ format: 'uuid' }),
      amount: Type.Number({ exclusiveMinimum: 0 }),
    }),
    { minItems: 1 },
  ),
});

const creditCreateBody = Type.Object({
  vendorId: Type.String({ format: 'uuid' }),
  billId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
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

const indentPerms = [
  PERMISSIONS.FINANCE_INDENT_APPLY,
  PERMISSIONS.FINANCE_INDENT_APPROVE,
  PERMISSIONS.FINANCE_PURCHASE_VIEW,
  PERMISSIONS.FINANCE_PURCHASE_MANAGE,
] as const;

const purchaseViewPerms = [
  PERMISSIONS.FINANCE_PURCHASE_VIEW,
  PERMISSIONS.FINANCE_PURCHASE_MANAGE,
  PERMISSIONS.FINANCE_INDENT_APPROVE,
] as const;

export async function registerFinanceProcurementRoutes(app: FastifyInstance): Promise<void> {
  // --- Indents ---
  app.get('/api/v1/finance/indents', { preHandler: [requirePermission(...indentPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createProcurementService(app.supabase!).listIndents(request.user!));
  });

  app.get('/api/v1/finance/indents/:id', { preHandler: [requirePermission(...indentPerms)] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createProcurementService(app.supabase!).getIndent(request.user!, id));
  });

  app.post(
    '/api/v1/finance/indents',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_INDENT_APPLY)], schema: { body: indentCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createProcurementService(app.supabase!).createIndent(
          request.user!,
          request.body as {
            purpose: string;
            lines: { description: string; quantity: number; estimatedRate: number }[];
          },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/finance/indents/:id',
    { preHandler: [requirePermission(...indentPerms)], schema: { body: indentPatchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createProcurementService(app.supabase!).updateIndent(
          request.user!,
          id,
          request.body as Record<string, unknown>,
          metaOf(request),
        ),
      );
    },
  );

  app.post('/api/v1/finance/indents/:id/submit', { preHandler: [requirePermission(...indentPerms)] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createProcurementService(app.supabase!).submitIndent(request.user!, id, metaOf(request)));
  });

  app.post(
    '/api/v1/finance/indents/:id/decide',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_INDENT_APPROVE)], schema: { body: decideBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createProcurementService(app.supabase!).decideIndent(
          request.user!,
          id,
          request.body as { decision: 'approve' | 'reject'; comment?: string },
          metaOf(request),
        ),
      );
    },
  );

  // --- RFQs ---
  app.get('/api/v1/finance/rfqs', { preHandler: [requirePermission(...purchaseViewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createProcurementService(app.supabase!).listRfqs(request.user!));
  });

  app.get('/api/v1/finance/rfqs/:id', { preHandler: [requirePermission(...purchaseViewPerms)] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createProcurementService(app.supabase!).getRfq(request.user!, id));
  });

  app.post(
    '/api/v1/finance/rfqs/from-indent',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)], schema: { body: rfqFromIndentBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createProcurementService(app.supabase!).createRfqFromIndent(
          request.user!,
          request.body as { indentId: string; vendorIds: string[] },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/rfqs/:id/close',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createProcurementService(app.supabase!).closeRfq(request.user!, id, metaOf(request)));
    },
  );

  // --- Vendor quotes ---
  app.get(
    '/api/v1/finance/rfqs/:id/quotes',
    { preHandler: [requirePermission(...purchaseViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createProcurementService(app.supabase!).listQuotesForRfq(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/rfqs/:id/quotes',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)], schema: { body: quoteCreateBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        vendorId: string;
        lines: { description: string; quantity: number; rate: number; taxPercent: number }[];
      };
      return ok(
        await createProcurementService(app.supabase!).createVendorQuote(
          request.user!,
          { ...body, rfqId: id },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/vendor-quotes/:id/select',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createProcurementService(app.supabase!).selectVendorQuote(request.user!, id, metaOf(request)));
    },
  );

  // --- Purchase orders ---
  app.get(
    '/api/v1/finance/purchase-orders',
    { preHandler: [requirePermission(...purchaseViewPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createProcurementService(app.supabase!).listPurchaseOrders(request.user!));
    },
  );

  app.get(
    '/api/v1/finance/purchase-orders/:id',
    { preHandler: [requirePermission(...purchaseViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createProcurementService(app.supabase!).getPurchaseOrder(request.user!, id));
    },
  );

  app.get(
    '/api/v1/finance/purchase-orders/:id/print',
    { preHandler: [requirePermission(...purchaseViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createProcurementService(app.supabase!).getPurchaseOrderPrint(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/purchase-orders',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)], schema: { body: poCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createProcurementService(app.supabase!).createPurchaseOrder(
          request.user!,
          request.body as {
            vendorId: string;
            lines: { description: string; quantity: number; rate: number; taxPercent: number }[];
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/purchase-orders/from-quote',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)], schema: { body: poFromQuoteBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createProcurementService(app.supabase!).createPurchaseOrderFromQuote(
          request.user!,
          request.body as { quoteId: string },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/purchase-orders/:id/approve',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createProcurementService(app.supabase!).approvePurchaseOrder(request.user!, id, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/finance/purchase-orders/:id/issue',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createProcurementService(app.supabase!).issuePurchaseOrder(request.user!, id, metaOf(request)));
    },
  );

  // --- Receipts ---
  app.get('/api/v1/finance/receipts', { preHandler: [requirePermission(...purchaseViewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createProcurementService(app.supabase!).listReceipts(request.user!));
  });

  app.get('/api/v1/finance/receipts/:id', { preHandler: [requirePermission(...purchaseViewPerms)] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createProcurementService(app.supabase!).getReceipt(request.user!, id));
  });

  app.post(
    '/api/v1/finance/receipts',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)], schema: { body: receiptCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createProcurementService(app.supabase!).createReceipt(
          request.user!,
          request.body as {
            purchaseOrderId: string;
            lines: { purchaseOrderLineId: string; quantityReceived: number }[];
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/receipts/:id/post',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createProcurementService(app.supabase!).postReceipt(request.user!, id, metaOf(request)));
    },
  );

  // --- Bills ---
  app.get('/api/v1/finance/bills', { preHandler: [requirePermission(...purchaseViewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createProcurementService(app.supabase!).listBills(request.user!));
  });

  app.get('/api/v1/finance/bills/:id', { preHandler: [requirePermission(...purchaseViewPerms)] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createProcurementService(app.supabase!).getBill(request.user!, id));
  });

  app.post(
    '/api/v1/finance/bills/from-purchase-order',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)], schema: { body: billFromPoBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createProcurementService(app.supabase!).createBillFromPurchaseOrder(
          request.user!,
          request.body as { purchaseOrderId: string },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/bills/:id/post',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createProcurementService(app.supabase!).postBill(request.user!, id, metaOf(request)));
    },
  );

  // --- Payments ---
  app.get('/api/v1/finance/payments', { preHandler: [requirePermission(...purchaseViewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createProcurementService(app.supabase!).listPayments(request.user!));
  });

  app.get('/api/v1/finance/payments/:id', { preHandler: [requirePermission(...purchaseViewPerms)] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createProcurementService(app.supabase!).getPayment(request.user!, id));
  });

  app.post(
    '/api/v1/finance/payments',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)], schema: { body: paymentCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createProcurementService(app.supabase!).createPayment(
          request.user!,
          request.body as {
            vendorId: string;
            amount: number;
            allocations: { billId: string; amount: number }[];
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/payments/:id/post',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createProcurementService(app.supabase!).postPayment(request.user!, id, metaOf(request)));
    },
  );

  // --- Vendor credits ---
  app.get(
    '/api/v1/finance/vendor-credits',
    { preHandler: [requirePermission(...purchaseViewPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createProcurementService(app.supabase!).listCredits(request.user!));
    },
  );

  app.get(
    '/api/v1/finance/vendor-credits/:id',
    { preHandler: [requirePermission(...purchaseViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createProcurementService(app.supabase!).getCredit(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/vendor-credits',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)], schema: { body: creditCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createProcurementService(app.supabase!).createCredit(
          request.user!,
          request.body as {
            vendorId: string;
            lines: { description: string; quantity: number; rate: number; taxPercent: number }[];
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/vendor-credits/:id/post',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_PURCHASE_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createProcurementService(app.supabase!).postCredit(request.user!, id, metaOf(request)));
    },
  );
}
