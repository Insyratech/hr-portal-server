-- One-off. October 2026 payslips.
--
-- 1. 31 Oct miss punch that is not LOP (no FULL_LOP / HALF_LOP, final_lop is 0)
--    and is not an approved leave day is cleared on the confirmed October attendance:
--    status becomes PRESENT, hr_action NO_LOP.
--    A 31 Oct miss punch that already has LOP is left as it is.
-- 2. Salary-slip leave particulars are rebuilt from that attendance.
--    Approved leave (CL, SL, ML, EL, maternity / paternity) stays on the slip,
--    whether or not that day is LOP. Half-day leave counts as 0.5.
--    Absent, miss punch, and late days stay only when the day is mapped to LOP
--    (final_lop > 0 or hr_action FULL_LOP / HALF_LOP) and is not an approved leave day.
--    Pay (gross, lop_days, lop_amount, net) is not recalculated.
--    Permissions already on the slip are left as they are.
--
-- Run STEP 1 in the Supabase SQL editor and read it.
-- Then run STEP 2. Then run STEP 3.

-- =============================================================================
-- STEP 1 — inspect
-- =============================================================================

select
  e.employee_code,
  e.full_name,
  d.attendance_date,
  d.status,
  d.hr_action,
  d.final_lop,
  d.proposed_lop,
  d.leave_type_name,
  d.leave_duration,
  d.leave_paid,
  case
    when d.attendance_date = date '2026-10-31'
      and d.status = 'MISSING_PUNCH'
      and d.leave_type_name is null
      and coalesce(d.hr_action, '') not in ('FULL_LOP', 'HALF_LOP')
      and coalesce(d.final_lop, 0) = 0
    then 'clear 31 Oct miss punch'
    when d.leave_type_name is not null
    then 'keep approved leave on payslip'
    when coalesce(d.final_lop, 0) > 0
      or d.hr_action in ('FULL_LOP', 'HALF_LOP')
    then 'keep on payslip (LOP)'
    else 'drop from payslip counts'
  end as slip_effect
from public.payroll_runs r
join public.attendance_imports i on i.id = r.attendance_import_id
join public.attendance_day_reviews d on d.import_id = i.id
join public.employees e on e.id = d.employee_id
where r.period = '2026-10'
  and (
    d.attendance_date = date '2026-10-31'
    or d.status in ('MISSING_PUNCH', 'ABSENT', 'LATE', 'LEAVE', 'HALF_DAY')
    or d.leave_type_name is not null
    or coalesce(d.final_lop, 0) > 0
    or d.hr_action in ('FULL_LOP', 'HALF_LOP', 'NO_LOP')
  )
order by e.full_name, d.attendance_date;

-- =============================================================================
-- STEP 2 — clear non-LOP 31 Oct miss punches, then rebuild slip particulars
-- =============================================================================

begin;

update public.attendance_day_reviews d
set
  status = 'PRESENT',
  hr_action = 'NO_LOP',
  proposed_lop = 0,
  final_lop = 0,
  needs_hr_decision = false,
  skipped_from_lop = true,
  reason = '31 Oct miss punch cleared — not LOP. Removed from the payslip (SQL 2026-11-03).'
from public.payroll_runs r
join public.attendance_imports i on i.id = r.attendance_import_id
where d.import_id = i.id
  and r.period = '2026-10'
  and d.attendance_date = date '2026-10-31'
  and d.status = 'MISSING_PUNCH'
  and d.leave_type_name is null
  and coalesce(d.hr_action, '') not in ('FULL_LOP', 'HALF_LOP')
  and coalesce(d.final_lop, 0) = 0;

update public.attendance_records ar
set status = 'PRESENT'
from public.attendance_day_reviews d
join public.payroll_runs r on r.period = '2026-10'
join public.attendance_imports i on i.id = r.attendance_import_id
where d.import_id = i.id
  and ar.id = d.attendance_record_id
  and d.attendance_date = date '2026-10-31'
  and d.status = 'PRESENT'
  and d.hr_action = 'NO_LOP'
  and d.reason = '31 Oct miss punch cleared — not LOP. Removed from the payslip (SQL 2026-11-03).'
  and ar.status = 'MISSING_PUNCH';

