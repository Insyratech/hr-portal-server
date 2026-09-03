-- Close duplicate open working-week rows (keep latest effective_from per employee).
-- Add shift change request table + permissions.

with ranked as (
  select
    id,
    employee_id,
    effective_from,
    row_number() over (
      partition by employee_id
      order by effective_from desc, created_at desc
    ) as rn
  from public.employee_work_weeks
  where effective_to is null
),
to_close as (
  select
    r.id,
    (r2.effective_from - interval '1 day')::date as close_on
  from ranked r
  join ranked r2 on r2.employee_id = r.employee_id and r2.rn = 1
  where r.rn > 1
)
update public.employee_work_weeks eww
set effective_to = tc.close_on
from to_close tc
where eww.id = tc.id;

insert into public.permissions (code, description) values
  ('shift_change.apply', 'Request a temporary shift change'),
  ('shift_change.approve', 'Approve or reject shift change requests'),
  ('shift_change.view', 'View org-wide shift change requests')
on conflict (code) do nothing;

-- Apply: same audience as leave.apply / work_permission.apply
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'shift_change.apply'
where r.code in (
  'SUPER_ADMIN',
  'GENERAL_MANAGER',
  'HR_MANAGER',
  'CSO',
  'FINANCE_MANAGER',
  'EMPLOYEE'
)
on conflict do nothing;

-- Approve: HR only
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'shift_change.approve'
where r.code = 'HR_MANAGER'
on conflict do nothing;

-- View: HR, GM, CSO (org/team boards)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'shift_change.view'
where r.code in ('HR_MANAGER', 'GENERAL_MANAGER', 'CSO')
on conflict do nothing;

create table if not exists public.shift_change_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id),
  project_id uuid references public.projects (id) on delete set null,
  start_date date not null,
  end_date date not null,
  requested_shift_id uuid not null references public.shifts (id),
  current_shift_id uuid references public.shifts (id),
  reason text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  project_lead_employee_id uuid references public.employees (id),
  project_lead_required boolean not null default false,
  project_lead_accepted boolean not null default false,
  project_lead_acted_at timestamptz,
  reviewer_employee_id uuid references public.employees (id),
  reviewer_comment text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_change_requests_dates_chk check (end_date >= start_date),
  constraint shift_change_requests_reason_chk check (char_length(trim(reason)) > 0)
);

create unique index if not exists shift_change_requests_one_pending_per_employee
  on public.shift_change_requests (employee_id)
  where status = 'PENDING';

create index if not exists shift_change_requests_employee_idx
  on public.shift_change_requests (employee_id, start_date desc);

create index if not exists shift_change_requests_status_idx
  on public.shift_change_requests (status, start_date desc);

create index if not exists shift_change_requests_lead_pending_idx
  on public.shift_change_requests (project_lead_employee_id, status)
  where project_lead_required = true and project_lead_accepted = false;

create index if not exists shift_change_requests_approved_range_idx
  on public.shift_change_requests (employee_id, start_date, end_date)
  where status = 'APPROVED';

drop trigger if exists shift_change_requests_set_updated_at on public.shift_change_requests;
create trigger shift_change_requests_set_updated_at
  before update on public.shift_change_requests
  for each row execute procedure public.set_updated_at();

alter table public.shift_change_requests enable row level security;

drop policy if exists shift_change_requests_select on public.shift_change_requests;
create policy shift_change_requests_select on public.shift_change_requests
  for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or exists (
      select 1 from public.employees e
      where e.id = project_lead_employee_id and e.user_id = auth.uid()
    )
    or public.authorize('shift_change.approve')
    or public.authorize('shift_change.view')
    or public.authorize('users.view')
  );

drop policy if exists shift_change_requests_insert on public.shift_change_requests;
create policy shift_change_requests_insert on public.shift_change_requests
  for insert to authenticated
  with check (
    public.authorize('shift_change.apply')
    and exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

drop policy if exists shift_change_requests_update on public.shift_change_requests;
create policy shift_change_requests_update on public.shift_change_requests
  for update to authenticated
  using (
    public.authorize('shift_change.approve')
    or exists (
      select 1 from public.employees e
      where e.id = project_lead_employee_id and e.user_id = auth.uid()
    )
    or exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  )
  with check (
    public.authorize('shift_change.approve')
    or exists (
      select 1 from public.employees e
      where e.id = project_lead_employee_id and e.user_id = auth.uid()
    )
    or exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

grant all on public.shift_change_requests to service_role;

notify pgrst, 'reload schema';
