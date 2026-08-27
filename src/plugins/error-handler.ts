import { API_ERROR_CODES } from '../shared/constants/error-codes';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../shared/errors/app-error';

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(statusCode).send({
    success: false,
    error: { code, message },
  });
}

export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler(
    (
      error: Error & { statusCode?: number; validation?: unknown },
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      request.log.error(error);

      if (error instanceof AppError) {
        return sendError(reply, error.statusCode, error.code, error.message);
      }

      if (error.validation) {
        return sendError(reply, 400, API_ERROR_CODES.VALIDATION_ERROR, error.message);
      }

      const statusCode = error.statusCode ?? 500;
      const message = statusCode >= 500 ? 'An unexpected error occurred.' : error.message;

      return sendError(
        reply,
        statusCode,
        statusCode === 401
          ? API_ERROR_CODES.UNAUTHORIZED
          : statusCode === 403
            ? API_ERROR_CODES.FORBIDDEN
            : statusCode === 404
              ? API_ERROR_CODES.NOT_FOUND
              : statusCode === 429
                ? API_ERROR_CODES.RATE_LIMITED
                : API_ERROR_CODES.INTERNAL_ERROR,
        message,
      );
    },
  );
});
