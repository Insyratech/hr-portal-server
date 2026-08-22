import type { FastifyInstance } from 'fastify';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/ok';
import { requirePermission } from '../../plugins/permissions';
import { requireSupabase } from '../leave/support';
import { createReportService } from './service';

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/reports/overview',
    { preHandler: [requirePermission(PERMISSIONS.REPORTS_VIEW, PERMISSIONS.SYSTEM_MANAGE)] },
    async (request) => {
      const supabase = requireSupabase(app.supabase);
      if (!request.user) throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.', 401);
      const query = request.query as { from?: string; to?: string; period?: string };
      return ok(await createReportService(supabase).overview(request.user, query));
    },
  );
}
