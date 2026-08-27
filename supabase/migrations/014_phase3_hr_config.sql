-- Payroll Phase 3: leave type paid flag and live working-days calendar (Mon–Sat).
-- Weekly off = any weekday missing from organization_settings.working_days.
-- Phase 5 LOP review must call loadWorkingDays(); do not hardcode Saturday or Sunday.

alter table public.leave_types
  add column if not exists paid boolean not null default true;

update public.leave_types
set paid = false
where code = 'LOP';

alter table public.organization_settings
  alter column working_days set default array['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']::text[];

update public.organization_settings
set working_days = array['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']::text[]
where working_days = array['MON', 'TUE', 'WED', 'THU', 'FRI']::text[];

notify pgrst, 'reload schema';
