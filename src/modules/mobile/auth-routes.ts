import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth } from '../../plugins/permissions';
import { requireSupabase } from '../leave/support';
import { createMobileAuthService } from './auth-service';

function requestMeta(request: FastifyRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

const deviceIdBody = Type.Object({
  deviceId: Type.String({ minLength: 8, maxLength: 128 }),
});

const refreshBody = Type.Object({
  deviceId: Type.String({ minLength: 8, maxLength: 128 }),
  deviceRefreshSecret: Type.String({ minLength: 16, maxLength: 256 }),
});

export async function registerMobileAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/mobile/auth/credential',
    {
      preHandler: [requireAuth()],
      schema: { body: deviceIdBody },
    },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) {
        throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      }
      const { deviceId } = request.body as { deviceId: string };
      await createMobileAuthService(supabase).recordCredentialAuth(request.user.authUserId, deviceId);
      return ok({ recorded: true });
    },
  );

  app.post(
    '/api/v1/mobile/auth/enroll',
    {
      preHandler: [requireAuth()],
      schema: { body: deviceIdBody },
    },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) {
        throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      }
      const { deviceId } = request.body as { deviceId: string };
      const result = await createMobileAuthService(supabase).enroll(
        request.user.authUserId,
        deviceId,
        requestMeta(request),
      );
      return ok(result);
    },
  );

  app.post(
    '/api/v1/mobile/auth/refresh',
    {
      schema: { body: refreshBody },
    },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      const body = request.body as { deviceId: string; deviceRefreshSecret: string };
      const session = await createMobileAuthService(supabase).refresh(
        body.deviceId,
        body.deviceRefreshSecret,
        requestMeta(request),
      );
      return ok(session);
    },
  );

  app.delete(
    '/api/v1/mobile/auth/enroll',
    {
      preHandler: [requireAuth()],
      schema: { body: deviceIdBody },
    },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) {
        throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      }
      const { deviceId } = request.body as { deviceId: string };
      const result = await createMobileAuthService(supabase).revokeEnroll(
        request.user.authUserId,
        deviceId,
        requestMeta(request),
      );
      return ok(result);
    },
  );
}
