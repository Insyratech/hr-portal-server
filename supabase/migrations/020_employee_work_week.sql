-- Per-employee working week. Org working_days remains the default until a row exists.
-- Patterns: Sunday off; Sat+Sun off; Sunday off plus 2nd and 4th Saturday off.

create table if not exists public.employee_work_weeks (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  pattern text not null check (
    pattern in ('SUNDAY_OFF', 'WEEKEND_OFF', 'SECOND_FOURTH_SATURDAY')
  ),
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  unique (employee_id, effective_from)
);

create index if not exists employee_work_weeks_employee_id_idx on public.employee_work_weeks (employee_id);

alter table public.employee_work_weeks enable row level security;

drop policy if exists employee_work_weeks_select on public.employee_work_weeks;
create policy employee_work_weeks_select on public.employee_work_weeks for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('users.view')
    or public.authorize('shifts.manage')
    or public.authorize('attendance.view')
  );

drop policy if exists employee_work_weeks_write on public.employee_work_weeks;
create policy employee_work_weeks_write on public.employee_work_weeks for all to authenticated
  using (public.authorize('shifts.manage') or public.authorize('users.manage'))
  with check (public.authorize('shifts.manage') or public.authorize('users.manage'));

grant all on public.employee_work_weeks to service_role;

notify pgrst, 'reload schema';
