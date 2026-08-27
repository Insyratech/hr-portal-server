import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requireAuth, requirePermission } from '../../plugins/permissions';
import { requireSupabase } from '../leave/support';
import { createAttendanceImportService } from './import/service';
import { createAttendanceService } from './service';
import { createShiftService } from './shift-service';
import type { HrAction } from './import/lop-proposal';

function metaOf(request: { ip: string; headers: { 'user-agent'?: string } }) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

const uploadBody = Type.Object({
  period: Type.String({ minLength: 7, maxLength: 7 }),
  fileName: Type.String({ minLength: 1 }),
  contentBase64: Type.String({ minLength: 8 }),
});

const decideBody = Type.Object({
  action: Type.Union([
    Type.Literal('FULL_LOP'),
    Type.Literal('HALF_LOP'),
    Type.Literal('NO_LOP'),
    Type.Literal('EXCLUDE'),
  ]),
  reason: Type.Optional(Type.String()),
});

export async function registerAttendanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/attendance/me', { preHandler: [requireAuth()] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const query = request.query as { period?: string };
    return ok(await createAttendanceService(supabase).getMine(request.user, query.period));
  });

  app.get(
    '/api/v1/attendance',
    { preHandler: [requirePermission(PERMISSIONS.ATTENDANCE_MANAGE, PERMISSIONS.USERS_VIEW)] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const query = request.query as { date?: string };
      return ok(await createAttendanceService(supabase).listForDate(request.user, query.date));
    },
  );

  app.get(
    '/api/v1/attendance/imports',
    { preHandler: [requirePermission(PERMISSIONS.ATTENDANCE_MANAGE, PERMISSIONS.USERS_VIEW)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      return ok(await createAttendanceImportService(requireSupabase(app.supabase)).list(request.user));
    },
  );

  app.post(
    '/api/v1/attendance/imports',
    {
      preHandler: [requirePermission(PERMISSIONS.ATTENDANCE_MANAGE)],
      schema: { body: uploadBody },
      bodyLimit: 15_000_000,
    },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const body = request.body as { period: string; fileName: string; contentBase64: string };
      return ok(await createAttendanceImportService(requireSupabase(app.supabase)).upload(request.user, body, metaOf(request)));
    },
  );

  app.get(
    '/api/v1/attendance/imports/:id',
    { preHandler: [requirePermission(PERMISSIONS.ATTENDANCE_MANAGE, PERMISSIONS.USERS_VIEW)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(await createAttendanceImportService(requireSupabase(app.supabase)).get(request.user, id));
    },
  );

  app.get(
    '/api/v1/attendance/imports/:id/employees/:employeeId',
    { preHandler: [requirePermission(PERMISSIONS.ATTENDANCE_MANAGE, PERMISSIONS.USERS_VIEW)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id, employeeId } = request.params as { id: string; employeeId: string };
      return ok(await createAttendanceImportService(requireSupabase(app.supabase)).getCard(request.user, id, employeeId));
    },
  );

  app.post(
    '/api/v1/attendance/reviews/:id/decide',
    { preHandler: [requirePermission(PERMISSIONS.ATTENDANCE_MANAGE)], schema: { body: decideBody } },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      const body = request.body as { action: HrAction; reason?: string };
      return ok(await createAttendanceImportService(requireSupabase(app.supabase)).decideDay(request.user, id, body, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/attendance/imports/:id/confirm',
    { preHandler: [requirePermission(PERMISSIONS.ATTENDANCE_MANAGE)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(await createAttendanceImportService(requireSupabase(app.supabase)).confirm(request.user, id, metaOf(request)));
    },
  );

  app.post(
    '/api/v1/attendance/imports/:id/reject',
    { preHandler: [requirePermission(PERMISSIONS.ATTENDANCE_MANAGE)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(await createAttendanceImportService(requireSupabase(app.supabase)).reject(request.user, id, metaOf(request)));
    },
  );

  app.delete(
    '/api/v1/attendance/imports/:id',
    { preHandler: [requirePermission(PERMISSIONS.ATTENDANCE_MANAGE)] },
    async (request) => {
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const { id } = request.params as { id: string };
      return ok(await createAttendanceImportService(requireSupabase(app.supabase)).remove(request.user, id, metaOf(request)));
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

  app.get('/api/v1/shift-assignments', { preHandler: [requirePermission(PERMISSIONS.SHIFTS_MANAGE, PERMISSIONS.USERS_VIEW, PERMISSIONS.ATTENDANCE_VIEW)] }, async () => {
    return ok(await createShiftService(requireSupabase(app.supabase)).listAssignments());
  });

  app.post('/api/v1/shift-assignments', { preHandler: [requirePermission(PERMISSIONS.SHIFTS_MANAGE)] }, async (request) => {
    if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
    const body = request.body as { employeeId: string; shiftId: string; effectiveFrom?: string };
    return ok(await createShiftService(requireSupabase(app.supabase)).assign(request.user, body, metaOf(request)));
  });
}
