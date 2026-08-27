-- Phase 0: one project lead per project (role bound to project via lead_employee_id).

alter table public.projects
  add column if not exists lead_employee_id uuid references public.employees (id) on delete restrict;

-- Backfill: first member (by employee_id) becomes lead when members exist.
update public.projects p
set lead_employee_id = (
  select m.employee_id
  from public.project_members m
  where m.project_id = p.id
  order by m.employee_id
  limit 1
)
where p.lead_employee_id is null
  and exists (select 1 from public.project_members m where m.project_id = p.id);

-- Active projects with no members: leave null until CSO assigns (app requires lead on create/update).
create index if not exists projects_lead_employee_id_idx on public.projects (lead_employee_id);

notify pgrst, 'reload schema';
