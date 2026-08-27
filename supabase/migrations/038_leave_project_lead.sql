-- Phase 3: leave applications can bind to a project; project lead is an approval step.

alter table public.leave_applications
  add column if not exists project_id uuid references public.projects (id) on delete set null;

create index if not exists leave_applications_project_id_idx
  on public.leave_applications (project_id);

notify pgrst, 'reload schema';
