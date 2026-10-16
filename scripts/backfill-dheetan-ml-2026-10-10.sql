-- =============================================================================
-- Backfill APPROVED ML (Menstrual Leave) for Dheetan Parth Sarthi on 2026-10-10.
-- Reason: portal apply blocked after shift cutoff; ticket / grievance request.
--
-- Scope: ONLY this one employee + this one date + leave type ML.
-- Does: leave_applications (APPROVED) + leave_ledger + recompute allocation
-- Also: if attendance already imported as ABSENT for that day → set LEAVE
--
-- Run order in Supabase SQL Editor:
--   1) PREVIEW A  — must show name_match_count = 1 and no overlap
--   2) APPLY B    — creates the approved ML
--   3) PREVIEW C  — optional attendance check
--   4) PATCH D    — only if C shows ABSENT / needs_hr_decision rows
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A) PREVIEW — run alone first
-- ---------------------------------------------------------------------------
with params as (
  select
    'Dheetan Parth Sarthi'::text as full_name_exact,
    'ML'::text as leave_code,
    date '2026-10-10' as leave_date,
    '2026'::text as period
)
select
  e.id as employee_id,
  e.full_name,
  e.employee_code,
  (
    select count(*)::int
    from public.employees e2
    where e2.full_name ilike 'Dheetan Parth Sarthi'
      and e2.deleted_at is null
  ) as name_match_count,
  lt.id as leave_type_id,
  lt.code as leave_code,
  lt.name as leave_type_name,
  lpv.id as policy_version_id,
  la.id as allocation_id,
  la.allocated,
  la.used as used_before,
  la.available as available_before,
  (
    select count(*)::int
    from public.leave_applications a
    where a.employee_id = e.id
      and a.status in ('PENDING', 'APPROVED')
      and a.start_date <= p.leave_date
      and a.end_date >= p.leave_date
  ) as overlapping_open_leave
from params p
join public.employees e
  on e.full_name ilike p.full_name_exact
 and e.deleted_at is null
join public.leave_types lt
  on upper(lt.code) = upper(p.leave_code)
 and lt.active = true
join public.leave_policies lp
  on lp.leave_type_id = lt.id
join public.leave_policy_versions lpv
  on lpv.policy_id = lp.id
 and lpv.status = 'published'
left join public.leave_allocations la
  on la.employee_id = e.id
 and la.leave_type_id = lt.id
 and la.period = p.period
order by lpv.version_number desc
limit 1;

-- ---------------------------------------------------------------------------
-- B) APPLY — run only after PREVIEW A: name_match_count = 1, overlapping = 0
-- ---------------------------------------------------------------------------
do $$
declare
  v_employee_id uuid;
  v_leave_type_id uuid;
  v_policy_version_id uuid;
  v_annual numeric;
  v_allow_neg boolean;
  v_result jsonb;
  v_match_count integer;
  v_overlap integer;
begin
  select count(*)::int into v_match_count
  from public.employees e
  where e.full_name ilike 'Dheetan Parth Sarthi'
    and e.deleted_at is null;

  if v_match_count <> 1 then
    raise exception 'Expected exactly 1 employee named Dheetan Parth Sarthi, found %', v_match_count;
  end if;

  select e.id into v_employee_id
  from public.employees e
  where e.full_name ilike 'Dheetan Parth Sarthi'
    and e.deleted_at is null;

  select lt.id into v_leave_type_id
  from public.leave_types lt
  where upper(lt.code) = 'ML'
    and lt.active = true;

  if v_leave_type_id is null then
    raise exception 'Leave type ML not found or inactive';
  end if;

  select count(*)::int into v_overlap
  from public.leave_applications a
  where a.employee_id = v_employee_id
    and a.status in ('PENDING', 'APPROVED')
    and a.start_date <= date '2026-10-10'
    and a.end_date >= date '2026-10-10';

  if v_overlap > 0 then
    raise exception 'Leave already exists for Dheetan on 2026-10-10 (PENDING/APPROVED)';
  end if;

  select lpv.id into v_policy_version_id
  from public.leave_policies lp
  join public.leave_policy_versions lpv on lpv.policy_id = lp.id
  where lp.leave_type_id = v_leave_type_id
    and lpv.status = 'published'
  order by lpv.version_number desc
  limit 1;

  if v_policy_version_id is null then
    raise exception 'No published policy version for ML';
  end if;

  select
    coalesce((r.rules->>'annual_allocation')::numeric, 12),
    coalesce((r.rules->>'allow_negative_balance')::boolean, false)
  into v_annual, v_allow_neg
  from public.leave_policy_rules r
  where r.version_id = v_policy_version_id;

  v_result := public.apply_leave_application(
    v_employee_id,
    v_leave_type_id,
    v_policy_version_id,
    date '2026-10-10',
    date '2026-10-10',
    'full',
    1,
    'Backfill: portal apply blocked after shift cutoff; ticket request (ML for 2026-10-10).',
    null,
    null,
    'APPROVED',
    '2026',
    v_annual,
    v_allow_neg
  );

  raise notice 'Created APPROVED ML for Dheetan Parth Sarthi on 2026-10-10: %', v_result;
