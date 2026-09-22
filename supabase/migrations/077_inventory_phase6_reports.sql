-- Inventory Phase 6: expense & usage reports permission.
-- Additive only — no schema change to lots / plastic (expense flags already on lots).

insert into public.permissions (code, description) values
  ('inventory.reports.view', 'View inventory expense and usage reports')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'INVENTORY_MANAGER'
  and p.code in ('inventory.reports.view')
on conflict do nothing;

notify pgrst, 'reload schema';
