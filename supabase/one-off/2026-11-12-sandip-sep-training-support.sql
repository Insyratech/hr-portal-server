-- September 2026 payslip only: Sandip Kumar Yadav (ID2025009).
-- Same training support as October: ₹10,000 added to gross (52,000 + 10,000 = 62,000)
-- and deducted on the slip.
-- Professional tax and welfare stay as stored, so net is
-- 62,000 − 10,000 − professional tax − welfare − other stored deductions.
-- October and every other employee are left as they are.
--
-- Run STEP 1, confirm one September row, then run STEP 2.

-- =============================================================================
-- STEP 1 — inspect
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
where r.period = '2026-09'
  and e.employee_code = 'ID2025009'
  and e.full_name = 'Sandip Kumar Yadav';

-- =============================================================================
-- STEP 2 — apply
-- =============================================================================

update public.salary_slips s
set
  gross = 62000,
  daily_rate = round(62000::numeric / s.calendar_days, 2),
  particulars = coalesce(s.particulars, '{}'::jsonb) || jsonb_build_object('trainingSupport', 10000),
  net = round(
    62000
      - s.professional_tax
      - s.tds
      - s.employee_welfare
      - s.kpi
      - s.other_deductions
      - s.lop_amount
      - 10000,
    2
  )
from public.employees e, public.payroll_runs r
where s.employee_id = e.id
  and s.run_id = r.id
  and r.period = '2026-09'
  and e.employee_code = 'ID2025009'
  and e.full_name = 'Sandip Kumar Yadav';

-- =============================================================================
-- STEP 3 — verify
-- =============================================================================

select
  e.employee_code,
  e.full_name,
  r.period,
  s.calendar_days,
  s.gross,
  s.particulars ->> 'trainingSupport' as training_support,
  s.professional_tax,
  s.employee_welfare,
  s.net
from public.salary_slips s
join public.employees e on e.id = s.employee_id
join public.payroll_runs r on r.id = s.run_id
where r.period = '2026-09'
  and e.employee_code = 'ID2025009';
