-- Work & Priorities Phase 8: retention settings, archive, second reminder, legal hold.
-- Purge job: POST /api/v1/jobs/work/retention-purge  (x-cron-secret)
-- Retention is rolling days (90 / 180 / 365). Never a fixed “delete last month on the 10th.”

alter table public.organization_settings
  add column if not exists work_update_second_reminder_hour smallint,
  add column if not exists work_retention_days integer not null default 180,
  add column if not exists work_archive_before_delete boolean not null default true,
  add column if not exists work_notify_before_purge boolean not null default true,
  add column if not exists work_purge_notify_days_before integer not null default 7,
  add column if not exists work_legal_hold boolean not null default false;

alter table public.organization_settings
  drop constraint if exists organization_settings_work_update_second_reminder_hour_check;
alter table public.organization_settings
  add constraint organization_settings_work_update_second_reminder_hour_check
  check (work_update_second_reminder_hour is null or work_update_second_reminder_hour between 0 and 23);

alter table public.organization_settings
  drop constraint if exists organization_settings_work_retention_days_check;
alter table public.organization_settings
  add constraint organization_settings_work_retention_days_check
  check (work_retention_days in (90, 180, 365));

alter table public.organization_settings
  drop constraint if exists organization_settings_work_purge_notify_days_before_check;
alter table public.organization_settings
  add constraint organization_settings_work_purge_notify_days_before_check
  check (work_purge_notify_days_before between 1 and 30);

alter table public.work_reminder_log
  drop constraint if exists work_reminder_log_reminder_kind_check;
alter table public.work_reminder_log
  add constraint work_reminder_log_reminder_kind_check
  check (reminder_kind in ('monday_priorities', 'daily_update', 'daily_update_second', 'carry_forward'));

create table if not exists public.work_data_archive (
  id uuid primary key default gen_random_uuid(),
  archived_at timestamptz not null default now(),
  cutoff_date date not null,
  retention_days integer not null,
  source_table text not null,
  source_id uuid not null,
  employee_id uuid,
  anchor_date date,
  payload jsonb not null
);

create index if not exists work_data_archive_cutoff_idx on public.work_data_archive (cutoff_date);
create index if not exists work_data_archive_source_idx on public.work_data_archive (source_table, source_id);

create table if not exists public.work_purge_notices (
  cutoff_date date primary key,
  notified_at timestamptz not null default now(),
  retention_days integer not null,
  eligible_days integer not null default 0,
  eligible_plans integer not null default 0
);

insert into public.permissions (code, description) values
  ('work.settings', 'Configure work reminders, retention, and purge policy')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'work.settings'
where r.code = 'SUPER_ADMIN'
on conflict do nothing;

alter table public.work_data_archive enable row level security;
alter table public.work_purge_notices enable row level security;

drop policy if exists work_data_archive_select on public.work_data_archive;
create policy work_data_archive_select on public.work_data_archive for select to authenticated
  using (public.authorize('work.settings') or public.authorize('audit.view'));

drop policy if exists work_purge_notices_select on public.work_purge_notices;
create policy work_purge_notices_select on public.work_purge_notices for select to authenticated
  using (public.authorize('work.settings') or public.authorize('audit.view'));

grant all on public.work_data_archive, public.work_purge_notices to service_role;

--   01:00 daily  → POST /api/v1/jobs/work/retention-purge
--                  (archive then delete only rows past retention with no legal hold;
--                   notify Super Admins before purge when enabled; rolling cutoff, never “July on Aug 10”)

notify pgrst, 'reload schema';
