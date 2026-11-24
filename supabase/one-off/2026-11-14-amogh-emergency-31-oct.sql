-- One-off (Supabase SQL editor).
-- Amogh Bellurkar: 1 full-day emergency leave on 31 Oct 2026.
-- He could not apply in the portal. The manager approved it outside the system.
--
-- How this portal counts leave:
--   used / available on the Leaves tab come from leave_ledger, then
--   recompute_leave_allocation. Editing leave_allocations.used by itself
--   is overwritten the next time a leave is approved or recomputed.
--
-- Where the day is charged:
--   This portal records emergency leave on Sick Leave (SL).
--   Emergency (EML) is not on Amogh's entitlements. His Sick Leave has
--   room for 1 day (screenshot: allocated 7, used 4, available 3).
--   Casual Leave is not changed.
--
-- What APPLY does:
--   • inserts one APPROVED Sick Leave application for 2026-10-31, quantity 1
--   • writes LEAVE_APPROVED −1 on the 2026 SL ledger
--   • recomputes SL so used becomes 5 and available becomes 2
--   • marks 31 Oct attendance as paid Sick Leave with no LOP, when a review row exists
--   • does NOT change any salary slip
--
-- Expected after APPLY:
--   Sick Leave 2026:   allocated 7, used 5, available 2
--   Casual Leave 2026: unchanged (used 3, available 4)
--
-- Run STEP 1 first. Confirm one Amogh, no leave already covering 31 Oct,
-- and Sick Leave available is at least 1. Then run STEP 2.

-- =============================================================================
-- STEP 1 — inspect
-- =============================================================================

select e.id, e.employee_code, e.full_name, e.status
from public.employees e
where e.deleted_at is null
  and (
    e.id = '0d30daf4-6718-4456-ada1-cbd533cbb81d'
    or e.full_name ilike 'Amogh Bellurkar'
  );

select id, code, name, paid, active
from public.leave_types
where upper(code) in ('SL', 'CL', 'EML')
   or name ilike '%emergency%'
   or name ilike 'sick leave'
   or name ilike 'casual leave'
order by code;

select
  lt.code,
  lt.name,
  la.period,
  la.allocated,
  la.used,
  la.available,
  la.id as allocation_id
from public.leave_allocations la
join public.leave_types lt on lt.id = la.leave_type_id
where la.employee_id = '0d30daf4-6718-4456-ada1-cbd533cbb81d'
  and la.period = '2026'
order by lt.code;

select
  lt.code,
  a.id,
  a.status,
  a.start_date,
  a.end_date,
  a.duration,
  a.quantity,
  a.reason
from public.leave_applications a
join public.leave_types lt on lt.id = a.leave_type_id
where a.employee_id = '0d30daf4-6718-4456-ada1-cbd533cbb81d'
  and a.status in ('PENDING', 'APPROVED')
  and a.start_date <= date '2026-10-31'
  and a.end_date >= date '2026-10-31';

select
  i.period,
  i.status as import_status,
  d.attendance_date,
  d.status as day_status,
  d.leave_type_name,
  d.leave_paid,
  d.final_lop,
  d.hr_action
from public.attendance_day_reviews d
join public.attendance_imports i on i.id = d.import_id
where d.employee_id = '0d30daf4-6718-4456-ada1-cbd533cbb81d'
  and d.attendance_date = date '2026-10-31';

select r.period, r.status as payroll_status, s.lop_days, s.net
from public.salary_slips s
join public.payroll_runs r on r.id = s.run_id
where s.employee_id = '0d30daf4-6718-4456-ada1-cbd533cbb81d'
  and r.period = '2026-10';

-- =============================================================================
-- STEP 2 — apply
-- =============================================================================

begin;

do $$
declare
  v_emp_id uuid := '0d30daf4-6718-4456-ada1-cbd533cbb81d';
  v_emp_name text;
  v_sl_id uuid;
  v_policy_version_id uuid;
  v_allocation_id uuid;
  v_available numeric;
  v_created jsonb;
  v_application_id uuid;
  v_attendance_updated int;
