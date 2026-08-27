-- Phase 1 role restructure:
-- ADMIN → GENERAL_MANAGER; add HR_MANAGER, CSO, FINANCE_MANAGER.
-- Permission matrix: SA = accounts + audit + policies + work.settings;
-- HR = leave/permission approve, grievances, org, leave catalog, shifts;
-- GM = attendance + payroll ops; CSO = work desk; Finance = personal stub.

-- Fixed role ids (ADMIN uuid retained as GENERAL_MANAGER).
-- SUPER_ADMIN  00000000-0000-4000-8000-000000000001
-- GENERAL_MANAGER (ex-ADMIN) 00000000-0000-4000-8000-000000000002
-- EMPLOYEE     00000000-0000-4000-8000-000000000003
-- HR_MANAGER   00000000-0000-4000-8000-000000000004
-- CSO          00000000-0000-4000-8000-000000000005
-- FINANCE_MANAGER 00000000-0000-4000-8000-000000000006

update public.roles
set code = 'GENERAL_MANAGER', name = 'General Manager'
where code = 'ADMIN';

insert into public.roles (id, code, name) values
  ('00000000-0000-4000-8000-000000000004', 'HR_MANAGER', 'HR Manager'),
  ('00000000-0000-4000-8000-000000000005', 'CSO', 'Chief Scientific Officer'),
  ('00000000-0000-4000-8000-000000000006', 'FINANCE_MANAGER', 'Finance Manager')
on conflict (id) do update set code = excluded.code, name = excluded.name;

delete from public.role_permissions
where role_id in (
  select id from public.roles
  where code in (
    'SUPER_ADMIN',
    'GENERAL_MANAGER',
    'HR_MANAGER',
    'CSO',
    'FINANCE_MANAGER',
    'EMPLOYEE',
    'ADMIN'
  )
);

-- Super Admin: account factory, audit, policies, personal basics, work settings. No leave/grievance approve.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on true
where r.code = 'SUPER_ADMIN'
  and p.code in (
    'users.manage',
    'users.view',
    'leave.view',
    'leave.apply',
    'reports.view',
    'audit.view',
    'payroll.view',
    'attendance.view',
    'policies.manage',
    'policies.view',
    'profile.view',
    'work.own',
    'work.settings',
    'work_permission.apply',
    'grievance.create',
    'grievance.view_own'
  );

-- HR Manager: leave + permission approve, grievances, org, leave catalog, shifts, directory view.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on true
where r.code = 'HR_MANAGER'
  and p.code in (
    'users.view',
    'leave.approve',
    'leave.view',
    'leave.apply',
    'leave.types.manage',
    'leave.policies.manage',
    'leave.allocations.manage',
    'work_permission.approve',
    'work_permission.apply',
    'grievances.manage',
    'grievance.create',
    'grievance.view_own',
    'shifts.manage',
    'system.manage',
    'companies.manage',
    'attendance.view',
    'payroll.view',
    'reports.view',
    'policies.view',
    'profile.view',
    'work.own',
    'work.view'
  );

-- General Manager (ex-ADMIN): attendance + payroll ops, reports, leave visibility. No approve.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on true
where r.code = 'GENERAL_MANAGER'
  and p.code in (
    'users.view',
    'leave.view',
    'leave.apply',
    'attendance.manage',
    'attendance.view',
    'attendance.correct',
    'payroll.manage',
    'payroll.view',
    'reports.view',
    'policies.view',
    'profile.view',
    'work_permission.apply',
    'grievance.create',
    'grievance.view_own',
    'work.own',
    'work.view'
  );

-- CSO: work desk (team, projects, feedback).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on true
where r.code = 'CSO'
  and p.code in (
    'users.view',
    'leave.view',
    'leave.apply',
    'attendance.view',
    'policies.view',
    'profile.view',
    'work_permission.apply',
    'grievance.create',
    'grievance.view_own',
    'work.own',
    'work.view',
    'work.assign',
    'work.feedback',
    'projects.manage'
  );

-- Finance Manager: personal stub only (finance features later).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on true
where r.code = 'FINANCE_MANAGER'
  and p.code in (
    'profile.view',
    'leave.apply',
    'leave.view',
    'attendance.view',
    'policies.view',
    'work_permission.apply',
    'grievance.create',
    'grievance.view_own',
    'work.own',
    'reports.view',
    'payroll.view'
  );

-- Employee: unchanged self-service + work.own.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on true
where r.code = 'EMPLOYEE'
  and p.code in (
    'profile.view',
    'leave.apply',
    'leave.view',
    'attendance.view',
    'grievance.create',
    'grievance.view_own',
    'policies.view',
    'work_permission.apply',
    'work.own'
  );

notify pgrst, 'reload schema';
