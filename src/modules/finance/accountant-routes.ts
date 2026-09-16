import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createAccountantService } from './accountant-service';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function requireDb(app: FastifyInstance, request: { user?: unknown }) {
  if (!app.supabase || !request.user) {
    throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
  }
}

const journalLineBody = Type.Object({
  accountId: Type.String({ format: 'uuid' }),
  description: Type.Optional(Type.String()),
  debit: Type.Number({ minimum: 0 }),
  credit: Type.Number({ minimum: 0 }),
});

const journalCreateBody = Type.Object({
  entryDate: Type.String({ minLength: 10 }),
  memo: Type.Optional(Type.String()),
  lines: Type.Array(journalLineBody, { minItems: 2 }),
  post: Type.Optional(Type.Boolean()),
});

const journalPatchBody = Type.Object({
  entryDate: Type.Optional(Type.String({ minLength: 10 })),
  memo: Type.Optional(Type.String()),
  lines: Type.Optional(Type.Array(journalLineBody, { minItems: 2 })),
});

const openingLineBody = Type.Object({
  accountId: Type.String({ format: 'uuid' }),
  debit: Type.Number({ minimum: 0 }),
  credit: Type.Number({ minimum: 0 }),
});

const openingCreateBody = Type.Object({
  asOfDate: Type.String({ minLength: 10 }),
  memo: Type.Optional(Type.String()),
  lines: Type.Array(openingLineBody, { minItems: 2 }),
});

const openingPatchBody = Type.Object({
  asOfDate: Type.Optional(Type.String({ minLength: 10 })),
  memo: Type.Optional(Type.String()),
  lines: Type.Optional(Type.Array(openingLineBody, { minItems: 2 })),
});

const periodLockBody = Type.Object({
  periodYear: Type.Integer({ minimum: 2000, maximum: 2100 }),
  periodMonth: Type.Integer({ minimum: 1, maximum: 12 }),
  notes: Type.Optional(Type.String()),
});

const viewPerms = [
  PERMISSIONS.FINANCE_ACCOUNTANT_VIEW,
  PERMISSIONS.FINANCE_ACCOUNTANT_MANAGE,
  PERMISSIONS.FINANCE_COA_VIEW,
  PERMISSIONS.FINANCE_COA_MANAGE,
] as const;

const managePerms = [PERMISSIONS.FINANCE_ACCOUNTANT_MANAGE] as const;

export async function registerFinanceAccountantRoutes(app: FastifyInstance): Promise<void> {
  // --- Journals ---
  app.get('/api/v1/finance/journals', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    const query = request.query as { fromDate?: string; toDate?: string; status?: 'draft' | 'posted' | 'reversed' };
    return ok(
      await createAccountantService(app.supabase!).listJournals(request.user!, {
        fromDate: query.fromDate,
        toDate: query.toDate,
        status: query.status,
      }),
    );
  });

  app.get('/api/v1/finance/journals/:id', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    const { id } = request.params as { id: string };
    return ok(await createAccountantService(app.supabase!).getJournal(request.user!, id));
  });

  app.post(
    '/api/v1/finance/journals',
    { preHandler: [requirePermission(...managePerms)], schema: { body: journalCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createAccountantService(app.supabase!).createManualJournal(
          request.user!,
          request.body as {
            entryDate: string;
            memo?: string;
            lines: Array<{ accountId: string; description?: string; debit: number; credit: number }>;
            post?: boolean;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/finance/journals/:id',
    { preHandler: [requirePermission(...managePerms)], schema: { body: journalPatchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createAccountantService(app.supabase!).updateManualJournal(
          request.user!,
          id,
          request.body as {
            entryDate?: string;
            memo?: string;
            lines?: Array<{ accountId: string; description?: string; debit: number; credit: number }>;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/journals/:id/post',
    { preHandler: [requirePermission(...managePerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createAccountantService(app.supabase!).postManualJournal(request.user!, id, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/finance/journals/:id/reverse',
    { preHandler: [requirePermission(...managePerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createAccountantService(app.supabase!).reverseJournal(request.user!, id, metaOf(request)));
    },
  );

  // --- General ledger & trial balance ---
  app.get('/api/v1/finance/ledger', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    const query = request.query as { accountId?: string; fromDate?: string; toDate?: string };
    if (!query.accountId) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'accountId is required.', 400);
    }
    return ok(
      await createAccountantService(app.supabase!).getGeneralLedger(request.user!, {
        accountId: query.accountId,
        fromDate: query.fromDate,
        toDate: query.toDate,
      }),
    );
  });

  app.get('/api/v1/finance/trial-balance', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    const query = request.query as { asOfDate?: string };
    if (!query.asOfDate) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'asOfDate is required.', 400);
    }
    return ok(await createAccountantService(app.supabase!).getTrialBalance(request.user!, { asOfDate: query.asOfDate }));
  });

  // --- Period locks ---
  app.get('/api/v1/finance/period-locks', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createAccountantService(app.supabase!).listPeriodLocks(request.user!));
  });

  app.post(
    '/api/v1/finance/period-locks',
    { preHandler: [requirePermission(...managePerms)], schema: { body: periodLockBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createAccountantService(app.supabase!).lockPeriod(
          request.user!,
          request.body as { periodYear: number; periodMonth: number; notes?: string },
          metaOf(request),
        ),
      );
    },
  );

  app.delete(
    '/api/v1/finance/period-locks/:year/:month',
    { preHandler: [requirePermission(...managePerms)] },
    async (request) => {
      requireDb(app, request);
      const { year, month } = request.params as { year: string; month: string };
      return ok(
        await createAccountantService(app.supabase!).unlockPeriod(
          request.user!,
          { periodYear: Number(year), periodMonth: Number(month) },
          metaOf(request),
        ),
      );
    },
  );

  // --- Opening balances ---
  app.get('/api/v1/finance/opening-balances', { preHandler: [requirePermission(...viewPerms)] }, async (request) => {
    requireDb(app, request);
    return ok(await createAccountantService(app.supabase!).listOpeningBalanceSets(request.user!));
  });

  app.get(
    '/api/v1/finance/opening-balances/:id',
    { preHandler: [requirePermission(...viewPerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(await createAccountantService(app.supabase!).getOpeningBalanceSet(request.user!, id));
    },
  );

  app.post(
    '/api/v1/finance/opening-balances',
    { preHandler: [requirePermission(...managePerms)], schema: { body: openingCreateBody } },
    async (request) => {
      requireDb(app, request);
      return ok(
        await createAccountantService(app.supabase!).createOpeningBalanceSet(
          request.user!,
          request.body as {
            asOfDate: string;
            memo?: string;
            lines: Array<{ accountId: string; debit: number; credit: number }>;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/finance/opening-balances/:id',
    { preHandler: [requirePermission(...managePerms)], schema: { body: openingPatchBody } },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createAccountantService(app.supabase!).updateOpeningBalanceSet(
          request.user!,
          id,
          request.body as {
            asOfDate?: string;
            memo?: string;
            lines?: Array<{ accountId: string; debit: number; credit: number }>;
          },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/opening-balances/:id/post',
    { preHandler: [requirePermission(...managePerms)] },
    async (request) => {
      requireDb(app, request);
      const { id } = request.params as { id: string };
      return ok(
        await createAccountantService(app.supabase!).postOpeningBalanceSet(request.user!, id, metaOf(request)),
      );
    },
  );
}
