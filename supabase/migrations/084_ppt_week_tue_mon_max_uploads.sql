-- PPT week becomes Tue–Mon; max weekly/JC replaces rises to 10.
-- Shift existing weekly PPT week bounds from Mon–Sun → Tue–Mon (+1 day).

alter table public.weekly_work_updates
  drop constraint if exists weekly_work_updates_upload_count_check;

alter table public.weekly_work_updates
  add constraint weekly_work_updates_upload_count_check
  check (upload_count between 1 and 10);

-- Historical rows were stored as Mon–Sun; move to Tue–Mon so lookups stay aligned.
-- PostgreSQL extract(dow): 0 = Sunday, 1 = Monday.
update public.weekly_work_updates
set
  week_start = week_start + 1,
  week_end = week_end + 1
where extract(dow from week_start) = 1;

update public.weekly_ppt_shares
set
  week_start = week_start + 1,
  week_end = week_end + 1
where extract(dow from week_start) = 1;

comment on table public.weekly_work_updates is
  'Weekly wrap PPT. Week = Tue–Mon IST (Mon meeting day). Upload window Sat 14:00–Sun 23:59 IST; max 10 replaces.';

comment on column public.weekly_work_updates.submission_timing is
  'on_time | last_hour (Sun 23:00–23:59 IST) | late (outside Sat 14:00–Sun 23:59 window).';

comment on column public.weekly_work_updates.late is
  'True when submission_timing = late (outside the Sat–Sun upload window).';

notify pgrst, 'reload schema';
