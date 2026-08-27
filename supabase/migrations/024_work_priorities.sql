-- Work & Priorities Phase 1: projects, weekly plans, daily work days, reminder hour.
-- Daily reminder cron (Phase 4) should run near work_update_reminder_hour (default 20, UTC until timezone is added):
--   POST /api/v1/jobs/work/daily-reminders   header x-cron-secret

alter table public.organization_settings
  add column if not exists work_update_reminder_hour smallint not null default 20;

alter table public.organization_settings
  drop constraint if exists organization_settings_work_update_reminder_hour_check;

alter table public.organization_settings
  add constraint organization_settings_work_update_reminder_hour_check
  check (work_update_reminder_hour between 0 and 23);

insert into public.permissions (code, description) values
  ('work.own', 'Create and view own weekly priorities and daily work updates'),
  ('work.view', 'View all employee work updates'),
  ('work.assign', 'Assign weekly priorities to employees'),
  ('work.feedback', 'Add feedback on a weekly plan'),
  ('projects.manage', 'Create and assign projects')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'work.own'
where r.code in ('SUPER_ADMIN', 'ADMIN', 'EMPLOYEE')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in ('work.view', 'work.assign', 'work.feedback', 'projects.manage')
where r.code in ('SUPER_ADMIN', 'ADMIN')
on conflict do nothing;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, employee_id)
);

create table if not exists public.weekly_plans (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  week_start date not null,
  week_end date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, week_start),
  check (week_end >= week_start)
);

