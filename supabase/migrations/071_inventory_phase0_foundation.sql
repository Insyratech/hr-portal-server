-- Inventory Phase 0: Inventory Manager role + overview permission stub.
-- Additive only — does not alter existing roles or finance/work data.

-- Fixed role id (next after FINANCE_MANAGER …0006).
-- INVENTORY_MANAGER 00000000-0000-4000-8000-000000000007

insert into public.roles (id, code, name) values
  ('00000000-0000-4000-8000-000000000007', 'INVENTORY_MANAGER', 'Inventory Manager')
on conflict (id) do update set code = excluded.code, name = excluded.name;

insert into public.permissions (code, description) values
  ('inventory.overview.view', 'View inventory overview (Phase 0 stub)')
on conflict (code) do nothing;

-- Personal stub permissions (same pattern as FINANCE_MANAGER in 027) + overview.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on true
where r.code = 'INVENTORY_MANAGER'
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
    'payroll.view',
    'inventory.overview.view'
  )
on conflict do nothing;
