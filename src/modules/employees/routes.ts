import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth, requirePermission } from '../../plugins/permissions';
import { listAuditLogs } from '../audit/write-audit-log';
import { createEmployeeRepository } from './repository';
import { employeeBody, employeePatchBody } from './schemas';
import { createEmployeeService } from './service';
import type { CreateEmployeeInput, EmployeeStatus, UpdateEmployeeInput } from './types';

function requestMeta(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

export async function registerEmployeeRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/employees',
    { preHandler: [requirePermission(PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE)] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }

      const query = request.query as { q?: string; status?: EmployeeStatus };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      const items = await service.list(request.user, {
        query: query.q,
        status: query.status,
      });

      return ok(items, { total: items.length });
    },
  );

  app.post(
    '/api/v1/employees',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)],
      schema: { body: employeeBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }

      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      const created = await service.create(
        request.user,
        request.body as CreateEmployeeInput,
        requestMeta(request),
      );
      return ok(created);
    },
  );

  app.get(
    '/api/v1/employees/:id',
    { preHandler: [requireAuth()] },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }

      const { id } = request.params as { id: string };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      return ok(await service.getById(request.user, id));
    },
  );

  app.patch(
    '/api/v1/employees/:id',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE)],
      schema: { body: employeePatchBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }

      const { id } = request.params as { id: string };
      const service = createEmployeeService(app.supabase, createEmployeeRepository(app.supabase));
      return ok(
        await service.update(
          request.user,
          id,
          request.body as UpdateEmployeeInput,
          requestMeta(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/employees/:id/audit',
    { preHandler: [requirePermission(PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE, PERMISSIONS.AUDIT_VIEW)] },
    async (request) => {
      if (!app.supabase) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }

      const { id } = request.params as { id: string };
      return ok(await listAuditLogs(app.supabase, { entityId: id, limit: 50 }));
    },
  );
}
