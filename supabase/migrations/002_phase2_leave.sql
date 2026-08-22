-- Phase 2 leave engine. Apply in the Supabase SQL editor after 001_phase1_foundation.sql.
-- Mid-year joiners receive the full annual_allocation unless a future policy version
-- adds pro-rata. Seed policies do not pro-rate.

create table if not exists public.leave_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  description text not null default '',
  active boolean not null default true,
  requires_approval boolean not null default true,
  requires_handover boolean not null default false,
  requires_attachment boolean not null default false,
  allow_half_day boolean not null default true,
  allow_multiple_days boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.leave_policies (
  id uuid primary key default gen_random_uuid(),
  leave_type_id uuid not null unique references public.leave_types (id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.leave_policy_versions (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.leave_policies (id) on delete cascade,
  version_number integer not null,
  status text not null check (status in ('draft', 'published')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (policy_id, version_number)
);

create table if not exists public.leave_policy_rules (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null unique references public.leave_policy_versions (id) on delete cascade,
  rules jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.holidays (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  holiday_date date not null unique,
  type text not null default 'public',
  region text not null default 'IN',
  optional boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.leave_allocations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  leave_type_id uuid not null references public.leave_types (id) on delete restrict,
  period text not null,
  allocated numeric(8, 2) not null default 0,
  carried_forward numeric(8, 2) not null default 0,
  adjusted numeric(8, 2) not null default 0,
  used numeric(8, 2) not null default 0,
  available numeric(8, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, leave_type_id, period)
);

create table if not exists public.leave_applications (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  leave_type_id uuid not null references public.leave_types (id) on delete restrict,
  policy_version_id uuid not null references public.leave_policy_versions (id) on delete restrict,
  start_date date not null,
  end_date date not null,
  duration text not null check (duration in ('full', 'half')),
  quantity numeric(8, 2) not null,
  reason text,
  handover text,
  attachment_url text,
  status text not null check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.leave_approvals (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.leave_applications (id) on delete cascade,
  step_order integer not null,
  approver_role text not null default 'ADMIN',
  status text not null check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  actor_id uuid references public.employees (id) on delete set null,
  comment text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (application_id, step_order)
);

create table if not exists public.leave_ledger (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  leave_type_id uuid not null references public.leave_types (id) on delete restrict,
  allocation_id uuid not null references public.leave_allocations (id) on delete restrict,
  transaction_type text not null check (
    transaction_type in ('ALLOCATION', 'LEAVE_PENDING', 'LEAVE_APPROVED', 'LEAVE_CANCELLED', 'ADMIN_ADJUSTMENT')
  ),
  quantity numeric(8, 2) not null,
  reference_type text,
  reference_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists leave_applications_employee_id_idx on public.leave_applications (employee_id);
create index if not exists leave_applications_status_idx on public.leave_applications (status);
create index if not exists leave_ledger_allocation_id_idx on public.leave_ledger (allocation_id);
create index if not exists leave_ledger_employee_type_idx on public.leave_ledger (employee_id, leave_type_id);

drop trigger if exists leave_types_set_updated_at on public.leave_types;
create trigger leave_types_set_updated_at
  before update on public.leave_types
  for each row execute procedure public.set_updated_at();

drop trigger if exists leave_policies_set_updated_at on public.leave_policies;
create trigger leave_policies_set_updated_at
  before update on public.leave_policies
  for each row execute procedure public.set_updated_at();

drop trigger if exists leave_allocations_set_updated_at on public.leave_allocations;
create trigger leave_allocations_set_updated_at
  before update on public.leave_allocations
  for each row execute procedure public.set_updated_at();

drop trigger if exists leave_applications_set_updated_at on public.leave_applications;
create trigger leave_applications_set_updated_at
  before update on public.leave_applications
  for each row execute procedure public.set_updated_at();

create or replace function public.recompute_leave_allocation(p_allocation_id uuid)
returns void
language plpgsql
as $$
declare
  v_allocated numeric;
  v_carried numeric;
  v_adjusted numeric;
  v_used numeric;
  v_available numeric;
begin
  select
    coalesce(sum(case when transaction_type = 'ALLOCATION' then quantity else 0 end), 0),
    coalesce(sum(case when transaction_type = 'ADMIN_ADJUSTMENT' then quantity else 0 end), 0),
    coalesce(sum(case when transaction_type = 'LEAVE_APPROVED' then -quantity else 0 end), 0),
    coalesce(sum(quantity), 0)
  into v_allocated, v_adjusted, v_used, v_available
  from public.leave_ledger
  where allocation_id = p_allocation_id;

  select carried_forward into v_carried from public.leave_allocations where id = p_allocation_id;

  update public.leave_allocations
  set
    allocated = v_allocated,
    adjusted = v_adjusted,
    used = v_used,
    available = v_available
  where id = p_allocation_id;
end;
$$;

create or replace function public.apply_leave_application(
  p_employee_id uuid,
  p_leave_type_id uuid,
  p_policy_version_id uuid,
  p_start_date date,
  p_end_date date,
  p_duration text,
  p_quantity numeric,
  p_reason text,
  p_handover text,
  p_attachment_url text,
  p_status text,
  p_period text,
  p_annual_allocation numeric,
  p_allow_negative boolean
)
returns jsonb
language plpgsql
as $$
declare
  v_allocation public.leave_allocations%rowtype;
  v_overlap integer;
  v_application_id uuid;
  v_ledger_type text;
begin
  select * into v_allocation
  from public.leave_allocations
  where employee_id = p_employee_id
    and leave_type_id = p_leave_type_id
    and period = p_period
  for update;

  if not found then
    insert into public.leave_allocations (
      employee_id, leave_type_id, period, allocated, carried_forward, adjusted, used, available
    )
    values (
      p_employee_id, p_leave_type_id, p_period, p_annual_allocation, 0, 0, 0, p_annual_allocation
    )
    returning * into v_allocation;

    insert into public.leave_ledger (
      employee_id, leave_type_id, allocation_id, transaction_type, quantity, reference_type, reference_id
    )
    values (
      p_employee_id, p_leave_type_id, v_allocation.id, 'ALLOCATION', p_annual_allocation, 'period', null
    );

    perform public.recompute_leave_allocation(v_allocation.id);
    select * into v_allocation from public.leave_allocations where id = v_allocation.id for update;
  end if;

  select count(*) into v_overlap
  from public.leave_applications
  where employee_id = p_employee_id
    and status in ('PENDING', 'APPROVED')
    and start_date <= p_end_date
    and end_date >= p_start_date;

  if v_overlap > 0 then
    raise exception 'LEAVE_OVERLAP';
  end if;

  if p_allow_negative is false and v_allocation.available < p_quantity then
    raise exception 'INSUFFICIENT_LEAVE_BALANCE';
  end if;

  insert into public.leave_applications (
    employee_id, leave_type_id, policy_version_id, start_date, end_date, duration,
    quantity, reason, handover, attachment_url, status
  )
  values (
    p_employee_id, p_leave_type_id, p_policy_version_id, p_start_date, p_end_date, p_duration,
    p_quantity, p_reason, p_handover, p_attachment_url, p_status
  )
  returning id into v_application_id;

  v_ledger_type := case when p_status = 'APPROVED' then 'LEAVE_APPROVED' else 'LEAVE_PENDING' end;

  insert into public.leave_ledger (
    employee_id, leave_type_id, allocation_id, transaction_type, quantity, reference_type, reference_id
  )
  values (
    p_employee_id, p_leave_type_id, v_allocation.id, v_ledger_type, -p_quantity, 'leave_application', v_application_id
  );

  if p_status = 'PENDING' then
    insert into public.leave_approvals (application_id, step_order, approver_role, status)
    values (v_application_id, 1, 'ADMIN', 'PENDING');
  end if;

  perform public.recompute_leave_allocation(v_allocation.id);

  return jsonb_build_object('id', v_application_id, 'status', p_status);
end;
$$;

create or replace function public.finalise_leave_application(
  p_application_id uuid,
  p_action text,
  p_actor_id uuid,
  p_comment text
)
returns jsonb
language plpgsql
as $$
declare
  v_app public.leave_applications%rowtype;
  v_allocation_id uuid;
  v_pending public.leave_ledger%rowtype;
begin
  select * into v_app from public.leave_applications where id = p_application_id for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  select id into v_allocation_id
  from public.leave_allocations
  where employee_id = v_app.employee_id
    and leave_type_id = v_app.leave_type_id
  order by period desc
  limit 1
  for update;

  if p_action = 'approve' then
    if v_app.status <> 'PENDING' then
      raise exception 'VALIDATION_ERROR';
    end if;
    update public.leave_applications set status = 'APPROVED' where id = p_application_id;
    update public.leave_approvals
      set status = 'APPROVED', actor_id = p_actor_id, comment = p_comment, decided_at = now()
      where application_id = p_application_id and step_order = 1;
    update public.leave_ledger
      set transaction_type = 'LEAVE_APPROVED'
      where reference_id = p_application_id and transaction_type = 'LEAVE_PENDING';
  elsif p_action = 'reject' then
    if v_app.status <> 'PENDING' then
      raise exception 'VALIDATION_ERROR';
    end if;
    update public.leave_applications set status = 'REJECTED' where id = p_application_id;
    update public.leave_approvals
      set status = 'REJECTED', actor_id = p_actor_id, comment = p_comment, decided_at = now()
      where application_id = p_application_id and step_order = 1;
    select * into v_pending from public.leave_ledger
      where reference_id = p_application_id and transaction_type = 'LEAVE_PENDING';
    if found then
      insert into public.leave_ledger (
        employee_id, leave_type_id, allocation_id, transaction_type, quantity, reference_type, reference_id
      )
      values (
        v_app.employee_id, v_app.leave_type_id, v_pending.allocation_id, 'LEAVE_CANCELLED', -v_pending.quantity,
        'leave_application', p_application_id
      );
    end if;
  elsif p_action = 'cancel' then
    if v_app.status not in ('PENDING', 'APPROVED') then
      raise exception 'VALIDATION_ERROR';
    end if;
    update public.leave_applications set status = 'CANCELLED' where id = p_application_id;
    insert into public.leave_ledger (
      employee_id, leave_type_id, allocation_id, transaction_type, quantity, reference_type, reference_id
    )
    select v_app.employee_id, v_app.leave_type_id, allocation_id, 'LEAVE_CANCELLED', -quantity,
      'leave_application', p_application_id
    from public.leave_ledger
    where reference_id = p_application_id
      and transaction_type in ('LEAVE_PENDING', 'LEAVE_APPROVED')
    order by created_at desc
    limit 1;
  else
    raise exception 'VALIDATION_ERROR';
  end if;

  if v_allocation_id is not null then
    perform public.recompute_leave_allocation(v_allocation_id);
  end if;

  return jsonb_build_object('id', p_application_id, 'action', p_action);
end;
$$;

alter table public.leave_types enable row level security;
alter table public.leave_policies enable row level security;
alter table public.leave_policy_versions enable row level security;
alter table public.leave_policy_rules enable row level security;
alter table public.holidays enable row level security;
alter table public.leave_allocations enable row level security;
alter table public.leave_applications enable row level security;
alter table public.leave_approvals enable row level security;
alter table public.leave_ledger enable row level security;

drop policy if exists leave_types_select on public.leave_types;
create policy leave_types_select on public.leave_types for select to authenticated using (auth.uid() is not null);
drop policy if exists leave_types_write on public.leave_types;
create policy leave_types_write on public.leave_types for all to authenticated
  using (public.authorize('leave.types.manage')) with check (public.authorize('leave.types.manage'));

drop policy if exists leave_policies_select on public.leave_policies;
create policy leave_policies_select on public.leave_policies for select to authenticated using (auth.uid() is not null);
drop policy if exists leave_policies_write on public.leave_policies;
create policy leave_policies_write on public.leave_policies for all to authenticated
  using (public.authorize('leave.policies.manage')) with check (public.authorize('leave.policies.manage'));

drop policy if exists leave_policy_versions_select on public.leave_policy_versions;
create policy leave_policy_versions_select on public.leave_policy_versions for select to authenticated using (auth.uid() is not null);
drop policy if exists leave_policy_versions_write on public.leave_policy_versions;
create policy leave_policy_versions_write on public.leave_policy_versions for all to authenticated
  using (public.authorize('leave.policies.manage')) with check (public.authorize('leave.policies.manage'));

drop policy if exists leave_policy_rules_select on public.leave_policy_rules;
create policy leave_policy_rules_select on public.leave_policy_rules for select to authenticated using (auth.uid() is not null);
drop policy if exists leave_policy_rules_write on public.leave_policy_rules;
create policy leave_policy_rules_write on public.leave_policy_rules for all to authenticated
  using (public.authorize('leave.policies.manage')) with check (public.authorize('leave.policies.manage'));

drop policy if exists holidays_select on public.holidays;
create policy holidays_select on public.holidays for select to authenticated using (auth.uid() is not null);
drop policy if exists holidays_write on public.holidays;
create policy holidays_write on public.holidays for all to authenticated
  using (public.authorize('system.manage')) with check (public.authorize('system.manage'));

drop policy if exists leave_allocations_select on public.leave_allocations;
create policy leave_allocations_select on public.leave_allocations for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('leave.allocations.manage')
  );

drop policy if exists leave_applications_select on public.leave_applications;
create policy leave_applications_select on public.leave_applications for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('leave.approve')
  );

drop policy if exists leave_ledger_select on public.leave_ledger;
create policy leave_ledger_select on public.leave_ledger for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('leave.allocations.manage')
  );

grant all on public.leave_types, public.leave_policies, public.leave_policy_versions, public.leave_policy_rules,
  public.holidays, public.leave_allocations, public.leave_applications, public.leave_approvals, public.leave_ledger
  to service_role;
grant execute on function public.apply_leave_application(uuid, uuid, uuid, date, date, text, numeric, text, text, text, text, text, numeric, boolean) to service_role;
grant execute on function public.finalise_leave_application(uuid, text, uuid, text) to service_role;
grant execute on function public.recompute_leave_allocation(uuid) to service_role;

insert into public.leave_types (
  id, name, code, description, active, requires_approval, requires_handover, requires_attachment, allow_half_day, allow_multiple_days
) values
  ('00000000-0000-4000-8000-000000000101', 'Casual Leave', 'CL', 'Short planned absence', true, true, true, false, true, true),
  ('00000000-0000-4000-8000-000000000102', 'Sick Leave', 'SL', 'Unplanned illness', true, true, false, false, true, true),
  ('00000000-0000-4000-8000-000000000103', 'Earned Leave', 'EL', 'Privilege leave after one year of service', true, true, true, false, false, true),
  ('00000000-0000-4000-8000-000000000104', 'Menstrual Leave', 'ML', 'Menstrual leave', true, false, false, false, true, false),
  ('00000000-0000-4000-8000-000000000105', 'Loss of Pay', 'LOP', 'Unpaid leave; negative balance allowed', true, true, false, false, true, true),
  ('00000000-0000-4000-8000-000000000106', 'Compensatory Leave', 'COMP', 'Compensatory off', true, true, false, false, true, true),
  ('00000000-0000-4000-8000-000000000107', 'Maternity Leave', 'MAT', 'Maternity leave', true, true, true, true, false, true),
  ('00000000-0000-4000-8000-000000000108', 'Paternity Leave', 'PAT', 'Paternity leave', true, true, true, false, false, true),
  ('00000000-0000-4000-8000-000000000109', 'Other', 'OTH', 'Other leave', true, true, false, false, true, true)
on conflict (code) do nothing;

insert into public.leave_policies (id, leave_type_id, name) values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', 'Casual Leave Policy'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000102', 'Sick Leave Policy'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000103', 'Earned Leave Policy'),
  ('00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000104', 'Menstrual Leave Policy'),
  ('00000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-000000000105', 'Loss of Pay Policy')
on conflict (leave_type_id) do nothing;

insert into public.leave_policy_versions (id, policy_id, version_number, status, published_at) values
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000201', 1, 'published', now()),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000202', 1, 'published', now()),
  ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000203', 1, 'published', now()),
  ('00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000204', 1, 'published', now()),
  ('00000000-0000-4000-8000-000000000305', '00000000-0000-4000-8000-000000000205', 1, 'published', now())
on conflict (policy_id, version_number) do nothing;

insert into public.leave_policy_rules (version_id, rules) values
  ('00000000-0000-4000-8000-000000000301', '{"notice_period":{"value":24,"unit":"hours"},"requires_approval":true,"requires_handover":true,"requires_attachment":false,"allow_half_day":true,"allow_negative_balance":false,"minimum_service_days":0,"maximum_consecutive_days":3,"annual_allocation":12,"carry_forward":0}'::jsonb),
  ('00000000-0000-4000-8000-000000000302', '{"notice_period":{"value":2,"unit":"hours"},"requires_approval":true,"requires_handover":false,"requires_attachment":false,"allow_half_day":true,"allow_negative_balance":false,"minimum_service_days":0,"maximum_consecutive_days":5,"annual_allocation":12,"carry_forward":0}'::jsonb),
  ('00000000-0000-4000-8000-000000000303', '{"notice_period":{"value":24,"unit":"hours"},"requires_approval":true,"requires_handover":true,"requires_attachment":false,"allow_half_day":false,"allow_negative_balance":false,"minimum_service_days":365,"maximum_consecutive_days":null,"annual_allocation":18,"carry_forward":0,"eligibility":{"minimum_service_days":365}}'::jsonb),
  ('00000000-0000-4000-8000-000000000304', '{"notice_period":{"value":0,"unit":"hours"},"requires_approval":false,"requires_handover":false,"requires_attachment":false,"allow_half_day":true,"allow_negative_balance":false,"minimum_service_days":0,"maximum_consecutive_days":1,"annual_allocation":12,"carry_forward":0}'::jsonb),
  ('00000000-0000-4000-8000-000000000305', '{"notice_period":{"value":0,"unit":"hours"},"requires_approval":true,"requires_handover":false,"requires_attachment":false,"allow_half_day":true,"allow_negative_balance":true,"minimum_service_days":0,"maximum_consecutive_days":null,"annual_allocation":0,"carry_forward":0}'::jsonb)
on conflict (version_id) do nothing;

insert into public.holidays (name, holiday_date, type, region, optional) values
  ('Independence Day', '2026-08-15', 'public', 'IN', false)
on conflict (holiday_date) do nothing;

notify pgrst, 'reload schema';
