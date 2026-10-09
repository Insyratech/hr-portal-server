-- JC PPT: Tue–Mon week, Sat–Sun window metadata, max 10 replaces, paper title + DOI.

alter table public.jc_ppts
  add column if not exists paper_title text not null default '',
  add column if not exists doi_url text not null default '',
  add column if not exists week_start date,
  add column if not exists week_end date,
  add column if not exists upload_count integer not null default 1,
  add column if not exists submission_timing text,
  add column if not exists late boolean not null default false;

-- Backfill week bounds from upload time (IST calendar date → Tue–Mon week).
update public.jc_ppts
set
  week_start =
    ((uploaded_at at time zone 'Asia/Kolkata')::date)
    - ((((extract(dow from (uploaded_at at time zone 'Asia/Kolkata')::date)::integer) - 2 + 7) % 7)),
  week_end =
    ((uploaded_at at time zone 'Asia/Kolkata')::date)
    - ((((extract(dow from (uploaded_at at time zone 'Asia/Kolkata')::date)::integer) - 2 + 7) % 7))
    + 6
where week_start is null;

-- Keep newest row when historical data collides on employee+week.
delete from public.jc_ppts a
using public.jc_ppts b
where a.employee_id = b.employee_id
  and a.week_start is not null
  and b.week_start is not null
  and a.week_start = b.week_start
  and a.uploaded_at < b.uploaded_at;

alter table public.jc_ppts
  alter column week_start set not null,
  alter column week_end set not null;

alter table public.jc_ppts
  drop constraint if exists jc_ppts_upload_count_check;

alter table public.jc_ppts
  add constraint jc_ppts_upload_count_check
  check (upload_count between 1 and 10);

alter table public.jc_ppts
  drop constraint if exists jc_ppts_submission_timing_check;

alter table public.jc_ppts
  add constraint jc_ppts_submission_timing_check
  check (
    submission_timing is null
    or submission_timing in ('on_time', 'last_hour', 'late')
  );

create unique index if not exists jc_ppts_employee_week_unique
  on public.jc_ppts (employee_id, week_start);

create index if not exists jc_ppts_week_start_idx
  on public.jc_ppts (week_start desc);

comment on column public.jc_ppts.paper_title is
  'Research paper title as presented in the JC.';
comment on column public.jc_ppts.doi_url is
  'DOI or link for the research paper presented.';
comment on column public.jc_ppts.week_start is
  'Tue–Mon PPT week start (Tuesday ISO date).';
comment on column public.jc_ppts.upload_count is
  'Replaces within the week; max 10.';
comment on column public.jc_ppts.submission_timing is
  'on_time | last_hour | late (same Sat 14:00–Sun 23:59 IST window as weekly PPT).';
comment on column public.jc_ppts.late is
  'True when submission_timing = late (outside the Sat–Sun upload window).';

notify pgrst, 'reload schema';
