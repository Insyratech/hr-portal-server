-- One-off (Supabase SQL editor).
-- Sandip Kumar Yadav + Vengalaraju Naveen Kumar:
--   move Emergency (EML) applications onto Sick Leave (SL),
--   debit SL for those used days, then remove Emergency allocations.
--
-- Why the trash icon fails:
--   deleteAllocation blocks when used > 0 OR any PENDING/APPROVED application
--   exists for that leave type. Naveen has APPROVED EML 2026-10-15.
--
-- Expected after APPLY:
--   Sandip  SL  allocated 7  used 4  available 3   (was used 3 / available 4)
--   Naveen  SL  allocated 7  used 8  available -1  (was used 7 / available 0)
--   Emergency entitlement gone for both. Applications remain, now typed SL.
--
-- Run STEP 1 first. Then STEP 2. Then STEP 3.

-- =============================================================================
-- STEP 1 — inspect
-- =============================================================================

select e.id, e.employee_code, e.full_name, e.status
from public.employees e
where e.deleted_at is null
  and (
    e.id in (
      '3a882b24-30d7-4c47-961e-513b73b1aba7',
      '04615f4e-40b4-4ff3-a224-a817a551a8cf'
    )
    or e.employee_code in ('ID2025009')
    or e.full_name ilike 'Sandip Kumar Yadav'
    or e.full_name ilike 'Vengalaraju Naveen Kumar'
  )
order by e.full_name;

select id, code, name, active
from public.leave_types
where upper(code) in ('EML', 'SL')
   or name ilike '%emergency%'
   or name ilike 'sick leave'
order by code;

select
  e.full_name,
  e.employee_code,
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
where e.id in (
    '3a882b24-30d7-4c47-961e-513b73b1aba7',
    '04615f4e-40b4-4ff3-a224-a817a551a8cf'
  )
  and la.period = '2026'
  and (upper(lt.code) in ('EML', 'SL') or lt.name ilike '%emergency%')
order by e.full_name, lt.code;

select
  e.full_name,
  e.employee_code,
  a.id as application_id,
  lt.code,
  lt.name,
  a.start_date,
  a.end_date,
  a.quantity,
  a.status
from public.leave_applications a
join public.employees e on e.id = a.employee_id
join public.leave_types lt on lt.id = a.leave_type_id
where e.id in (
    '3a882b24-30d7-4c47-961e-513b73b1aba7',
    '04615f4e-40b4-4ff3-a224-a817a551a8cf'
  )
  and (upper(lt.code) = 'EML' or lt.name ilike '%emergency%')
order by e.full_name, a.start_date;

select
  e.full_name,
  lt.code,
  ll.transaction_type,
  ll.quantity,
  ll.reference_id,
  ll.allocation_id
from public.leave_ledger ll
join public.employees e on e.id = ll.employee_id
join public.leave_types lt on lt.id = ll.leave_type_id
where e.id in (
    '3a882b24-30d7-4c47-961e-513b73b1aba7',
    '04615f4e-40b4-4ff3-a224-a817a551a8cf'
  )
  and (upper(lt.code) = 'EML' or lt.name ilike '%emergency%')
order by e.full_name, ll.created_at;

-- =============================================================================
-- STEP 2 — apply
-- =============================================================================

begin;

create temporary table tmp_eml_apps (
  employee_id uuid not null,
  application_id uuid not null,
  status text not null,
  quantity numeric(8, 2) not null
) on commit drop;

do $$
declare
  v_eml_id uuid;
  v_sl_id uuid;
  v_sl_policy_version_id uuid;
  v_employee_id uuid;
  v_eml_alloc_id uuid;
  v_sl_alloc_id uuid;
  r record;
  v_moved_apps int;
  v_moved_ledger int;
  v_inserted_ledger int;
  v_eml_type_count int;
