-- Work reminder idempotency + weekly snapshot (Phase 4).
-- Cron (header x-cron-secret), UTC until timezone is stored:
--   09:00  POST /api/v1/jobs/reminders/daily          leave + Monday priorities + mark yesterday Missing
--   {work_update_reminder_hour}:00  POST /api/v1/jobs/work/daily-reminders   one update reminder; last working day carry-forward + snapshot

alter table public.weekly_plans
  add column if not exists snapshot jsonb,
  add column if not exists snapshot_at timestamptz;

create table if not exists public.work_reminder_log (
  employee_id uuid not null references public.employees (id) on delete cascade,
  work_date date not null,
  reminder_kind text not null check (reminder_kind in ('monday_priorities', 'daily_update', 'carry_forward')),
  created_at timestamptz not null default now(),
  primary key (employee_id, work_date, reminder_kind)
);

alter table public.work_reminder_log enable row level security;

drop policy if exists work_reminder_log_select on public.work_reminder_log;
create policy work_reminder_log_select on public.work_reminder_log for select to authenticated
  using (
    public.authorize('work.view')
    or exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

grant all on public.work_reminder_log to service_role;

notify pgrst, 'reload schema';
