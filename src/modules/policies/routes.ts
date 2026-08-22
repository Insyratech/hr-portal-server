import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth, requirePermission } from '../../plugins/permissions';
import { requireSupabase } from '../leave/support';
import { createPolicyService } from './service';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

const createBody = Type.Object({
  title: Type.String({ minLength: 1 }),
  content: Type.String({ minLength: 1 }),
  versionLabel: Type.Optional(Type.String()),
  effectiveDate: Type.Optional(Type.String()),
  acknowledgementRequired: Type.Optional(Type.Boolean()),
});

const publishBody = Type.Object({
  content: Type.Optional(Type.String({ minLength: 1 })),
  versionLabel: Type.Optional(Type.String()),
  effectiveDate: Type.Optional(Type.String()),
  acknowledgementRequired: Type.Optional(Type.Boolean()),
});

export async function registerPolicyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/policies', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    return ok(await createPolicyService(supabase).list(request.user));
  });

  app.get('/api/v1/policies/:id', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    return ok(await createPolicyService(supabase).get(request.user, id));
  });

  app.post(
    '/api/v1/policies',
    { preHandler: [requirePermission(PERMISSIONS.POLICIES_MANAGE)], schema: { body: createBody } },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = request.body as {
        title: string;
        content: string;
        versionLabel?: string;
        effectiveDate?: string;
        acknowledgementRequired?: boolean;
      };
      return ok(await createPolicyService(supabase).create(request.user, body, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/policies/:id/publish',
    { preHandler: [requirePermission(PERMISSIONS.POLICIES_MANAGE)], schema: { body: publishBody } },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as {
        content?: string;
        versionLabel?: string;
        effectiveDate?: string;
        acknowledgementRequired?: boolean;
      };
      return ok(await createPolicyService(supabase).publish(request.user, id, body, metaOf(request)));
    },
  );

  app.post('/api/v1/policies/:id/acknowledge', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    return ok(await createPolicyService(supabase).acknowledge(request.user, id, metaOf(request)));
  });

  app.get(
    '/api/v1/policies/:id/acknowledgements',
    { preHandler: [requirePermission(PERMISSIONS.POLICIES_MANAGE, PERMISSIONS.REPORTS_VIEW)] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const query = request.query as { version?: string };
      return ok(await createPolicyService(supabase).acknowledgementReport(request.user, id, query.version));
    },
  );
}
