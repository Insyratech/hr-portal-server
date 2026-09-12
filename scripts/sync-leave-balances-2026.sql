-- =============================================================================
-- Sync leave balances for period 2026 from Leave_Record.xlsx (source of truth)
-- Run in Supabase SQL Editor (or any Postgres client connected to production).
--
-- Scope: ONLY the employees + leave types listed below.
-- Does NOT touch: Archana, unpaid/LOP, WFH, other years, other leave types.
--
-- Overrides vs sheet:
--   Dheetan ML  -> used 3, available 9 (allocated 12)
--   Naveen SL   -> balance 0 (extra SL day ignored; used capped at 7)
--   Naveen CL   -> balance 0
--
-- How it works (safe for future leave apply/recompute):
--   1) Match employees by full_name (case-insensitive contains)
--   2) Upsert leave_allocations for period '2026'
--   3) Replace ledger rows for THOSE allocations only with:
--        ALLOCATION (+total) + LEAVE_APPROVED (-used)
--   4) recompute_leave_allocation so used/available stay consistent
--
-- IMPORTANT:
--   - Run the PREVIEW block first and confirm employee matches.
--   - Then run the UPDATE transaction.
--   - Existing leave_applications for these people/types remain as history but
--     no longer drive 2026 balances (Excel is the opening truth for the year).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) PREVIEW — run this alone first; do not continue if any row is missing
-- ---------------------------------------------------------------------------
with desired (employee_key, leave_code, allocated, used, available) as (
  values
    -- Nikitha
    ('Nikitha',   'CL', 7::numeric, 1::numeric,  6::numeric),
    ('Nikitha',   'SL', 7::numeric, 2::numeric,  5::numeric),
    ('Nikitha',   'ML', 12::numeric, 2::numeric, 10::numeric),
    -- Amogh
    ('Amogh',     'CL', 7::numeric, 1::numeric,  6::numeric),
    ('Amogh',     'SL', 7::numeric, 2::numeric,  5::numeric),
    -- Shivam
    ('Shivam',    'CL', 7::numeric, 2::numeric,  5::numeric),
    ('Shivam',    'SL', 7::numeric, 1::numeric,  6::numeric),
    -- Chakritha
    ('Chakritha', 'CL', 7::numeric, 2::numeric,  5::numeric),
    ('Chakritha', 'SL', 7::numeric, 0::numeric,  7::numeric),
    ('Chakritha', 'ML', 12::numeric, 1::numeric, 11::numeric),
    -- Dheetan (ML override: used 3 / balance 9)
    ('Dheetan',   'CL', 7::numeric, 2::numeric,  5::numeric),
    ('Dheetan',   'SL', 7::numeric, 0::numeric,  7::numeric),
    ('Dheetan',   'ML', 12::numeric, 3::numeric,  9::numeric),
    -- Sandip
    ('Sandip',    'CL', 7::numeric, 5::numeric,  2::numeric),
    ('Sandip',    'SL', 7::numeric, 3::numeric,  4::numeric),
    -- Naveen (CL & SL balance forced to 0)
    ('Naveen',    'CL', 7::numeric, 7::numeric,  0::numeric),
    ('Naveen',    'SL', 7::numeric, 7::numeric,  0::numeric)
),
matched as (
  select
    d.employee_key,
    d.leave_code,
    d.allocated as excel_allocated,
    d.used as excel_used,
    d.available as excel_available,
    e.id as employee_id,
    e.full_name,
    e.employee_code,
    lt.id as leave_type_id,
    lt.name as leave_type_name,
    la.id as allocation_id,
    la.allocated as current_allocated,
    la.used as current_used,
    la.available as current_available,
    (
      select count(*)::int
      from public.employees e2
      where e2.full_name ilike '%' || d.employee_key || '%'
        and e2.deleted_at is null
    ) as name_match_count
  from desired d
  left join lateral (
    select e.*
    from public.employees e
    where e.full_name ilike '%' || d.employee_key || '%'
      and e.deleted_at is null
    order by length(e.full_name)
    limit 1
  ) e on true
  left join public.leave_types lt
    on upper(lt.code) = upper(d.leave_code)
  left join public.leave_allocations la
    on la.employee_id = e.id
   and la.leave_type_id = lt.id
   and la.period = '2026'
)
select *
from matched
order by employee_key, leave_code;

-- Stop here after preview. If every row has employee_id + leave_type_id and
-- name_match_count = 1, run section 2 below.


-- ---------------------------------------------------------------------------
-- 2) APPLY — updates only the rows above for period 2026
-- ---------------------------------------------------------------------------
begin;

create temporary table tmp_leave_sync_2026 (
  employee_key text not null,
  leave_code text not null,
  allocated numeric(8, 2) not null,
  used numeric(8, 2) not null,
  available numeric(8, 2) not null,
  employee_id uuid,
  leave_type_id uuid,
  allocation_id uuid,
  primary key (employee_key, leave_code)
) on commit drop;

