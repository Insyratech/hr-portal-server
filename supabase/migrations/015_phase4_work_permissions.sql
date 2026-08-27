-- Payroll Phase 4: monthly 2-hour work permission bucket.
-- Does not touch leave_ledger. Quota is 120 minutes per employee per calendar month of permission_date.

create table if not exists public.work_permissions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  permission_date date not null,
  minutes integer not null check (minutes in (60, 120)),
  reason text not null default '',
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  actor_id uuid references public.employees (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists work_permissions_employee_date_idx
  on public.work_permissions (employee_id, permission_date);

create unique index if not exists work_permissions_open_date_idx
  on public.work_permissions (employee_id, permission_date)
  where status in ('PENDING', 'APPROVED');

drop trigger if exists work_permissions_set_updated_at on public.work_permissions;
create trigger work_permissions_set_updated_at
  before update on public.work_permissions
  for each row execute procedure public.set_updated_at();

alter table public.work_permissions enable row level security;

drop policy if exists work_permissions_select on public.work_permissions;
create policy work_permissions_select on public.work_permissions
  for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('work_permission.approve')
    or public.authorize('users.view')
  );

drop policy if exists work_permissions_insert on public.work_permissions;
create policy work_permissions_insert on public.work_permissions
  for insert to authenticated
  with check (
    public.authorize('work_permission.apply')
    and exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

drop policy if exists work_permissions_update on public.work_permissions;
create policy work_permissions_update on public.work_permissions
  for update to authenticated
  using (public.authorize('work_permission.approve'))
  with check (public.authorize('work_permission.approve'));

grant all on public.work_permissions to service_role;

notify pgrst, 'reload schema';
