-- Weekly PPT lateness is a three-state tag instead of a single "after Sunday 18:00" flag:
--   on_time    submitted up to Sunday 22:59 IST
--   last_hour  submitted Sunday 23:00–23:59 IST  ("Last hour submission")
--   late       submitted after Sunday 23:59 IST
-- The `late` boolean stays as the derived flag (timing = 'late') so existing readers keep working.

alter table public.weekly_work_updates
  add column if not exists submission_timing text;

-- Backfill from the actual submission time in IST, which also clears the decks that were
-- wrongly tagged Late for arriving between Sunday 18:00 and 23:59.
update public.weekly_work_updates
set submission_timing = case
      when (submitted_at at time zone 'Asia/Kolkata')::date > (week_start + 6) then 'late'
      when (submitted_at at time zone 'Asia/Kolkata')::date = (week_start + 6)
        and extract(hour from (submitted_at at time zone 'Asia/Kolkata')) >= 23 then 'last_hour'
      else 'on_time'
    end
where submission_timing is null;

update public.weekly_work_updates
set late = (submission_timing = 'late')
where late is distinct from (submission_timing = 'late');

alter table public.weekly_work_updates
  alter column submission_timing set default 'on_time';

alter table public.weekly_work_updates
  alter column submission_timing set not null;

alter table public.weekly_work_updates
  drop constraint if exists weekly_work_updates_submission_timing_check;

alter table public.weekly_work_updates
  add constraint weekly_work_updates_submission_timing_check
  check (submission_timing in ('on_time', 'last_hour', 'late'));

comment on column public.weekly_work_updates.submission_timing is
  'on_time up to Sun 22:59 IST, last_hour Sun 23:00–23:59 IST, late after Sunday. Source of truth for the badge.';
comment on column public.weekly_work_updates.late is
  'Derived from submission_timing: true only when submission_timing = late.';

comment on table public.weekly_work_updates is
  'Employee weekly wrap PPT (Mon–Sun week). Max 2 uploads/week; 2nd replaces 1st. Deadline Sun 23:59 IST; 23:00–23:59 is a last-hour submission. Max 15 MB. GM may remove storage file; row kept for audit.';

notify pgrst, 'reload schema';