insert into tmp_leave_sync_2026 (employee_key, leave_code, allocated, used, available)
values
  ('Nikitha',   'CL', 7, 1, 6),
  ('Nikitha',   'SL', 7, 2, 5),
  ('Nikitha',   'ML', 12, 2, 10),
  ('Amogh',     'CL', 7, 1, 6),
  ('Amogh',     'SL', 7, 2, 5),
  ('Shivam',    'CL', 7, 2, 5),
  ('Shivam',    'SL', 7, 1, 6),
  ('Chakritha', 'CL', 7, 2, 5),
  ('Chakritha', 'SL', 7, 0, 7),
  ('Chakritha', 'ML', 12, 1, 11),
  ('Dheetan',   'CL', 7, 2, 5),
  ('Dheetan',   'SL', 7, 0, 7),
  ('Dheetan',   'ML', 12, 3, 9),
  ('Sandip',    'CL', 7, 5, 2),
  ('Sandip',    'SL', 7, 3, 4),
  ('Naveen',    'CL', 7, 7, 0),
  ('Naveen',    'SL', 7, 7, 0);

-- Resolve employee + leave type (exact same matching rules as preview)
update tmp_leave_sync_2026 t
set
  employee_id = (
    select emp.id
    from public.employees emp
    where emp.full_name ilike '%' || t.employee_key || '%'
      and emp.deleted_at is null
    order by length(emp.full_name)
    limit 1
  ),
  leave_type_id = (
    select lt.id
    from public.leave_types lt
    where upper(lt.code) = upper(t.leave_code)
    limit 1
  );

-- Fail loudly if anyone is missing or name is ambiguous
do $$
declare
  v_bad text;
  v_ambiguous text;
begin
  select string_agg(employee_key || '/' || leave_code, ', ')
  into v_bad
  from tmp_leave_sync_2026
  where employee_id is null or leave_type_id is null;

  if v_bad is not null then
    raise exception
      'Leave sync aborted — could not resolve employee or leave type for: %. Fix names/codes and retry.',
      v_bad;
  end if;

  select string_agg(distinct t.employee_key, ', ')
  into v_ambiguous
  from tmp_leave_sync_2026 t
  where (
    select count(*)
    from public.employees e
    where e.full_name ilike '%' || t.employee_key || '%'
      and e.deleted_at is null
  ) <> 1;

  if v_ambiguous is not null then
    raise exception
      'Leave sync aborted — ambiguous employee name match for: %. Use a more specific key.',
      v_ambiguous;
  end if;
end $$;

-- Upsert allocations for 2026
insert into public.leave_allocations (
  employee_id, leave_type_id, period, allocated, carried_forward, adjusted, used, available
)
select
  t.employee_id,
  t.leave_type_id,
  '2026',
  t.allocated,
  0,
  0,
  t.used,
  t.available
from tmp_leave_sync_2026 t
on conflict (employee_id, leave_type_id, period) do update
set
  allocated = excluded.allocated,
  carried_forward = 0,
  adjusted = 0,
  used = excluded.used,
  available = excluded.available,
  updated_at = now();

-- Capture allocation ids
update tmp_leave_sync_2026 t
set allocation_id = la.id
from public.leave_allocations la
where la.employee_id = t.employee_id
  and la.leave_type_id = t.leave_type_id
  and la.period = '2026';

-- Rebuild ledger ONLY for these allocations so recompute matches Excel
delete from public.leave_ledger ll
using tmp_leave_sync_2026 t
where ll.allocation_id = t.allocation_id;

insert into public.leave_ledger (
  employee_id,
  leave_type_id,
  allocation_id,
  transaction_type,
  quantity,
  reference_type,
  reference_id
)
select
  t.employee_id,
  t.leave_type_id,
  t.allocation_id,
  'ALLOCATION',
  t.allocated,
  'excel_sync_2026',
  null
from tmp_leave_sync_2026 t;

insert into public.leave_ledger (
  employee_id,
  leave_type_id,
  allocation_id,
  transaction_type,
  quantity,
  reference_type,
  reference_id
)
select
  t.employee_id,
  t.leave_type_id,
  t.allocation_id,
  'LEAVE_APPROVED',
  -t.used,
  'excel_sync_2026',
  null
from tmp_leave_sync_2026 t
where t.used > 0;

-- Recompute so allocated / used / available stay consistent with ledger
do $$
declare
  r record;
begin
  for r in select allocation_id from tmp_leave_sync_2026 loop
    perform public.recompute_leave_allocation(r.allocation_id);
  end loop;
end $$;

-- Verification (should match Excel + overrides)
select
  e.full_name,
  e.employee_code,
  lt.code as leave_code,
  la.period,
  la.allocated,
  la.used,
  la.available,
  la.adjusted,
  la.carried_forward
from tmp_leave_sync_2026 t
join public.employees e on e.id = t.employee_id
join public.leave_types lt on lt.id = t.leave_type_id
join public.leave_allocations la on la.id = t.allocation_id
order by e.full_name, lt.code;

commit;
