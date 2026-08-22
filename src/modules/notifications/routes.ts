import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth } from '../../plugins/permissions';
import { requireSupabase } from '../leave/support';
import { createNotificationService } from './service';

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/notifications', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const query = request.query as { unread?: string };
    return ok(await createNotificationService(supabase).list(request.user, query.unread === 'true'));
  });

  app.get('/api/v1/notifications/unread-count', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    return ok(await createNotificationService(supabase).unreadCount(request.user));
  });

  app.post('/api/v1/notifications/:id/read', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    return ok(await createNotificationService(supabase).markRead(request.user, id));
  });

  app.post('/api/v1/notifications/read-all', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    return ok(await createNotificationService(supabase).markAllRead(request.user));
  });
}
