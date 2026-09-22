-- Inventory Phase 5: alert dedupe log + IM view permission.
-- Additive only — alert policy fields already live on categories / catalog (Phase 1).

insert into public.permissions (code, description) values
  ('inventory.alerts.view', 'View inventory stock and expiry alerts')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'INVENTORY_MANAGER'
  and p.code in ('inventory.alerts.view')
on conflict do nothing;

-- One row per subject + alert kind per calendar day (prevents email / notify spam).
create table if not exists public.inventory_alert_log (
  id uuid primary key default gen_random_uuid(),
  alert_date date not null,
  subject_type text not null
    check (subject_type in ('lot', 'plastic_stock')),
  subject_id uuid not null,
  alert_kind text not null
    check (alert_kind in ('expiry', 'reorder', 'velocity')),
  catalog_item_id uuid references public.inventory_catalog_items (id) on delete set null,
  title text not null,
  detail text not null default '',
  deep_link text not null default '',
  metric_value numeric(18, 4),
  created_at timestamptz not null default now(),
  constraint inventory_alert_log_dedupe_unique
    unique (alert_date, subject_type, subject_id, alert_kind)
);

create index if not exists inventory_alert_log_date_idx
  on public.inventory_alert_log (alert_date desc, created_at desc);
create index if not exists inventory_alert_log_subject_idx
  on public.inventory_alert_log (subject_type, subject_id, alert_date desc);

alter table public.inventory_alert_log enable row level security;
drop policy if exists inventory_alert_log_select on public.inventory_alert_log;
create policy inventory_alert_log_select on public.inventory_alert_log
  for select to authenticated
  using (
    public.authorize('inventory.alerts.view')
    or public.authorize('inventory.overview.view')
  );
-- Inserts are done by service role / backend (bypass RLS). Authenticated app users only read.
drop policy if exists inventory_alert_log_insert on public.inventory_alert_log;
create policy inventory_alert_log_insert on public.inventory_alert_log
  for insert to authenticated
  with check (
    public.authorize('inventory.alerts.view')
    or public.authorize('inventory.lots.manage')
  );

notify pgrst, 'reload schema';
