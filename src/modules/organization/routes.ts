import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth, requirePermission } from '../../plugins/permissions';
import { listAuditLogs } from '../audit/write-audit-log';
import { createOrganizationService } from './service';

const namedBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  code: Type.String({ minLength: 1 }),
});

const namedPatchBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  code: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
});

const settingsPatchBody = Type.Object({
  workingDays: Type.Array(Type.String({ minLength: 3, maxLength: 3 }), { minItems: 1 }),
});

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export async function registerOrganizationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/departments', { preHandler: [requireAuth()] }, async () => {
    if (!app.supabase) {
      throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
    }
    return ok(await createOrganizationService(app.supabase).listDepartments());
  });

  app.post(
    '/api/v1/departments',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE, PERMISSIONS.SYSTEM_MANAGE)],
      schema: { body: namedBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const body = request.body as { name: string; code: string };
      return ok(
        await createOrganizationService(app.supabase).createDepartment(
          request.user.employeeId,
          body,
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/departments/:id',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE, PERMISSIONS.SYSTEM_MANAGE)],
      schema: { body: namedPatchBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      return ok(
        await createOrganizationService(app.supabase).updateDepartment(
          request.user.employeeId,
          id,
          request.body as { name?: string; code?: string; status?: 'active' | 'inactive' },
          metaOf(request),
        ),
      );
    },
  );

  app.get('/api/v1/designations', { preHandler: [requireAuth()] }, async () => {
    if (!app.supabase) {
      throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
    }
    return ok(await createOrganizationService(app.supabase).listDesignations());
  });

  app.post(
    '/api/v1/designations',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE, PERMISSIONS.SYSTEM_MANAGE)],
      schema: { body: namedBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const body = request.body as { name: string; code: string };
      return ok(
        await createOrganizationService(app.supabase).createDesignation(
          request.user.employeeId,
          body,
          metaOf(request),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/designations/:id',
    {
      preHandler: [requirePermission(PERMISSIONS.USERS_MANAGE, PERMISSIONS.SYSTEM_MANAGE)],
      schema: { body: namedPatchBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      return ok(
        await createOrganizationService(app.supabase).updateDesignation(
          request.user.employeeId,
          id,
          request.body as { name?: string; code?: string; status?: 'active' | 'inactive' },
          metaOf(request),
        ),
      );
    },
  );

  app.get('/api/v1/roles', { preHandler: [requireAuth()] }, async () => {
    if (!app.supabase) {
      throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
    }
    return ok(await createOrganizationService(app.supabase).listRoles());
  });

  app.get('/api/v1/organization/settings', { preHandler: [requireAuth()] }, async () => {
    if (!app.supabase) {
      throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
    }
    return ok(await createOrganizationService(app.supabase).getSettings());
  });

  app.patch(
    '/api/v1/organization/settings',
    {
      preHandler: [requirePermission(PERMISSIONS.SYSTEM_MANAGE)],
      schema: { body: settingsPatchBody },
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const body = request.body as { workingDays: string[] };
      return ok(
        await createOrganizationService(app.supabase).updateSettings(
          request.user.employeeId,
          body.workingDays,
          metaOf(request),
        ),
      );
    },
  );

  app.get(
    '/api/v1/audit-logs',
    { preHandler: [requirePermission(PERMISSIONS.AUDIT_VIEW, PERMISSIONS.USERS_MANAGE)] },
    async (request) => {
      if (!app.supabase) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const query = request.query as { entityId?: string };
      return ok(await listAuditLogs(app.supabase, { entityId: query.entityId, limit: 100 }));
    },
  );
}
