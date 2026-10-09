-- PPT late-upload concerns (weekly + JC). CSO approves → one late upload reopen.
-- Unapproved/rejected concerns surface as red flags on the GM monthly report.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ppt-concern-screenshots',
  'ppt-concern-screenshots',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update
set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.ppt_upload_concerns (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('weekly', 'jc')),
  employee_id uuid not null references public.employees (id) on delete cascade,
  week_start date not null,
  week_end date not null,
  reason text not null,
  screenshot_path text,
  screenshot_file_name text,
  screenshot_content_type text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.employees (id) on delete set null,
  reviewed_at timestamptz,
  review_note text not null default '',
  late_upload_used boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ppt_upload_concerns_employee_idx
  on public.ppt_upload_concerns (employee_id, week_start desc);
create index if not exists ppt_upload_concerns_status_idx
  on public.ppt_upload_concerns (status, kind, week_start desc);
create index if not exists ppt_upload_concerns_week_idx
  on public.ppt_upload_concerns (week_start, kind);

-- One open (pending/approved unused) concern per employee+week+kind.
create unique index if not exists ppt_upload_concerns_open_unique
  on public.ppt_upload_concerns (employee_id, week_start, kind)
  where status in ('pending', 'approved') and late_upload_used = false;

drop trigger if exists ppt_upload_concerns_set_updated_at on public.ppt_upload_concerns;
create trigger ppt_upload_concerns_set_updated_at
  before update on public.ppt_upload_concerns
  for each row execute procedure public.set_updated_at();

alter table public.ppt_upload_concerns enable row level security;

drop policy if exists ppt_upload_concerns_select on public.ppt_upload_concerns;
create policy ppt_upload_concerns_select on public.ppt_upload_concerns for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('work.view')
    or public.authorize('work.assign')
  );

drop policy if exists ppt_upload_concerns_insert on public.ppt_upload_concerns;
create policy ppt_upload_concerns_insert on public.ppt_upload_concerns for insert to authenticated
  with check (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

drop policy if exists ppt_upload_concerns_update on public.ppt_upload_concerns;
create policy ppt_upload_concerns_update on public.ppt_upload_concerns for update to authenticated
  using (public.authorize('work.view') or public.authorize('work.assign'));

grant all on public.ppt_upload_concerns to service_role;

comment on table public.ppt_upload_concerns is
  'Late/missed PPT upload concerns. CSO approve unlocks one late upload; rejected/pending → GM red flag.';

notify pgrst, 'reload schema';
