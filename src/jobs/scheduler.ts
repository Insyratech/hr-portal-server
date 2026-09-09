import type { FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isSupabaseConfigured, type Env } from '../config/env';
import { isMailConfigured } from '../modules/notifications/mail';
import {
  runMondayPriorityReminders,
  runWeeklyPptCsoDigest,
  runWeeklyPptReminders,
  runWorkEveningReminders,
} from '../modules/work/work-jobs';

/**
 * How often the in-process runner ticks. Every job self-gates on the IST hour and claims each
 * send in work_reminder_log, so ticking more often than the reminder hours cannot duplicate mail —
 * it only makes a missed hour recoverable within a few minutes.
 */
const TICK_MS = 5 * 60 * 1000;

type WorkJobRun = {
  mondayPriorities: Awaited<ReturnType<typeof runMondayPriorityReminders>>;
  dailyUpdates: Awaited<ReturnType<typeof runWorkEveningReminders>>;
  weeklyPpt: Awaited<ReturnType<typeof runWeeklyPptReminders>>;
  weeklyPptDigest: Awaited<ReturnType<typeof runWeeklyPptCsoDigest>>;
};

/** One full reminder sweep. Shared by the scheduler tick and the cron HTTP route so both behave alike. */
export async function runWorkReminderJobs(supabase: SupabaseClient): Promise<WorkJobRun> {
  return {
    mondayPriorities: await runMondayPriorityReminders(supabase),
    dailyUpdates: await runWorkEveningReminders(supabase),
    weeklyPpt: await runWeeklyPptReminders(supabase),
    weeklyPptDigest: await runWeeklyPptCsoDigest(supabase),
  };
}

/**
 * Fires the work reminder jobs from inside the API process.
 *
 * The HTTP job routes stay available for an external scheduler; this exists so reminders do not
 * depend on one being configured. Set WORK_CRON_ENABLED=false to hand the schedule back to cron.
 */
export function startWorkJobScheduler(app: FastifyInstance, env: Env): void {
  if (!env.WORK_CRON_ENABLED || env.NODE_ENV === 'test' || !isSupabaseConfigured(env)) return;

  if (!isMailConfigured(env)) {
    // Said once at boot: otherwise every reminder is silently skipped with no clue why.
    app.log.warn(
      'Work reminders are scheduled but BREVO_API_KEY / BREVO_SENDER_EMAIL are unset — no reminder mail will be delivered.',
    );
  }

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    const supabase = app.supabase;
    if (!supabase) return;
    running = true;
    try {
      const result = await runWorkReminderJobs(supabase);
      const sent =
        result.mondayPriorities.sent +
        result.dailyUpdates.dailyReminders +
        result.dailyUpdates.carryForwardMails +
        result.weeklyPpt.sent +
        result.weeklyPptDigest.sent;
      if (sent > 0) {
        app.log.info({ workReminders: result }, 'Work reminder jobs sent notifications');
      }
    } catch (error) {
      // A scheduler tick must never take the API down.
      app.log.error({ err: error }, 'Work reminder jobs failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
  });

  void tick();
}
