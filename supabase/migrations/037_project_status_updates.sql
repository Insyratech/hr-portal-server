-- Phase 2: project-bound lead status updates (history stays on project_id).

create table if not exists public.project_status_updates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  author_id uuid not null references public.employees (id) on delete restrict,
  body text not null check (char_length(trim(body)) > 0 and char_length(body) <= 2000),
  created_at timestamptz not null default now()
);

create index if not exists project_status_updates_project_id_created_at_idx
  on public.project_status_updates (project_id, created_at desc);

alter table public.project_status_updates enable row level security;

-- App uses service role; keep a conservative authenticated policy for direct clients.
drop policy if exists project_status_updates_select on public.project_status_updates;
create policy project_status_updates_select on public.project_status_updates for select to authenticated
  using (
    public.authorize('projects.manage')
    or public.authorize('work.settings')
    or exists (
      select 1
      from public.projects p
      join public.employees e on e.id = p.lead_employee_id
      where p.id = project_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists project_status_updates_insert on public.project_status_updates;
create policy project_status_updates_insert on public.project_status_updates for insert to authenticated
  with check (
    exists (
      select 1
      from public.projects p
      join public.employees e on e.id = p.lead_employee_id
      where p.id = project_id
        and e.id = author_id
        and e.user_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
