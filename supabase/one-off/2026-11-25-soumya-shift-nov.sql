-- One-off (Supabase SQL editor).
-- Soumya Kanta Hati (20260032 / 52f6052d-163d-4d20-b33e-2e3a2d1f5126):
-- rebuild November 2026 shift assignment history from the manager roster.
--
-- Target history (attendance uses these ranges by date):
--   Night Shift    2026-11-13 → 2026-11-16
--   Evening Shift  2026-11-17 → 2026-11-17
--   General Shift  2026-11-18 → 2026-11-18
--   Evening Shift  2026-11-19 → 2026-11-19
--   General Shift  2026-11-20 → 2026-11-20
--   Evening Shift  2026-11-21 → open (Current)
--
-- Keeps older rows that end on or before 2026-11-12 (e.g. Evening until 12 Nov).
-- Does not create compensatory leave for 21 Nov — shift only.
-- Does not rewrite attendance imports or payslips.
--
-- Fix vs previous draft: shift lookup no longer requires active = true.
-- Production had only 2 of those three marked active, which raised:
--   Expected exactly 3 active shifts named Night / Evening / General, found 2.
--
-- Run STEP 1 first. Confirm one Soumya and that Night / Evening / General appear
-- (active or inactive). Then run STEP 2 alone (do not re-run STEP 1 in the same go).

-- =============================================================================
-- STEP 1 — inspect
-- =============================================================================

select e.id, e.employee_code, e.full_name, e.status
from public.employees e
where e.deleted_at is null
  and (
    e.id = '52f6052d-163d-4d20-b33e-2e3a2d1f5126'
    or e.employee_code = '20260032'
    or e.full_name ilike 'Soumya Kanta Hati'
    or e.full_name ilike '%soumya%hati%'
  )
order by e.full_name;

-- Show matching shifts even if inactive (that was the earlier failure).
select id, name, start_time, end_time, active
from public.shifts
where lower(btrim(name)) in ('night shift', 'evening shift', 'general shift')
order by name, active desc;

-- Full shift list if a name differs slightly
select id, name, start_time, end_time, active
from public.shifts
order by name;

select
  sa.id,
  s.name as shift_name,
  sa.effective_from,
  sa.effective_to,
  case
    when sa.effective_to is null then 'Current'
    else 'Until ' || sa.effective_to::text
  end as status
from public.shift_assignments sa
join public.shifts s on s.id = sa.shift_id
where sa.employee_id = '52f6052d-163d-4d20-b33e-2e3a2d1f5126'
order by sa.effective_from desc;

-- =============================================================================
-- STEP 2 — apply (run this block by itself after STEP 1 looks correct)
-- =============================================================================

begin;

do $$
declare
  v_emp_id uuid := '52f6052d-163d-4d20-b33e-2e3a2d1f5126';
  v_emp_name text;
  v_night_id uuid;
  v_evening_id uuid;
  v_general_id uuid;
  v_missing text := '';
begin
  select e.full_name into v_emp_name
  from public.employees e
  where e.id = v_emp_id
    and e.deleted_at is null
    and (
      e.employee_code = '20260032'
      or e.full_name ilike 'Soumya Kanta Hati'
      or e.full_name ilike '%soumya%hati%'
    );

  if v_emp_name is null then
    raise exception 'Employee % is not Soumya Kanta Hati (20260032). Nothing was changed.', v_emp_id;
  end if;

  -- Prefer an active row; fall back to inactive so a deactivated catalog shift still works.
  select s.id into v_night_id
  from public.shifts s
  where lower(btrim(s.name)) = 'night shift'
  order by s.active desc, s.created_at asc
  limit 1;

  select s.id into v_evening_id
  from public.shifts s
  where lower(btrim(s.name)) = 'evening shift'
  order by s.active desc, s.created_at asc
  limit 1;

  select s.id into v_general_id
  from public.shifts s
  where lower(btrim(s.name)) = 'general shift'
  order by s.active desc, s.created_at asc
  limit 1;

  if v_night_id is null then
    v_missing := v_missing || ' Night Shift;';
  end if;
  if v_evening_id is null then
    v_missing := v_missing || ' Evening Shift;';
  end if;
  if v_general_id is null then
    v_missing := v_missing || ' General Shift;';
  end if;

  if v_missing <> '' then
    raise exception
      'Missing shift catalog row(s):%. Run STEP 1 and check public.shifts names.',
      v_missing;
  end if;

  -- Drop every assignment that starts on or after 13 Nov (rebuild that stretch).
  -- Removes the mistaken "Night Shift Current from 13 Nov" row.
  delete from public.shift_assignments
  where employee_id = v_emp_id
    and effective_from >= date '2026-11-13';

  -- Older history (e.g. Evening until 12 Nov) must end on or before 12 Nov
  -- so only the new 21 Nov Evening row is Current.
  update public.shift_assignments
  set effective_to = date '2026-11-12'
  where employee_id = v_emp_id
    and effective_from < date '2026-11-13'
    and (effective_to is null or effective_to >= date '2026-11-13');

  -- One row per effective_from (unique). Dates match the manager roster.
  -- Evening Shift catalog is 1:30 pm – 10:00 pm (used for 17, 19, and Current).
  insert into public.shift_assignments (
    employee_id, shift_id, effective_from, effective_to
  ) values
    (v_emp_id, v_night_id,   date '2026-11-13', date '2026-11-16'),
    (v_emp_id, v_evening_id, date '2026-11-17', date '2026-11-17'),
    (v_emp_id, v_general_id, date '2026-11-18', date '2026-11-18'),
    (v_emp_id, v_evening_id, date '2026-11-19', date '2026-11-19'),
    (v_emp_id, v_general_id, date '2026-11-20', date '2026-11-20'),
    (v_emp_id, v_evening_id, date '2026-11-21', null);

  raise notice
    'Soumya % shift history rebuilt: Night 13–16, Eve 17, Gen 18, Eve 19, Gen 20, Eve Current from 21. night=% evening=% general=%',
    v_emp_name, v_night_id, v_evening_id, v_general_id;
end;
$$;

commit;

-- =============================================================================
-- STEP 3 — verify
-- =============================================================================

select
  e.full_name,
  s.name as shift_name,
  s.active as shift_active,
  sa.effective_from,
  sa.effective_to,
  case
    when sa.effective_to is null then 'Current'
    else 'Until ' || sa.effective_to::text
  end as status
from public.shift_assignments sa
join public.employees e on e.id = sa.employee_id
join public.shifts s on s.id = sa.shift_id
where sa.employee_id = '52f6052d-163d-4d20-b33e-2e3a2d1f5126'
order by sa.effective_from desc;

with days as (
  select d::date as attendance_date
  from generate_series(date '2026-11-13', date '2026-11-22', interval '1 day') as d
)
select
  days.attendance_date,
  s.name as shift_name,
  sa.effective_from,
  sa.effective_to
from days
left join lateral (
  select sa.*
  from public.shift_assignments sa
  where sa.employee_id = '52f6052d-163d-4d20-b33e-2e3a2d1f5126'
    and sa.effective_from <= days.attendance_date
    and (sa.effective_to is null or sa.effective_to >= days.attendance_date)
  order by sa.effective_from desc
  limit 1
) sa on true
left join public.shifts s on s.id = sa.shift_id
order by days.attendance_date;
