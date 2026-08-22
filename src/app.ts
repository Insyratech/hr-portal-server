import cors from '@fastify/cors';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import { isSupabaseConfigured, type Env } from './config/env';
import { registerJobRoutes } from './jobs/routes';
import { registerAttendanceRoutes } from './modules/attendance/routes';
import { registerAuthRoutes } from './modules/auth/routes';
import { registerEmployeeRoutes } from './modules/employees/routes';
import { registerGrievanceRoutes } from './modules/grievances/routes';
import { registerLeaveRoutes } from './modules/leave/routes';
import { registerNotificationRoutes } from './modules/notifications/routes';
import { registerOrganizationRoutes } from './modules/organization/routes';
import { registerPolicyRoutes } from './modules/policies/routes';
import { registerReportRoutes } from './modules/reports/routes';
import { authPlugin } from './plugins/auth';
import { errorHandlerPlugin } from './plugins/error-handler';
import { supabasePlugin } from './plugins/supabase';

const HEALTH_RESPONSE = Type.Object({
  success: Type.Literal(true),
  data: Type.Object({
    status: Type.Literal('ok'),
    service: Type.String(),
    phase: Type.Integer(),
    supabaseConfigured: Type.Boolean(),
  }),
  meta: Type.Object({}),
});

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV !== 'test',
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-cron-secret'],
  });
  await app.register(errorHandlerPlugin);
  await app.register(supabasePlugin, env);
  await app.register(authPlugin, env);

  app.get(
    '/health',
    {
      schema: {
        response: {
          200: HEALTH_RESPONSE,
        },
      },
    },
    async () => ({
      success: true as const,
      data: {
        status: 'ok' as const,
        service: 'hr-portal-api',
        phase: 6,
        supabaseConfigured: isSupabaseConfigured(env),
      },
      meta: {},
    }),
  );

  await registerAuthRoutes(app);
  await registerEmployeeRoutes(app);
  await registerOrganizationRoutes(app);
  await registerLeaveRoutes(app);
  await registerAttendanceRoutes(app);
  await registerGrievanceRoutes(app);
  await registerPolicyRoutes(app);
  await registerNotificationRoutes(app);
  await registerReportRoutes(app);
  await registerJobRoutes(app, env);

  return app;
}
