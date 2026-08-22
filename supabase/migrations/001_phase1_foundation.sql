-- Phase 1 foundation: org, employees, RBAC, audit, notifications.
-- Apply in the Supabase SQL editor or via CLI: supabase db push / migration up.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.designations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  primary key (role_id, permission_id)
);

create table if not exists public.organization_settings (
  id uuid primary key default gen_random_uuid(),
  working_days text[] not null default array['MON', 'TUE', 'WED', 'THU', 'FRI']::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_settings_working_days_valid check (
    working_days <@ array['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']::text[]
    and cardinality(working_days) > 0
  )
);

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete restrict,
  employee_code text not null unique,
  full_name text not null,
  email text not null unique,
  phone text,
  date_of_birth date,
  department_id uuid references public.departments (id) on delete set null,
  designation_id uuid references public.designations (id) on delete set null,
  joining_date date not null,
  employment_type text not null check (
    employment_type in ('full_time', 'part_time', 'contract', 'intern')
  ),
  manager_id uuid references public.employees (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.employee_roles (
  employee_id uuid not null references public.employees (id) on delete cascade,
  role_id uuid not null references public.roles (id) on delete restrict,
  primary key (employee_id, role_id)
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.employees (id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  old_values jsonb,
  new_values jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null,
  title text not null,
  message text not null,
  reference_type text,
  reference_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists employees_department_id_idx on public.employees (department_id);
create index if not exists employees_status_idx on public.employees (status);
create index if not exists employees_manager_id_idx on public.employees (manager_id);
create index if not exists employees_full_name_idx on public.employees (full_name);
create index if not exists audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index if not exists audit_logs_actor_id_idx on public.audit_logs (actor_id);
create index if not exists audit_logs_created_at_idx on public.audit_logs (created_at desc);
create index if not exists notifications_user_id_idx on public.notifications (user_id);

drop trigger if exists departments_set_updated_at on public.departments;
create trigger departments_set_updated_at
  before update on public.departments
  for each row execute procedure public.set_updated_at();

drop trigger if exists designations_set_updated_at on public.designations;
create trigger designations_set_updated_at
  before update on public.designations
  for each row execute procedure public.set_updated_at();

drop trigger if exists roles_set_updated_at on public.roles;
create trigger roles_set_updated_at
  before update on public.roles
  for each row execute procedure public.set_updated_at();

drop trigger if exists organization_settings_set_updated_at on public.organization_settings;
create trigger organization_settings_set_updated_at
  before update on public.organization_settings
  for each row execute procedure public.set_updated_at();

drop trigger if exists employees_set_updated_at on public.employees;
create trigger employees_set_updated_at
  before update on public.employees
  for each row execute procedure public.set_updated_at();

insert into public.permissions (code, description) values
  ('users.manage', 'Create and update employees'),
  ('users.view', 'View employees'),
  ('roles.manage', 'Manage roles'),
  ('leave.types.manage', 'Manage leave types'),
  ('leave.policies.manage', 'Manage leave policies'),
  ('leave.allocations.manage', 'Manage leave allocations'),
  ('leave.approve', 'Approve leave'),
  ('leave.apply', 'Apply for leave'),
  ('leave.view', 'View own leave'),
  ('attendance.manage', 'Manage attendance'),
  ('attendance.view', 'View attendance'),
  ('attendance.correct', 'Approve attendance corrections'),
  ('shifts.manage', 'Manage shifts'),
  ('grievances.manage', 'Manage grievances'),
  ('grievance.create', 'Create a grievance'),
  ('grievance.view_own', 'View own grievances'),
  ('policies.manage', 'Manage HR policies'),
  ('policies.view', 'View HR policies'),
  ('reports.view', 'View reports'),
  ('system.manage', 'Manage organisation settings'),
  ('audit.view', 'View audit logs'),
  ('profile.view', 'View own profile')
on conflict (code) do nothing;

insert into public.roles (id, code, name) values
  ('00000000-0000-4000-8000-000000000001', 'SUPER_ADMIN', 'Super Admin'),
  ('00000000-0000-4000-8000-000000000002', 'ADMIN', 'Admin'),
  ('00000000-0000-4000-8000-000000000003', 'EMPLOYEE', 'Employee')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on true
where r.code = 'SUPER_ADMIN'
  and p.code in (
    'users.manage', 'users.view', 'roles.manage', 'leave.types.manage', 'leave.policies.manage',
    'leave.allocations.manage', 'leave.approve', 'attendance.manage', 'shifts.manage',
    'grievances.manage', 'policies.manage', 'reports.view', 'system.manage', 'audit.view'
  )
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on true
where r.code = 'ADMIN'
  and p.code in (
    'users.view', 'leave.allocations.manage', 'leave.approve', 'attendance.view',
    'attendance.correct', 'grievances.manage', 'reports.view'
  )
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on true
where r.code = 'EMPLOYEE'
  and p.code in (
    'profile.view', 'leave.apply', 'leave.view', 'attendance.view',
    'grievance.create', 'grievance.view_own', 'policies.view'
  )
on conflict do nothing;

insert into public.organization_settings (id, working_days)
select '00000000-0000-4000-8000-000000000010', array['MON', 'TUE', 'WED', 'THU', 'FRI']::text[]
where not exists (select 1 from public.organization_settings);

create or replace function public.authorize(requested_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.employees e
    join public.employee_roles er on er.employee_id = e.id
    join public.role_permissions rp on rp.role_id = er.role_id
    join public.permissions p on p.id = rp.permission_id
    where e.user_id = auth.uid()
      and e.status = 'active'
      and p.code = requested_permission
  );
$$;

alter table public.departments enable row level security;
alter table public.designations enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.organization_settings enable row level security;
alter table public.employees enable row level security;
alter table public.employee_roles enable row level security;
alter table public.audit_logs enable row level security;
alter table public.notifications enable row level security;

drop policy if exists departments_select on public.departments;
create policy departments_select on public.departments
  for select to authenticated
  using (auth.uid() is not null);

drop policy if exists departments_write on public.departments;
create policy departments_write on public.departments
  for all to authenticated
  using (public.authorize('users.manage') or public.authorize('system.manage'))
  with check (public.authorize('users.manage') or public.authorize('system.manage'));

drop policy if exists designations_select on public.designations;
create policy designations_select on public.designations
  for select to authenticated
  using (auth.uid() is not null);

drop policy if exists designations_write on public.designations;
create policy designations_write on public.designations
  for all to authenticated
  using (public.authorize('users.manage') or public.authorize('system.manage'))
  with check (public.authorize('users.manage') or public.authorize('system.manage'));

drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles
  for select to authenticated
  using (auth.uid() is not null);

drop policy if exists permissions_select on public.permissions;
create policy permissions_select on public.permissions
  for select to authenticated
  using (auth.uid() is not null);

drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions
  for select to authenticated
  using (auth.uid() is not null);

drop policy if exists organization_settings_select on public.organization_settings;
create policy organization_settings_select on public.organization_settings
  for select to authenticated
  using (auth.uid() is not null);

drop policy if exists organization_settings_update on public.organization_settings;
create policy organization_settings_update on public.organization_settings
  for update to authenticated
  using (public.authorize('system.manage'))
  with check (public.authorize('system.manage'));

drop policy if exists employees_select on public.employees;
create policy employees_select on public.employees
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.authorize('users.view')
    or public.authorize('users.manage')
  );

drop policy if exists employees_write on public.employees;
create policy employees_write on public.employees
  for all to authenticated
  using (public.authorize('users.manage'))
  with check (public.authorize('users.manage'));

drop policy if exists employee_roles_select on public.employee_roles;
create policy employee_roles_select on public.employee_roles
  for select to authenticated
  using (
    exists (
      select 1 from public.employees e
      where e.id = employee_id and e.user_id = auth.uid()
    )
    or public.authorize('users.view')
    or public.authorize('users.manage')
  );

drop policy if exists employee_roles_write on public.employee_roles;
create policy employee_roles_write on public.employee_roles
  for all to authenticated
  using (public.authorize('users.manage'))
  with check (public.authorize('users.manage'));

drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (public.authorize('audit.view') or public.authorize('users.view') or public.authorize('users.manage'));

drop policy if exists audit_logs_insert on public.audit_logs;
create policy audit_logs_insert on public.audit_logs
  for insert to authenticated
  with check (public.authorize('users.manage') or public.authorize('system.manage') or public.authorize('audit.view'));

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = auth.uid());

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant select on all tables in schema public to authenticated;
grant insert, update on public.departments, public.designations, public.employees, public.organization_settings, public.audit_logs to authenticated;
grant insert, update, delete on public.employee_roles to authenticated;
grant select, insert, update, delete on public.notifications to authenticated;

notify pgrst, 'reload schema';
