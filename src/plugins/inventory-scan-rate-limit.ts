import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import {
  hitRateLimit,
  INVENTORY_SCAN_RATE_MAX,
  INVENTORY_SCAN_RATE_WINDOW_MS,
  INVENTORY_SCAN_TOKEN_RATE_MAX,
  INVENTORY_SCAN_TOKEN_RATE_WINDOW_MS,
} from '../shared/rate-limit';

const ipHits = new Map();
const tokenHits = new Map();

function isInventoryScanIssuePost(method: string, urlPath: string): boolean {
  if (method !== 'POST') return false;
  // /api/v1/inventory/public/scan/:token/issue
  // /api/v1/inventory/public/scan/:token/plastic-issue
  return (
    /^\/api\/v1\/inventory\/public\/scan\/[^/]+\/issue$/.test(urlPath) ||
    /^\/api\/v1\/inventory\/public\/scan\/[^/]+\/plastic-issue$/.test(urlPath)
  );
}

export const inventoryScanRateLimitPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('preHandler', async (request) => {
    const urlPath = request.url.split('?')[0] ?? '';
    if (!isInventoryScanIssuePost(request.method, urlPath)) {
      return;
    }

    const ipKey = `inv-scan:ip:${request.ip || 'unknown'}`;
    hitRateLimit(
      ipHits,
      ipKey,
      Date.now(),
      INVENTORY_SCAN_RATE_WINDOW_MS,
      INVENTORY_SCAN_RATE_MAX,
      'Too many scan submissions from this network. Wait a few minutes and try again.',
    );

    const tokenKey = `inv-scan:path:${request.ip || 'unknown'}:${urlPath}`;
    hitRateLimit(
      tokenHits,
      tokenKey,
      Date.now(),
      INVENTORY_SCAN_TOKEN_RATE_WINDOW_MS,
      INVENTORY_SCAN_TOKEN_RATE_MAX,
      'Too many submissions for this label. Wait a moment and try again.',
    );
  });
});
