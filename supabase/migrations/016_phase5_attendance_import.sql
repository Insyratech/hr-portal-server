-- Phase 5 Excel attendance import + LOP review. Apply after 015_phase4_work_permissions.sql.

create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  period text not null unique check (period ~ '^\d{4}-\d{2}$'),
  status text not null check (status in ('DRAFT', 'PUBLISHED')),
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.attendance_imports (
  id uuid primary key default gen_random_uuid(),
  period text not null check (period ~ '^\d{4}-\d{2}$'),
  file_name text not null,
  uploaded_by uuid not null references public.employees (id) on delete restrict,
  status text not null check (
    status in ('UPLOADED', 'PARSED', 'IN_REVIEW', 'CONFIRMED', 'REJECTED')
  ),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.attendance_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.attendance_imports (id) on delete cascade,
  employee_code text not null,
  name text not null default '',
  attendance_date date not null,
  raw_in text,
  raw_out text,
  warnings jsonb not null default '[]'::jsonb,
  employee_id uuid references public.employees (id) on delete set null,
  match_status text not null check (
    match_status in ('MATCHED', 'UNMATCHED', 'DUPLICATE', 'NAME_MISMATCH')
  ),
  created_at timestamptz not null default now()
);

create table if not exists public.attendance_day_reviews (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.attendance_imports (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete restrict,
  attendance_date date not null,
  attendance_record_id uuid references public.attendance_records (id) on delete set null,
  status text not null,
  shift_name text,
  actual_in timestamptz,
  actual_out timestamptz,
  worked_minutes integer,
  late_minutes integer not null default 0,
  permission_minutes integer not null default 0,
  permission_covered boolean not null default false,
  leave_type_name text,
  leave_paid boolean,
  leave_duration text,
  proposed_lop numeric(4, 2),
  final_lop numeric(4, 2),
  hr_action text check (hr_action in ('FULL_LOP', 'HALF_LOP', 'NO_LOP', 'EXCLUDE')),
  reason text,
  needs_hr_decision boolean not null default false,
  skipped_from_lop boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (import_id, employee_id, attendance_date)
);

create index if not exists attendance_imports_period_idx on public.attendance_imports (period);
create index if not exists attendance_import_rows_import_id_idx on public.attendance_import_rows (import_id);
create index if not exists attendance_day_reviews_import_employee_idx
  on public.attendance_day_reviews (import_id, employee_id);

drop trigger if exists attendance_imports_set_updated_at on public.attendance_imports;
create trigger attendance_imports_set_updated_at
  before update on public.attendance_imports
  for each row execute procedure public.set_updated_at();

drop trigger if exists attendance_day_reviews_set_updated_at on public.attendance_day_reviews;
create trigger attendance_day_reviews_set_updated_at
  before update on public.attendance_day_reviews
  for each row execute procedure public.set_updated_at();

alter table public.payroll_runs enable row level security;
alter table public.attendance_imports enable row level security;
alter table public.attendance_import_rows enable row level security;
alter table public.attendance_day_reviews enable row level security;

drop policy if exists payroll_runs_select on public.payroll_runs;
create policy payroll_runs_select on public.payroll_runs for select to authenticated
  using (public.authorize('attendance.view') or public.authorize('attendance.manage') or public.authorize('payroll.view'));

drop policy if exists attendance_imports_select on public.attendance_imports;
create policy attendance_imports_select on public.attendance_imports for select to authenticated
  using (public.authorize('attendance.view') or public.authorize('attendance.manage'));

drop policy if exists attendance_import_rows_select on public.attendance_import_rows;
create policy attendance_import_rows_select on public.attendance_import_rows for select to authenticated
  using (public.authorize('attendance.view') or public.authorize('attendance.manage'));

drop policy if exists attendance_day_reviews_select on public.attendance_day_reviews;
create policy attendance_day_reviews_select on public.attendance_day_reviews for select to authenticated
  using (
    public.authorize('attendance.view')
    or public.authorize('attendance.manage')
    or exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

grant all on public.payroll_runs, public.attendance_imports, public.attendance_import_rows, public.attendance_day_reviews
  to service_role;

notify pgrst, 'reload schema';
