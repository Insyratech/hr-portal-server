-- One-off (Supabase SQL editor). Naveen: offset leave 2026-10-15 with work on Sunday 2026-10-18.
-- Verbal/manual COMP — was not applied in the portal.
--
-- What APPLY does:
--   • records an APPROVED compensatory-work offset (work 18 Oct → leave 15 Oct)
--   • restores 1 day (or 0.5 if that leave was half-day) on the original leave type
--   • clears LOP / leave overlay on 15 Oct in OPEN attendance imports (PARSED / IN_REVIEW)
--   • does NOT rewrite a PUBLISHED October payslip
--
-- Run STEP 1 first. Confirm there is exactly one Naveen and one leave covering 15 Oct.
-- Then run STEP 2.

-- =============================================================================
-- STEP 1 — inspect
-- =============================================================================

-- 1a. Who matches "Naveen"  (must be exactly one before STEP 2)
select e.id, e.employee_code, e.full_name, e.status, e.email
from public.employees e
where e.status = 'active'
  and e.full_name ilike '%naveen%'
order by e.full_name;

-- 1b. Leave covering 15 Oct 2026
select
  e.full_name,
  e.employee_code,
  lt.code as leave_code,
  lt.name as leave_name,
  lt.paid as leave_paid,
  la.id as leave_id,
  la.status,
  la.start_date,
  la.end_date,
  la.duration,
  la.quantity
from public.employees e
join public.leave_applications la on la.employee_id = e.id
join public.leave_types lt on lt.id = la.leave_type_id
where e.status = 'active'
  and e.full_name ilike '%naveen%'
  and la.start_date <= date '2026-10-15'
  and la.end_date >= date '2026-10-15'
order by la.created_at desc;

-- 1c. 2026 leave balances
select
  e.full_name,
  lt.code,
  a.period,
  a.allocated,
  a.used,
  a.adjusted,
  a.available,
  a.id as allocation_id
from public.employees e
join public.leave_allocations a on a.employee_id = e.id
join public.leave_types lt on lt.id = a.leave_type_id
where e.status = 'active'
  and e.full_name ilike '%naveen%'
  and a.period = '2026'
order by lt.code;

-- 1d. Existing compensatory requests for these dates
select
  e.full_name,
  r.id,
  r.status,
  r.work_date,
  r.leave_date,
  r.quantity,
  r.balance_restored,
  r.leave_application_id
from public.employees e
join public.comp_off_work_requests r on r.employee_id = e.id
where e.status = 'active'
  and e.full_name ilike '%naveen%'
  and (r.work_date = date '2026-10-18' or r.leave_date = date '2026-10-15')
order by r.created_at desc;

-- 1e. October attendance reviews (15th leave day + 18th Sunday work)
select
  e.full_name,
  i.period,
  i.status as import_status,
  d.attendance_date,
  d.status as day_status,
  d.leave_type_name,
  d.leave_paid,
  d.leave_duration,
  d.proposed_lop,
  d.final_lop,
  d.hr_action,
  d.needs_hr_decision
from public.employees e
join public.attendance_day_reviews d on d.employee_id = e.id
join public.attendance_imports i on i.id = d.import_id
where e.status = 'active'
  and e.full_name ilike '%naveen%'
  and d.attendance_date in (date '2026-10-15', date '2026-10-18')
order by i.created_at desc, d.attendance_date;

-- 1f. October payroll / slip (do not rewrite if PUBLISHED)
select
  e.full_name,
  r.period,
  r.status as payroll_status,
  s.lop_days,
  s.lop_amount,
  s.net
from public.employees e
left join public.salary_slips s on s.employee_id = e.id
left join public.payroll_runs r on r.id = s.run_id
where e.status = 'active'
  and e.full_name ilike '%naveen%'
  and (r.period = '2026-10' or r.period is null)
order by r.period;

-- =============================================================================
-- STEP 2 — apply (only after STEP 1: one Naveen, one leave covering 15 Oct)
-- =============================================================================

begin;

