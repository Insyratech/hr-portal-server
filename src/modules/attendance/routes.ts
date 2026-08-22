import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth, requirePermission } from '../../plugins/permissions';
import { requireSupabase } from '../leave/support';
import { createAttendanceService } from './service';
import { createShiftService } from './shift-service';

const locationBody = Type.Object({
  latitude: Type.Optional(Type.Number()),
  longitude: Type.Optional(Type.Number()),
});

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export async function registerAttendanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/attendance/me', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const query = request.query as { date?: string };
    return ok(await createAttendanceService(supabase).getMine(request.user, query.date));
  });

  app.post(
    '/api/v1/attendance/punch-in',
    { preHandler: [requireAuth()], schema: { body: locationBody } },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = (request.body ?? {}) as { latitude?: number; longitude?: number };
      return ok(await createAttendanceService(supabase).punchIn(request.user, body, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/attendance/punch-out',
    { preHandler: [requireAuth()], schema: { body: locationBody } },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = (request.body ?? {}) as { latitude?: number; longitude?: number };
      return ok(await createAttendanceService(supabase).punchOut(request.user, body, metaOf(request)));
    },
  );

  app.get(
    '/api/v1/attendance',
    { preHandler: [requirePermission(PERMISSIONS.ATTENDANCE_VIEW, PERMISSIONS.ATTENDANCE_MANAGE)] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const query = request.query as { date?: string };
      return ok(await createAttendanceService(supabase).listForDate(request.user, query.date));
    },
  );

  app.post('/api/v1/attendance/corrections', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const body = request.body as { date: string; proposedIn: string; proposedOut: string; reason: string };
    return ok(await createAttendanceService(supabase).submitCorrection(request.user, body, metaOf(request)));
  });

  app.get('/api/v1/attendance/corrections', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const query = request.query as { status?: string };
    return ok(await createAttendanceService(supabase).listCorrections(request.user, query.status));
  });

  app.post(
    '/api/v1/attendance/corrections/:id/approve',
    { preHandler: [requirePermission(PERMISSIONS.ATTENDANCE_CORRECT, PERMISSIONS.ATTENDANCE_MANAGE)] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(await createAttendanceService(supabase).decideCorrection(request.user, id, 'approve', metaOf(request)));
    },
  );

  app.post(
    '/api/v1/attendance/corrections/:id/reject',
    { preHandler: [requirePermission(PERMISSIONS.ATTENDANCE_CORRECT, PERMISSIONS.ATTENDANCE_MANAGE)] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(await createAttendanceService(supabase).decideCorrection(request.user, id, 'reject', metaOf(request)));
    },
  );

  app.get('/api/v1/shifts', { preHandler: [requireAuth()] }, async () => {
    return ok(await createShiftService(requireSupabase(app.supabase)).list());
  });

  app.post('/api/v1/shifts', { preHandler: [requirePermission(PERMISSIONS.SHIFTS_MANAGE)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const body = request.body as {
      name: string;
      startTime: string;
      endTime: string;
      minimumDurationMinutes: number;
      gracePeriodMinutes?: number;
      lateThresholdMinutes?: number;
      earlyExitThresholdMinutes?: number;
      flexible?: boolean;
    };
    return ok(await createShiftService(requireSupabase(app.supabase)).create(request.user, body, metaOf(request)));
  });

  app.patch('/api/v1/shifts/:id', { preHandler: [requirePermission(PERMISSIONS.SHIFTS_MANAGE)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const { id } = request.params as { id: string };
    return ok(
      await createShiftService(requireSupabase(app.supabase)).update(
        request.user,
        id,
        request.body as Record<string, unknown>,
        metaOf(request),
      ),
    );
  });

  app.get('/api/v1/shift-assignments', { preHandler: [requirePermission(PERMISSIONS.SHIFTS_MANAGE)] }, async () => {
    return ok(await createShiftService(requireSupabase(app.supabase)).listAssignments());
  });

  app.post('/api/v1/shift-assignments', { preHandler: [requirePermission(PERMISSIONS.SHIFTS_MANAGE)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const body = request.body as { employeeId: string; shiftId: string; effectiveFrom?: string };
    return ok(await createShiftService(requireSupabase(app.supabase)).assign(request.user, body, metaOf(request)));
  });
}
