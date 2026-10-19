import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createCompOffWorkService } from './service';
import type { CompOffWorkStatus } from './types';

const applyBody = Type.Object({
  workDate: Type.String({ minLength: 10 }),
  leaveApplicationId: Type.String({ minLength: 1 }),
  leaveDate: Type.String({ minLength: 10 }),
  reason: Type.Optional(Type.String()),
});

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export async function registerCompOffWorkRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/comp-off-work/me',
    { preHandler: [requirePermission(PERMISSIONS.COMP_OFF_APPLY)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      return ok(await createCompOffWorkService(app.supabase).listMine(request.user));
    },
  );

  app.get(
    '/api/v1/comp-off-work/eligible-leaves',
    { preHandler: [requirePermission(PERMISSIONS.COMP_OFF_APPLY)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const query = request.query as { month?: string };
      const month = query.month?.trim() || new Date().toISOString().slice(0, 7);
      return ok(await createCompOffWorkService(app.supabase).listEligibleLeaves(request.user, month));
    },
  );

  app.get(
    '/api/v1/comp-off-work',
    {
      preHandler: [requirePermission(PERMISSIONS.COMP_OFF_APPROVE, PERMISSIONS.USERS_VIEW)],
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const query = request.query as { status?: CompOffWorkStatus };
      return ok(await createCompOffWorkService(app.supabase).listQueue(request.user, query.status));
    },
  );

  app.post(
    '/api/v1/comp-off-work',
    { preHandler: [requirePermission(PERMISSIONS.COMP_OFF_APPLY)], schema: { body: applyBody } },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const body = request.body as {
        workDate: string;
        leaveApplicationId: string;
        leaveDate: string;
        reason?: string;
      };
      return ok(await createCompOffWorkService(app.supabase).apply(request.user, body, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/comp-off-work/:id/approve',
    { preHandler: [requirePermission(PERMISSIONS.COMP_OFF_APPROVE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      return ok(await createCompOffWorkService(app.supabase).decide(request.user, id, 'approve', metaOf(request)));
    },
  );

  app.post(
    '/api/v1/comp-off-work/:id/reject',
    { preHandler: [requirePermission(PERMISSIONS.COMP_OFF_APPROVE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      return ok(await createCompOffWorkService(app.supabase).decide(request.user, id, 'reject', metaOf(request)));
    },
  );

  app.post(
    '/api/v1/comp-off-work/:id/cancel',
    {
      preHandler: [requirePermission(PERMISSIONS.COMP_OFF_APPLY)],
      schema: { params: Type.Object({ id: Type.String({ minLength: 1 }) }) },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      return ok(await createCompOffWorkService(app.supabase).cancel(request.user, id, metaOf(request)));
    },
  );
}
