-- Inventory Phase 3: reagent purchase + lab prep sessions + expense attribution.
-- Additive only — does not alter Materials/Chemicals/Solvents Phase 2 behaviour.

insert into public.permissions (code, description) values
  ('inventory.prep.manage', 'Manage reagent prep sessions (IM desk)')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'INVENTORY_MANAGER'
  and p.code in ('inventory.prep.manage')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Prep sessions (lab-made reagents)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_prep_sessions (
  id uuid primary key default gen_random_uuid(),
  catalog_item_id uuid not null references public.inventory_catalog_items (id) on delete restrict,
  location_id uuid not null references public.inventory_locations (id) on delete restrict,
  target_qty numeric(18, 4) not null
    check (target_qty > 0),
  unit text not null,
  qty_chips jsonb not null default '[]'::jsonb,
  status text not null default 'open'
    check (status in ('open', 'completed', 'cancelled')),
  notes text not null default '',
  prepared_by uuid references public.employees (id) on delete set null,
  reagent_lot_id uuid,
  component_cost_total numeric(18, 4) not null default 0
    check (component_cost_total >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint inventory_prep_sessions_chips_is_array
    check (jsonb_typeof(qty_chips) = 'array')
);

create index if not exists inventory_prep_sessions_status_idx
  on public.inventory_prep_sessions (status, created_at desc);

drop trigger if exists inventory_prep_sessions_set_updated_at on public.inventory_prep_sessions;
create trigger inventory_prep_sessions_set_updated_at
  before update on public.inventory_prep_sessions
  for each row execute procedure public.set_updated_at();

alter table public.inventory_prep_sessions enable row level security;
drop policy if exists inventory_prep_sessions_all on public.inventory_prep_sessions;
create policy inventory_prep_sessions_all on public.inventory_prep_sessions
  for all to authenticated
  using (
    public.authorize('inventory.prep.manage')
    or public.authorize('inventory.lots.manage')
  )
  with check (
    public.authorize('inventory.prep.manage')
    or public.authorize('inventory.lots.manage')
  );

-- ---------------------------------------------------------------------------
-- Lot origin / expense flags (Phase 2 lots default to purchase expense)
-- ---------------------------------------------------------------------------
alter table public.inventory_lots
  add column if not exists origin text not null default 'purchase'
    check (origin in ('purchase', 'prep')),
  add column if not exists counts_toward_purchase_expense boolean not null default true,
  add column if not exists component_cost_total numeric(18, 4) not null default 0
    check (component_cost_total >= 0),
  add column if not exists prep_session_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'inventory_lots_prep_session_fk'
  ) then
    alter table public.inventory_lots
      add constraint inventory_lots_prep_session_fk
      foreign key (prep_session_id) references public.inventory_prep_sessions (id) on delete set null;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'inventory_prep_sessions_reagent_lot_fk'
  ) then
    alter table public.inventory_prep_sessions
      add constraint inventory_prep_sessions_reagent_lot_fk
      foreign key (reagent_lot_id) references public.inventory_lots (id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Prep inputs (chemical/solvent issues attributed to a prep)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_prep_inputs (
  id uuid primary key default gen_random_uuid(),
  prep_session_id uuid not null references public.inventory_prep_sessions (id) on delete cascade,
  source_lot_id uuid not null references public.inventory_lots (id) on delete restrict,
  movement_id uuid not null references public.inventory_movements (id) on delete restrict,
  qty numeric(18, 4) not null
    check (qty > 0),
  unit text not null,
  attributed_cost numeric(18, 4) not null default 0
    check (attributed_cost >= 0),
  created_at timestamptz not null default now()
);

create index if not exists inventory_prep_inputs_session_idx
  on public.inventory_prep_inputs (prep_session_id, created_at);

alter table public.inventory_prep_inputs enable row level security;
drop policy if exists inventory_prep_inputs_all on public.inventory_prep_inputs;
create policy inventory_prep_inputs_all on public.inventory_prep_inputs
  for all to authenticated
  using (
    public.authorize('inventory.prep.manage')
    or public.authorize('inventory.lots.manage')
  )
  with check (
    public.authorize('inventory.prep.manage')
    or public.authorize('inventory.lots.manage')
  );

-- Link issues to prep sessions on the movement ledger
alter table public.inventory_movements
  add column if not exists prep_session_id uuid references public.inventory_prep_sessions (id) on delete set null;

create index if not exists inventory_movements_prep_idx
  on public.inventory_movements (prep_session_id)
  where prep_session_id is not null;

-- ---------------------------------------------------------------------------
-- Atomic issue (extended with optional prep_session_id)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_issue_lot(
  p_lot_id uuid,
  p_qty numeric,
  p_employee_id uuid,
  p_notes text default '',
  p_created_by uuid default null,
  p_prep_session_id uuid default null
)
returns table (
  lot_id uuid,
  remaining_qty numeric,
  qty_before numeric,
  qty_after numeric,
  unit text,
  movement_id uuid,
  lot_status text,
  attributed_cost numeric
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
  v_cost numeric(18, 4);
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

  -- Pro-rata purchase cost of this issue (for prep component attribution).
  if v_lot.received_qty > 0 then
    v_cost := round((p_qty / v_lot.received_qty) * v_lot.total_cost, 4);
  else
    v_cost := 0;
  end if;

  update public.inventory_lots
  set remaining_qty = v_after,
      status = v_status
  where id = p_lot_id;

  insert into public.inventory_movements (
    lot_id, movement_type, qty, qty_before, qty_after, unit, employee_id, notes, created_by, prep_session_id
  ) values (
    p_lot_id, 'issue', p_qty, v_before, v_after, v_lot.unit, p_employee_id, coalesce(p_notes, ''), p_created_by, p_prep_session_id
  )
  returning id into v_movement_id;

  lot_id := p_lot_id;
  remaining_qty := v_after;
  qty_before := v_before;
  qty_after := v_after;
  unit := v_lot.unit;
  movement_id := v_movement_id;
  lot_status := v_status;
  attributed_cost := v_cost;
  return next;
end;
$$;

revoke all on function public.inventory_issue_lot(uuid, numeric, uuid, text, uuid, uuid) from public;
grant execute on function public.inventory_issue_lot(uuid, numeric, uuid, text, uuid, uuid) to service_role;
grant execute on function public.inventory_issue_lot(uuid, numeric, uuid, text, uuid, uuid) to authenticated;

-- Drop Phase 2 5-arg signature if present (replaced by 6-arg above).
drop function if exists public.inventory_issue_lot(uuid, numeric, uuid, text, uuid);

notify pgrst, 'reload schema';
