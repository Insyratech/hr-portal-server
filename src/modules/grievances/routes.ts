import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth, requirePermission } from '../../plugins/permissions';
import { requireSupabase } from '../leave/support';
import { createGrievanceService } from './service';
import type { CommentVisibility, GrievanceCategory } from './transitions';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

const createBody = Type.Object({
  category: Type.Union([
    Type.Literal('WORKPLACE'),
    Type.Literal('SALARY'),
    Type.Literal('MANAGER'),
    Type.Literal('ATTENDANCE'),
    Type.Literal('POLICY'),
    Type.Literal('OTHER'),
  ]),
  subject: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
});

export async function registerGrievanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/grievances', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const query = request.query as { status?: string };
    return ok(await createGrievanceService(supabase).list(request.user, query.status));
  });

  app.post(
    '/api/v1/grievances',
    { preHandler: [requirePermission(PERMISSIONS.GRIEVANCE_CREATE)], schema: { body: createBody } },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = request.body as { category: GrievanceCategory; subject: string; description: string };
      return ok(await createGrievanceService(supabase).create(request.user, body, metaOf(request)));
    },
  );

  app.get('/api/v1/grievances/:id', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    return ok(await createGrievanceService(supabase).get(request.user, id));
  });

  app.post('/api/v1/grievances/:id/comments', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    const body = request.body as { body: string; visibility?: CommentVisibility };
    return ok(await createGrievanceService(supabase).addComment(request.user, id, body, metaOf(request)));
  });

  app.post(
    '/api/v1/grievances/:id/assign',
    { preHandler: [requirePermission(PERMISSIONS.GRIEVANCES_MANAGE)] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = request.body as { assigneeId: string };
      return ok(await createGrievanceService(supabase).assign(request.user, id, body.assigneeId, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/grievances/:id/status',
    { preHandler: [requirePermission(PERMISSIONS.GRIEVANCES_MANAGE)] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = request.body as { status: string };
      return ok(await createGrievanceService(supabase).changeStatus(request.user, id, body.status, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/grievances/:id/resolve',
    { preHandler: [requirePermission(PERMISSIONS.GRIEVANCES_MANAGE)] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = request.body as { resolution: string };
      return ok(await createGrievanceService(supabase).resolve(request.user, id, body.resolution, metaOf(request)));
    },
  );

  app.post('/api/v1/grievances/:id/attachments', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    const body = request.body as { fileName: string; contentType: string; sizeBytes: number };
    return ok(await createGrievanceService(supabase).createAttachmentUpload(request.user, id, body, metaOf(request)));
  });

  app.get(
    '/api/v1/grievances/:id/attachments/:attachmentId/url',
    { preHandler: [requireAuth()] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id, attachmentId } = request.params as { id: string; attachmentId: string };
      return ok(await createGrievanceService(supabase).getAttachmentDownloadUrl(request.user, id, attachmentId));
    },
  );
}
