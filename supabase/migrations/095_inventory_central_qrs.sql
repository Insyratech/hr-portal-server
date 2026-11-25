-- Three fixed room QRs (stock room, stationery, inside lab).
-- Receive attaches stock to a room; usage goes through these QRs (not per-bottle).

create table if not exists public.inventory_central_qrs (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in ('stock_room', 'stationery', 'inside_lab')),
  name text not null,
  qr_token text not null,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_central_qrs_kind_unique unique (kind),
  constraint inventory_central_qrs_qr_token_unique unique (qr_token)
);

create index if not exists inventory_central_qrs_qr_token_idx
  on public.inventory_central_qrs (qr_token);

drop trigger if exists inventory_central_qrs_set_updated_at on public.inventory_central_qrs;
create trigger inventory_central_qrs_set_updated_at
  before update on public.inventory_central_qrs
  for each row execute procedure public.set_updated_at();

alter table public.inventory_central_qrs enable row level security;
drop policy if exists inventory_central_qrs_all on public.inventory_central_qrs;
create policy inventory_central_qrs_all on public.inventory_central_qrs
  for all to authenticated
  using (
    public.authorize('inventory.lots.manage')
    or public.authorize('inventory.plastic.manage')
  )
  with check (
    public.authorize('inventory.lots.manage')
    or public.authorize('inventory.plastic.manage')
  );

insert into public.inventory_central_qrs (kind, name, qr_token, notes)
values
  (
    'stock_room',
    'Stock room',
    encode(gen_random_bytes(24), 'hex'),
    'Central QR for taking measured lots and plasticwares out of the stock room.'
  ),
  (
    'stationery',
    'Stationery',
    encode(gen_random_bytes(24), 'hex'),
    'Central QR for taking stationery / miscellaneous box stock.'
  ),
  (
    'inside_lab',
    'Inside lab',
    encode(gen_random_bytes(24), 'hex'),
    'Central QR for reagents and materials kept inside the lab (work logging follows).'
  )
on conflict (kind) do nothing;

-- Attach destination on measured lots and plastic stock.
alter table public.inventory_lots
  add column if not exists central_qr_id uuid
    references public.inventory_central_qrs (id) on delete restrict;

alter table public.inventory_plastic_stock
  add column if not exists central_qr_id uuid
    references public.inventory_central_qrs (id) on delete restrict;

create index if not exists inventory_lots_central_qr_idx
  on public.inventory_lots (central_qr_id, status);

create index if not exists inventory_plastic_stock_central_qr_idx
  on public.inventory_plastic_stock (central_qr_id, status);

-- Backfill existing stock so room scans have something to show.
update public.inventory_lots l
set central_qr_id = cq.id
from public.inventory_central_qrs cq
where l.central_qr_id is null
  and cq.kind = case
    when coalesce(l.origin, 'purchase') = 'prep' then 'inside_lab'
    else 'stock_room'
  end;

update public.inventory_plastic_stock ps
set central_qr_id = cq.id
from public.inventory_central_qrs cq,
     public.inventory_catalog_items ci,
     public.inventory_categories cat
where ps.central_qr_id is null
  and ps.catalog_item_id = ci.id
  and ci.category_id = cat.id
  and cq.kind = case
    when cat.code = 'MISCELLANEOUS' then 'stationery'
    else 'stock_room'
  end;
