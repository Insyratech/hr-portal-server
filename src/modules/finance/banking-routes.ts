import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createBankingService } from './banking-service';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function requireDb(app: FastifyInstance, request: { user?: unknown }) {
  if (!app.supabase || !request.user) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

const viewPerms = [PERMISSIONS.FINANCE_BANKING_VIEW, PERMISSIONS.FINANCE_BANKING_MANAGE] as const;
const managePerms = [PERMISSIONS.FINANCE_BANKING_MANAGE] as const;

const bankAccountCreateBody = Type.Object({
  glAccountId: Type.String({ format: 'uuid' }),
  displayName: Type.String({ minLength: 1 }),
  accountKind: Type.Union([Type.Literal('bank'), Type.Literal('cash')]),
  bankName: Type.Optional(Type.String()),
  accountNumberMasked: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

const bankAccountPatchBody = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1 })),
  accountKind: Type.Optional(Type.Union([Type.Literal('bank'), Type.Literal('cash')])),
  bankName: Type.Optional(Type.String()),
  accountNumberMasked: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  isActive: Type.Optional(Type.Boolean()),
});

const manualTxnBody = Type.Object({
  bankAccountId: Type.String({ format: 'uuid' }),
  transactionDate: Type.String({ minLength: 10 }),
  description: Type.Optional(Type.String()),
  reference: Type.Optional(Type.String()),
  transactionType: Type.Union([Type.Literal('credit'), Type.Literal('debit')]),
  amount: Type.Number({ exclusiveMinimum: 0 }),
  notes: Type.Optional(Type.String()),
});

const matchBody = Type.Object({
  matchType: Type.Union([
    Type.Literal('customer_payment'),
    Type.Literal('vendor_payment'),
    Type.Literal('expense'),
    Type.Literal('expense_reimbursement'),
    Type.Literal('transfer'),
  ]),
  matchId: Type.Optional(Type.String({ format: 'uuid' })),
  transferBankAccountId: Type.Optional(Type.String({ format: 'uuid' })),
});

const categorizeBody = Type.Object({
  categoryAccountId: Type.String({ format: 'uuid' }),
});

const importBody = Type.Object({
  bankAccountId: Type.String({ format: 'uuid' }),
  filename: Type.Optional(Type.String()),
  csvText: Type.String({ minLength: 1 }),
});

const reconciliationSaveBody = Type.Object({
  bankAccountId: Type.String({ format: 'uuid' }),
  statementDate: Type.String({ minLength: 10 }),
  statementEndingBalance: Type.Number(),
  notes: Type.Optional(Type.String()),
  complete: Type.Optional(Type.Boolean()),
});

