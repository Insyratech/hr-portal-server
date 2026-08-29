import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth } from '../../plugins/permissions';
import { requireSupabase } from '../leave/support';
import { createWebPushService } from './service';
import type { WebPushSubscribeInput } from './types';

function requestMeta(request: FastifyRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

const subscribeBody = Type.Object({
  endpoint: Type.String({ minLength: 8, maxLength: 2048 }),
  keys: Type.Object({
    p256dh: Type.String({ minLength: 8, maxLength: 256 }),
    auth: Type.String({ minLength: 8, maxLength: 256 }),
  }),
});

const unsubscribeBody = Type.Object({
  endpoint: Type.String({ minLength: 8, maxLength: 2048 }),
});

export async function registerWebPushRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/web-push/subscribe',
    {
      preHandler: [requireAuth()],
      schema: { body: subscribeBody },
    },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) {
        throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      }

      const body = request.body as WebPushSubscribeInput;
      const result = await createWebPushService(supabase).subscribe(
        request.user.authUserId,
        body,
        requestMeta(request),
      );
      return ok(result);
    },
  );

  app.delete(
    '/api/v1/web-push/subscribe',
    {
      preHandler: [requireAuth()],
      schema: { body: unsubscribeBody },
    },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) {
        throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      }

      const { endpoint } = request.body as { endpoint: string };
      const result = await createWebPushService(supabase).revoke(
        request.user.authUserId,
        endpoint,
        requestMeta(request),
      );
      return ok(result);
    },
  );
}
