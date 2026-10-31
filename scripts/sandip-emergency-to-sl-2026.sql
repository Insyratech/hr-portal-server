-- =============================================================================
-- Sandip Kumar Yadav (ID2025009): move used Emergency leave onto Sick Leave (SL)
-- then remove Emergency from his 2026 entitlements.
--
-- Does:
--   • retarget his Emergency leave_applications to SL
--   • move LEAVE_PENDING / LEAVE_APPROVED / LEAVE_CANCELLED ledger onto SL
--   • drop the Emergency allocation (unused Emergency quota is not added to SL)
--   • recompute SL used/available
--   • relabel attendance reviews on those dates to Sick Leave
--
-- Run in Supabase SQL Editor:
--   1) PREVIEW  — confirm employee, Emergency used, SL balance, applications
--   2) APPLY    — only if preview looks right
--   3) VERIFY   — Emergency row gone; SL used increased by that quantity
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) PREVIEW — run each select on its own first
-- ---------------------------------------------------------------------------
select e.id, e.full_name, e.employee_code
from public.employees e
where e.deleted_at is null
  and (
    e.id = '3a882b24-30d7-4c47-961e-513b73b1aba7'
    or e.employee_code = 'ID2025009'
  );

select id, code, name
from public.leave_types
where name ilike '%emergency%'
   or upper(code) = 'SL';

select
  lt.code,
  lt.name,
  la.period,
  la.allocated,
  la.used,
  la.available,
  la.id as allocation_id
from public.leave_allocations la
join public.employees e on e.id = la.employee_id
join public.leave_types lt on lt.id = la.leave_type_id
where e.employee_code = 'ID2025009'
  and la.period = '2026'
  and (lt.name ilike '%emergency%' or upper(lt.code) = 'SL');

select
  a.id,
  lt.code,
  lt.name,
  a.start_date,
  a.end_date,
  a.quantity,
  a.status
from public.leave_applications a
join public.employees e on e.id = a.employee_id
join public.leave_types lt on lt.id = a.leave_type_id
where e.employee_code = 'ID2025009'
  and lt.name ilike '%emergency%';

select
  ll.transaction_type,
  ll.quantity,
  ll.reference_id,
  lt.code
from public.leave_ledger ll
join public.employees e on e.id = ll.employee_id
join public.leave_types lt on lt.id = ll.leave_type_id
where e.employee_code = 'ID2025009'
  and lt.name ilike '%emergency%';

-- ---------------------------------------------------------------------------
-- 2) APPLY — run only after PREVIEW: one Sandip, one Emergency type, SL exists
-- ---------------------------------------------------------------------------
begin;

do $$
declare
  v_employee_id uuid;
  v_emergency_type_id uuid;
  v_sl_type_id uuid;
  v_emergency_alloc_id uuid;
  v_sl_alloc_id uuid;
  v_sl_policy_version_id uuid;
  v_emergency_used numeric;
  v_moved_apps int;
  v_moved_ledger int;
begin
  select e.id into v_employee_id
  from public.employees e
  where e.deleted_at is null
    and (
      e.id = '3a882b24-30d7-4c47-961e-513b73b1aba7'
      or e.employee_code = 'ID2025009'
    );

  if v_employee_id is null then
    raise exception 'Sandip Kumar Yadav (ID2025009) was not found.';
  end if;

  if (
    select count(*) from public.employees e
    where e.deleted_at is null
      and (e.id = '3a882b24-30d7-4c47-961e-513b73b1aba7' or e.employee_code = 'ID2025009')
  ) <> 1 then
    raise exception 'Expected exactly one Sandip row (ID2025009).';
  end if;

  select count(*) into v_moved_apps from public.leave_types where name ilike '%emergency%';
  if v_moved_apps <> 1 then
    raise exception 'Expected exactly 1 Emergency leave type, found %.', v_moved_apps;
  end if;

  select id into v_emergency_type_id
  from public.leave_types
  where name ilike '%emergency%';

  select id into v_sl_type_id
  from public.leave_types
  where upper(code) = 'SL';

  if v_sl_type_id is null then
    raise exception 'Sick Leave (SL) was not found.';
  end if;

  select id into v_emergency_alloc_id
  from public.leave_allocations
  where employee_id = v_employee_id
    and leave_type_id = v_emergency_type_id
    and period = '2026';

  select id into v_sl_alloc_id
  from public.leave_allocations
  where employee_id = v_employee_id
    and leave_type_id = v_sl_type_id
    and period = '2026';

  if v_sl_alloc_id is null then
    raise exception 'Sandip has no 2026 SL allocation to receive the used Emergency days.';
  end if;

  select lpv.id into v_sl_policy_version_id
  from public.leave_policies lp
  join public.leave_policy_versions lpv on lpv.policy_id = lp.id
  where lp.leave_type_id = v_sl_type_id
    and lpv.status = 'published'
  order by lpv.version_number desc
  limit 1;

  if v_sl_policy_version_id is null then
    raise exception 'No published SL policy version.';
  end if;

  update public.leave_applications
  set
    leave_type_id = v_sl_type_id,
    policy_version_id = v_sl_policy_version_id,
    updated_at = now()
  where employee_id = v_employee_id
    and leave_type_id = v_emergency_type_id;
  get diagnostics v_moved_apps = row_count;

  if v_emergency_alloc_id is not null then
    update public.leave_ledger
    set
      leave_type_id = v_sl_type_id,
      allocation_id = v_sl_alloc_id
    where employee_id = v_employee_id
      and allocation_id = v_emergency_alloc_id
      and transaction_type in ('LEAVE_PENDING', 'LEAVE_APPROVED', 'LEAVE_CANCELLED');
    get diagnostics v_moved_ledger = row_count;

    delete from public.leave_ledger
    where allocation_id = v_emergency_alloc_id;

    delete from public.leave_allocations
    where id = v_emergency_alloc_id;
  else
    v_moved_ledger := 0;
  end if;

  update public.attendance_day_reviews adr
  set leave_type_name = 'Sick Leave'
  where adr.employee_id = v_employee_id
    and adr.leave_type_name ilike '%emergency%'
    and adr.attendance_date in (
      select d::date
      from public.leave_applications a
      cross join lateral generate_series(a.start_date, a.end_date, interval '1 day') as d
      where a.employee_id = v_employee_id
        and a.leave_type_id = v_sl_type_id
        and a.status in ('PENDING', 'APPROVED')
    );

  perform public.recompute_leave_allocation(v_sl_alloc_id);

  select used into v_emergency_used
  from public.leave_allocations
  where id = v_sl_alloc_id;

  raise notice
    'Sandip Emergency → SL: applications=% ledger_moved=% SL used now=%',
    v_moved_apps, v_moved_ledger, v_emergency_used;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- 3) VERIFY
-- ---------------------------------------------------------------------------
select
  lt.code,
  lt.name,
  la.period,
  la.allocated,
  la.used,
  la.available
from public.leave_allocations la
join public.leave_types lt on lt.id = la.leave_type_id
join public.employees e on e.id = la.employee_id
where e.employee_code = 'ID2025009'
  and la.period = '2026'
order by lt.name;

select
  a.id,
  lt.code,
  a.start_date,
  a.end_date,
  a.quantity,
  a.status
from public.leave_applications a
join public.leave_types lt on lt.id = a.leave_type_id
join public.employees e on e.id = a.employee_id
where e.employee_code = 'ID2025009'
  and (
    lt.name ilike '%emergency%'
    or upper(lt.code) = 'SL'
  )
order by a.start_date;
