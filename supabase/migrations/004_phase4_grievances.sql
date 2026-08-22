-- Phase 4 grievance management. Apply after 003_phase3_attendance.sql.
-- Attachments store Storage paths only — never file bytes in Postgres.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'grievance-attachments',
  'grievance-attachments',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain']::text[]
)
on conflict (id) do nothing;

create table if not exists public.grievances (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  category text not null check (
    category in ('WORKPLACE', 'SALARY', 'MANAGER', 'ATTENDANCE', 'POLICY', 'OTHER')
  ),
  subject text not null,
  description text not null,
  status text not null default 'OPEN' check (
    status in ('OPEN', 'UNDER_REVIEW', 'INVESTIGATING', 'RESOLVED', 'CLOSED')
  ),
  resolution text,
  resolved_at timestamptz,
  resolved_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.grievance_comments (
  id uuid primary key default gen_random_uuid(),
  grievance_id uuid not null references public.grievances (id) on delete cascade,
  author_id uuid not null references public.employees (id) on delete restrict,
  body text not null,
  visibility text not null check (visibility in ('EMPLOYEE', 'INTERNAL')),
  created_at timestamptz not null default now()
);

create table if not exists public.grievance_attachments (
  id uuid primary key default gen_random_uuid(),
  grievance_id uuid not null references public.grievances (id) on delete cascade,
  uploaded_by uuid not null references public.employees (id) on delete restrict,
  file_name text not null,
  content_type text not null,
  size_bytes integer not null check (size_bytes >= 0),
  storage_path text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.grievance_assignments (
  id uuid primary key default gen_random_uuid(),
  grievance_id uuid not null references public.grievances (id) on delete cascade,
  assignee_id uuid not null references public.employees (id) on delete restrict,
  assigned_by uuid not null references public.employees (id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists grievances_employee_id_idx on public.grievances (employee_id);
create index if not exists grievances_status_idx on public.grievances (status);
create index if not exists grievance_comments_grievance_id_idx on public.grievance_comments (grievance_id);
create index if not exists grievance_attachments_grievance_id_idx on public.grievance_attachments (grievance_id);
create index if not exists grievance_assignments_grievance_id_idx on public.grievance_assignments (grievance_id);

drop trigger if exists grievances_set_updated_at on public.grievances;
create trigger grievances_set_updated_at
  before update on public.grievances
  for each row execute procedure public.set_updated_at();

alter table public.grievances enable row level security;
alter table public.grievance_comments enable row level security;
alter table public.grievance_attachments enable row level security;
alter table public.grievance_assignments enable row level security;

drop policy if exists grievances_select on public.grievances;
create policy grievances_select on public.grievances for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('grievances.manage')
  );

drop policy if exists grievances_insert on public.grievances;
create policy grievances_insert on public.grievances for insert to authenticated
  with check (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    and public.authorize('grievance.create')
  );

drop policy if exists grievance_comments_select on public.grievance_comments;
create policy grievance_comments_select on public.grievance_comments for select to authenticated
  using (
    public.authorize('grievances.manage')
    or (
      visibility = 'EMPLOYEE'
      and exists (
        select 1
        from public.grievances g
        join public.employees e on e.id = g.employee_id
        where g.id = grievance_id and e.user_id = auth.uid()
      )
    )
  );

drop policy if exists grievance_attachments_select on public.grievance_attachments;
create policy grievance_attachments_select on public.grievance_attachments for select to authenticated
  using (
    public.authorize('grievances.manage')
    or exists (
      select 1
      from public.grievances g
      join public.employees e on e.id = g.employee_id
      where g.id = grievance_id and e.user_id = auth.uid()
    )
  );

drop policy if exists grievance_assignments_select on public.grievance_assignments;
create policy grievance_assignments_select on public.grievance_assignments for select to authenticated
  using (
    public.authorize('grievances.manage')
    or exists (
      select 1
      from public.grievances g
      join public.employees e on e.id = g.employee_id
      where g.id = grievance_id and e.user_id = auth.uid()
    )
  );

-- Storage: only service role uploads via API; authenticated users read via signed URLs issued by API.
drop policy if exists grievance_attachments_storage_select on storage.objects;
create policy grievance_attachments_storage_select on storage.objects for select to authenticated
  using (bucket_id = 'grievance-attachments' and public.authorize('grievances.manage'));

grant all on public.grievances, public.grievance_comments, public.grievance_attachments, public.grievance_assignments
  to service_role;

notify pgrst, 'reload schema';
