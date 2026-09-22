-- Inventory Phase 1: locations, system categories, catalog, authorizations.
-- Additive only — does not alter Finance/HR tables or Phase 0 role seed.

insert into public.permissions (code, description) values
  ('inventory.locations.manage', 'Manage inventory locations'),
  ('inventory.categories.manage', 'View categories and tune alert defaults'),
  ('inventory.catalog.manage', 'Manage inventory catalog items'),
  ('inventory.authorizations.manage', 'Manage inventory employee authorizations')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'INVENTORY_MANAGER'
  and p.code in (
    'inventory.locations.manage',
    'inventory.categories.manage',
    'inventory.catalog.manage',
    'inventory.authorizations.manage'
  )
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_locations (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  description text not null default '',
  location_type text not null default 'store'
    check (location_type in ('stock_room', 'store', 'bench', 'freezer', 'other')),
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_locations_code_unique unique (code)
);

create index if not exists inventory_locations_status_idx
  on public.inventory_locations (status, name);

drop trigger if exists inventory_locations_set_updated_at on public.inventory_locations;
create trigger inventory_locations_set_updated_at
  before update on public.inventory_locations
  for each row execute procedure public.set_updated_at();

alter table public.inventory_locations enable row level security;
drop policy if exists inventory_locations_all on public.inventory_locations;
create policy inventory_locations_all on public.inventory_locations
  for all to authenticated
  using (public.authorize('inventory.locations.manage'))
  with check (public.authorize('inventory.locations.manage'));

-- ---------------------------------------------------------------------------
-- Fixed system categories (IM may tune alert defaults only)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  sort_order integer not null default 0,
  deduction_mode text not null
    check (deduction_mode in ('measured', 'box')),
  default_alert_mode text not null default 'both'
    check (default_alert_mode in ('reorder', 'velocity', 'both')),
  default_reorder_qty numeric(18, 4),
  default_velocity_days integer not null default 15
    check (default_velocity_days between 1 and 365),
  default_expiry_lead_days integer not null default 15
    check (default_expiry_lead_days between 0 and 365),
  is_system boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_categories_code_unique unique (code)
);

create index if not exists inventory_categories_sort_idx
  on public.inventory_categories (sort_order, name);

drop trigger if exists inventory_categories_set_updated_at on public.inventory_categories;
create trigger inventory_categories_set_updated_at
  before update on public.inventory_categories
  for each row execute procedure public.set_updated_at();

alter table public.inventory_categories enable row level security;
drop policy if exists inventory_categories_select on public.inventory_categories;
create policy inventory_categories_select on public.inventory_categories
  for select to authenticated
  using (
    public.authorize('inventory.categories.manage')
    or public.authorize('inventory.catalog.manage')
    or public.authorize('inventory.overview.view')
  );
drop policy if exists inventory_categories_update on public.inventory_categories;
create policy inventory_categories_update on public.inventory_categories
  for update to authenticated
  using (public.authorize('inventory.categories.manage'))
  with check (public.authorize('inventory.categories.manage'));

-- Fixed ids (stable across environments)
insert into public.inventory_categories (
  id, code, name, sort_order, deduction_mode,
  default_alert_mode, default_reorder_qty, default_velocity_days, default_expiry_lead_days, is_system
) values
  ('00000000-0000-4000-8000-000000000071', 'MATERIALS', 'Materials', 10, 'measured', 'both', null, 15, 15, true),
  ('00000000-0000-4000-8000-000000000072', 'CHEMICALS', 'Chemicals', 20, 'measured', 'both', null, 15, 15, true),
  ('00000000-0000-4000-8000-000000000073', 'SOLVENTS', 'Solvents', 30, 'measured', 'both', null, 15, 15, true),
  ('00000000-0000-4000-8000-000000000074', 'REAGENTS', 'Reagents', 40, 'measured', 'both', null, 15, 15, true),
  ('00000000-0000-4000-8000-000000000075', 'PLASTIC_WARES', 'Plastic wares', 50, 'box', 'reorder', 2, 15, 0, true)
on conflict (id) do update set
  code = excluded.code,
  name = excluded.name,
  sort_order = excluded.sort_order,
  deduction_mode = excluded.deduction_mode,
  is_system = excluded.is_system;

-- ---------------------------------------------------------------------------
-- Catalog items
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_catalog_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.inventory_categories (id) on delete restrict,
  name text not null,
  unit text not null,
  default_qty_chips jsonb not null default '[]'::jsonb,
  alert_mode text not null default 'both'
    check (alert_mode in ('reorder', 'velocity', 'both')),
  reorder_qty numeric(18, 4),
  velocity_days integer
    check (velocity_days is null or velocity_days between 1 and 365),
  expiry_lead_days integer
    check (expiry_lead_days is null or expiry_lead_days between 0 and 365),
  notes text not null default '',
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_catalog_items_name_unique unique (category_id, name),
  constraint inventory_catalog_items_chips_is_array
    check (jsonb_typeof(default_qty_chips) = 'array')
);

create index if not exists inventory_catalog_items_category_idx
  on public.inventory_catalog_items (category_id, status, name);

drop trigger if exists inventory_catalog_items_set_updated_at on public.inventory_catalog_items;
create trigger inventory_catalog_items_set_updated_at
  before update on public.inventory_catalog_items
  for each row execute procedure public.set_updated_at();

alter table public.inventory_catalog_items enable row level security;
drop policy if exists inventory_catalog_items_all on public.inventory_catalog_items;
create policy inventory_catalog_items_all on public.inventory_catalog_items
  for all to authenticated
  using (public.authorize('inventory.catalog.manage'))
  with check (public.authorize('inventory.catalog.manage'));

-- ---------------------------------------------------------------------------
-- Employee authorizations (usage / receipt / prep)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_authorizations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  can_usage boolean not null default false,
  can_receipt boolean not null default false,
  can_prep boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_authorizations_employee_unique unique (employee_id),
  constraint inventory_authorizations_has_right
    check (can_usage or can_receipt or can_prep)
);

create index if not exists inventory_authorizations_employee_idx
  on public.inventory_authorizations (employee_id);

drop trigger if exists inventory_authorizations_set_updated_at on public.inventory_authorizations;
create trigger inventory_authorizations_set_updated_at
  before update on public.inventory_authorizations
  for each row execute procedure public.set_updated_at();

alter table public.inventory_authorizations enable row level security;
drop policy if exists inventory_authorizations_all on public.inventory_authorizations;
create policy inventory_authorizations_all on public.inventory_authorizations
  for all to authenticated
  using (public.authorize('inventory.authorizations.manage'))
  with check (public.authorize('inventory.authorizations.manage'));

notify pgrst, 'reload schema';
