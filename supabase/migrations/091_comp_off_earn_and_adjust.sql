-- Compensatory work earns COMP leave (PL then HR, then work confirmation).
-- COMP leave is taken through the existing leave module.
-- Previously taken leave this month can be adjusted against COMP (HR).
-- Legacy offset rows (leave_application_id set) stay as LEGACY_OFFSET.

alter table public.leave_ledger
  drop constraint if exists leave_ledger_transaction_type_check;

alter table public.leave_ledger
  add constraint leave_ledger_transaction_type_check
  check (
    transaction_type in (
      'ALLOCATION',
      'LEAVE_PENDING',
      'LEAVE_APPROVED',
      'LEAVE_CANCELLED',
      'ADMIN_ADJUSTMENT',
      'COMP_EARNED',
      'COMP_ADJUSTMENT',
      'COMP_EXPIRED'
    )
  );

alter table public.leave_allocations
  add column if not exists earned numeric(8, 2) not null default 0;
alter table public.leave_allocations
  add column if not exists expired numeric(8, 2) not null default 0;

create or replace function public.recompute_leave_allocation(p_allocation_id uuid)
returns void
language plpgsql
as $$
declare
  v_allocated numeric;
  v_carried numeric;
  v_adjusted numeric;
  v_used numeric;
  v_earned numeric;
  v_expired numeric;
  v_available numeric;
begin
  select
    coalesce(sum(case when transaction_type = 'ALLOCATION' then quantity else 0 end), 0),
    coalesce(sum(case when transaction_type = 'ADMIN_ADJUSTMENT' then quantity else 0 end), 0)
      + coalesce(sum(case when transaction_type = 'COMP_ADJUSTMENT' then quantity else 0 end), 0),
    coalesce(sum(case when transaction_type = 'LEAVE_APPROVED' then -quantity else 0 end), 0),
    coalesce(sum(case when transaction_type = 'COMP_EARNED' then quantity else 0 end), 0),
    coalesce(sum(case when transaction_type = 'COMP_EXPIRED' then -quantity else 0 end), 0),
    coalesce(sum(quantity), 0)
  into v_allocated, v_adjusted, v_used, v_earned, v_expired, v_available
  from public.leave_ledger
  where allocation_id = p_allocation_id;

  select carried_forward into v_carried from public.leave_allocations where id = p_allocation_id;

  update public.leave_allocations
  set
    allocated = v_allocated,
    adjusted = v_adjusted,
    used = v_used,
    earned = v_earned,
    expired = v_expired,
    available = v_available
  where id = p_allocation_id;
end;
$$;

alter table public.comp_off_work_requests
  add column if not exists kind text not null default 'EARN';

update public.comp_off_work_requests
set kind = 'LEGACY_OFFSET'
where leave_application_id is not null
  and kind = 'EARN';

alter table public.comp_off_work_requests
  drop constraint if exists comp_off_work_requests_kind_check;
alter table public.comp_off_work_requests
  add constraint comp_off_work_requests_kind_check
  check (kind in ('EARN', 'LEGACY_OFFSET'));

alter table public.comp_off_work_requests
  alter column leave_application_id drop not null;
alter table public.comp_off_work_requests
  alter column leave_date drop not null;

alter table public.comp_off_work_requests
  drop constraint if exists comp_off_work_same_month_chk;
alter table public.comp_off_work_requests
  drop constraint if exists comp_off_work_dates_distinct_chk;

alter table public.comp_off_work_requests
  add constraint comp_off_work_kind_shape_chk check (
    (kind = 'EARN' and leave_application_id is null and leave_date is null)
    or (
      kind = 'LEGACY_OFFSET'
      and leave_application_id is not null
      and leave_date is not null
      and work_date <> leave_date
    )
  );

alter table public.comp_off_work_requests
  add column if not exists project_id uuid references public.projects (id) on delete set null;
alter table public.comp_off_work_requests
  add column if not exists project_lead_employee_id uuid references public.employees (id) on delete set null;
alter table public.comp_off_work_requests
  add column if not exists project_lead_required boolean not null default false;
alter table public.comp_off_work_requests
  add column if not exists project_lead_accepted boolean not null default false;
alter table public.comp_off_work_requests
  add column if not exists project_lead_acted_at timestamptz;
alter table public.comp_off_work_requests
  add column if not exists hr_accepted boolean not null default false;
alter table public.comp_off_work_requests
  add column if not exists hr_acted_at timestamptz;
alter table public.comp_off_work_requests
  add column if not exists work_confirmed_at timestamptz;
alter table public.comp_off_work_requests
  add column if not exists work_confirmed_by uuid references public.employees (id) on delete set null;
alter table public.comp_off_work_requests
  add column if not exists credited_at timestamptz;
alter table public.comp_off_work_requests
  add column if not exists credited_quantity numeric(8, 2) not null default 0;

create index if not exists comp_off_work_lead_inbox_idx
  on public.comp_off_work_requests (project_lead_employee_id, status)
  where kind = 'EARN' and project_lead_required = true and project_lead_accepted = false;

create table if not exists public.comp_off_adjustments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  leave_application_id uuid not null references public.leave_applications (id) on delete restrict,
  leave_date date not null,
  quantity numeric(8, 2) not null check (quantity in (0.5, 1)),
  reason text not null default '',
  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  comp_consumed numeric(8, 2) not null default 0,
  original_restored numeric(8, 2) not null default 0,
  actor_id uuid references public.employees (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists comp_off_adjust_open_leave_date_idx
  on public.comp_off_adjustments (leave_application_id, leave_date)
  where status in ('PENDING', 'APPROVED');

create index if not exists comp_off_adjust_employee_idx
  on public.comp_off_adjustments (employee_id, created_at desc);
create index if not exists comp_off_adjust_status_idx
  on public.comp_off_adjustments (status, created_at desc);
create index if not exists comp_off_adjust_approved_date_idx
  on public.comp_off_adjustments (employee_id, leave_date)
  where status = 'APPROVED';

drop trigger if exists comp_off_adjustments_set_updated_at on public.comp_off_adjustments;
create trigger comp_off_adjustments_set_updated_at
  before update on public.comp_off_adjustments
  for each row execute procedure public.set_updated_at();

alter table public.comp_off_adjustments enable row level security;

drop policy if exists comp_off_adjust_select on public.comp_off_adjustments;
create policy comp_off_adjust_select on public.comp_off_adjustments
  for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('comp_off.approve')
    or public.authorize('users.view')
  );

drop policy if exists comp_off_adjust_insert on public.comp_off_adjustments;
create policy comp_off_adjust_insert on public.comp_off_adjustments
  for insert to authenticated
  with check (
    public.authorize('comp_off.apply')
    and exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

drop policy if exists comp_off_adjust_update on public.comp_off_adjustments;
create policy comp_off_adjust_update on public.comp_off_adjustments
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

grant all on public.comp_off_adjustments to service_role;

create unique index if not exists leave_ledger_comp_earned_once_idx
  on public.leave_ledger (reference_id)
  where transaction_type = 'COMP_EARNED' and reference_id is not null;

update public.leave_types
set description = 'Compensatory leave earned by working an approved holiday or week-off. Apply here to use the COMP balance. Project lead and HR review as configured.'
where code = 'COMP';

notify pgrst, 'reload schema';
