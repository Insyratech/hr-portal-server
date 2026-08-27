import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth, requirePermission } from '../../plugins/permissions';
import { requireSupabase } from '../leave/support';
import { createPayrollService } from './service';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export async function registerPayrollRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/payroll/runs',
    { preHandler: [requirePermission(PERMISSIONS.PAYROLL_VIEW, PERMISSIONS.PAYROLL_MANAGE)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      return ok(await createPayrollService(requireSupabase(app.supabase)).listRuns(request.user));
    },
  );

  app.get(
    '/api/v1/payroll/imports',
    { preHandler: [requirePermission(PERMISSIONS.PAYROLL_MANAGE)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      return ok(await createPayrollService(requireSupabase(app.supabase)).listConfirmedImports(request.user));
    },
  );

  app.get(
    '/api/v1/payroll/runs/:id',
    { preHandler: [requirePermission(PERMISSIONS.PAYROLL_VIEW, PERMISSIONS.PAYROLL_MANAGE)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(await createPayrollService(requireSupabase(app.supabase)).getRun(request.user, id));
    },
  );

  app.post(
    '/api/v1/payroll/calculate',
    {
      preHandler: [requirePermission(PERMISSIONS.PAYROLL_MANAGE)],
      schema: { body: Type.Object({ importId: Type.String({ minLength: 1 }) }) },
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = request.body as { importId: string };
      return ok(await createPayrollService(requireSupabase(app.supabase)).calculate(request.user, body, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/payroll/runs/:id/publish',
    { preHandler: [requirePermission(PERMISSIONS.PAYROLL_MANAGE)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(await createPayrollService(requireSupabase(app.supabase)).publish(request.user, id, metaOf(request)));
    },
  );

  app.get('/api/v1/payroll/slips/me', { preHandler: [requireAuth()] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    return ok(await createPayrollService(requireSupabase(app.supabase)).listMine(request.user));
  });

  app.get('/api/v1/payroll/slips/:id', { preHandler: [requireAuth()] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    return ok(await createPayrollService(requireSupabase(app.supabase)).getSlip(request.user, id));
  });
}
