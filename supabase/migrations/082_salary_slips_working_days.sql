-- Payable working days on salary slips (distinct from calendar days and LOP).
-- Apply after 081_attendance_records_no_shift.sql.

alter table public.salary_slips
  add column if not exists working_days numeric(8, 2);

-- Existing slips were calculated for the full calendar month.
update public.salary_slips
set working_days = calendar_days
where working_days is null;

alter table public.salary_slips
  alter column working_days set default 0,
  alter column working_days set not null;

notify pgrst, 'reload schema';
