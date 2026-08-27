-- Payroll Phase 2: companies, employee company, compensation, and bank/PAN.
-- Slip letterhead will snapshot company fields in Phase 6; changing company does not rewrite slips.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'company-logos',
  'company-logos',
  false,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do nothing;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  address text not null default '',
  logo_storage_path text unique,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.employees
  add column if not exists company_id uuid references public.companies (id) on delete restrict;

create index if not exists employees_company_id_idx on public.employees (company_id);

create table if not exists public.employee_compensation (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  basic numeric(12, 2) not null default 0 check (basic >= 0),
  da numeric(12, 2) not null default 0 check (da >= 0),
  hra numeric(12, 2) not null default 0 check (hra >= 0),
  fuel numeric(12, 2) not null default 0 check (fuel >= 0),
  incentives numeric(12, 2) not null default 0 check (incentives >= 0),
  other_earnings numeric(12, 2) not null default 0 check (other_earnings >= 0),
  professional_tax numeric(12, 2) not null default 0 check (professional_tax >= 0),
  tds numeric(12, 2) not null default 0 check (tds >= 0),
  employee_welfare numeric(12, 2) not null default 0 check (employee_welfare >= 0),
  kpi numeric(12, 2) not null default 0 check (kpi >= 0),
  other_deductions numeric(12, 2) not null default 0 check (other_deductions >= 0),
  effective_from date not null,
  created_at timestamptz not null default now(),
  unique (employee_id, effective_from)
);

create index if not exists employee_compensation_employee_id_idx
  on public.employee_compensation (employee_id, effective_from desc);

create table if not exists public.employee_payment (
  employee_id uuid primary key references public.employees (id) on delete cascade,
  pan text,
  bank_account_number text,
  bank_name text,
  ifsc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists companies_set_updated_at on public.companies;
create trigger companies_set_updated_at
  before update on public.companies
  for each row execute procedure public.set_updated_at();

drop trigger if exists employee_payment_set_updated_at on public.employee_payment;
create trigger employee_payment_set_updated_at
  before update on public.employee_payment
  for each row execute procedure public.set_updated_at();

alter table public.companies enable row level security;
alter table public.employee_compensation enable row level security;
alter table public.employee_payment enable row level security;

drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
  for select to authenticated
  using (
    public.authorize('users.view')
    or public.authorize('users.manage')
    or public.authorize('companies.manage')
    or public.authorize('payroll.view')
    or public.authorize('payroll.manage')
  );

drop policy if exists companies_write on public.companies;
create policy companies_write on public.companies
  for all to authenticated
  using (public.authorize('companies.manage'))
  with check (public.authorize('companies.manage'));

drop policy if exists employee_compensation_select on public.employee_compensation;
create policy employee_compensation_select on public.employee_compensation
  for select to authenticated
  using (
    exists (
      select 1 from public.employees e
      where e.id = employee_id and e.user_id = auth.uid()
    )
    or public.authorize('payroll.view')
    or public.authorize('payroll.manage')
    or public.authorize('users.view')
    or public.authorize('users.manage')
  );

drop policy if exists employee_compensation_write on public.employee_compensation;
create policy employee_compensation_write on public.employee_compensation
  for all to authenticated
  using (public.authorize('payroll.manage'))
  with check (public.authorize('payroll.manage'));

drop policy if exists employee_payment_select on public.employee_payment;
create policy employee_payment_select on public.employee_payment
  for select to authenticated
  using (
    exists (
      select 1 from public.employees e
      where e.id = employee_id and e.user_id = auth.uid()
    )
    or public.authorize('payroll.view')
    or public.authorize('payroll.manage')
    or public.authorize('users.view')
    or public.authorize('users.manage')
  );

drop policy if exists employee_payment_write on public.employee_payment;
create policy employee_payment_write on public.employee_payment
  for all to authenticated
  using (public.authorize('payroll.manage'))
  with check (public.authorize('payroll.manage'));

drop policy if exists company_logos_storage_select on storage.objects;
create policy company_logos_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'company-logos'
    and (
      public.authorize('companies.manage')
      or public.authorize('users.view')
      or public.authorize('payroll.view')
    )
  );

grant all on public.companies, public.employee_compensation, public.employee_payment to service_role;

notify pgrst, 'reload schema';
