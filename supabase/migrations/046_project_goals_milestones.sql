-- Project goals, milestones, milestone history, and weekly priority linkage.

-- ---------------------------------------------------------------------------
-- Fresh start: remove all weekly priorities (and related week plans)
-- ---------------------------------------------------------------------------
update public.weekly_priorities
set carried_from_id = null
where carried_from_id is not null;

delete from public.notifications
where reference_type in ('weekly_priority', 'weekly_plan');

delete from public.week_feedback;
delete from public.weekly_priorities;
delete from public.weekly_plans;

-- ---------------------------------------------------------------------------
-- Goals
-- ---------------------------------------------------------------------------
create table if not exists public.project_goals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  description text not null default '',
  is_primary boolean not null default false,
  sequence integer not null default 1 check (sequence > 0),
  created_by uuid not null references public.employees (id) on delete restrict,
  updated_by uuid not null references public.employees (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_goals_project_id_idx on public.project_goals (project_id, sequence);
create unique index if not exists project_goals_one_primary_per_project_idx
  on public.project_goals (project_id)
  where is_primary = true;

-- ---------------------------------------------------------------------------
-- Milestones
-- ---------------------------------------------------------------------------
create table if not exists public.project_milestones (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.project_goals (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  description text not null default '',
  start_date date,
  target_date date,
  status text not null default 'UPCOMING'
    check (status in ('UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
  sequence integer not null default 1 check (sequence > 0),
  created_by uuid not null references public.employees (id) on delete restrict,
  updated_by uuid not null references public.employees (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (target_date is null or start_date is null or target_date >= start_date)
);

create index if not exists project_milestones_project_id_idx
  on public.project_milestones (project_id, sequence);
create index if not exists project_milestones_goal_id_idx
  on public.project_milestones (goal_id, sequence);
create unique index if not exists project_milestones_one_active_per_project_idx
  on public.project_milestones (project_id)
  where status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Milestone change history (versioned audit)
-- ---------------------------------------------------------------------------
create table if not exists public.project_milestone_history (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references public.project_milestones (id) on delete cascade,
  version integer not null check (version > 0),
  changed_field text not null,
  old_value text,
  new_value text,
  changed_by uuid not null references public.employees (id) on delete restrict,
  changed_at timestamptz not null default now(),
  change_reason text not null check (char_length(trim(change_reason)) > 0),
  unique (milestone_id, version, changed_field)
);

create index if not exists project_milestone_history_milestone_id_idx
  on public.project_milestone_history (milestone_id, version desc, changed_at desc);

-- ---------------------------------------------------------------------------
-- Weekly priorities: link PROJECT lines to milestones
-- ---------------------------------------------------------------------------
alter table public.weekly_priorities
  add column if not exists milestone_id uuid references public.project_milestones (id) on delete restrict;

alter table public.weekly_priorities
  add column if not exists is_additional boolean not null default false;

create index if not exists weekly_priorities_milestone_id_idx
  on public.weekly_priorities (milestone_id)
  where milestone_id is not null;

alter table public.weekly_priorities
  drop constraint if exists weekly_priorities_project_milestone_check;

alter table public.weekly_priorities
  add constraint weekly_priorities_project_milestone_check
  check (
    (
      priority_type = 'PROJECT'
      and project_id is not null
      and milestone_id is not null
    )
    or (
      priority_type <> 'PROJECT'
      and milestone_id is null
    )
  );

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
drop trigger if exists project_goals_set_updated_at on public.project_goals;
create trigger project_goals_set_updated_at
  before update on public.project_goals
  for each row execute procedure public.set_updated_at();

drop trigger if exists project_milestones_set_updated_at on public.project_milestones;
create trigger project_milestones_set_updated_at
  before update on public.project_milestones
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS (service role used by API; conservative authenticated policies)
-- ---------------------------------------------------------------------------
alter table public.project_goals enable row level security;
alter table public.project_milestones enable row level security;
alter table public.project_milestone_history enable row level security;

drop policy if exists project_goals_select on public.project_goals;
create policy project_goals_select on public.project_goals for select to authenticated
  using (
    public.authorize('projects.manage')
    or public.authorize('work.view')
    or exists (
      select 1
      from public.project_members m
      join public.employees e on e.id = m.employee_id
      where m.project_id = project_goals.project_id
        and e.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.projects p
      join public.employees e on e.id = p.lead_employee_id
      where p.id = project_goals.project_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists project_milestones_select on public.project_milestones;
create policy project_milestones_select on public.project_milestones for select to authenticated
  using (
    public.authorize('projects.manage')
    or public.authorize('work.view')
    or exists (
      select 1
      from public.project_members m
      join public.employees e on e.id = m.employee_id
      where m.project_id = project_milestones.project_id
        and e.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.projects p
      join public.employees e on e.id = p.lead_employee_id
      where p.id = project_milestones.project_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists project_milestone_history_select on public.project_milestone_history;
create policy project_milestone_history_select on public.project_milestone_history for select to authenticated
  using (
    public.authorize('projects.manage')
    or public.authorize('work.view')
    or exists (
      select 1
      from public.project_milestones ms
      join public.project_members m on m.project_id = ms.project_id
      join public.employees e on e.id = m.employee_id
      where ms.id = project_milestone_history.milestone_id
        and e.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.project_milestones ms
      join public.projects p on p.id = ms.project_id
      join public.employees e on e.id = p.lead_employee_id
      where ms.id = project_milestone_history.milestone_id
        and e.user_id = auth.uid()
    )
  );

grant all on public.project_goals to service_role;
grant all on public.project_milestones to service_role;
grant all on public.project_milestone_history to service_role;

-- Goals and milestones are created by the project lead in the portal (no default seed).

notify pgrst, 'reload schema';
