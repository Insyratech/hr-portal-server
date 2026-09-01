import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { hitRateLimit, UPLOAD_RATE_MAX, UPLOAD_RATE_WINDOW_MS } from '../shared/rate-limit';

const hits = new Map();

export const uploadRateLimitPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('preHandler', async (request) => {
    if (request.method !== 'POST' || request.url.split('?')[0] !== '/api/v1/attendance/imports') {
      return;
    }
    const key = request.user?.employeeId ?? request.ip;
    hitRateLimit(
      hits,
      key,
      Date.now(),
      UPLOAD_RATE_WINDOW_MS,
      UPLOAD_RATE_MAX,
      'Too many attendance uploads. Wait a few minutes and try again.',
    );
  });
});
