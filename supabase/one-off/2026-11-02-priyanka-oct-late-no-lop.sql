-- One-off. Priyanka Devi (20260028) October 2026 attendance.
-- 21 Oct and 29 Oct were late from a biometric issue — remove LOP (HALF_LOP / LATE LOP → NO_LOP).
-- Does not rewrite a published payslip. Recalculate October payroll after this if a DRAFT/CALCULATED run exists.
--
-- Import: 87576165-3be3-4b90-ac1c-197a18146af7
-- Employee: a9d32fcf-180f-47ff-ac6a-267b190f5b36

-- =============================================================================
-- STEP 1 — inspect (run first)
-- =============================================================================

select e.id, e.employee_code, e.full_name
from public.employees e
where e.status = 'active'
  and (
    e.employee_code = '20260028'
    or e.id = 'a9d32fcf-180f-47ff-ac6a-267b190f5b36'
    or e.full_name ilike '%priyanka%devi%'
  );

select
  e.full_name,
  e.employee_code,
  i.id as import_id,
  i.period,
  i.status as import_status,
  d.attendance_date,
  d.status as day_status,
  d.late_minutes,
  d.hr_action,
  d.proposed_lop,
  d.final_lop,
  d.needs_hr_decision,
  d.reason
from public.employees e
join public.attendance_day_reviews d on d.employee_id = e.id
join public.attendance_imports i on i.id = d.import_id
where e.employee_code = '20260028'
  and d.attendance_date in (date '2026-10-21', date '2026-10-29')
order by i.created_at desc, d.attendance_date;

select r.period, r.status as payroll_status, s.lop_days, s.net
from public.employees e
left join public.salary_slips s on s.employee_id = e.id
left join public.payroll_runs r on r.id = s.run_id
where e.employee_code = '20260028'
  and (r.period = '2026-10' or r.period is null);

-- =============================================================================
-- STEP 2 — set those days to NO_LOP
-- =============================================================================

begin;

update public.attendance_day_reviews d
set
  hr_action = 'NO_LOP',
  proposed_lop = 0,
  final_lop = 0,
  needs_hr_decision = false,
  skipped_from_lop = false,
  reason = 'Biometric issue — late mark waived. NO_LOP (SQL one-off 2026-11-02).'
from public.employees e,
     public.attendance_imports i
where d.employee_id = e.id
  and d.import_id = i.id
  and e.employee_code = '20260028'
  and i.period = '2026-10'
  and i.status <> 'REJECTED'
  and d.attendance_date in (date '2026-10-21', date '2026-10-29')
  and (
    d.hr_action in ('HALF_LOP', 'FULL_LOP')
    or coalesce(d.final_lop, 0) > 0
    or coalesce(d.proposed_lop, 0) > 0
    or d.status in ('LATE', 'HALF_DAY')
  );

commit;

-- =============================================================================
-- STEP 3 — verify: hr_action NO_LOP, final_lop 0
-- =============================================================================

select
  e.full_name,
  d.attendance_date,
  d.status,
  d.hr_action,
  d.proposed_lop,
  d.final_lop
from public.employees e
join public.attendance_day_reviews d on d.employee_id = e.id
join public.attendance_imports i on i.id = d.import_id
where e.employee_code = '20260028'
  and i.period = '2026-10'
  and i.status <> 'REJECTED'
  and d.attendance_date in (date '2026-10-21', date '2026-10-29')
order by d.attendance_date;
