import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createEditRequestBody, decideEditRequestBody } from './edit-request-schemas';
import { createDirectoryEditRequestService, type EditRequestStatus } from './edit-requests';

function requestMeta(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

export async function registerDirectoryEditRequestRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/directory-edit-requests',
    { preHandler: [requirePermission(PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const query = request.query as { status?: EditRequestStatus };
      const service = createDirectoryEditRequestService(app.supabase);
      const items = await service.list(request.user, query.status);
      return ok(items, { total: items.length });
    },
  );

  app.get(
    '/api/v1/directory-edit-requests/for-employee/:employeeId',
    { preHandler: [requirePermission(PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { employeeId } = request.params as { employeeId: string };
      const service = createDirectoryEditRequestService(app.supabase);
      return ok(await service.getForTarget(request.user, employeeId));
    },
  );

  app.post(
    '/api/v1/directory-edit-requests',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_VIEW)],
      schema: { body: createEditRequestBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const body = request.body as {
        targetEmployeeId: string;
        reason: string;
        fieldHints?: string | null;
      };
      const service = createDirectoryEditRequestService(app.supabase);
      return ok(await service.create(request.user, body, requestMeta(request)));
    },
  );

  app.post(
    '/api/v1/directory-edit-requests/:id/approve',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)],
      schema: { body: decideEditRequestBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const body = request.body as { note?: string | null; unlockHours?: number };
      const service = createDirectoryEditRequestService(app.supabase);
      return ok(await service.approve(request.user, id, body, requestMeta(request)));
    },
  );

  app.post(
    '/api/v1/directory-edit-requests/:id/reject',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)],
      schema: { body: decideEditRequestBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const body = request.body as { note?: string | null };
      const service = createDirectoryEditRequestService(app.supabase);
      return ok(await service.reject(request.user, id, body, requestMeta(request)));
    },
  );

  app.post(
    '/api/v1/directory-edit-requests/:id/cancel',
    { preHandler: [requirePermission(PERMISSIONS.USERS_VIEW)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const service = createDirectoryEditRequestService(app.supabase);
      return ok(await service.cancel(request.user, id, requestMeta(request)));
    },
  );

  app.post(
    '/api/v1/directory-edit-requests/:id/fulfill',
    { preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const service = createDirectoryEditRequestService(app.supabase);
      return ok(await service.fulfill(request.user, id, requestMeta(request)));
    },
  );
}