begin
  select count(*) into v_eml_type_count
  from public.leave_types
  where upper(code) = 'EML' or name ilike '%emergency%';

  if v_eml_type_count <> 1 then
    raise exception 'Expected exactly 1 Emergency leave type, found %.', v_eml_type_count;
  end if;

  select id into v_eml_id
  from public.leave_types
  where upper(code) = 'EML' or name ilike '%emergency%';

  select id into v_sl_id from public.leave_types where upper(code) = 'SL';
  if v_sl_id is null then
    raise exception 'Sick Leave (SL) was not found.';
  end if;

  select lpv.id into v_sl_policy_version_id
  from public.leave_policies lp
  join public.leave_policy_versions lpv on lpv.policy_id = lp.id
  where lp.leave_type_id = v_sl_id
    and lpv.status = 'published'
  order by lpv.version_number desc
  limit 1;

  if v_sl_policy_version_id is null then
    raise exception 'No published SL policy version.';
  end if;

  foreach v_employee_id in array array[
    '3a882b24-30d7-4c47-961e-513b73b1aba7'::uuid,
    '04615f4e-40b4-4ff3-a224-a817a551a8cf'::uuid
  ]
  loop
    if not exists (
      select 1 from public.employees e
      where e.id = v_employee_id and e.deleted_at is null
    ) then
      raise exception 'Employee % was not found.', v_employee_id;
    end if;

    select id into v_sl_alloc_id
    from public.leave_allocations
    where employee_id = v_employee_id
      and leave_type_id = v_sl_id
      and period = '2026';

    if v_sl_alloc_id is null then
      raise exception 'Employee % has no 2026 SL allocation.', v_employee_id;
    end if;

    select id into v_eml_alloc_id
    from public.leave_allocations
    where employee_id = v_employee_id
      and leave_type_id = v_eml_id
      and period = '2026';

    insert into tmp_eml_apps (employee_id, application_id, status, quantity)
    select a.employee_id, a.id, a.status, a.quantity
    from public.leave_applications a
    where a.employee_id = v_employee_id
      and a.leave_type_id = v_eml_id;

    update public.leave_applications
    set
      leave_type_id = v_sl_id,
      policy_version_id = v_sl_policy_version_id,
      updated_at = now()
    where employee_id = v_employee_id
      and leave_type_id = v_eml_id;
    get diagnostics v_moved_apps = row_count;

    v_moved_ledger := 0;
    if v_eml_alloc_id is not null then
      update public.leave_ledger
      set
        leave_type_id = v_sl_id,
        allocation_id = v_sl_alloc_id
      where employee_id = v_employee_id
        and allocation_id = v_eml_alloc_id
        and transaction_type in ('LEAVE_PENDING', 'LEAVE_APPROVED', 'LEAVE_CANCELLED');
      get diagnostics v_moved_ledger = row_count;
    end if;

    v_inserted_ledger := 0;
    for r in
      select t.application_id, t.status, t.quantity
      from tmp_eml_apps t
      where t.employee_id = v_employee_id
        and t.status in ('PENDING', 'APPROVED')
        and not exists (
          select 1
          from public.leave_ledger ll
          where ll.reference_id = t.application_id
            and ll.allocation_id = v_sl_alloc_id
            and ll.transaction_type in ('LEAVE_PENDING', 'LEAVE_APPROVED')
        )
    loop
      insert into public.leave_ledger (
        employee_id, leave_type_id, allocation_id, transaction_type, quantity, reference_type, reference_id
      )
      values (
        v_employee_id,
        v_sl_id,
        v_sl_alloc_id,
        case when r.status = 'APPROVED' then 'LEAVE_APPROVED' else 'LEAVE_PENDING' end,
        -r.quantity,
        'leave_application',
        r.application_id
      );
      v_inserted_ledger := v_inserted_ledger + 1;
    end loop;

    if v_eml_alloc_id is not null then
      delete from public.leave_ledger where allocation_id = v_eml_alloc_id;
      delete from public.leave_allocations where id = v_eml_alloc_id;
    end if;

    update public.attendance_day_reviews adr
    set leave_type_name = 'Sick Leave'
    where adr.employee_id = v_employee_id
      and adr.leave_type_name ilike '%emergency%';

    perform public.recompute_leave_allocation(v_sl_alloc_id);

    raise notice
      'employee=% apps_moved=% ledger_moved=% ledger_inserted=%',
      v_employee_id, v_moved_apps, v_moved_ledger, v_inserted_ledger;
  end loop;
end $$;

commit;

-- =============================================================================
-- STEP 3 — verify
-- =============================================================================

select
  e.full_name,
  e.employee_code,
  lt.code,
  lt.name,
  la.allocated,
  la.used,
  la.available
from public.leave_allocations la
join public.employees e on e.id = la.employee_id
join public.leave_types lt on lt.id = la.leave_type_id
where e.id in (
    '3a882b24-30d7-4c47-961e-513b73b1aba7',
    '04615f4e-40b4-4ff3-a224-a817a551a8cf'
  )
  and la.period = '2026'
order by e.full_name, lt.name;

select
  e.full_name,
  lt.code,
  a.start_date,
  a.end_date,
  a.quantity,
  a.status
from public.leave_applications a
join public.employees e on e.id = a.employee_id
join public.leave_types lt on lt.id = a.leave_type_id
where e.id in (
    '3a882b24-30d7-4c47-961e-513b73b1aba7',
    '04615f4e-40b4-4ff3-a224-a817a551a8cf'
  )
  and (
    upper(lt.code) in ('EML', 'SL')
    or lt.name ilike '%emergency%'
  )
order by e.full_name, a.start_date;
