import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { isAuthConfigured, type Env } from '../config/env';
import { API_ERROR_CODES } from '../shared/constants/error-codes';
import { AppError } from '../shared/errors/app-error';
import type { RequestUser } from '../shared/types/request-user';
import { resolveRequestUser } from '../modules/auth/resolve-request-user';
import { verifyAccessToken } from '../modules/auth/verify-access-token';

declare module 'fastify' {
  interface FastifyRequest {
    user: RequestUser | null;
  }
}

function readBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  return token;
}

export const authPlugin = fp(async (app: FastifyInstance, env: Env) => {
  app.decorateRequest('user', null);

  app.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
    request.user = null;

    if (!request.url.startsWith('/api/v1')) {
      return;
    }

    const token = readBearerToken(request.headers.authorization);
    if (!token) {
      return;
    }

    if (!isAuthConfigured(env) || !app.supabase) {
      throw new AppError(
        API_ERROR_CODES.SERVICE_UNAVAILABLE,
        'Authentication is not configured.',
        503,
      );
    }

    const payload = await verifyAccessToken(token, {
      jwtSecret: env.SUPABASE_JWT_SECRET,
      supabaseUrl: env.SUPABASE_URL,
    });
    request.user = await resolveRequestUser(app.supabase, payload.sub, payload.email);
  });
});
