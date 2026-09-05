-- Raise weekly work-update PPT limit 1 MB → 5 MB.
-- Add JC PPT flow: employee upload → CSO transfer to GM → GM download/email (file removed; audit row kept).

update storage.buckets
set file_size_limit = 5242880
where id = 'weekly-work-updates';

alter table public.weekly_work_updates
  drop constraint if exists weekly_work_updates_size_bytes_check;

alter table public.weekly_work_updates
  add constraint weekly_work_updates_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 5242880);

comment on table public.weekly_work_updates is
  'Employee weekly wrap PPT (Mon–Sun week). Max 2 uploads/week; 2nd replaces 1st. late = after Sun 18:00 IST. Max 5 MB.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'jc-ppt-uploads',
  'jc-ppt-uploads',
  false,
  5242880,
  array[
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/octet-stream'
  ]::text[]
)
on conflict (id) do update
set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.jc_ppts (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  storage_path text unique,
  original_file_name text not null,
  system_file_name text not null,
  content_type text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  status text not null default 'uploaded'
    check (status in ('uploaded', 'with_gm', 'downloaded', 'emailed')),
  uploaded_at timestamptz not null default now(),
  transferred_at timestamptz,
  transferred_by uuid references public.employees (id) on delete set null,
  consumed_at timestamptz,
  consumed_by uuid references public.employees (id) on delete set null,
  email_recipient text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jc_ppts_employee_id_idx on public.jc_ppts (employee_id);
create index if not exists jc_ppts_status_idx on public.jc_ppts (status);
create index if not exists jc_ppts_uploaded_at_idx on public.jc_ppts (uploaded_at desc);

drop trigger if exists jc_ppts_set_updated_at on public.jc_ppts;
create trigger jc_ppts_set_updated_at
  before update on public.jc_ppts
  for each row execute procedure public.set_updated_at();

create table if not exists public.jc_ppt_events (
  id uuid primary key default gen_random_uuid(),
  jc_ppt_id uuid not null references public.jc_ppts (id) on delete cascade,
  actor_id uuid references public.employees (id) on delete set null,
  event_type text not null
    check (event_type in ('uploaded', 'replaced', 'transferred_to_gm', 'downloaded', 'emailed')),
  note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists jc_ppt_events_jc_ppt_id_idx on public.jc_ppt_events (jc_ppt_id);
create index if not exists jc_ppt_events_created_at_idx on public.jc_ppt_events (created_at desc);

alter table public.jc_ppts enable row level security;
alter table public.jc_ppt_events enable row level security;

drop policy if exists jc_ppts_select on public.jc_ppts;
create policy jc_ppts_select on public.jc_ppts for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('work.view')
  );

drop policy if exists jc_ppt_events_select on public.jc_ppt_events;
create policy jc_ppt_events_select on public.jc_ppt_events for select to authenticated
  using (
    exists (
      select 1
      from public.jc_ppts j
      join public.employees e on e.id = j.employee_id
      where j.id = jc_ppt_id and e.user_id = auth.uid()
    )
    or public.authorize('work.view')
  );

grant all on public.jc_ppts to service_role;
grant all on public.jc_ppt_events to service_role;

comment on table public.jc_ppts is
  'JC PPT: employee uploads; CSO transfers to GM; GM download/email removes storage file but keeps this audit row.';

comment on table public.jc_ppt_events is
  'Immutable JC PPT audit trail for employee / CSO / GM portals.';

notify pgrst, 'reload schema';
