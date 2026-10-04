-- =============================================================================
-- One-off fix: Priyanka Devi (20260028) — Sep 2026 published salary slip
-- =============================================================================
-- Problem: HRA stored as 3000 (50% of Basic 6000) instead of 2700 (45%).
--          CTC / Net show 12300; should be 12000.
-- Scope:   THIS employee + THIS payroll run only. Other slips untouched.
--
-- Run in Supabase SQL Editor as postgres / service_role.
-- Recommended: run Step 1, review rows, then Step 2, then Step 3.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Step 1 — Preview (safe, no changes)
-- ---------------------------------------------------------------------------
select
  s.id as slip_id,
  r.id as run_id,
  r.period,
  r.status,
  s.employee_code,
  s.employee_name,
  s.basic,
  s.da,
  s.hra,
  s.fuel,
  s.incentives,
  s.other_earnings,
  s.gross,
  s.daily_rate,
  s.net,
  s.working_days,
  s.calendar_days
from public.salary_slips s
join public.payroll_runs r on r.id = s.run_id
where r.period = '2026-09'
  and s.employee_code = '20260028'
  and s.employee_name ilike '%Priyanka%';

-- Also check master compensation (so next month is not wrong again)
select
  e.employee_code,
  e.full_name,
  c.id as compensation_id,
  c.basic,
  c.da,
  c.hra,
  c.fuel,
  c.effective_from
from public.employees e
join public.employee_compensation c on c.employee_id = e.id
where e.employee_code = '20260028'
order by c.effective_from desc;

-- ---------------------------------------------------------------------------
-- Step 2 — Correct the published slip only
-- ---------------------------------------------------------------------------
-- Math check:
--   Basic 6000 + DA 2400 + HRA 2700 + Fuel 900 = 12000
--   calendar_days 30 → daily_rate = 12000 / 30 = 400
--   deductions / LOP = 0 → net = 12000
-- ---------------------------------------------------------------------------

do $$
declare
  n int;
begin
  update public.salary_slips s
  set
    hra = 2700.00,
    gross = 12000.00,
    daily_rate = 400.00,
    net = 12000.00
  from public.payroll_runs r
  where s.run_id = r.id
    and r.period = '2026-09'
    and r.status = 'PUBLISHED'
    and s.employee_code = '20260028'
    and s.hra = 3000.00
    and s.gross = 12300.00;

  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'Expected exactly 1 slip update, got %. No changes applied.', n;
  end if;
  raise notice 'Updated % salary slip row for Priyanka Devi (20260028).', n;
end $$;

-- ---------------------------------------------------------------------------
-- Step 3 — Verify slip after update
-- ---------------------------------------------------------------------------
select
  s.employee_code,
  s.employee_name,
  s.basic,
  s.hra,
  s.gross,
  s.daily_rate,
  s.net
from public.salary_slips s
join public.payroll_runs r on r.id = s.run_id
where r.period = '2026-09'
  and s.employee_code = '20260028';

-- ---------------------------------------------------------------------------
-- Step 4 (recommended) — Fix master compensation HRA if it is still 3000
-- ---------------------------------------------------------------------------
-- Uncomment and run only after confirming Step 1 compensation preview.
-- This does NOT change other employees. Only Priyanka's latest / matching row.
/*
begin;

update public.employee_compensation c
set hra = 2700.00
from public.employees e
where c.employee_id = e.id
  and e.employee_code = '20260028'
  and c.hra = 3000.00
  and c.basic = 6000.00;

commit;

select e.employee_code, c.basic, c.hra, c.effective_from
from public.employee_compensation c
join public.employees e on e.id = c.employee_id
where e.employee_code = '20260028'
order by c.effective_from desc;
*/
