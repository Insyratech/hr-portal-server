import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createWorkPermissionService } from './service';
import type { WorkPermissionStatus } from './types';

const applyBody = Type.Object({
  permissionDate: Type.String({ minLength: 10 }),
  minutes: Type.Literal(60),
  slot: Type.Union([Type.Literal('START'), Type.Literal('END')]),
  reason: Type.Optional(Type.String()),
});

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export async function registerWorkPermissionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/work-permissions/me',
    { preHandler: [requirePermission(PERMISSIONS.WORK_PERMISSION_APPLY)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      return ok(await createWorkPermissionService(app.supabase).listMine(request.user));
    },
  );

  app.get(
    '/api/v1/work-permissions',
    {
      preHandler: [
        requirePermission(PERMISSIONS.WORK_PERMISSION_APPROVE, PERMISSIONS.USERS_VIEW),
      ],
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const query = request.query as { status?: WorkPermissionStatus };
      return ok(await createWorkPermissionService(app.supabase).listQueue(request.user, query.status));
    },
  );

  app.post(
    '/api/v1/work-permissions',
    { preHandler: [requirePermission(PERMISSIONS.WORK_PERMISSION_APPLY)], schema: { body: applyBody } },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const body = request.body as { permissionDate: string; minutes: 60; slot: 'START' | 'END'; reason?: string };
      return ok(await createWorkPermissionService(app.supabase).apply(request.user, body, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/work-permissions/:id/approve',
    { preHandler: [requirePermission(PERMISSIONS.WORK_PERMISSION_APPROVE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      return ok(await createWorkPermissionService(app.supabase).decide(request.user, id, 'approve', metaOf(request)));
    },
  );

  app.post(
    '/api/v1/work-permissions/:id/reject',
    { preHandler: [requirePermission(PERMISSIONS.WORK_PERMISSION_APPROVE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      return ok(await createWorkPermissionService(app.supabase).decide(request.user, id, 'reject', metaOf(request)));
    },
  );
}
