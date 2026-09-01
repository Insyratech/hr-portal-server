import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth } from '../../plugins/permissions';
import { requireSupabase } from '../leave/support';
import { createPasswordResetService } from './password-reset';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/me', { preHandler: [requireAuth()] }, async (request) => {
    if (!request.user) {
      throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    }

    return ok({
      employeeId: request.user.employeeId,
      authUserId: request.user.authUserId,
      email: request.user.email,
      fullName: request.user.fullName,
      roles: request.user.roles,
      permissions: request.user.permissions,
    });
  });

  app.post(
    '/api/v1/auth/forgot-password',
    {
      schema: {
        body: Type.Object({
          email: Type.String({ minLength: 5, maxLength: 254 }),
          redirectTo: Type.Optional(Type.String({ minLength: 8, maxLength: 500 })),
        }),
      },
    },
    async (request) => {
      const body = request.body as { email: string; redirectTo?: string };
      const result = await createPasswordResetService(requireSupabase(app.supabase)).requestReset({
        email: body.email,
        redirectTo: body.redirectTo,
        ipAddress: request.ip,
      });
      return ok(result);
    },
  );
}
