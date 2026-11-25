-- Remove training support from Sandip Kumar Yadav (ID2025009) only —
-- September 2026 (2026-09) and October 2026 (2026-10) published slips.
--
-- Reverses 2026-11-12-sandip-sep-training-support.sql and
-- 2026-11-12-sandip-oct-training-support.sql:
--   • gross back to component total (basic+da+hra+fuel+incentives+other)
--   • drop particulars.trainingSupport
--   • recompute daily_rate and net without the ₹10,000 training line
--
-- No other employee or month is updated.
-- UI already hides the Training support rows when the amount is 0 / missing.
--
-- Run STEP 1, confirm exactly two rows (Sep + Oct) with training_support = 10000,
-- then run STEP 2, then STEP 3.

-- =============================================================================
-- STEP 1 — inspect (expect 2 rows for Sandip only)
-- =============================================================================

select
  e.employee_code,
  e.full_name,
  r.period,
  r.status,
  s.id as slip_id,
  s.calendar_days,
  s.basic + s.da + s.hra + s.fuel + s.incentives + s.other_earnings as component_total,
  s.gross,
  s.professional_tax,
  s.tds,
  s.employee_welfare,
  s.kpi,
  s.other_deductions,
  s.lop_amount,
  s.net,
  s.particulars ->> 'trainingSupport' as training_support
from public.salary_slips s
join public.employees e on e.id = s.employee_id
join public.payroll_runs r on r.id = s.run_id
where r.period in ('2026-09', '2026-10')
  and e.employee_code = 'ID2025009'
  and e.full_name = 'Sandip Kumar Yadav'
order by r.period;

-- =============================================================================
-- STEP 2 — remove training support (Sandip Sep + Oct only)
-- =============================================================================

update public.salary_slips s
set
  gross = round(
    (s.basic + s.da + s.hra + s.fuel + s.incentives + s.other_earnings)::numeric,
    2
  ),
  daily_rate = round(
    (s.basic + s.da + s.hra + s.fuel + s.incentives + s.other_earnings)::numeric
      / nullif(s.calendar_days, 0),
    2
  ),
  particulars = coalesce(s.particulars, '{}'::jsonb) - 'trainingSupport',
  net = round(
    (s.basic + s.da + s.hra + s.fuel + s.incentives + s.other_earnings)::numeric
      - s.professional_tax
      - s.tds
      - s.employee_welfare
      - s.kpi
      - s.other_deductions
      - s.lop_amount,
    2
  )
from public.employees e, public.payroll_runs r
where s.employee_id = e.id
  and s.run_id = r.id
  and r.period in ('2026-09', '2026-10')
  and e.employee_code = 'ID2025009'
  and e.full_name = 'Sandip Kumar Yadav'
  and coalesce((s.particulars ->> 'trainingSupport')::numeric, 0) > 0;

-- =============================================================================
-- STEP 3 — verify (training_support null; gross = component total; net without 10k)
-- =============================================================================

select
  e.employee_code,
  e.full_name,
  r.period,
  s.calendar_days,
  s.basic + s.da + s.hra + s.fuel + s.incentives + s.other_earnings as component_total,
  s.gross,
  s.particulars ->> 'trainingSupport' as training_support,
  s.professional_tax,
  s.employee_welfare,
  s.net
from public.salary_slips s
join public.employees e on e.id = s.employee_id
join public.payroll_runs r on r.id = s.run_id
where r.period in ('2026-09', '2026-10')
  and e.employee_code = 'ID2025009'
  and e.full_name = 'Sandip Kumar Yadav'
order by r.period;
