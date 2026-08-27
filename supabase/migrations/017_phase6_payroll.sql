-- Phase 6 payroll runs + frozen salary slips. Apply after 016_phase5_attendance_import.sql.

alter table public.payroll_runs
  add column if not exists attendance_import_id uuid references public.attendance_imports (id) on delete restrict,
  add column if not exists calculated_at timestamptz,
  add column if not exists calculated_by uuid references public.employees (id) on delete set null,
  add column if not exists published_by uuid references public.employees (id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

alter table public.payroll_runs drop constraint if exists payroll_runs_status_check;
alter table public.payroll_runs
  add constraint payroll_runs_status_check
  check (status in ('DRAFT', 'CALCULATED', 'PUBLISHED'));

create table if not exists public.salary_slips (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete restrict,
  employee_code text not null,
  employee_name text not null,
  designation_name text,
  department_name text,
  company_name text not null,
  company_address text not null,
  company_logo_path text,
  pan_masked text,
  bank_account_masked text,
  bank_name_masked text,
  ifsc_masked text,
  basic numeric(12, 2) not null default 0,
  da numeric(12, 2) not null default 0,
  hra numeric(12, 2) not null default 0,
  fuel numeric(12, 2) not null default 0,
  incentives numeric(12, 2) not null default 0,
  other_earnings numeric(12, 2) not null default 0,
  professional_tax numeric(12, 2) not null default 0,
  tds numeric(12, 2) not null default 0,
  employee_welfare numeric(12, 2) not null default 0,
  kpi numeric(12, 2) not null default 0,
  other_deductions numeric(12, 2) not null default 0,
  calendar_days integer not null,
  gross numeric(12, 2) not null,
  daily_rate numeric(12, 2) not null,
  lop_days numeric(8, 2) not null,
  lop_amount numeric(12, 2) not null,
  net numeric(12, 2) not null,
  particulars jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, employee_id)
);

create index if not exists salary_slips_employee_id_idx on public.salary_slips (employee_id);
create index if not exists payroll_runs_import_id_idx on public.payroll_runs (attendance_import_id);

drop trigger if exists payroll_runs_set_updated_at on public.payroll_runs;
create trigger payroll_runs_set_updated_at
  before update on public.payroll_runs
  for each row execute procedure public.set_updated_at();

alter table public.salary_slips enable row level security;

drop policy if exists payroll_runs_select on public.payroll_runs;
create policy payroll_runs_select on public.payroll_runs for select to authenticated
  using (public.authorize('payroll.view') or public.authorize('payroll.manage'));

drop policy if exists salary_slips_select on public.salary_slips;
create policy salary_slips_select on public.salary_slips for select to authenticated
  using (
    public.authorize('payroll.view')
    or public.authorize('payroll.manage')
    or exists (
      select 1 from public.employees e
      join public.payroll_runs r on r.id = run_id
      where e.id = employee_id
        and e.user_id = auth.uid()
        and r.status = 'PUBLISHED'
    )
  );

grant all on public.payroll_runs, public.salary_slips to service_role;

notify pgrst, 'reload schema';
