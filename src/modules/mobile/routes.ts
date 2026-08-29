import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth } from '../../plugins/permissions';
import { requireSupabase } from '../leave/support';
import { createMobileDeviceService } from './service';
import type { RegisterMobileDeviceInput } from './types';

const registerBody = Type.Object({
  deviceId: Type.String({ minLength: 8, maxLength: 128 }),
  platform: Type.Union([Type.Literal('android'), Type.Literal('ios')]),
  pushToken: Type.String({ minLength: 8, maxLength: 512 }),
  appVersion: Type.Optional(Type.String({ maxLength: 32 })),
});

export async function registerMobileRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/mobile/devices/register',
    {
      preHandler: [requireAuth()],
      schema: { body: registerBody },
    },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) {
        throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      }

      const body = request.body as RegisterMobileDeviceInput;
      const device = await createMobileDeviceService(supabase).register(request.user.authUserId, body);
      return ok(device);
    },
  );

  app.delete(
    '/api/v1/mobile/devices/:deviceId',
    { preHandler: [requireAuth()] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) {
        throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      }

      const { deviceId } = request.params as { deviceId: string };
      const result = await createMobileDeviceService(supabase).revoke(request.user.authUserId, deviceId);
      return ok(result);
    },
  );

  app.get('/api/v1/mobile/devices/me', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) {
      throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    }

    const devices = await createMobileDeviceService(supabase).listMine(request.user.authUserId);
    return ok(devices);
  });
}
