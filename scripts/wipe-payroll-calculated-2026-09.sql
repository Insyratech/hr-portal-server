-- =============================================================================
-- Remove CALCULATED payroll run(s) for September 2026 so GM can Calculate again.
-- Does NOT delete attendance imports or attendance_records.
-- =============================================================================
-- From portal screenshots: Salary slip · September 2026, run status CALCULATED.
-- Period key: 2026-09
--
-- Run in Supabase SQL Editor (postgres / service_role).
-- =============================================================================

begin;

do $$
declare
  v_period text := '2026-09';
  v_published int;
  v_runs int;
begin
  select count(*)::int into v_published
  from public.payroll_runs
  where period = v_period
    and status = 'PUBLISHED';

  if v_published > 0 then
    raise exception
      'Payroll for % is PUBLISHED. Aborting — unpublish or handle published slips separately.',
      v_period;
  end if;

  select count(*)::int into v_runs
  from public.payroll_runs
  where period = v_period;

  raise notice 'OK: removing % payroll run(s) for % (slips cascade).', v_runs, v_period;
end $$;

-- Preview
select id, period, status, calculated_at, attendance_import_id
from public.payroll_runs
where period = '2026-09';

select count(*)::int as slip_count
from public.salary_slips s
join public.payroll_runs r on r.id = s.run_id
where r.period = '2026-09';

-- Delete slips then run (slips also cascade on run delete; explicit for clarity)
delete from public.salary_slips s
using public.payroll_runs r
where s.run_id = r.id
  and r.period = '2026-09'
  and r.status <> 'PUBLISHED';

delete from public.payroll_runs
where period = '2026-09'
  and status <> 'PUBLISHED';

-- Verify
select 'payroll_runs_left' as check_name, count(*)::int as n
from public.payroll_runs
where period = '2026-09';

select 'salary_slips_left' as check_name, count(*)::int as n
from public.salary_slips s
join public.payroll_runs r on r.id = s.run_id
where r.period = '2026-09';

commit;

-- After this: Payroll hub shows Sep 2026 as Not calculated. Use Calculate again.
