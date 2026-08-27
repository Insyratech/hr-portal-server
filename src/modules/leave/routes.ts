import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth, requirePermission } from '../../plugins/permissions';
import { parsePolicyRules } from './parse-rules';
import { createLeaveApplicationService } from './application-service';
import { createLeaveCatalogService } from './catalog-service';
import { requireSupabase } from './support';
import type { LeaveDuration } from './types';

const applicationBody = Type.Object({
  leaveTypeId: Type.String({ minLength: 1 }),
  startDate: Type.String({ minLength: 10 }),
  endDate: Type.String({ minLength: 10 }),
  duration: Type.Union([Type.Literal('full'), Type.Literal('half')]),
  reason: Type.Optional(Type.String()),
  handover: Type.Optional(Type.String()),
  handoverEmployeeId: Type.Optional(Type.String()),
  attachmentUrl: Type.Optional(Type.String()),
});

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export async function registerLeaveRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/leaves/balance', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    return ok(await createLeaveApplicationService(supabase).listBalances(request.user));
  });

  app.get('/api/v1/leaves/applications', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const query = request.query as { status?: string };
    return ok(await createLeaveApplicationService(supabase).listApplications(request.user, query.status));
  });

  app.post(
    '/api/v1/leaves/applications',
    { preHandler: [requireAuth()], schema: { body: applicationBody } },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = request.body as {
        leaveTypeId: string;
        startDate: string;
        endDate: string;
        duration: LeaveDuration;
        reason?: string;
        handover?: string;
        handoverEmployeeId?: string;
        attachmentUrl?: string;
      };
      return ok(await createLeaveApplicationService(supabase).apply(request.user, body, metaOf(request)));
    },
  );

  app.patch(
    '/api/v1/leaves/applications/:id',
    { preHandler: [requireAuth()], schema: { body: applicationBody } },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = request.body as {
        leaveTypeId: string;
        startDate: string;
        endDate: string;
        duration: LeaveDuration;
        reason?: string;
        handover?: string;
        handoverEmployeeId?: string;
        attachmentUrl?: string;
      };
      return ok(await createLeaveApplicationService(supabase).update(request.user, id, body, metaOf(request)));
    },
  );

  app.get('/api/v1/leaves/applications/:id', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    return ok(await createLeaveApplicationService(supabase).getApplication(request.user, id));
  });

  app.post('/api/v1/leaves/applications/:id/cancel', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    return ok(await createLeaveApplicationService(supabase).decide(request.user, id, 'cancel', undefined, metaOf(request)));
  });

  app.post(
    '/api/v1/leaves/:id/approve',
    { preHandler: [requirePermission(PERMISSIONS.LEAVE_APPROVE)] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { comment?: string };
      return ok(await createLeaveApplicationService(supabase).decide(request.user, id, 'approve', body.comment, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/leaves/:id/reject',
    { preHandler: [requirePermission(PERMISSIONS.LEAVE_APPROVE)] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { comment?: string };
      return ok(await createLeaveApplicationService(supabase).decide(request.user, id, 'reject', body.comment, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/leaves/:id/request-changes',
    { preHandler: [requirePermission(PERMISSIONS.LEAVE_APPROVE)] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { comment?: string };
      return ok(
        await createLeaveApplicationService(supabase).requestChanges(request.user, id, body.comment ?? '', metaOf(request)),
      );
    },
  );

  app.post('/api/v1/leaves/:id/handover-accept', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    return ok(await createLeaveApplicationService(supabase).acceptHandover(request.user, id, metaOf(request)));
  });

  app.get('/api/v1/leave-colleagues', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    return ok(
      await createLeaveApplicationService(supabase).listColleagues(
        request.user,
        (request.query as { startDate?: string }).startDate,
        (request.query as { endDate?: string }).endDate,
      ),
    );
  });

  app.get('/api/v1/leave-types', { preHandler: [requireAuth()] }, async () => {
    return ok(await createLeaveCatalogService(requireSupabase(app.supabase)).listTypes());
  });

  app.post('/api/v1/leave-types', { preHandler: [requirePermission(PERMISSIONS.LEAVE_TYPES_MANAGE)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    return ok(
      await createLeaveCatalogService(requireSupabase(app.supabase)).createType(
        request.user,
        request.body as Record<string, unknown>,
        metaOf(request),
      ),
    );
  });

  app.patch('/api/v1/leave-types/:id', { preHandler: [requirePermission(PERMISSIONS.LEAVE_TYPES_MANAGE)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    return ok(
      await createLeaveCatalogService(requireSupabase(app.supabase)).updateType(
        request.user,
        id,
        request.body as Record<string, unknown>,
        metaOf(request),
      ),
    );
  });

  app.get('/api/v1/leave-policies', { preHandler: [requireAuth()] }, async () => {
    return ok(await createLeaveCatalogService(requireSupabase(app.supabase)).listPolicies());
  });

  app.post('/api/v1/leave-policies', { preHandler: [requirePermission(PERMISSIONS.LEAVE_POLICIES_MANAGE)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const body = request.body as { name: string; leaveTypeId: string; rules: Record<string, unknown> };
    return ok(
      await createLeaveCatalogService(requireSupabase(app.supabase)).createPolicy(
        request.user,
        { name: body.name, leaveTypeId: body.leaveTypeId, rules: parsePolicyRules(body.rules) },
        metaOf(request),
      ),
    );
  });

  app.post(
    '/api/v1/leave-policies/:id/versions',
    { preHandler: [requirePermission(PERMISSIONS.LEAVE_POLICIES_MANAGE)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = request.body as { rules: Record<string, unknown> };
      return ok(
        await createLeaveCatalogService(requireSupabase(app.supabase)).addVersion(
          request.user,
          id,
          parsePolicyRules(body.rules),
          metaOf(request),
        ),
      );
    },
  );

  app.post(
    '/api/v1/leave-policies/:id/publish',
    { preHandler: [requirePermission(PERMISSIONS.LEAVE_POLICIES_MANAGE)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(await createLeaveCatalogService(requireSupabase(app.supabase)).publish(request.user, id, metaOf(request)));
    },
  );

  app.get('/api/v1/leave-allocations', { preHandler: [requirePermission(PERMISSIONS.LEAVE_ALLOCATIONS_MANAGE, PERMISSIONS.USERS_VIEW)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const query = request.query as { employeeId?: string };
    return ok(
      await createLeaveCatalogService(requireSupabase(app.supabase)).listAllocations(request.user, {
        employeeId: query.employeeId,
      }),
    );
  });

  app.post('/api/v1/leave-allocations', { preHandler: [requirePermission(PERMISSIONS.LEAVE_ALLOCATIONS_MANAGE)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const body = request.body as { employeeId: string; leaveTypeId: string; allocated: number; period?: string };
    return ok(
      await createLeaveCatalogService(requireSupabase(app.supabase)).createAllocation(request.user, body, metaOf(request)),
    );
  });

  app.patch('/api/v1/leave-allocations/:id', { preHandler: [requirePermission(PERMISSIONS.LEAVE_ALLOCATIONS_MANAGE)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    const body = request.body as { allocated?: number; adjustment?: number };
    if (typeof body.allocated === 'number') {
      return ok(
        await createLeaveCatalogService(requireSupabase(app.supabase)).setAllocated(
          request.user,
          id,
          body.allocated,
          metaOf(request),
        ),
      );
    }
    return ok(
      await createLeaveCatalogService(requireSupabase(app.supabase)).adjustAllocation(
        request.user,
        id,
        body.adjustment ?? 0,
        metaOf(request),
      ),
    );
  });

  app.delete('/api/v1/leave-allocations/:id', { preHandler: [requirePermission(PERMISSIONS.LEAVE_ALLOCATIONS_MANAGE)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    await createLeaveCatalogService(requireSupabase(app.supabase)).deleteAllocation(request.user, id, metaOf(request));
    return ok({ id });
  });

  app.get('/api/v1/holidays', { preHandler: [requireAuth()] }, async () => {
    return ok(await createLeaveCatalogService(requireSupabase(app.supabase)).listHolidays());
  });

  app.post('/api/v1/holidays', { preHandler: [requirePermission(PERMISSIONS.SYSTEM_MANAGE)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const body = request.body as { name: string; date: string; type?: string; region?: string; optional?: boolean };
    return ok(await createLeaveCatalogService(requireSupabase(app.supabase)).createHoliday(request.user, body, metaOf(request)));
  });

  app.patch('/api/v1/holidays/:id', { preHandler: [requirePermission(PERMISSIONS.SYSTEM_MANAGE)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; date?: string; type?: string; region?: string; optional?: boolean };
    return ok(
      await createLeaveCatalogService(requireSupabase(app.supabase)).updateHoliday(request.user, id, body, metaOf(request)),
    );
  });
}