begin
  select e.full_name into v_emp_name
  from public.employees e
  where e.id = v_emp_id
    and e.deleted_at is null
    and e.full_name ilike 'Amogh Bellurkar';

  if v_emp_name is null then
    raise exception 'Employee % is not Amogh Bellurkar. Nothing was changed.', v_emp_id;
  end if;

  select id into v_sl_id
  from public.leave_types
  where upper(code) = 'SL';

  if v_sl_id is null then
    raise exception 'Sick Leave (SL) was not found.';
  end if;

  select lpv.id into v_policy_version_id
  from public.leave_policies lp
  join public.leave_policy_versions lpv on lpv.policy_id = lp.id
  where lp.leave_type_id = v_sl_id
    and lpv.status = 'published'
  order by lpv.version_number desc
  limit 1;

  if v_policy_version_id is null then
    raise exception 'No published Sick Leave policy version.';
  end if;

  select la.id, la.available
  into v_allocation_id, v_available
  from public.leave_allocations la
  where la.employee_id = v_emp_id
    and la.leave_type_id = v_sl_id
    and la.period = '2026';

  if v_allocation_id is null then
    raise exception 'Amogh has no 2026 Sick Leave allocation.';
  end if;

  if v_available < 1 then
    raise exception 'Sick Leave available is %. Need at least 1.', v_available;
  end if;

  if exists (
    select 1
    from public.leave_applications a
    where a.employee_id = v_emp_id
      and a.status in ('PENDING', 'APPROVED')
      and a.start_date <= date '2026-10-31'
      and a.end_date >= date '2026-10-31'
  ) then
    raise exception 'Amogh already has a pending or approved leave covering 2026-10-31.';
  end if;

  if exists (
    select 1
    from public.attendance_day_reviews d
    where d.employee_id = v_emp_id
      and d.attendance_date = date '2026-10-31'
      and d.status in ('WEEK_OFF', 'HOLIDAY')
  ) then
    raise exception '31 Oct 2026 is a week off or holiday on attendance. Leave was not deducted.';
  end if;

  v_created := public.apply_leave_application(
    v_emp_id,
    v_sl_id,
    v_policy_version_id,
    date '2026-10-31',
    date '2026-10-31',
    'full',
    1,
    'Emergency leave on 31 Oct 2026. Approved by the manager outside the portal.',
    null,
    null,
    'APPROVED',
    '2026',
    7,
    false
  );

  v_application_id := (v_created ->> 'id')::uuid;

  update public.leave_applications
  set reviewer_comment = 'Recorded by HR. Manager approval was outside the portal.'
  where id = v_application_id;

  insert into public.leave_approvals (
    application_id, step_order, approver_role, status, comment, decided_at
  )
  values (
    v_application_id,
    1,
    'HR_MANAGER',
    'APPROVED',
    'Manager approved this emergency leave outside the portal.',
    now()
  )
  on conflict (application_id, step_order) do update
  set
    status = 'APPROVED',
    approver_role = 'HR_MANAGER',
    comment = excluded.comment,
    decided_at = now();

  update public.attendance_day_reviews d
  set
    status = 'LEAVE',
    leave_type_name = 'Sick Leave',
    leave_paid = true,
    leave_duration = 'full',
    proposed_lop = 0,
    final_lop = 0,
    hr_action = 'NO_LOP',
    needs_hr_decision = false,
    skipped_from_lop = true
  where d.employee_id = v_emp_id
    and d.attendance_date = date '2026-10-31'
    and d.status not in ('WEEK_OFF', 'HOLIDAY');

  get diagnostics v_attendance_updated = row_count;

  raise notice
    'Amogh SL application % recorded for 2026-10-31. Attendance rows updated: %. Salary slips were not changed.',
    v_application_id, v_attendance_updated;
end;
$$;

commit;

-- =============================================================================
-- STEP 3 — verify
-- =============================================================================

select
  lt.code,
  lt.name,
  la.allocated,
  la.used,
  la.available
from public.leave_allocations la
join public.leave_types lt on lt.id = la.leave_type_id
where la.employee_id = '0d30daf4-6718-4456-ada1-cbd533cbb81d'
  and la.period = '2026'
  and upper(lt.code) in ('SL', 'CL')
order by lt.code;

select
  a.start_date,
  a.end_date,
  a.status,
  a.quantity,
  a.reason,
  lt.code
from public.leave_applications a
join public.leave_types lt on lt.id = a.leave_type_id
where a.employee_id = '0d30daf4-6718-4456-ada1-cbd533cbb81d'
  and a.start_date = date '2026-10-31';

select
  d.attendance_date,
  d.status,
  d.leave_type_name,
  d.final_lop,
  d.hr_action
from public.attendance_day_reviews d
where d.employee_id = '0d30daf4-6718-4456-ada1-cbd533cbb81d'
  and d.attendance_date = date '2026-10-31';
