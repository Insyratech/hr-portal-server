import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Env } from '../config/env';
import { API_ERROR_CODES } from '../shared/constants/error-codes';
import { AppError } from '../shared/errors/app-error';
import { ok } from '../shared/http/ok';
import { requireSupabase } from '../modules/leave/support';
import { finalizeAttendanceForDate } from './attendance-finalize';
import { yesterdayIso } from './attendance-finalize-helpers';
import { runAnnualLeaveAllocation, runDailyReminders } from './leave-jobs';

function requireCronSecret(env: Env) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!env.CRON_SECRET) {
      throw new AppError(API_ERROR_CODES.SERVICE_UNAVAILABLE, 'Cron secret is not configured.', 503);
    }
    const header = request.headers['x-cron-secret'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided || provided !== env.CRON_SECRET) {
      throw new AppError(API_ERROR_CODES.UNAUTHORIZED, 'Invalid cron secret.', 401);
    }
  };
}

export async function registerJobRoutes(app: FastifyInstance, env: Env): Promise<void> {
  const cronAuth = requireCronSecret(env);

  app.post('/api/v1/jobs/attendance/finalize', { preHandler: [cronAuth] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    const body = (request.body ?? {}) as { date?: string };
    const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : yesterdayIso();
    return ok(await finalizeAttendanceForDate(supabase, date));
  });

  app.post('/api/v1/jobs/reminders/daily', { preHandler: [cronAuth] }, async () => {
    const supabase = requireSupabase(app.supabase);
    return ok(await runDailyReminders(supabase));
  });

  app.post('/api/v1/jobs/leave/annual-allocation', { preHandler: [cronAuth] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    const body = (request.body ?? {}) as { period?: string };
    const period = body.period && /^\d{4}$/.test(body.period) ? body.period : undefined;
    return ok(await runAnnualLeaveAllocation(supabase, period));
  });

  /** Alias: annual allocation already applies carry-forward / expiry per policy. */
  app.post('/api/v1/jobs/leave/carry-forward', { preHandler: [cronAuth] }, async (request) => {
    const supabase = requireSupabase(app.supabase);
    const body = (request.body ?? {}) as { period?: string };
    const period = body.period && /^\d{4}$/.test(body.period) ? body.period : undefined;
    return ok(await runAnnualLeaveAllocation(supabase, period));
  });
}
