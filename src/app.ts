import cors from '@fastify/cors';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import { isSupabaseConfigured, type Env } from './config/env';
import { registerJobRoutes } from './jobs/routes';
import { registerAttendanceRoutes } from './modules/attendance/routes';
import { registerAuthRoutes } from './modules/auth/routes';
import { registerCompanyRoutes } from './modules/companies/routes';
import { registerDirectoryEditRequestRoutes } from './modules/employees/edit-request-routes';
import { registerEmployeeRoutes } from './modules/employees/routes';
import { registerGrievanceRoutes } from './modules/grievances/routes';
import { registerLeaveRoutes } from './modules/leave/routes';
import { registerNotificationRoutes } from './modules/notifications/routes';
import { registerWebPushRoutes } from './modules/web-push/routes';
import { registerOrganizationRoutes } from './modules/organization/routes';
import { registerPolicyRoutes } from './modules/policies/routes';
import { registerWorkPermissionRoutes } from './modules/work-permissions/routes';
import { registerShiftChangeRoutes } from './modules/shift-changes/routes';
import { registerWorkRoutes } from './modules/work/routes';
import { registerPayrollRoutes } from './modules/payroll/routes';
import { registerReportRoutes } from './modules/reports/routes';
import { authPlugin } from './plugins/auth';
import { errorHandlerPlugin } from './plugins/error-handler';
import { supabasePlugin } from './plugins/supabase';
import { uploadRateLimitPlugin } from './plugins/upload-rate-limit';

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
  await app.register(uploadRateLimitPlugin);

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
        phase: 8,
        supabaseConfigured: isSupabaseConfigured(env),
      },
      meta: {},
    }),
  );

  app.route({
    method: ['GET', 'HEAD'],
    url: '/',
    handler: async (request, reply) => {
      if (request.method === 'HEAD') {
        return reply.code(200).send();
      }
      return reply.code(200).send({ success: true, data: { status: 'ok' }, meta: {} });
    },
  });

  await registerAuthRoutes(app);
  await registerEmployeeRoutes(app);
  await registerDirectoryEditRequestRoutes(app);
  await registerCompanyRoutes(app);
  await registerOrganizationRoutes(app);
  await registerLeaveRoutes(app);
  await registerWorkPermissionRoutes(app);
  await registerShiftChangeRoutes(app);
  await registerWorkRoutes(app);
  await registerAttendanceRoutes(app);
  await registerGrievanceRoutes(app);
  await registerPolicyRoutes(app);
  await registerNotificationRoutes(app);
  await registerWebPushRoutes(app);
  await registerPayrollRoutes(app);
  await registerReportRoutes(app);
  await registerJobRoutes(app, env);

  return app;
}
