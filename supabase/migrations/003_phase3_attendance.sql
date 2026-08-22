-- Phase 3 attendance engine. Apply in the Supabase SQL editor after 002_phase2_leave.sql.

create table if not exists public.shifts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  start_time time not null,
  end_time time not null,
  minimum_duration_minutes integer not null check (minimum_duration_minutes > 0),
  grace_period_minutes integer not null default 0 check (grace_period_minutes >= 0),
  late_threshold_minutes integer not null default 0 check (late_threshold_minutes >= 0),
  early_exit_threshold_minutes integer not null default 0 check (early_exit_threshold_minutes >= 0),
  flexible boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shift_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  shift_id uuid not null references public.shifts (id) on delete restrict,
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  unique (employee_id, effective_from)
);

create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  attendance_date date not null,
  shift_id uuid references public.shifts (id) on delete set null,
  scheduled_in timestamptz,
  scheduled_out timestamptz,
  actual_in timestamptz,
  actual_out timestamptz,
  worked_minutes integer,
  status text not null check (
    status in ('PRESENT', 'ABSENT', 'LATE', 'HALF_DAY', 'LEAVE', 'HOLIDAY', 'WEEK_OFF', 'MISSING_PUNCH')
  ),
  late_minutes integer not null default 0,
  early_exit_minutes integer not null default 0,
  overtime_minutes integer not null default 0,
  punch_in_latitude double precision,
  punch_in_longitude double precision,
  punch_out_latitude double precision,
  punch_out_longitude double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, attendance_date)
);

create table if not exists public.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  attendance_date date not null,
  proposed_in timestamptz not null,
  proposed_out timestamptz not null,
  reason text not null,
  status text not null check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  actor_id uuid references public.employees (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shift_assignments_employee_id_idx on public.shift_assignments (employee_id);
create index if not exists attendance_records_date_idx on public.attendance_records (attendance_date);
create index if not exists attendance_records_status_idx on public.attendance_records (status);
create index if not exists attendance_corrections_status_idx on public.attendance_corrections (status);

drop trigger if exists shifts_set_updated_at on public.shifts;
create trigger shifts_set_updated_at
  before update on public.shifts
  for each row execute procedure public.set_updated_at();

drop trigger if exists attendance_records_set_updated_at on public.attendance_records;
create trigger attendance_records_set_updated_at
  before update on public.attendance_records
  for each row execute procedure public.set_updated_at();

drop trigger if exists attendance_corrections_set_updated_at on public.attendance_corrections;
create trigger attendance_corrections_set_updated_at
  before update on public.attendance_corrections
  for each row execute procedure public.set_updated_at();

alter table public.shifts enable row level security;
alter table public.shift_assignments enable row level security;
alter table public.attendance_records enable row level security;
alter table public.attendance_corrections enable row level security;

drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts for select to authenticated using (auth.uid() is not null);
drop policy if exists shifts_write on public.shifts;
create policy shifts_write on public.shifts for all to authenticated
  using (public.authorize('shifts.manage')) with check (public.authorize('shifts.manage'));

drop policy if exists shift_assignments_select on public.shift_assignments;
create policy shift_assignments_select on public.shift_assignments for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('shifts.manage')
    or public.authorize('attendance.view')
  );
drop policy if exists shift_assignments_write on public.shift_assignments;
create policy shift_assignments_write on public.shift_assignments for all to authenticated
  using (public.authorize('shifts.manage')) with check (public.authorize('shifts.manage'));

drop policy if exists attendance_records_select on public.attendance_records;
create policy attendance_records_select on public.attendance_records for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('attendance.view')
  );

drop policy if exists attendance_corrections_select on public.attendance_corrections;
create policy attendance_corrections_select on public.attendance_corrections for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('attendance.correct')
  );

grant all on public.shifts, public.shift_assignments, public.attendance_records, public.attendance_corrections
  to service_role;

insert into public.shifts (
  id, name, start_time, end_time, minimum_duration_minutes, grace_period_minutes,
  late_threshold_minutes, early_exit_threshold_minutes, flexible, active
) values
  (
    '00000000-0000-4000-8000-000000000401',
    'Flexible 9H',
    '08:00',
    '20:00',
    540,
    0,
    0,
    0,
    true,
    true
  ),
  (
    '00000000-0000-4000-8000-000000000402',
    'Morning',
    '08:00',
    '17:00',
    540,
    10,
    60,
    30,
    false,
    true
  ),
  (
    '00000000-0000-4000-8000-000000000403',
    'General',
    '09:00',
    '18:00',
    540,
    10,
    60,
    30,
    false,
    true
  )
on conflict (name) do nothing;

notify pgrst, 'reload schema';