create table if not exists public.weekly_priorities (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.weekly_plans (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  priority_type text not null check (priority_type in ('PROJECT', 'REGULAR', 'SKILL')),
  project_id uuid references public.projects (id) on delete set null,
  title text not null,
  description text not null default '',
  expected_outcome text not null default '',
  success_criteria text not null default '',
  priority_level text not null check (priority_level in ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  status text not null default 'NOT_STARTED' check (
    status in (
      'NOT_STARTED',
      'IN_PROGRESS',
      'COMPLETED',
      'PARTIALLY_COMPLETED',
      'BLOCKED',
      'CANCELLED',
      'CARRIED_FORWARD'
    )
  ),
  incomplete_reason text,
  assigned_by uuid references public.employees (id) on delete set null,
  carried_from_id uuid references public.weekly_priorities (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (priority_type <> 'PROJECT' or project_id is not null)
);

create table if not exists public.priority_history (
  id uuid primary key default gen_random_uuid(),
  priority_id uuid not null references public.weekly_priorities (id) on delete cascade,
  actor_id uuid references public.employees (id) on delete set null,
  action text not null,
  old_values jsonb,
  new_values jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_work_days (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  work_date date not null,
  status text not null check (
    status in ('COMPLETED', 'MISSING', 'ON_LEAVE', 'HOLIDAY', 'WEEKEND', 'NOT_REQUIRED')
  ),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, work_date)
);

create table if not exists public.daily_work_entries (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references public.daily_work_days (id) on delete cascade,
  category text not null check (category in ('PLANNED', 'UNPLANNED', 'SKILL', 'OTHER')),
  priority_id uuid references public.weekly_priorities (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  description text not null default '',
  progress integer check (progress is null or (progress >= 0 and progress <= 100)),
  minutes_spent integer check (minutes_spent is null or minutes_spent >= 0),
  next_action text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.work_blockers (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  day_id uuid references public.daily_work_days (id) on delete cascade,
  priority_id uuid references public.weekly_priorities (id) on delete set null,
  category text not null default 'DEPENDENCY' check (
    category in ('DEPENDENCY', 'APPROVAL', 'TECHNICAL', 'PRIORITY_CHANGE', 'TIME', 'URGENT_ASSIGNMENT', 'OTHER')
  ),
  impact text not null default 'MEDIUM' check (impact in ('HIGH', 'MEDIUM', 'LOW')),
  description text not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.week_feedback (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.weekly_plans (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  actor_id uuid not null references public.employees (id) on delete restrict,
  feedback_type text not null check (feedback_type in ('POSITIVE', 'IMPROVEMENT', 'SUPPORT')),
  comment text not null,
  created_at timestamptz not null default now()
);

create index if not exists project_members_employee_id_idx on public.project_members (employee_id);
create index if not exists weekly_plans_week_start_idx on public.weekly_plans (week_start);
create index if not exists weekly_priorities_plan_id_idx on public.weekly_priorities (plan_id);
create index if not exists weekly_priorities_employee_id_idx on public.weekly_priorities (employee_id);
create index if not exists priority_history_priority_id_idx on public.priority_history (priority_id);
create index if not exists daily_work_days_date_idx on public.daily_work_days (work_date, status);
create index if not exists daily_work_entries_day_id_idx on public.daily_work_entries (day_id);
create index if not exists work_blockers_employee_id_idx on public.work_blockers (employee_id)
  where resolved_at is null;
create index if not exists week_feedback_plan_id_idx on public.week_feedback (plan_id);

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row execute procedure public.set_updated_at();

drop trigger if exists weekly_plans_set_updated_at on public.weekly_plans;
create trigger weekly_plans_set_updated_at
  before update on public.weekly_plans
  for each row execute procedure public.set_updated_at();

drop trigger if exists weekly_priorities_set_updated_at on public.weekly_priorities;
create trigger weekly_priorities_set_updated_at
  before update on public.weekly_priorities
  for each row execute procedure public.set_updated_at();

drop trigger if exists daily_work_days_set_updated_at on public.daily_work_days;
create trigger daily_work_days_set_updated_at
  before update on public.daily_work_days
  for each row execute procedure public.set_updated_at();

drop trigger if exists daily_work_entries_set_updated_at on public.daily_work_entries;
create trigger daily_work_entries_set_updated_at
  before update on public.daily_work_entries
  for each row execute procedure public.set_updated_at();

drop trigger if exists work_blockers_set_updated_at on public.work_blockers;
create trigger work_blockers_set_updated_at
  before update on public.work_blockers
  for each row execute procedure public.set_updated_at();

alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.weekly_plans enable row level security;
alter table public.weekly_priorities enable row level security;
alter table public.priority_history enable row level security;
alter table public.daily_work_days enable row level security;
alter table public.daily_work_entries enable row level security;
alter table public.work_blockers enable row level security;
alter table public.week_feedback enable row level security;

drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated
  using (
    public.authorize('projects.manage')
    or public.authorize('work.view')
    or exists (
      select 1 from public.project_members m
      join public.employees e on e.id = m.employee_id
      where m.project_id = projects.id and e.user_id = auth.uid()
    )
  );

drop policy if exists project_members_select on public.project_members;
create policy project_members_select on public.project_members for select to authenticated
  using (
    public.authorize('projects.manage')
    or public.authorize('work.view')
    or exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

drop policy if exists weekly_plans_select on public.weekly_plans;
create policy weekly_plans_select on public.weekly_plans for select to authenticated
  using (
    public.authorize('work.view')
    or exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

drop policy if exists weekly_priorities_select on public.weekly_priorities;
create policy weekly_priorities_select on public.weekly_priorities for select to authenticated
  using (
    public.authorize('work.view')
    or exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

drop policy if exists priority_history_select on public.priority_history;
create policy priority_history_select on public.priority_history for select to authenticated
  using (
    public.authorize('work.view')
    or exists (
      select 1 from public.weekly_priorities p
      join public.employees e on e.id = p.employee_id
      where p.id = priority_history.priority_id and e.user_id = auth.uid()
    )
  );

drop policy if exists daily_work_days_select on public.daily_work_days;
create policy daily_work_days_select on public.daily_work_days for select to authenticated
  using (
    public.authorize('work.view')
    or exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

drop policy if exists daily_work_entries_select on public.daily_work_entries;
create policy daily_work_entries_select on public.daily_work_entries for select to authenticated
  using (
    public.authorize('work.view')
    or exists (
      select 1 from public.daily_work_days d
      join public.employees e on e.id = d.employee_id
      where d.id = daily_work_entries.day_id and e.user_id = auth.uid()
    )
  );

drop policy if exists work_blockers_select on public.work_blockers;
create policy work_blockers_select on public.work_blockers for select to authenticated
  using (
    public.authorize('work.view')
    or exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

drop policy if exists week_feedback_select on public.week_feedback;
create policy week_feedback_select on public.week_feedback for select to authenticated
  using (
    public.authorize('work.view')
    or public.authorize('work.feedback')
    or exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
  );

grant all on
  public.projects,
  public.project_members,
  public.weekly_plans,
  public.weekly_priorities,
  public.priority_history,
  public.daily_work_days,
  public.daily_work_entries,
  public.work_blockers,
  public.week_feedback
to service_role;

notify pgrst, 'reload schema';