export async function registerFinanceBankingRoutes(app: FastifyInstance): Promise<void> {
  // --- Bank accounts ---
  app.get('/api/v1/finance/bank-accounts', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createBankingService(app.supabase!).listBankAccounts(request.user!));
  });

  app.get('/api/v1/finance/bank-accounts/:id', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createBankingService(app.supabase!).getBankAccount(request.user!, id));
  });

  app.post(
    '/api/v1/finance/bank-accounts',
    { preHandler: [requirePermission(...managePerms)], schema: { body: bankAccountCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createBankingService(app.supabase!).createBankAccount(
          request.user!,
          request.body as {
            glAccountId: string;
            displayName: string;
            accountKind: 'bank' | 'cash';
            bankName?: string;
            accountNumberMasked?: string;
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/finance/bank-accounts/:id',
    { preHandler: [requirePermission(...managePerms)], schema: { body: bankAccountPatchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createBankingService(app.supabase!).updateBankAccount(
          request.user!,
          id,
          request.body as {
            displayName?: string;
            accountKind?: 'bank' | 'cash';
            bankName?: string;
            accountNumberMasked?: string;
            notes?: string;
            isActive?: boolean;
          },
          metaOf(request),
        ),
      );
    },
  );

  // --- Bank transactions ---
  app.get('/api/v1/finance/bank-transactions', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    const query = request.query as {
      bankAccountId?: string;
      status?: 'unmatched' | 'matched' | 'categorized' | 'excluded';
      fromDate?: string;
      toDate?: string;
    };
    return ok(
      await createBankingService(app.supabase!).listTransactions(request.user!, {
        bankAccountId: query.bankAccountId,
        status: query.status,
        fromDate: query.fromDate,
        toDate: query.toDate,
      }),
    );
  });

  app.get(
    '/api/v1/finance/bank-transactions/:id',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createBankingService(app.supabase!).getTransaction(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/bank-transactions',
    { preHandler: [requirePermission(...managePerms)], schema: { body: manualTxnBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createBankingService(app.supabase!).createManualTransaction(
          request.user!,
          request.body as {
            bankAccountId: string;
            transactionDate: string;
            description?: string;
            reference?: string;
            transactionType: 'credit' | 'debit';
            amount: number;
            notes?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/bank-transactions/:id/match',
    { preHandler: [requirePermission(...managePerms)], schema: { body: matchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createBankingService(app.supabase!).matchTransaction(
          request.user!,
          id,
          request.body as {
            matchType: 'customer_payment' | 'vendor_payment' | 'expense' | 'expense_reimbursement' | 'transfer';
            matchId?: string;
            transferBankAccountId?: string;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/bank-transactions/:id/unmatch',
    { preHandler: [requirePermission(...managePerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createBankingService(app.supabase!).unmatchTransaction(request.user!, id, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/finance/bank-transactions/:id/categorize',
    { preHandler: [requirePermission(...managePerms)], schema: { body: categorizeBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createBankingService(app.supabase!).categorizeTransaction(
          request.user!,
          id,
          request.body as { categoryAccountId: string },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/bank-transactions/:id/exclude',
    { preHandler: [requirePermission(...managePerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createBankingService(app.supabase!).excludeTransaction(request.user!, id, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/finance/bank-transactions/:id/unexclude',
    { preHandler: [requirePermission(...managePerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createBankingService(app.supabase!).unexcludeTransaction(request.user!, id, metaOf(request)));
    },
  );

  app.get(
    '/api/v1/finance/bank-transactions/:id/match-candidates',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      const query = request.query as { bankAccountId?: string };
      const service = createBankingService(app.supabase!);
      const txn = await service.getTransaction(request.user!, id);
      const bankAccountId = query.bankAccountId ?? txn.bankAccountId;
      return ok(
        await service.listMatchCandidates(request.user!, {
          bankAccountId,
          transactionId: id,
        }),
      );
    },
  );

  // --- CSV import ---
  app.post(
    '/api/v1/finance/bank-imports',
    { preHandler: [requirePermission(...managePerms)], schema: { body: importBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createBankingService(app.supabase!).importStatementCsv(
          request.user!,
          request.body as { bankAccountId: string; filename?: string; csvText: string },
          metaOf(request),
        ),
      );
    },
  );

  // --- Reconciliation ---
  app.get(
    '/api/v1/finance/bank-reconciliation',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const query = request.query as {
        bankAccountId?: string;
        asOfDate?: string;
        statementEndingBalance?: string;
      };
      if (!query.bankAccountId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'bankAccountId is required.', 400);
      }
      if (!query.asOfDate) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'asOfDate is required.', 400);
      }
      if (query.statementEndingBalance === undefined || query.statementEndingBalance === '') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'statementEndingBalance is required.', 400);
      }
      return ok(
        await createBankingService(app.supabase!).getReconciliationReport(request.user!, {
          bankAccountId: query.bankAccountId,
          asOfDate: query.asOfDate,
          statementEndingBalance: Number(query.statementEndingBalance),
        }),
      );
    },
  );

  app.get(
    '/api/v1/finance/bank-reconciliations',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      return ok(await createBankingService(app.supabase!).listReconciliations(request.user!));
    },
  );

  app.post(
    '/api/v1/finance/bank-reconciliations',
    { preHandler: [requirePermission(...managePerms)], schema: { body: reconciliationSaveBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createBankingService(app.supabase!).saveReconciliation(
          request.user!,
          request.body as {
            bankAccountId: string;
            statementDate: string;
            statementEndingBalance: number;
            notes?: string;
            complete?: boolean;
          },
          metaOf(request),
        ),
      );
    },
  );
}
