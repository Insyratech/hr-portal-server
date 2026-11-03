-- Miscellaneous is a box category (gloves-style counts), not a measured lot.
-- Stations can point at a category so the room QR is not always "Plasticware".
-- Stationery rooms are linked to Miscellaneous. Other existing stations stay Plastic wares.

insert into public.inventory_categories (
  code, name, sort_order, deduction_mode,
  default_alert_mode, default_reorder_qty, default_velocity_days, default_expiry_lead_days, is_system
) values (
  'MISCELLANEOUS', 'Miscellaneous', 60, 'box', 'reorder', 2, 15, 0, false
)
on conflict (code) do nothing;

alter table public.inventory_stations
  add column if not exists category_id uuid references public.inventory_categories (id) on delete restrict;

update public.inventory_stations s
set category_id = misc.id
from public.inventory_categories misc, public.inventory_locations loc
where misc.code = 'MISCELLANEOUS'
  and s.location_id = loc.id
  and s.category_id is null
  and (
    s.name ilike '%stationer%'
    or loc.name ilike '%stationer%'
    or loc.code ilike 'store'
  );

update public.inventory_stations s
set category_id = plastic.id
from public.inventory_categories plastic
where plastic.code = 'PLASTIC_WARES'
  and s.category_id is null;
