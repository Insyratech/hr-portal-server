import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { createCompanyService } from './service';

const createBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  address: Type.String(),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
});

const patchBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  address: Type.Optional(Type.String()),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
  logoStoragePath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const logoBody = Type.Object({
  fileName: Type.String({ minLength: 1 }),
  contentType: Type.String({ minLength: 1 }),
  sizeBytes: Type.Integer({ minimum: 1 }),
});

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export async function registerCompanyRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/companies',
    {
      preHandler: [
        requirePermission(
          PERMISSIONS.USERS_VIEW,
          PERMISSIONS.USERS_MANAGE,
          PERMISSIONS.COMPANIES_MANAGE,
          PERMISSIONS.PAYROLL_VIEW,
          PERMISSIONS.PAYROLL_MANAGE,
        ),
      ],
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      return ok(await createCompanyService(app.supabase).list(request.user));
    },
  );

  app.post(
    '/api/v1/companies',
    { preHandler: [requirePermission(PERMISSIONS.COMPANIES_MANAGE)], schema: { body: createBody } },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const body = request.body as { name: string; address: string; status?: 'active' | 'inactive' };
      return ok(await createCompanyService(app.supabase).create(request.user, body, metaOf(request)));
    },
  );

  app.get(
    '/api/v1/companies/:id',
    {
      preHandler: [
        requirePermission(
          PERMISSIONS.USERS_VIEW,
          PERMISSIONS.USERS_MANAGE,
          PERMISSIONS.COMPANIES_MANAGE,
          PERMISSIONS.PAYROLL_VIEW,
          PERMISSIONS.PAYROLL_MANAGE,
        ),
      ],
    },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      return ok(await createCompanyService(app.supabase).get(request.user, id));
    },
  );

  app.patch(
    '/api/v1/companies/:id',
    { preHandler: [requirePermission(PERMISSIONS.COMPANIES_MANAGE)], schema: { body: patchBody } },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      return ok(
        await createCompanyService(app.supabase).update(
          request.user,
          id,
          request.body as { name?: string; address?: string; status?: 'active' | 'inactive'; logoStoragePath?: string | null },
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/companies/:id/logo',
    { preHandler: [requirePermission(PERMISSIONS.COMPANIES_MANAGE)], schema: { body: logoBody } },
    async (request) => {
      if (!app.supabase || !request.user) {
        throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Database is not configured.', 503);
      }
      const { id } = request.params as { id: string };
      const body = request.body as { fileName: string; contentType: string; sizeBytes: number };
      return ok(await createCompanyService(app.supabase).createLogoUpload(request.user, id, body, metaOf(request)));
    },
  );
}
