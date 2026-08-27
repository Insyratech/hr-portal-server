-- Phase 2: work reminder hours are Asia/Kolkata (IST).
-- Cron (header x-cron-secret), fire near these IST windows (cron may run in UTC — convert):
--   Mon 16:00 IST  POST /api/v1/jobs/work/monday-priorities
--   Daily 20:00 IST  POST /api/v1/jobs/work/daily-reminders   (primary)
--   Daily 22:00 IST  POST /api/v1/jobs/work/daily-reminders   (second)
--   Morning (e.g. 09:00 IST)  POST /api/v1/jobs/reminders/daily  leave + mark yesterday Missing
--     (Monday priorities inside that bundle only send when the clock is 16:00 IST.)

update public.organization_settings
set
  work_update_reminder_hour = coalesce(work_update_reminder_hour, 20),
  work_update_second_reminder_hour = coalesce(work_update_second_reminder_hour, 22)
where true;

comment on column public.organization_settings.work_update_reminder_hour is
  'Daily work-update reminder hour in Asia/Kolkata (IST), 0–23. Default 20.';
comment on column public.organization_settings.work_update_second_reminder_hour is
  'Optional second daily reminder hour in Asia/Kolkata (IST). Default 22.';
