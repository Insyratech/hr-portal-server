-- Phase 3: weekly work-update PPT (employee Saturday wrap deck).
-- Late = submitted after Saturday 18:00 IST. Deadline = Saturday 23:59 IST.
-- Reminders Sat 20:00 / 22:00 IST if still missing after 18:00.
-- Cron: POST /api/v1/jobs/work/weekly-ppt-reminders  (x-cron-secret) at those IST hours.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'weekly-work-updates',
  'weekly-work-updates',
  false,
  1048576,
  array[
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/octet-stream'
  ]::text[]
)
on conflict (id) do update
set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.weekly_work_updates (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  week_start date not null,
  week_end date not null,
  storage_path text not null unique,
  original_file_name text not null,
  system_file_name text not null,
  content_type text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 1048576),
  upload_count integer not null default 1 check (upload_count between 1 and 2),
  submitted_at timestamptz not null default now(),
  late boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, week_start)
);

create index if not exists weekly_work_updates_employee_id_idx
  on public.weekly_work_updates (employee_id);
create index if not exists weekly_work_updates_week_start_idx
  on public.weekly_work_updates (week_start);

drop trigger if exists weekly_work_updates_set_updated_at on public.weekly_work_updates;
create trigger weekly_work_updates_set_updated_at
  before update on public.weekly_work_updates
  for each row execute procedure public.set_updated_at();

alter table public.weekly_work_updates enable row level security;

drop policy if exists weekly_work_updates_select on public.weekly_work_updates;
create policy weekly_work_updates_select on public.weekly_work_updates for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('work.view')
  );

alter table public.work_reminder_log
  drop constraint if exists work_reminder_log_reminder_kind_check;
alter table public.work_reminder_log
  add constraint work_reminder_log_reminder_kind_check
  check (
    reminder_kind in (
      'monday_priorities',
      'daily_update',
      'daily_update_second',
      'carry_forward',
      'weekly_ppt',
      'weekly_ppt_second'
    )
  );

grant all on public.weekly_work_updates to service_role;

comment on table public.weekly_work_updates is
  'Employee Saturday weekly wrap PPT. Max 2 uploads/week; 2nd replaces 1st. late = after Sat 18:00 IST.';

notify pgrst, 'reload schema';
