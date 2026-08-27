-- Phase 3: leave final approval step label ADMIN → HR_MANAGER.
-- Backfill in-flight rows; update apply RPC insert label.

update public.leave_approvals
set approver_role = 'HR_MANAGER'
where approver_role = 'ADMIN';

alter table public.leave_approvals
  alter column approver_role set default 'HR_MANAGER';

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
    values (v_application_id, 1, 'HR_MANAGER', 'PENDING');
  end if;

  perform public.recompute_leave_allocation(v_allocation.id);

  return jsonb_build_object('id', v_application_id, 'status', p_status);
end;
$$;

notify pgrst, 'reload schema';
