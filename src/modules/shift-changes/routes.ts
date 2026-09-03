import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth, requirePermission } from '../../plugins/permissions';
import { createShiftChangeService } from './service';
import type { ShiftChangeStatus } from './types';

const applyBody = Type.Object({
  startDate: Type.String({ minLength: 10 }),
  endDate: Type.String({ minLength: 10 }),
  requestedShiftId: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
  projectId: Type.Optional(Type.String()),
});

const decideBody = Type.Object({
  comment: Type.Optional(Type.String()),
});

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export async function registerShiftChangeRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/shift-changes/projects',
    { preHandler: [requirePermission(PERMISSIONS.SHIFT_CHANGE_APPLY)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      return ok(await createShiftChangeService(app.supabase).listProjects(request.user));
    },
  );

  app.get(
    '/api/v1/shift-changes/me',
    { preHandler: [requirePermission(PERMISSIONS.SHIFT_CHANGE_APPLY)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      return ok(await createShiftChangeService(app.supabase).listMine(request.user));
    },
  );

  app.get('/api/v1/shift-changes/lead-inbox', { preHandler: [requireAuth()] }, async (request) => {
    if (!app.supabase || !request.user) {
      throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
    }
    return ok(await createShiftChangeService(app.supabase).listLeadInbox(request.user));
  });

  app.get(
    '/api/v1/shift-changes',
    {
      preHandler: [
        requirePermission(
          PERMISSIONS.SHIFT_CHANGE_APPROVE,
          PERMISSIONS.SHIFT_CHANGE_VIEW,
          PERMISSIONS.USERS_VIEW,
        ),
      ],
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const query = request.query as { status?: ShiftChangeStatus };
      return ok(await createShiftChangeService(app.supabase).listQueue(request.user, query.status));
    },
  );

  app.get('/api/v1/shift-changes/:id', { preHandler: [requireAuth()] }, async (request) => {
    if (!app.supabase || !request.user) {
      throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
    }
    const { id } = request.params as { id: string };
    return ok(await createShiftChangeService(app.supabase).get(request.user, id));
  });

  app.post(
    '/api/v1/shift-changes',
    { preHandler: [requirePermission(PERMISSIONS.SHIFT_CHANGE_APPLY)], schema: { body: applyBody } },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const body = request.body as {
        startDate: string;
        endDate: string;
        requestedShiftId: string;
        reason: string;
        projectId?: string;
      };
      return ok(await createShiftChangeService(app.supabase).apply(request.user, body, metaOf(request)));
    },
  );

  app.post('/api/v1/shift-changes/:id/project-lead-accept', { preHandler: [requireAuth()] }, async (request) => {
    if (!app.supabase || !request.user) {
      throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
    }
    const { id } = request.params as { id: string };
    return ok(await createShiftChangeService(app.supabase).acceptProjectLead(request.user, id, metaOf(request)));
  });

  app.post(
    '/api/v1/shift-changes/:id/approve',
    { preHandler: [requirePermission(PERMISSIONS.SHIFT_CHANGE_APPROVE)], schema: { body: decideBody } },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { comment?: string };
      return ok(
        await createShiftChangeService(app.supabase).decide(request.user, id, 'approve', metaOf(request), body.comment),
      );
    },
  );

  app.post(
    '/api/v1/shift-changes/:id/reject',
    { preHandler: [requirePermission(PERMISSIONS.SHIFT_CHANGE_APPROVE)], schema: { body: decideBody } },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { comment?: string };
      return ok(
        await createShiftChangeService(app.supabase).decide(request.user, id, 'reject', metaOf(request), body.comment),
      );
    },
  );

  app.post('/api/v1/shift-changes/:id/cancel', { preHandler: [requireAuth()] }, async (request) => {
    if (!app.supabase || !request.user) {
      throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
    }
    const { id } = request.params as { id: string };
    return ok(await createShiftChangeService(app.supabase).cancel(request.user, id, metaOf(request)));
  });
}
