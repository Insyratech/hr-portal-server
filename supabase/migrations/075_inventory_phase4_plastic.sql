-- Inventory Phase 4: plastic wares (box stock) + stock-room station QR.
-- Additive only — does not alter measured lots / reagent prep behaviour.

insert into public.permissions (code, description) values
  ('inventory.plastic.manage', 'Receive plastic box stock, manage stations, view plastic ledger'),
  ('inventory.plastic.adjust', 'Adjust plastic box counts (IM)')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'INVENTORY_MANAGER'
  and p.code in (
    'inventory.plastic.manage',
    'inventory.plastic.adjust'
  )
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Station QR (one scan point → picker of plastic SKUs at that location)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_stations (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.inventory_locations (id) on delete restrict,
  name text not null,
  qr_token text not null,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_stations_qr_token_unique unique (qr_token),
  constraint inventory_stations_location_unique unique (location_id)
);

create index if not exists inventory_stations_status_idx
  on public.inventory_stations (status, name);
create index if not exists inventory_stations_qr_token_idx
  on public.inventory_stations (qr_token);

drop trigger if exists inventory_stations_set_updated_at on public.inventory_stations;
create trigger inventory_stations_set_updated_at
  before update on public.inventory_stations
  for each row execute procedure public.set_updated_at();

alter table public.inventory_stations enable row level security;
drop policy if exists inventory_stations_all on public.inventory_stations;
create policy inventory_stations_all on public.inventory_stations
  for all to authenticated
  using (
    public.authorize('inventory.plastic.manage')
    or public.authorize('inventory.lots.manage')
  )
  with check (
    public.authorize('inventory.plastic.manage')
    or public.authorize('inventory.lots.manage')
  );

-- ---------------------------------------------------------------------------
-- Plastic box stock (SKU + manufacturer + size at a location)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_plastic_stock (
  id uuid primary key default gen_random_uuid(),
  stock_code text not null,
  catalog_item_id uuid not null references public.inventory_catalog_items (id) on delete restrict,
  location_id uuid not null references public.inventory_locations (id) on delete restrict,
  manufacturer text not null default '',
  size_label text not null default '',
  attributes jsonb not null default '{}'::jsonb,
  boxes_on_hand integer not null default 0
    check (boxes_on_hand >= 0),
  boxes_received integer not null
    check (boxes_received > 0),
  unit text not null default 'box',
  total_cost numeric(18, 4) not null default 0
    check (total_cost >= 0),
  supplier_name text not null default '',
  supplier_type text not null default 'external'
    check (supplier_type in ('external', 'internal')),
  purchase_date date not null,
  qty_chips jsonb not null default '[1, 2, 5]'::jsonb,
  status text not null default 'active'
    check (status in ('active', 'depleted', 'void')),
  notes text not null default '',
  received_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_plastic_stock_code_unique unique (stock_code),
  constraint inventory_plastic_stock_chips_is_array
    check (jsonb_typeof(qty_chips) = 'array'),
  constraint inventory_plastic_stock_attrs_is_object
    check (jsonb_typeof(attributes) = 'object'),
  constraint inventory_plastic_stock_on_hand_lte_received
    check (boxes_on_hand <= boxes_received)
);

create index if not exists inventory_plastic_stock_status_idx
  on public.inventory_plastic_stock (status, created_at desc);
create index if not exists inventory_plastic_stock_location_idx
  on public.inventory_plastic_stock (location_id, status);
create index if not exists inventory_plastic_stock_catalog_idx
  on public.inventory_plastic_stock (catalog_item_id);
create index if not exists inventory_plastic_stock_sku_idx
  on public.inventory_plastic_stock (catalog_item_id, location_id, manufacturer, size_label);

drop trigger if exists inventory_plastic_stock_set_updated_at on public.inventory_plastic_stock;
create trigger inventory_plastic_stock_set_updated_at
  before update on public.inventory_plastic_stock
  for each row execute procedure public.set_updated_at();

alter table public.inventory_plastic_stock enable row level security;
drop policy if exists inventory_plastic_stock_all on public.inventory_plastic_stock;
create policy inventory_plastic_stock_all on public.inventory_plastic_stock
  for all to authenticated
  using (
    public.authorize('inventory.plastic.manage')
    or public.authorize('inventory.plastic.adjust')
    or public.authorize('inventory.lots.manage')
  )
  with check (
    public.authorize('inventory.plastic.manage')
    or public.authorize('inventory.plastic.adjust')
    or public.authorize('inventory.lots.manage')
  );

