import type { FastifyReply, FastifyRequest } from 'fastify';
import { API_ERROR_CODES } from '../shared/constants/error-codes';
import type { Permission } from '../shared/constants/permissions';
import { AppError } from '../shared/errors/app-error';

export function requireAuth() {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    }
  };
}

export function requirePermission(...required: Permission[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    }

    const allowed = required.some((permission) => request.user?.permissions.includes(permission));
    if (!allowed) {
      throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You do not have permission to do that.', 403);
    }
  };
}
