-- Comp-off working: employee works a week-off/holiday to offset one leave day.
-- On HR approve: leave history stays; that leave day is compensated for attendance/payroll;
-- leave balance is restored when a LEAVE_APPROVED ledger debit can be reduced.

insert into public.permissions (code, description) values
  ('comp_off.apply', 'Request compensatory work for a leave day'),
  ('comp_off.approve', 'Approve or reject compensatory work requests')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'comp_off.apply'
where r.code in (
  'SUPER_ADMIN',
  'GENERAL_MANAGER',
  'HR_MANAGER',
  'CSO',
  'FINANCE_MANAGER',
  'INVENTORY_MANAGER',
  'EMPLOYEE'
)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'comp_off.approve'
where r.code = 'HR_MANAGER'
on conflict do nothing;

create table if not exists public.comp_off_work_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  leave_application_id uuid not null references public.leave_applications (id) on delete restrict,
  work_date date not null,
  leave_date date not null,
  quantity numeric(8, 2) not null check (quantity in (0.5, 1)),
  reason text not null default '',
  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  balance_restored numeric(8, 2) not null default 0,
  actor_id uuid references public.employees (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint comp_off_work_same_month_chk
    check (date_trunc('month', work_date::timestamp) = date_trunc('month', leave_date::timestamp)),
  constraint comp_off_work_dates_distinct_chk check (work_date <> leave_date)
);

create unique index if not exists comp_off_work_open_work_date_idx
  on public.comp_off_work_requests (employee_id, work_date)
  where status in ('PENDING', 'APPROVED');

create unique index if not exists comp_off_work_open_leave_date_idx
  on public.comp_off_work_requests (leave_application_id, leave_date)
  where status in ('PENDING', 'APPROVED');

create index if not exists comp_off_work_employee_idx
  on public.comp_off_work_requests (employee_id, work_date desc);

create index if not exists comp_off_work_status_idx
  on public.comp_off_work_requests (status, created_at desc);

create index if not exists comp_off_work_approved_leave_date_idx
  on public.comp_off_work_requests (employee_id, leave_date)
  where status = 'APPROVED';

drop trigger if exists comp_off_work_requests_set_updated_at on public.comp_off_work_requests;
create trigger comp_off_work_requests_set_updated_at
  before update on public.comp_off_work_requests
  for each row execute procedure public.set_updated_at();

alter table public.comp_off_work_requests enable row level security;

drop policy if exists comp_off_work_select on public.comp_off_work_requests;
create policy comp_off_work_select on public.comp_off_work_requests
  for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('comp_off.approve')
    or public.authorize('users.view')
  );

drop policy if exists comp_off_work_insert on public.comp_off_work_requests;
create policy comp_off_work_insert on public.comp_off_work_requests
  for insert to authenticated
  with check (
    public.authorize('comp_off.apply')
    and exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

drop policy if exists comp_off_work_update on public.comp_off_work_requests;
create policy comp_off_work_update on public.comp_off_work_requests
  for update to authenticated
  using (
    public.authorize('comp_off.approve')
    or (
      public.authorize('comp_off.apply')
      and exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    )
  )
  with check (
    public.authorize('comp_off.approve')
    or (
      public.authorize('comp_off.apply')
      and exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    )
  );

grant all on public.comp_off_work_requests to service_role;

notify pgrst, 'reload schema';