-- ---------------------------------------------------------------------------
-- Plastic movement ledger
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_plastic_movements (
  id uuid primary key default gen_random_uuid(),
  plastic_stock_id uuid not null references public.inventory_plastic_stock (id) on delete restrict,
  station_id uuid references public.inventory_stations (id) on delete set null,
  movement_type text not null
    check (movement_type in ('receive', 'issue', 'adjust')),
  boxes integer not null
    check (boxes > 0),
  boxes_before integer not null,
  boxes_after integer not null,
  unit text not null default 'box',
  employee_id uuid references public.employees (id) on delete set null,
  notes text not null default '',
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists inventory_plastic_movements_stock_idx
  on public.inventory_plastic_movements (plastic_stock_id, created_at desc);
create index if not exists inventory_plastic_movements_station_idx
  on public.inventory_plastic_movements (station_id, created_at desc)
  where station_id is not null;

alter table public.inventory_plastic_movements enable row level security;
drop policy if exists inventory_plastic_movements_select on public.inventory_plastic_movements;
create policy inventory_plastic_movements_select on public.inventory_plastic_movements
  for select to authenticated
  using (
    public.authorize('inventory.plastic.manage')
    or public.authorize('inventory.lots.manage')
  );
drop policy if exists inventory_plastic_movements_insert on public.inventory_plastic_movements;
create policy inventory_plastic_movements_insert on public.inventory_plastic_movements
  for insert to authenticated
  with check (
    public.authorize('inventory.plastic.manage')
    or public.authorize('inventory.plastic.adjust')
    or public.authorize('inventory.lots.manage')
  );

-- ---------------------------------------------------------------------------
-- Atomic box issue (station / kiosk)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_issue_plastic_boxes(
  p_plastic_stock_id uuid,
  p_boxes integer,
  p_employee_id uuid,
  p_notes text default '',
  p_created_by uuid default null,
  p_station_id uuid default null
)
returns table (
  plastic_stock_id uuid,
  boxes_on_hand integer,
  boxes_before integer,
  boxes_after integer,
  unit text,
  movement_id uuid,
  stock_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stock public.inventory_plastic_stock%rowtype;
  v_before integer;
  v_after integer;
  v_movement_id uuid;
  v_status text;
begin
  if p_boxes is null or p_boxes <= 0 then
    raise exception 'ISSUE_BOXES_INVALID';
  end if;

  select * into v_stock
  from public.inventory_plastic_stock
  where id = p_plastic_stock_id
  for update;

  if not found then
    raise exception 'PLASTIC_STOCK_NOT_FOUND';
  end if;

  if v_stock.status = 'void' then
    raise exception 'PLASTIC_STOCK_VOID';
  end if;

  if v_stock.boxes_on_hand < p_boxes then
    raise exception 'OVER_ISSUE:%', v_stock.boxes_on_hand;
  end if;

  v_before := v_stock.boxes_on_hand;
  v_after := v_before - p_boxes;
  v_status := case when v_after = 0 then 'depleted' else 'active' end;

  update public.inventory_plastic_stock
  set boxes_on_hand = v_after,
      status = v_status
  where id = p_plastic_stock_id;

  insert into public.inventory_plastic_movements (
    plastic_stock_id, station_id, movement_type, boxes, boxes_before, boxes_after, unit,
    employee_id, notes, created_by
  ) values (
    p_plastic_stock_id, p_station_id, 'issue', p_boxes, v_before, v_after, v_stock.unit,
    p_employee_id, coalesce(p_notes, ''), p_created_by
  )
  returning id into v_movement_id;

  plastic_stock_id := p_plastic_stock_id;
  boxes_on_hand := v_after;
  boxes_before := v_before;
  boxes_after := v_after;
  unit := v_stock.unit;
  movement_id := v_movement_id;
  stock_status := v_status;
  return next;
end;
$$;

revoke all on function public.inventory_issue_plastic_boxes(uuid, integer, uuid, text, uuid, uuid) from public;
grant execute on function public.inventory_issue_plastic_boxes(uuid, integer, uuid, text, uuid, uuid) to service_role;
grant execute on function public.inventory_issue_plastic_boxes(uuid, integer, uuid, text, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
