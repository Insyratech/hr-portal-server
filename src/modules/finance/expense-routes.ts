import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createExpenseService } from './expense-service';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function requireDb(app: FastifyInstance, request: { user?: unknown }) {
  if (!app.supabase || !request.user) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

const paidThrough = Type.Union([
  Type.Literal('cash'),
  Type.Literal('bank'),
  Type.Literal('accounts_payable'),
]);

const expenseCreateBody = Type.Object({
  expenseDate: Type.Optional(Type.String()),
  categoryId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  vendorId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  expenseAccountId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  description: Type.String({ minLength: 1 }),
  amount: Type.Number({ minimum: 0 }),
  taxPercent: Type.Optional(Type.Number({ minimum: 0 })),
  paidThrough,
  bankAccountId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  vendorInvoiceNumber: Type.Optional(Type.String()),
  receiptUrl: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

const expensePatchBody = Type.Object({
  expenseDate: Type.Optional(Type.String()),
  categoryId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  vendorId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  expenseAccountId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  description: Type.Optional(Type.String({ minLength: 1 })),
  amount: Type.Optional(Type.Number({ minimum: 0 })),
  taxPercent: Type.Optional(Type.Number({ minimum: 0 })),
  paidThrough: Type.Optional(paidThrough),
  bankAccountId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  vendorInvoiceNumber: Type.Optional(Type.String()),
  receiptUrl: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

const claimCreateBody = Type.Object({
  categoryId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  claimDate: Type.Optional(Type.String()),
  description: Type.String({ minLength: 1 }),
  amount: Type.Number({ minimum: 0 }),
  taxPercent: Type.Optional(Type.Number({ minimum: 0 })),
  vendorName: Type.Optional(Type.String()),
  billNumber: Type.Optional(Type.String()),
  receiptUrl: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

const claimPatchBody = Type.Object({
  categoryId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  claimDate: Type.Optional(Type.String()),
  description: Type.Optional(Type.String({ minLength: 1 })),
  amount: Type.Optional(Type.Number({ minimum: 0 })),
  taxPercent: Type.Optional(Type.Number({ minimum: 0 })),
  vendorName: Type.Optional(Type.String()),
  billNumber: Type.Optional(Type.String()),
  receiptUrl: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

const decideBody = Type.Object({
  decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
  comment: Type.Optional(Type.String()),
});

const reimbursementCreateBody = Type.Object({
  employeeId: Type.String({ format: 'uuid' }),
  paymentDate: Type.Optional(Type.String()),
  amount: Type.Number({ exclusiveMinimum: 0 }),
  bankAccountId: Type.String({ format: 'uuid' }),
  method: Type.Optional(Type.String()),
  reference: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  allocations: Type.Array(
    Type.Object({
      claimId: Type.String({ format: 'uuid' }),
      amount: Type.Number({ exclusiveMinimum: 0 }),
    }),
    { minItems: 1 },
  ),
});

const categoryPerms = [
  PERMISSIONS.FINANCE_EXPENSE_VIEW,
  PERMISSIONS.FINANCE_EXPENSE_MANAGE,
  PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPLY,
  PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPROVE,
] as const;

const expenseViewPerms = [PERMISSIONS.FINANCE_EXPENSE_VIEW, PERMISSIONS.FINANCE_EXPENSE_MANAGE] as const;

const claimPerms = [
  PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPLY,
  PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPROVE,
  PERMISSIONS.FINANCE_EXPENSE_VIEW,
  PERMISSIONS.FINANCE_EXPENSE_MANAGE,
] as const;

export async function registerFinanceExpenseRoutes(app: FastifyInstance): Promise<void> {
  // --- Categories ---
  app.get(
    '/api/v1/finance/expense-categories',
    { preHandler: [requirePermission(...categoryPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createExpenseService(app.supabase!).listCategories(request.user!));
    },
  );

  // --- Direct expenses ---
  app.get('/api/v1/finance/expenses', { preHandler: [requirePermission(...expenseViewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createExpenseService(app.supabase!).listExpenses(request.user!));
  });

  app.get('/api/v1/finance/expenses/:id', { preHandler: [requirePermission(...expenseViewPerms)] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createExpenseService(app.supabase!).getExpense(request.user!, id));
  });

  app.post(
    '/api/v1/finance/expenses',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_EXPENSE_MANAGE)], schema: { body: expenseCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createExpenseService(app.supabase!).createExpense(
          request.user!,
          request.body as {
            expenseDate?: string;
            categoryId?: string | null;
            vendorId?: string | null;
            expenseAccountId?: string | null;
            description: string;
            amount: number;
            taxPercent?: number;
            paidThrough: 'cash' | 'bank' | 'accounts_payable';
            bankAccountId?: string | null;
            vendorInvoiceNumber?: string;
            receiptUrl?: string;
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/finance/expenses/:id',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_EXPENSE_MANAGE)], schema: { body: expensePatchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createExpenseService(app.supabase!).updateExpense(
          request.user!,
          id,
          request.body as {
            expenseDate?: string;
            categoryId?: string | null;
            vendorId?: string | null;
            expenseAccountId?: string | null;
            description?: string;
            amount?: number;
            taxPercent?: number;
            paidThrough?: 'cash' | 'bank' | 'accounts_payable';
            bankAccountId?: string | null;
            vendorInvoiceNumber?: string;
            receiptUrl?: string;
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/expenses/:id/post',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_EXPENSE_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createExpenseService(app.supabase!).postExpense(request.user!, id, metaOf(request)));
    },
  );

  // --- Claims ---
  app.get('/api/v1/finance/expense-claims', { preHandler: [requirePermission(...claimPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createExpenseService(app.supabase!).listClaims(request.user!));
  });

  app.get('/api/v1/finance/expense-claims/:id', { preHandler: [requirePermission(...claimPerms)] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createExpenseService(app.supabase!).getClaim(request.user!, id));
  });

  app.post(
    '/api/v1/finance/expense-claims',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPLY)], schema: { body: claimCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createExpenseService(app.supabase!).createClaim(
          request.user!,
          request.body as {
            categoryId?: string | null;
            claimDate?: string;
            description: string;
            amount: number;
            taxPercent?: number;
            vendorName?: string;
            billNumber?: string;
            receiptUrl?: string;
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/finance/expense-claims/:id',
    { preHandler: [requirePermission(...claimPerms)], schema: { body: claimPatchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createExpenseService(app.supabase!).updateClaim(
          request.user!,
          id,
          request.body as {
            categoryId?: string | null;
            claimDate?: string;
            description?: string;
            amount?: number;
            taxPercent?: number;
            vendorName?: string;
            billNumber?: string;
            receiptUrl?: string;
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/expense-claims/:id/submit',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPLY, PERMISSIONS.FINANCE_EXPENSE_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createExpenseService(app.supabase!).submitClaim(request.user!, id, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/finance/expense-claims/:id/decide',
    {
      preHandler: [requirePermission(PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPROVE)],
      schema: { body: decideBody },
    },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      const body = request.body as { decision: 'approve' | 'reject'; comment?: string };
      return ok(await createExpenseService(app.supabase!).decideClaim(request.user!, id, body, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/finance/expense-claims/:id/cancel',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_EXPENSE_CLAIM_APPLY, PERMISSIONS.FINANCE_EXPENSE_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createExpenseService(app.supabase!).cancelClaim(request.user!, id, metaOf(request)));
    },
  );

  // --- Reimbursements ---
  app.get(
    '/api/v1/finance/expense-reimbursements',
    { preHandler: [requirePermission(...expenseViewPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createExpenseService(app.supabase!).listReimbursements(request.user!));
    },
  );

  app.get(
    '/api/v1/finance/expense-reimbursements/:id',
    { preHandler: [requirePermission(...expenseViewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createExpenseService(app.supabase!).getReimbursement(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/expense-reimbursements',
    {
      preHandler: [requirePermission(PERMISSIONS.FINANCE_EXPENSE_MANAGE)],
      schema: { body: reimbursementCreateBody },
    },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createExpenseService(app.supabase!).createReimbursement(
          request.user!,
          request.body as {
            employeeId: string;
            paymentDate?: string;
            amount: number;
            bankAccountId: string;
            method?: string;
            reference?: string;
            notes?: string;
            allocations: { claimId: string; amount: number }[];
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/expense-reimbursements/:id/post',
    { preHandler: [requirePermission(PERMISSIONS.FINANCE_EXPENSE_MANAGE)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createExpenseService(app.supabase!).postReimbursement(request.user!, id, metaOf(request)));
    },
  );
}
