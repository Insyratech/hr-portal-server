import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth } from '../../plugins/permissions';

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
}
