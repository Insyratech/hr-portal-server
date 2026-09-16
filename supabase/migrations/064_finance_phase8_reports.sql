-- Finance Phase 8: reports & dashboard permissions.
-- Additive; reports are computed from journals/documents (no new domain tables).

insert into public.permissions (code, description) values
  ('finance.reports.view', 'View finance dashboard and reports center')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'FINANCE_MANAGER'
  and p.code = 'finance.reports.view'
on conflict do nothing;

notify pgrst, 'reload schema';
