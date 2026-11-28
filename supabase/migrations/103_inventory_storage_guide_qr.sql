-- Dedicated "Where to store?" QR: lookup catalog item → all shelf locations with remaining qty.
-- Keeps unique(kind). Does not change stock_room / stationery / inside_lab receive destinations.

alter table public.inventory_central_qrs
  drop constraint if exists inventory_central_qrs_kind_check;

alter table public.inventory_central_qrs
  add constraint inventory_central_qrs_kind_check
  check (kind in ('stock_room', 'stationery', 'inside_lab', 'storage_guide'));

comment on column public.inventory_central_qrs.kind is
  'stock_room / stationery / inside_lab = usage destinations; storage_guide = put-away location lookup only.';

insert into public.inventory_central_qrs (kind, name, qr_token, notes)
values (
  'storage_guide',
  'Where to store',
  encode(gen_random_bytes(24), 'hex'),
  'Scan to look up a catalog item by name or catalogue number and see every shelf location with remaining stock.'
)
on conflict (kind) do nothing;
