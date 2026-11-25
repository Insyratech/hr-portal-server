-- Lab work types + recipes (IM-managed). Used by Inside lab room QR (Phase C).

insert into public.permissions (code, description) values
  ('inventory.lab.manage', 'Manage lab work types and reagent recipes')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'INVENTORY_MANAGER'
  and p.code = 'inventory.lab.manage'
on conflict do nothing;

create table if not exists public.inventory_lab_activities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  sort_order integer not null default 100,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_lab_activities_name_unique unique (name)
);

create index if not exists inventory_lab_activities_status_idx
  on public.inventory_lab_activities (status, sort_order, name);

drop trigger if exists inventory_lab_activities_set_updated_at on public.inventory_lab_activities;
create trigger inventory_lab_activities_set_updated_at
  before update on public.inventory_lab_activities
  for each row execute procedure public.set_updated_at();

alter table public.inventory_lab_activities enable row level security;
drop policy if exists inventory_lab_activities_all on public.inventory_lab_activities;
create policy inventory_lab_activities_all on public.inventory_lab_activities
  for all to authenticated
  using (
    public.authorize('inventory.lab.manage')
    or public.authorize('inventory.lots.manage')
  )
  with check (
    public.authorize('inventory.lab.manage')
    or public.authorize('inventory.lots.manage')
  );

create table if not exists public.inventory_lab_recipes (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.inventory_lab_activities (id) on delete cascade,
  name text not null,
  final_volume_value numeric(18, 4),
  final_volume_unit text not null default '',
  notes text not null default '',
  sort_order integer not null default 100,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_lab_recipes_activity_name_unique unique (activity_id, name)
);

create index if not exists inventory_lab_recipes_activity_idx
  on public.inventory_lab_recipes (activity_id, status, sort_order, name);

drop trigger if exists inventory_lab_recipes_set_updated_at on public.inventory_lab_recipes;
create trigger inventory_lab_recipes_set_updated_at
  before update on public.inventory_lab_recipes
  for each row execute procedure public.set_updated_at();

alter table public.inventory_lab_recipes enable row level security;
drop policy if exists inventory_lab_recipes_all on public.inventory_lab_recipes;
create policy inventory_lab_recipes_all on public.inventory_lab_recipes
  for all to authenticated
  using (
    public.authorize('inventory.lab.manage')
    or public.authorize('inventory.lots.manage')
  )
  with check (
    public.authorize('inventory.lab.manage')
    or public.authorize('inventory.lots.manage')
  );

create table if not exists public.inventory_lab_recipe_components (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.inventory_lab_recipes (id) on delete cascade,
  name text not null,
  quantity_value numeric(18, 4),
  quantity_unit text not null default '',
  notes text not null default '',
  sort_order integer not null default 100,
  catalog_item_id uuid references public.inventory_catalog_items (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inventory_lab_recipe_components_recipe_idx
  on public.inventory_lab_recipe_components (recipe_id, sort_order);

drop trigger if exists inventory_lab_recipe_components_set_updated_at on public.inventory_lab_recipe_components;
create trigger inventory_lab_recipe_components_set_updated_at
  before update on public.inventory_lab_recipe_components
  for each row execute procedure public.set_updated_at();

alter table public.inventory_lab_recipe_components enable row level security;
drop policy if exists inventory_lab_recipe_components_all on public.inventory_lab_recipe_components;
create policy inventory_lab_recipe_components_all on public.inventory_lab_recipe_components
  for all to authenticated
  using (
    public.authorize('inventory.lab.manage')
    or public.authorize('inventory.lots.manage')
  )
  with check (
    public.authorize('inventory.lab.manage')
    or public.authorize('inventory.lots.manage')
  );

-- Starter work types (IM can rename / add / deactivate).
insert into public.inventory_lab_activities (name, description, sort_order) values
  ('DNA Extraction', 'Choose a DNA extraction type/recipe, then adjust components if needed.', 10),
  ('PCR reaction', 'Choose a PCR type/recipe, then adjust components if needed.', 20),
  ('Gel preparation', 'Agarose gel and related prep recipes.', 30),
  ('DNA loading', 'Loading dye / DNA loading recipes.', 40),
  ('Reagent preparation', 'Prepare reagents from composition recipes (e.g. 6X Loading Dye).', 50)
on conflict (name) do nothing;
