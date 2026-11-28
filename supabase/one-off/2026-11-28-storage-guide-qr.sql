-- Seed / repair the "Where to store?" usage-area QR.
-- Safe to re-run. Does not touch Stock room / Stationery / Inside lab stock links.

alter table public.inventory_central_qrs
  drop constraint if exists inventory_central_qrs_kind_check;

alter table public.inventory_central_qrs
  add constraint inventory_central_qrs_kind_check
  check (kind in ('stock_room', 'stationery', 'inside_lab', 'storage_guide'));

insert into public.inventory_central_qrs (kind, name, qr_token, notes, status)
values (
  'storage_guide',
  'Where to store',
  encode(gen_random_bytes(24), 'hex'),
  'Scan to look up a catalog item by name or catalogue number and see every shelf location with remaining stock.',
  'active'
)
on conflict (kind) do update
set name = excluded.name,
    notes = excluded.notes,
    status = 'active',
    updated_at = now();

select id, kind, name, status, notes, '/scan/' || qr_token as scan_path
from public.inventory_central_qrs
order by kind;
