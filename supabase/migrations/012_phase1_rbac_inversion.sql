-- Payroll Phase 1: invert RBAC.
-- Super Admin creates HR Admin only and approves leave/grievances.
-- HR Admin creates employees and owns org/attendance/payroll writes.

insert into public.permissions (code, description) values
  ('payroll.view', 'View payroll and salary slips'),
  ('payroll.manage', 'Run payroll and generate salary slips'),
  ('work_permission.apply', 'Apply for a 2-hour work permission'),
  ('work_permission.approve', 'Approve 2-hour work permissions'),
  ('companies.manage', 'Create and update companies')
on conflict (code) do nothing;

delete from public.role_permissions
where role_id in (select id from public.roles where code in ('SUPER_ADMIN', 'ADMIN', 'EMPLOYEE'));

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on true
where r.code = 'SUPER_ADMIN'
  and p.code in (
    'users.manage',
    'users.view',
    'leave.approve',
    'leave.view',
    'grievances.manage',
    'reports.view',
    'audit.view',
    'payroll.view',
    'attendance.view',
    'leave.apply',
    'policies.manage',
    'policies.view'
  );

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on true
where r.code = 'ADMIN'
  and p.code in (
    'users.manage',
    'users.view',
    'leave.types.manage',
    'leave.policies.manage',
    'leave.allocations.manage',
    'leave.view',
    'shifts.manage',
    'system.manage',
    'companies.manage',
    'attendance.manage',
    'attendance.view',
    'attendance.correct',
    'payroll.manage',
    'payroll.view',
    'work_permission.approve',
    'work_permission.apply',
    'reports.view',
    'policies.view',
    'leave.apply',
    'profile.view',
    'grievance.create',
    'grievance.view_own'
  );

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
    'work_permission.apply'
  );

notify pgrst, 'reload schema';
