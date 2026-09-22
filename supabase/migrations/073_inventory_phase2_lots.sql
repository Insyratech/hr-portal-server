-- Inventory Phase 2: measured lots, QR tokens, movement ledger.
-- Additive only — Materials / Chemicals / Solvents receive + issue loop.

insert into public.permissions (code, description) values
  ('inventory.lots.manage', 'Receive measured lots, print QR labels, view stock and ledger'),
  ('inventory.lots.adjust', 'Adjust measured lot quantities (IM)')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'INVENTORY_MANAGER'
  and p.code in (
    'inventory.lots.manage',
    'inventory.lots.adjust'
  )
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Lots (one bottle/container + QR)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_lots (
  id uuid primary key default gen_random_uuid(),
  lot_code text not null,
  qr_token text not null,
  catalog_item_id uuid not null references public.inventory_catalog_items (id) on delete restrict,
  location_id uuid not null references public.inventory_locations (id) on delete restrict,
  supplier_name text not null default '',
  supplier_type text not null default 'external'
    check (supplier_type in ('external', 'internal')),
  purchase_date date not null,
  received_qty numeric(18, 4) not null
    check (received_qty > 0),
  remaining_qty numeric(18, 4) not null
    check (remaining_qty >= 0),
  unit text not null,
  total_cost numeric(18, 4) not null default 0
    check (total_cost >= 0),
  expiry_date date,
  qty_chips jsonb not null default '[]'::jsonb,
  status text not null default 'active'
    check (status in ('active', 'depleted', 'void')),
  notes text not null default '',
  received_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_lots_lot_code_unique unique (lot_code),
  constraint inventory_lots_qr_token_unique unique (qr_token),
  constraint inventory_lots_chips_is_array
    check (jsonb_typeof(qty_chips) = 'array'),
  constraint inventory_lots_remaining_lte_received
    check (remaining_qty <= received_qty)
);

create index if not exists inventory_lots_status_idx
  on public.inventory_lots (status, created_at desc);
create index if not exists inventory_lots_catalog_idx
  on public.inventory_lots (catalog_item_id);
create index if not exists inventory_lots_location_idx
  on public.inventory_lots (location_id);
create index if not exists inventory_lots_qr_token_idx
  on public.inventory_lots (qr_token);

drop trigger if exists inventory_lots_set_updated_at on public.inventory_lots;
create trigger inventory_lots_set_updated_at
  before update on public.inventory_lots
  for each row execute procedure public.set_updated_at();

alter table public.inventory_lots enable row level security;
drop policy if exists inventory_lots_all on public.inventory_lots;
create policy inventory_lots_all on public.inventory_lots
  for all to authenticated
  using (
    public.authorize('inventory.lots.manage')
    or public.authorize('inventory.lots.adjust')
  )
  with check (
    public.authorize('inventory.lots.manage')
    or public.authorize('inventory.lots.adjust')
  );

-- ---------------------------------------------------------------------------
-- Movement ledger (immutable append-only from app; no update policy needed)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.inventory_lots (id) on delete restrict,
  movement_type text not null
    check (movement_type in ('receive', 'issue', 'adjust')),
  qty numeric(18, 4) not null
    check (qty > 0),
  qty_before numeric(18, 4) not null,
  qty_after numeric(18, 4) not null,
  unit text not null,
  employee_id uuid references public.employees (id) on delete set null,
  notes text not null default '',
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists inventory_movements_lot_idx
  on public.inventory_movements (lot_id, created_at desc);
create index if not exists inventory_movements_employee_idx
  on public.inventory_movements (employee_id, created_at desc);

alter table public.inventory_movements enable row level security;
drop policy if exists inventory_movements_select on public.inventory_movements;
create policy inventory_movements_select on public.inventory_movements
  for select to authenticated
  using (public.authorize('inventory.lots.manage'));
drop policy if exists inventory_movements_insert on public.inventory_movements;
create policy inventory_movements_insert on public.inventory_movements
  for insert to authenticated
  with check (
    public.authorize('inventory.lots.manage')
    or public.authorize('inventory.lots.adjust')
  );

-- Atomic issue: prevents over-issue races. Service role bypasses RLS.
create or replace function public.inventory_issue_lot(
  p_lot_id uuid,
  p_qty numeric,
  p_employee_id uuid,
  p_notes text default '',
  p_created_by uuid default null
)
returns table (
  lot_id uuid,
  remaining_qty numeric,
  qty_before numeric,
  qty_after numeric,
  unit text,
  movement_id uuid,
  lot_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lot public.inventory_lots%rowtype;
  v_before numeric(18, 4);
  v_after numeric(18, 4);
  v_movement_id uuid;
  v_status text;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'ISSUE_QTY_INVALID';
  end if;

  select * into v_lot
  from public.inventory_lots
  where id = p_lot_id
  for update;

  if not found then
    raise exception 'LOT_NOT_FOUND';
  end if;

  if v_lot.status = 'void' then
    raise exception 'LOT_VOID';
  end if;

  if v_lot.remaining_qty < p_qty then
    raise exception 'OVER_ISSUE:%', v_lot.remaining_qty;
  end if;

  v_before := v_lot.remaining_qty;
  v_after := v_before - p_qty;
  v_status := case when v_after = 0 then 'depleted' else 'active' end;

  update public.inventory_lots
  set remaining_qty = v_after,
      status = v_status
  where id = p_lot_id;

  insert into public.inventory_movements (
    lot_id, movement_type, qty, qty_before, qty_after, unit, employee_id, notes, created_by
  ) values (
    p_lot_id, 'issue', p_qty, v_before, v_after, v_lot.unit, p_employee_id, coalesce(p_notes, ''), p_created_by
  )
  returning id into v_movement_id;

  lot_id := p_lot_id;
  remaining_qty := v_after;
  qty_before := v_before;
  qty_after := v_after;
  unit := v_lot.unit;
  movement_id := v_movement_id;
  lot_status := v_status;
  return next;
end;
$$;

revoke all on function public.inventory_issue_lot(uuid, numeric, uuid, text, uuid) from public;
grant execute on function public.inventory_issue_lot(uuid, numeric, uuid, text, uuid) to service_role;
grant execute on function public.inventory_issue_lot(uuid, numeric, uuid, text, uuid) to authenticated;

notify pgrst, 'reload schema';
