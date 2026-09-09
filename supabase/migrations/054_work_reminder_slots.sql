-- Daily work-update reminders move to three IST slots: 17:00, 20:00, 23:00.
-- Sunday weekly-PPT reminders are fixed in code at 18:00, 20:00, 22:00 IST.
-- The reminder log needs the new third-slot kinds before the jobs can claim them.

alter table public.organization_settings
  add column if not exists work_update_third_reminder_hour smallint;

alter table public.organization_settings
  drop constraint if exists organization_settings_work_update_third_reminder_hour_check;

alter table public.organization_settings
  add constraint organization_settings_work_update_third_reminder_hour_check
  check (work_update_third_reminder_hour is null or work_update_third_reminder_hour between 0 and 23);

alter table public.organization_settings
  alter column work_update_reminder_hour set default 17;

-- Deliberately overwrites the stored hours: the agreed schedule is 5 pm / 8 pm / 11 pm IST.
update public.organization_settings
set
  work_update_reminder_hour = 17,
  work_update_second_reminder_hour = 20,
  work_update_third_reminder_hour = 23
where true;

comment on column public.organization_settings.work_update_reminder_hour is
  'First daily work-update reminder hour in Asia/Kolkata (IST), 0–23. Default 17.';
comment on column public.organization_settings.work_update_second_reminder_hour is
  'Second daily reminder hour in Asia/Kolkata (IST). Default 20.';
comment on column public.organization_settings.work_update_third_reminder_hour is
  'Third daily reminder hour in Asia/Kolkata (IST). Default 23.';

alter table public.work_reminder_log
  drop constraint if exists work_reminder_log_reminder_kind_check;

alter table public.work_reminder_log
  add constraint work_reminder_log_reminder_kind_check
  check (
    reminder_kind in (
      'monday_priorities',
      'daily_update',
      'daily_update_second',
      'daily_update_third',
      'carry_forward',
      'weekly_ppt',
      'weekly_ppt_second',
      'weekly_ppt_third',
      'weekly_ppt_cso_digest'
    )
  );

comment on table public.work_reminder_log is
  'One row per employee per work_date per reminder slot. The primary key makes reminder sends idempotent, so the job runner may fire more often than the slot hours.';

notify pgrst, 'reload schema';
