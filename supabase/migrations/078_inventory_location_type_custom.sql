-- Inventory polish: allow custom location types beyond the original enum.
-- Additive / safe: keeps existing rows; only drops the restrictive check.

alter table public.inventory_locations
  drop constraint if exists inventory_locations_location_type_check;

alter table public.inventory_locations
  alter column location_type set default 'store';

-- Non-empty, length-bounded slug (preset or custom).
alter table public.inventory_locations
  add constraint inventory_locations_location_type_len
  check (char_length(trim(location_type)) between 2 and 40);

notify pgrst, 'reload schema';