end $$;

-- ---------------------------------------------------------------------------
-- C) PREVIEW attendance for that day (optional)
-- ---------------------------------------------------------------------------
select
  e.full_name,
  e.employee_code,
  ar.id as attendance_record_id,
  ar.attendance_date,
  ar.status as record_status,
  adr.id as day_review_id,
  adr.status as review_status,
  adr.leave_type_name,
  adr.proposed_lop,
  adr.needs_hr_decision,
  adr.skipped_from_lop
from public.employees e
left join public.attendance_records ar
  on ar.employee_id = e.id
 and ar.attendance_date = date '2026-10-10'
left join public.attendance_day_reviews adr
  on adr.employee_id = e.id
 and adr.attendance_date = date '2026-10-10'
where e.full_name ilike 'Dheetan Parth Sarthi'
  and e.deleted_at is null;

-- ---------------------------------------------------------------------------
-- D) PATCH attendance if already marked ABSENT (run only when C shows ABSENT)
-- ---------------------------------------------------------------------------
do $$
declare
  v_employee_id uuid;
  v_updated_records integer := 0;
  v_updated_reviews integer := 0;
begin
  select e.id into v_employee_id
  from public.employees e
  where e.full_name ilike 'Dheetan Parth Sarthi'
    and e.deleted_at is null;

  if v_employee_id is null then
    raise exception 'Employee Dheetan Parth Sarthi not found';
  end if;

  update public.attendance_records
  set status = 'LEAVE'
  where employee_id = v_employee_id
    and attendance_date = date '2026-10-10'
    and status = 'ABSENT';
  get diagnostics v_updated_records = row_count;

  update public.attendance_day_reviews
  set
    status = 'LEAVE',
    leave_type_name = 'Menstrual Leave',
    leave_paid = true,
    leave_duration = 'full',
    proposed_lop = 0,
    final_lop = 0,
    needs_hr_decision = false,
    skipped_from_lop = true,
    reason = coalesce(nullif(reason, ''), 'Backfill: approved ML for 2026-10-10')
  where employee_id = v_employee_id
    and attendance_date = date '2026-10-10'
    and status in ('ABSENT', 'LEAVE');
  get diagnostics v_updated_reviews = row_count;

  raise notice
    'Attendance patch for Dheetan 2026-10-10: records=% reviews=%',
    v_updated_records, v_updated_reviews;
end $$;

-- ---------------------------------------------------------------------------
-- E) VERIFY leave row
-- ---------------------------------------------------------------------------
select
  a.id,
  e.full_name,
  lt.code,
  a.start_date,
  a.end_date,
  a.duration,
  a.quantity,
  a.status,
  a.reason,
  a.created_at
from public.leave_applications a
join public.employees e on e.id = a.employee_id
join public.leave_types lt on lt.id = a.leave_type_id
where e.full_name ilike 'Dheetan Parth Sarthi'
  and e.deleted_at is null
  and a.start_date = date '2026-10-10'
  and a.end_date = date '2026-10-10'
  and upper(lt.code) = 'ML';
