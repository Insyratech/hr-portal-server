-- =============================================================================
-- Wipe September 2026 attendance import so GM can re-upload and re-decide LOP.
-- =============================================================================
-- Scope (from production screenshots):
--   Import id : 37a2bf5e-74db-498f-ba08-face5e11f992
--   Period    : 2026-09
--   File      : ATTENDRECORD_SEP.XLS / AttendRecord_Sep.xls
--   Status    : CONFIRMED (employees already see published attendance)
--   Payroll   : Not calculated / not published
--
-- What this removes (only for that import / period):
--   1) Draft/calculated payroll_runs + salary_slips linked to this period/import
--   2) attendance_records frozen from this import
--   3) attendance_imports row (cascades import_rows + day_reviews)
--   4) related in-app notifications for this month's publish
--
-- What this does NOT touch:
--   Other months, leave, permissions, shifts, employees, published payroll
--
-- Run in Supabase SQL Editor as a privileged role (postgres / service_role).
-- If anything looks wrong before commit is issued, the script aborts via RAISE.
-- To undo after a mistake: only possible if you have not yet committed — this
-- script ends with COMMIT. Prefer running inside a transaction and reviewing
-- NOTICE / result grids first.
-- =============================================================================

begin;

create temporary table tmp_sep2026_wipe (
  import_id uuid primary key,
  period text not null
) on commit drop;

insert into tmp_sep2026_wipe (import_id, period)
values ('37a2bf5e-74db-498f-ba08-face5e11f992', '2026-09');

-- Safety checks
do $$
declare
  v_import_id uuid;
  v_period text;
  v_file text;
  v_status text;
  v_period_db text;
  v_published_payroll int;
begin
  select import_id, period into v_import_id, v_period from tmp_sep2026_wipe;

  select file_name, status, period
    into v_file, v_status, v_period_db
  from public.attendance_imports
  where id = v_import_id
  for update;

  if not found then
    raise exception 'Import % not found. Aborting.', v_import_id;
  end if;

  if v_period_db is distinct from v_period then
    raise exception
      'Import % period is %, expected %. Aborting.',
      v_import_id, v_period_db, v_period;
  end if;

  select count(*)::int
    into v_published_payroll
  from public.payroll_runs
  where period = v_period
    and status = 'PUBLISHED';

  if v_published_payroll > 0 then
    raise exception
      'Payroll for % is PUBLISHED. Aborting — do not wipe published payroll.',
      v_period;
  end if;

  raise notice 'OK: wiping import % (% / % / %)',
    v_import_id, v_period_db, v_status, v_file;
end $$;

-- Capture frozen attendance_record ids BEFORE detaching FKs.
create temporary table tmp_sep2026_record_ids (
  id uuid primary key
) on commit drop;

insert into tmp_sep2026_record_ids (id)
select distinct adr.attendance_record_id
from public.attendance_day_reviews adr
join tmp_sep2026_wipe w on w.import_id = adr.import_id
where adr.attendance_record_id is not null;

-- Capture employees on this import (for month-range fallback).
create temporary table tmp_sep2026_employees (
  employee_id uuid primary key
) on commit drop;

insert into tmp_sep2026_employees (employee_id)
select distinct adr.employee_id
from public.attendance_day_reviews adr
join tmp_sep2026_wipe w on w.import_id = adr.import_id;

-- Preview
select 'import' as kind, i.id::text as id, i.period, i.status, i.file_name
from public.attendance_imports i
join tmp_sep2026_wipe w on w.import_id = i.id;

select 'day_reviews' as kind, count(*)::int as n
from public.attendance_day_reviews adr
join tmp_sep2026_wipe w on w.import_id = adr.import_id;

select 'import_rows' as kind, count(*)::int as n
from public.attendance_import_rows r
join tmp_sep2026_wipe w on w.import_id = r.import_id;

select 'frozen_records' as kind, count(*)::int as n
from tmp_sep2026_record_ids;

select 'payroll_runs' as kind, pr.id::text as id, pr.period, pr.status
from public.payroll_runs pr
join tmp_sep2026_wipe w on pr.period = w.period
   or pr.attendance_import_id = w.import_id;

-- 1) Non-published payroll for this period / import
delete from public.salary_slips s
using public.payroll_runs pr, tmp_sep2026_wipe w
where s.run_id = pr.id
  and pr.status <> 'PUBLISHED'
  and (pr.period = w.period or pr.attendance_import_id = w.import_id);

delete from public.payroll_runs pr
using tmp_sep2026_wipe w
where pr.status <> 'PUBLISHED'
  and (pr.period = w.period or pr.attendance_import_id = w.import_id);

-- 2) Detach + delete frozen attendance_records for this import
update public.attendance_day_reviews adr
set attendance_record_id = null
from tmp_sep2026_wipe w
where adr.import_id = w.import_id
  and adr.attendance_record_id is not null;

delete from public.attendance_records ar
using tmp_sep2026_record_ids t
where ar.id = t.id;

-- Fallback: any remaining Sep 2026 rows for employees on this import
delete from public.attendance_records ar
using tmp_sep2026_employees e
where ar.employee_id = e.employee_id
  and ar.attendance_date >= date '2026-09-01'
  and ar.attendance_date < date '2026-10-01';

-- 3) Publish notifications for this month / import
delete from public.notifications n
using tmp_sep2026_wipe w
where n.reference_type in ('attendance_import', 'attendance')
  and (
    n.reference_id = w.period
    or n.reference_id = w.import_id::text
  );

-- 4) Delete import(s) for this period (cascades rows + day reviews)
delete from public.attendance_imports i
using tmp_sep2026_wipe w
where i.id = w.import_id
   or i.period = w.period;

-- 5) Verify (all should be 0)
select 'imports_left_for_period' as check_name, count(*)::int as n
from public.attendance_imports
where period = '2026-09';

select 'records_left_for_period' as check_name, count(*)::int as n
from public.attendance_records
where attendance_date >= date '2026-09-01'
  and attendance_date < date '2026-10-01';

select 'payroll_left_for_period' as check_name, count(*)::int as n
from public.payroll_runs
where period = '2026-09';

commit;

-- After this:
--   Attendance list should have no Sep 2026 import.
--   Employees should no longer see published Sep 2026 attendance.
--   GM can Upload and review AttendRecord_Sep.xls again, set LOP flags, then confirm.