do $$
declare
  v_emp_id uuid;
  v_emp_name text;
  v_emp_count int;
  v_app record;
  v_qty numeric(8, 2);
  v_request_id uuid;
  v_ledger_id uuid;
  v_allocation_id uuid;
  v_current_qty numeric;
  v_next_qty numeric;
  v_restored numeric := 0;
  v_has_kind boolean;
  v_payroll_published boolean;
begin
  select count(*) into v_emp_count
  from public.employees e
  where e.status = 'active'
    and e.full_name ilike '%naveen%';

  if v_emp_count <> 1 then
    raise exception 'Expected exactly 1 active Naveen, found %. Fix the name filter before applying.', v_emp_count;
  end if;

  select e.id, e.full_name into v_emp_id, v_emp_name
  from public.employees e
  where e.status = 'active'
    and e.full_name ilike '%naveen%';

  select
    la.id,
    la.employee_id,
    la.leave_type_id,
    la.status,
    la.duration,
    la.quantity,
    la.start_date,
    la.end_date
  into v_app
  from public.leave_applications la
  where la.employee_id = v_emp_id
    and la.status = 'APPROVED'
    and la.start_date <= date '2026-10-15'
    and la.end_date >= date '2026-10-15'
  order by la.created_at desc
  limit 1;

  if v_app.id is null then
    raise exception
      '% has no APPROVED leave covering 2026-10-15. Attendance LOP was not changed. Insert/approve that leave first, or tell us the leave type.',
      v_emp_name;
  end if;

  v_qty := case when v_app.duration = 'half' then 0.5 else 1 end;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'comp_off_work_requests'
      and column_name = 'kind'
  ) into v_has_kind;

  -- Already offset? reuse it.
  select r.id into v_request_id
  from public.comp_off_work_requests r
  where r.employee_id = v_emp_id
    and r.status in ('PENDING', 'APPROVED')
    and (
      r.work_date = date '2026-10-18'
      or (r.leave_application_id = v_app.id and r.leave_date = date '2026-10-15')
    )
  limit 1;

  if v_request_id is null then
    if v_has_kind then
      insert into public.comp_off_work_requests (
        employee_id,
        kind,
        leave_application_id,
        work_date,
        leave_date,
        quantity,
        reason,
        status,
        balance_restored,
        hr_accepted,
        hr_acted_at,
        decided_at
      )
      values (
        v_emp_id,
        'LEGACY_OFFSET',
        v_app.id,
        date '2026-10-18',
        date '2026-10-15',
        v_qty,
        'Manual/verbal COMP: worked Sunday 2026-10-18 to offset leave 2026-10-15. Recorded by HR.',
        'APPROVED',
        0,
        true,
        now(),
        now()
      )
      returning id into v_request_id;
    else
      insert into public.comp_off_work_requests (
        employee_id,
        leave_application_id,
        work_date,
        leave_date,
        quantity,
        reason,
        status,
        balance_restored,
        decided_at
      )
      values (
        v_emp_id,
        v_app.id,
        date '2026-10-18',
        date '2026-10-15',
        v_qty,
        'Manual/verbal COMP: worked Sunday 2026-10-18 to offset leave 2026-10-15. Recorded by HR.',
        'APPROVED',
        0,
        now()
      )
      returning id into v_request_id;
    end if;
  else
    update public.comp_off_work_requests
    set
      status = 'APPROVED',
      work_date = date '2026-10-18',
      leave_date = date '2026-10-15',
      leave_application_id = v_app.id,
      quantity = v_qty,
      decided_at = coalesce(decided_at, now())
    where id = v_request_id
      and status in ('PENDING', 'APPROVED');
  end if;

  -- Restore original leave type by shrinking the LEAVE_APPROVED debit (history row stays).
  select ll.id, ll.allocation_id, ll.quantity
  into v_ledger_id, v_allocation_id, v_current_qty
  from public.leave_ledger ll
  where ll.reference_id = v_app.id
    and ll.transaction_type = 'LEAVE_APPROVED'
  order by ll.created_at desc
  limit 1;

  if v_ledger_id is not null
     and v_current_qty < 0
     and abs(v_current_qty) + 1e-9 >= v_qty then
    v_next_qty := round((v_current_qty + v_qty)::numeric, 2);
    update public.leave_ledger
    set quantity = v_next_qty
    where id = v_ledger_id;
    perform public.recompute_leave_allocation(v_allocation_id);
    v_restored := v_qty;
  end if;

  update public.comp_off_work_requests
  set balance_restored = v_restored
  where id = v_request_id;

  select exists (
    select 1
    from public.payroll_runs
    where period = '2026-10'
      and status = 'PUBLISHED'
  ) into v_payroll_published;

  -- Attendance: 15 Oct should not count as leave/LOP. Open imports only if payroll is published.
  update public.attendance_day_reviews d
  set
    leave_type_name = null,
    leave_paid = null,
    leave_duration = null,
    proposed_lop = 0,
    final_lop = 0,
    hr_action = 'NO_LOP',
    needs_hr_decision = false,
    skipped_from_lop = true,
    reason = case
      when coalesce(trim(d.reason), '') = '' then
        'Compensated by work on 2026-10-18 (Sunday). Manual COMP recorded by HR.'
      else d.reason
    end
  from public.attendance_imports i
  where d.import_id = i.id
    and d.employee_id = v_emp_id
    and d.attendance_date = date '2026-10-15'
    and i.status in ('PARSED', 'IN_REVIEW', 'CONFIRMED')
    and (
      v_payroll_published = false
      or i.status in ('PARSED', 'IN_REVIEW')
    );

  -- Sunday work day: never LOP.
  update public.attendance_day_reviews d
  set
    proposed_lop = 0,
    final_lop = 0,
    hr_action = case when d.hr_action is null then 'NO_LOP' else d.hr_action end,
    needs_hr_decision = false
  from public.attendance_imports i
  where d.import_id = i.id
    and d.employee_id = v_emp_id
    and d.attendance_date = date '2026-10-18'
    and i.status in ('PARSED', 'IN_REVIEW', 'CONFIRMED')
    and (
      v_payroll_published = false
      or i.status in ('PARSED', 'IN_REVIEW')
    );

  insert into public.audit_logs (
    actor_id,
    action,
    entity_type,
    entity_id,
    new_values
  )
  values (
    v_emp_id,
    'comp_off.manual_offset',
    'comp_off_work_request',
    v_request_id,
    jsonb_build_object(
      'employeeId', v_emp_id,
      'employeeName', v_emp_name,
      'workDate', '2026-10-18',
      'leaveDate', '2026-10-15',
      'leaveApplicationId', v_app.id,
      'quantity', v_qty,
      'balanceRestored', v_restored,
      'payrollPublished', v_payroll_published
    )
  );

  raise notice 'Naveen % offset 2026-10-18 → 2026-10-15. restored=% request=% payroll_published=%',
    v_emp_name, v_restored, v_request_id, v_payroll_published;
end;
$$;

commit;

-- =============================================================================
-- STEP 3 — verify
-- =============================================================================

select
  e.full_name,
  r.id,
  r.status,
  r.work_date,
  r.leave_date,
  r.quantity,
  r.balance_restored
from public.employees e
join public.comp_off_work_requests r on r.employee_id = e.id
where e.full_name ilike '%naveen%'
  and r.work_date = date '2026-10-18'
  and r.leave_date = date '2026-10-15';

select
  e.full_name,
  lt.code,
  a.used,
  a.available
from public.employees e
join public.leave_allocations a on a.employee_id = e.id
join public.leave_types lt on lt.id = a.leave_type_id
where e.full_name ilike '%naveen%'
  and a.period = '2026'
order by lt.code;

select
  e.full_name,
  i.status as import_status,
  d.attendance_date,
  d.leave_type_name,
  d.final_lop,
  d.hr_action
from public.employees e
join public.attendance_day_reviews d on d.employee_id = e.id
join public.attendance_imports i on i.id = d.import_id
where e.full_name ilike '%naveen%'
  and d.attendance_date in (date '2026-10-15', date '2026-10-18')
order by d.attendance_date;
