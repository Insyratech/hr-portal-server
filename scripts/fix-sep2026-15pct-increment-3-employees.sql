-- =============================================================================
-- One-off: 15% increment — Dheetan, Shivam, Badur (Sep 2026 PUBLISHED slips)
-- =============================================================================
-- Scope: ONLY these 3 employee_codes on period 2026-09. Other slips untouched.
-- Keeps incentives + all deductions as stored; updates Basic/DA/HRA/Fuel,
-- then recomputes gross, daily_rate, net.
--
-- Also updates employee_compensation (HR master) so next month uses new pay.
--
-- Targets (from business):
--   Dheetan 20260018 / Shivam 20250014:
--     package 46000 → Basic 23000, DA 9200, HRA 10350, Fuel 3450
--   Badur 20260008:
--     package 25300 → Basic 12650, DA 5060, HRA 5692.50, Fuel 1897.50
--
-- Run in Supabase SQL Editor (postgres / service_role).
-- Do Step 1 → review → Step 2 → Step 3 → Step 4.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Step 1 — Preview published slips (safe)
-- ---------------------------------------------------------------------------
select
  s.id as slip_id,
  r.status,
  s.employee_code,
  s.employee_name,
  s.basic,
  s.da,
  s.hra,
  s.fuel,
  s.incentives,
  s.professional_tax,
  s.employee_welfare,
  s.gross as ctc,
  s.daily_rate,
  s.net,
  s.calendar_days,
  s.working_days
from public.salary_slips s
join public.payroll_runs r on r.id = s.run_id
where r.period = '2026-09'
  and r.status = 'PUBLISHED'
  and s.employee_code in ('20260018', '20250014', '20260008')
order by s.employee_code;

-- Preview HR master compensation
select
  e.employee_code,
  e.full_name,
  c.id as compensation_id,
  c.basic,
  c.da,
  c.hra,
  c.fuel,
  c.incentives,
  c.effective_from
from public.employees e
join public.employee_compensation c on c.employee_id = e.id
where e.employee_code in ('20260018', '20250014', '20260008')
order by e.employee_code, c.effective_from desc;

-- ---------------------------------------------------------------------------
-- Step 2 — Update PUBLISHED salary_slips (3 rows only)
-- ---------------------------------------------------------------------------
-- Math (incentives kept; PT+Welfare unchanged from slip):
--   Dheetan: gross = 46000 + incentives(0) = 46000
--            net   = 46000 - 200 - 500 = 45300
--            rate  = round(46000/30, 2) = 1533.33
--   Shivam:  gross = 46000 + incentives(1150) = 47150
--            net   = 47150 - 200 - 500 = 46450
--            rate  = round(47150/30, 2) = 1571.67
--   Badur:   gross = 25300 + incentives(1270) = 26570
--            net   = 26570 - 200 - 500 = 25870
--            rate  = round(26570/30, 2) = 885.67
-- ---------------------------------------------------------------------------

do $$
declare
  n int;
begin
  -- Dheetan Parth Sarthi (20260018)
  update public.salary_slips s
  set
    basic = 23000.00,
    da = 9200.00,
    hra = 10350.00,
    fuel = 3450.00,
    gross = round((23000.00 + 9200.00 + 10350.00 + 3450.00 + s.incentives + s.other_earnings)::numeric, 2),
    daily_rate = round(
      (23000.00 + 9200.00 + 10350.00 + 3450.00 + s.incentives + s.other_earnings)
        / nullif(s.calendar_days, 0)::numeric,
      2
    ),
    net = round(
      (23000.00 + 9200.00 + 10350.00 + 3450.00 + s.incentives + s.other_earnings)
        - s.professional_tax - s.tds - s.employee_welfare - s.kpi - s.other_deductions - s.lop_amount,
      2
    )
  from public.payroll_runs r
  where s.run_id = r.id
    and r.period = '2026-09'
    and r.status = 'PUBLISHED'
    and s.employee_code = '20260018';

  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'Dheetan (20260018): expected 1 slip update, got %.', n;
  end if;

  -- Shivam Shekhar (20250014)
  update public.salary_slips s
  set
    basic = 23000.00,
    da = 9200.00,
    hra = 10350.00,
    fuel = 3450.00,
    gross = round((23000.00 + 9200.00 + 10350.00 + 3450.00 + s.incentives + s.other_earnings)::numeric, 2),
    daily_rate = round(
      (23000.00 + 9200.00 + 10350.00 + 3450.00 + s.incentives + s.other_earnings)
        / nullif(s.calendar_days, 0)::numeric,
      2
    ),
    net = round(
      (23000.00 + 9200.00 + 10350.00 + 3450.00 + s.incentives + s.other_earnings)
        - s.professional_tax - s.tds - s.employee_welfare - s.kpi - s.other_deductions - s.lop_amount,
      2
    )
  from public.payroll_runs r
  where s.run_id = r.id
    and r.period = '2026-09'
    and r.status = 'PUBLISHED'
    and s.employee_code = '20250014';

  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'Shivam (20250014): expected 1 slip update, got %.', n;
  end if;

  -- Badur Chakritha (20260008)
  update public.salary_slips s
  set
    basic = 12650.00,
    da = 5060.00,
    hra = 5692.50,
    fuel = 1897.50,
    gross = round((12650.00 + 5060.00 + 5692.50 + 1897.50 + s.incentives + s.other_earnings)::numeric, 2),
    daily_rate = round(
      (12650.00 + 5060.00 + 5692.50 + 1897.50 + s.incentives + s.other_earnings)
        / nullif(s.calendar_days, 0)::numeric,
      2
    ),
    net = round(
      (12650.00 + 5060.00 + 5692.50 + 1897.50 + s.incentives + s.other_earnings)
        - s.professional_tax - s.tds - s.employee_welfare - s.kpi - s.other_deductions - s.lop_amount,
      2
    )
  from public.payroll_runs r
  where s.run_id = r.id
    and r.period = '2026-09'
    and r.status = 'PUBLISHED'
    and s.employee_code = '20260008';

  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'Badur (20260008): expected 1 slip update, got %.', n;
  end if;

  raise notice 'Updated 3 published salary slips for 2026-09.';