update public.salary_slips s
set particulars = s.particulars || jsonb_build_object(
  'cl', agg.cl,
  'sl', agg.sl,
  'ml', agg.ml,
  'el', agg.el,
  'maternityPaternity', agg.maternity_paternity,
  'missPunch', agg.miss_punch,
  'lateDays', agg.late_days,
  'absent', agg.absent,
  'totalLop', s.lop_days
)
from (
  select
    s2.id as slip_id,
    coalesce(sum(
      case
        when d.leave_type_name is null then 0
        when upper(coalesce(lt.code, '')) = 'CL'
          or lower(d.leave_type_name) like '%casual%'
        then case when d.leave_duration = 'half' then 0.5 else 1 end
        else 0
      end
    ), 0) as cl,
    coalesce(sum(
      case
        when d.leave_type_name is null then 0
        when upper(coalesce(lt.code, '')) = 'SL'
          or lower(d.leave_type_name) like '%sick%'
        then case when d.leave_duration = 'half' then 0.5 else 1 end
        else 0
      end
    ), 0) as sl,
    coalesce(sum(
      case
        when d.leave_type_name is null then 0
        when upper(coalesce(lt.code, '')) = 'ML'
          or lower(d.leave_type_name) like '%menstrual%'
        then case when d.leave_duration = 'half' then 0.5 else 1 end
        else 0
      end
    ), 0) as ml,
    coalesce(sum(
      case
        when d.leave_type_name is null then 0
        when upper(coalesce(lt.code, '')) = 'EL'
          or lower(d.leave_type_name) like '%earned%'
          or lower(d.leave_type_name) like '%privilege%'
        then case when d.leave_duration = 'half' then 0.5 else 1 end
        else 0
      end
    ), 0) as el,
    coalesce(sum(
      case
        when d.leave_type_name is null then 0
        when upper(coalesce(lt.code, '')) in ('MAT', 'PAT')
          or lower(d.leave_type_name) like '%maternity%'
          or lower(d.leave_type_name) like '%paternity%'
        then case when d.leave_duration = 'half' then 0.5 else 1 end
        else 0
      end
    ), 0) as maternity_paternity,
    count(*) filter (
      where d.status = 'MISSING_PUNCH'
        and d.leave_type_name is null
        and (
          coalesce(d.final_lop, 0) > 0
          or d.hr_action in ('FULL_LOP', 'HALF_LOP')
        )
    ) as miss_punch,
    count(*) filter (
      where d.status = 'LATE'
        and d.leave_type_name is null
        and (
          coalesce(d.final_lop, 0) > 0
          or d.hr_action in ('FULL_LOP', 'HALF_LOP')
        )
    ) as late_days,
    count(*) filter (
      where d.status = 'ABSENT'
        and d.leave_type_name is null
        and (
          coalesce(d.final_lop, 0) > 0
          or d.hr_action in ('FULL_LOP', 'HALF_LOP')
        )
    ) as absent
  from public.salary_slips s2
  join public.payroll_runs r on r.id = s2.run_id
  join public.attendance_day_reviews d
    on d.import_id = r.attendance_import_id
   and d.employee_id = s2.employee_id
  left join public.leave_types lt
    on lower(lt.name) = lower(d.leave_type_name)
  where r.period = '2026-10'
  group by s2.id
) agg
where s.id = agg.slip_id;

commit;

-- =============================================================================
-- STEP 3 — verify
-- =============================================================================

select
  e.employee_code,
  e.full_name,
  d.attendance_date,
  d.status,
  d.hr_action,
  d.final_lop,
  d.leave_type_name,
  d.reason
from public.payroll_runs r
join public.attendance_day_reviews d on d.import_id = r.attendance_import_id
join public.employees e on e.id = d.employee_id
where r.period = '2026-10'
  and d.attendance_date = date '2026-10-31'
order by e.full_name;

select
  s.employee_code,
  s.employee_name,
  s.lop_days,
  s.particulars ->> 'cl' as cl,
  s.particulars ->> 'sl' as sl,
  s.particulars ->> 'ml' as ml,
  s.particulars ->> 'el' as el,
  s.particulars ->> 'maternityPaternity' as maternity_paternity,
  s.particulars ->> 'missPunch' as miss_punch,
  s.particulars ->> 'absent' as absent,
  s.particulars ->> 'lateDays' as late_days,
  s.particulars ->> 'totalLop' as total_lop
from public.salary_slips s
join public.payroll_runs r on r.id = s.run_id
where r.period = '2026-10'
order by s.employee_name;