end $$;

-- ---------------------------------------------------------------------------
-- Step 3 — Verify slips
-- ---------------------------------------------------------------------------
select
  s.employee_code,
  s.employee_name,
  s.basic,
  s.da,
  s.hra,
  s.fuel,
  s.incentives,
  s.gross as ctc,
  s.daily_rate,
  s.net,
  (s.basic + s.da + s.hra + s.fuel) as package_without_incentives
from public.salary_slips s
join public.payroll_runs r on r.id = s.run_id
where r.period = '2026-09'
  and s.employee_code in ('20260018', '20250014', '20260008')
order by s.employee_code;

-- Expected after Step 2 (with incentives from screenshots):
--   20260018 Dheetan: basic 23000 … fuel 3450, incentives 0,    ctc 46000,  net 45300
--   20250014 Shivam:  basic 23000 … fuel 3450, incentives 1150, ctc 47150,  net 46450
--   20260008 Badur:   basic 12650 … fuel 1897.50, incentives 1270, ctc 26570, net 25870

-- ---------------------------------------------------------------------------
-- Step 4 — Update HR master compensation (latest row per employee)
-- ---------------------------------------------------------------------------
-- Only Basic/DA/HRA/Fuel. Incentives and deductions unchanged.
-- Updates the most recent compensation row for each of the 3 employees.
-- ---------------------------------------------------------------------------

do $$
declare
  n int := 0;
  u int;
begin
  -- Dheetan
  update public.employee_compensation c
  set
    basic = 23000.00,
    da = 9200.00,
    hra = 10350.00,
    fuel = 3450.00
  from public.employees e
  where c.employee_id = e.id
    and e.employee_code = '20260018'
    and c.effective_from = (
      select max(c2.effective_from)
      from public.employee_compensation c2
      where c2.employee_id = e.id
    );
  get diagnostics u = row_count;
  n := n + u;
  if u <> 1 then
    raise exception 'Dheetan compensation: expected 1 row, got %.', u;
  end if;

  -- Shivam
  update public.employee_compensation c
  set
    basic = 23000.00,
    da = 9200.00,
    hra = 10350.00,
    fuel = 3450.00
  from public.employees e
  where c.employee_id = e.id
    and e.employee_code = '20250014'
    and c.effective_from = (
      select max(c2.effective_from)
      from public.employee_compensation c2
      where c2.employee_id = e.id
    );
  get diagnostics u = row_count;
  n := n + u;
  if u <> 1 then
    raise exception 'Shivam compensation: expected 1 row, got %.', u;
  end if;

  -- Badur
  update public.employee_compensation c
  set
    basic = 12650.00,
    da = 5060.00,
    hra = 5692.50,
    fuel = 1897.50
  from public.employees e
  where c.employee_id = e.id
    and e.employee_code = '20260008'
    and c.effective_from = (
      select max(c2.effective_from)
      from public.employee_compensation c2
      where c2.employee_id = e.id
    );
  get diagnostics u = row_count;
  n := n + u;
  if u <> 1 then
    raise exception 'Badur compensation: expected 1 row, got %.', u;
  end if;

  raise notice 'Updated % employee_compensation row(s).', n;
end $$;

-- Verify master
select
  e.employee_code,
  e.full_name,
  c.basic,
  c.da,
  c.hra,
  c.fuel,
  c.incentives,
  c.effective_from
from public.employees e
join public.employee_compensation c on c.employee_id = e.id
where e.employee_code in ('20260018', '20250014', '20260008')
  and c.effective_from = (
    select max(c2.effective_from)
    from public.employee_compensation c2
    where c2.employee_id = e.id
  )
order by e.employee_code;
